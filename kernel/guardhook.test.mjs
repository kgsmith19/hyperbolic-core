// node --test kernel/guardhook.test.mjs  (run from C:\code\guards)
// Integration: spawns the hook as a real subprocess with a real stdin payload,
// which is the only way the fail-closed and exit-code contract is actually proven.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "guardhook.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-hook-"));
const ROOT = path.join(BASE, "root");
const POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(POLICY, JSON.stringify({ kernel: { alwaysAllowTools: ["TodoWrite"] } }));

const S = await import("./settings.mjs");
const L = await import("./ledger.mjs");
const AU = await import("./autonomy.mjs");
const P = await import("./policy.mjs");

const RUN = "r-hook";
const contract = {
  goal: "g", constraints: [], rollbackPlan: "none",
  allowedActions: { readRoots: [path.join(BASE, "work")], writeRoots: [], bashPatterns: ["npm test"], networkHosts: [], vaultKeys: [], subagents: [] },
  budget: { wallClockMin: 10, toolCalls: 3, tokens: 100 },
  acceptanceCriteria: [{ id: "AC1", ears: "x", verify: { method: "git_clean" } }],
};

function stage() {
  process.env.ACC_ROOT = ROOT;
  process.env.ACC_POLICY = POLICY;
  fs.rmSync(ROOT, { recursive: true, force: true });
  return S.writeRunFiles(contract, { runId: RUN, guardhookPath: HOOK });
}

function fire(payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN), ...env },
  });
  return { code: r.status, err: r.stderr || "" };
}

beforeEach(() => stage());
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("an allowed call exits 0; a denied call exits 2 with the reason on stderr (AC-G1)", () => {
  const ok = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(ok.code, 0);
  const no = fire({ tool_name: "Write", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(no.code, 2);
  assert.match(no.err, /not granted by the contract/);
});

test("every decision, allow and deny, is appended to the run's sidecar (AC-G2)", () => {
  fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  fire({ tool_name: "Bash", tool_input: { command: "curl evil.example" } });
  process.env.ACC_ROOT = ROOT;
  const counts = L.decisionCounts(RUN);
  assert.deepEqual(counts, { allow: 1, deny: 1, total: 2 });
  const rows = fs.readFileSync(L.decisionsFile(RUN), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[1].tool, "Bash");
  assert.equal(rows[1].allow, false);
  assert.ok(rows[1].ts, "each decision is timestamped");
});

test("a settings file tampered mid-run denies everything and flags the run (AC-G6)", () => {
  const w = S.writeRunFiles(contract, { runId: RUN, guardhookPath: HOOK });
  const evil = JSON.parse(fs.readFileSync(w.settingsPath, "utf8"));
  evil.hooks.PreToolUse = [];
  fs.writeFileSync(w.settingsPath, JSON.stringify(evil, null, 2));
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 2);
  assert.match(r.err, /integrity/i);
  process.env.ACC_ROOT = ROOT;
  const rows = fs.readFileSync(L.decisionsFile(RUN), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).rule, "integrity");
});

test("every unreadable input fails closed (AC-G11)", () => {
  // no payload
  const noPayload = spawnSync(process.execPath, [HOOK], {
    input: "", encoding: "utf8",
    env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN) },
  });
  assert.equal(noPayload.status, 2);

  // no run directory in the environment
  assert.equal(fire({ tool_name: "Read", tool_input: { file_path: "x" } }, { ACC_KERNEL_DIR: "" }).code, 2);

  // corrupt contract
  fs.writeFileSync(path.join(S.runDir(RUN), "contract.json"), "{ not json");
  assert.equal(fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } }).code, 2);

  // corrupt policy
  stage();
  fs.writeFileSync(POLICY, "{ not json");
  assert.equal(fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } }).code, 2);
  fs.writeFileSync(POLICY, JSON.stringify({ kernel: { alwaysAllowTools: ["TodoWrite"] } }));

  // corrupt/missing pin
  stage();
  fs.rmSync(path.join(S.runDir(RUN), "pin.json"));
  const noPin = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(noPin.code, 2);
  assert.match(noPin.err, /cannot read the run pin/);
});

test("a corrupt contract with a payload that itself has no tool_name still fails closed", () => {
  fs.writeFileSync(path.join(S.runDir(RUN), "contract.json"), "{ not json");
  const r = fire({});
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot read the contract or kernel policy/);
});

test("the tool-call ceiling falls back to the policy default when the contract omits budget.toolCalls", () => {
  const c = { ...contract, budget: { wallClockMin: 10, tokens: 100 } }; // no toolCalls
  fs.writeFileSync(POLICY, JSON.stringify({ kernel: { alwaysAllowTools: ["TodoWrite"], budget: { toolCalls: 1 } } }));
  S.writeRunFiles(c, { runId: RUN, guardhookPath: HOOK });
  assert.equal(fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } }).code, 0);
  const over = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(over.code, 2);
  assert.match(over.err, /ceiling/);
  fs.writeFileSync(POLICY, JSON.stringify({ kernel: { alwaysAllowTools: ["TodoWrite"] } }));
});

test("a decision log that cannot be written fails closed (AC-G11)", () => {
  // Block only THIS run's decisions file, not the whole ledger directory:
  // OI-024's readAutonomyStrict() also reads a sibling file in that same
  // directory (autonomyFile()) earlier in the hook's flow, so blocking the
  // directory itself now trips that check first instead of the decision-log
  // write this test targets. A directory in place of the decisions file
  // makes appendFileSync throw while leaving autonomy.json's path untouched.
  fs.mkdirSync(L.decisionsFile(RUN), { recursive: true });
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot write the decision log/);
});

test("a deny that itself cannot log the decision still denies (the denial stands regardless)", () => {
  const w = S.writeRunFiles(contract, { runId: RUN, guardhookPath: HOOK });
  const evil = JSON.parse(fs.readFileSync(w.settingsPath, "utf8"));
  evil.hooks.PreToolUse = [];
  fs.writeFileSync(w.settingsPath, JSON.stringify(evil, null, 2));
  fs.mkdirSync(path.join(ROOT, "runner"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "runner", "ledger"), "blocked");
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 2);
  assert.match(r.err, /integrity/i);
});

test("a stdin pipe that never closes still fails closed once the timeout cap elapses", async () => {
  const child = spawn(process.execPath, [HOOK], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN), ACC_GUARDHOOK_STDIN_TIMEOUT_MS: "50" },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  // Deliberately never end() stdin — the hook must not hang waiting for it.
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 2);
  assert.match(stderr, /unreadable stdin payload|no readable hook payload/);
});

test("OI-028: an oversized stdin payload fails closed instead of buffering unbounded", async () => {
  const child = spawn(process.execPath, [HOOK], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN), ACC_GUARDHOOK_STDIN_MAX_BYTES: "100" },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdin.write("x".repeat(1000)); // well over the 100-byte cap
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 2);
  assert.match(stderr, /exceeded 100 bytes/);
});

test("the tool-call ceiling is enforced across separate hook fires (AC-B1)", () => {
  const call = () => fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(call().code, 0);
  assert.equal(call().code, 0);
  assert.equal(call().code, 0);
  const over = call();               // contract budget.toolCalls is 3
  assert.equal(over.code, 2);
  assert.match(over.err, /ceiling/);
});

test("a tightened autonomy factor shrinks the per-fire ceiling to EXACTLY effectiveCeilings' number (OI-024)", () => {
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor: 0.5 }));
  const shrunk = AU.effectiveCeilings(contract, P.loadKernelPolicy(), { factor: 0.5 }).toolCalls; // 3 * 0.5 -> 2
  const read = () => fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  for (let i = 0; i < shrunk; i++) assert.equal(read().code, 0, `fire ${i + 1} of ${shrunk} must still be allowed`);
  const over = read();
  assert.equal(over.code, 2, "the fire after the shrunk ceiling must be denied");
  const rows = fs.readFileSync(L.decisionsFile(RUN), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).ceiling, shrunk, "the decision record must carry the effective ceiling");
  assert.equal(rows.at(-1).autonomyFactor, 0.5, "…and the factor that produced it");
});

test("corrupt autonomy state fails closed", () => {
  // (The absent-state half this test once carried duplicated the sequential
  // tool-call-ceiling test above — beforeEach(stage) guarantees no autonomy
  // file there either.)
  const read = () => fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), "{ not json");
  const r = read();
  assert.equal(r.code, 2);
  assert.match(r.err, /autonomy/i);
});

test("a contract yielding no finite toolCalls ceiling denies instead of comparing against NaN", () => {
  process.env.ACC_ROOT = ROOT; process.env.ACC_POLICY = POLICY;
  fs.rmSync(ROOT, { recursive: true, force: true });
  S.writeRunFiles({ ...contract, budget: { ...contract.budget, toolCalls: "many" } }, { runId: RUN, guardhookPath: HOOK });
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 2);
  assert.match(r.err, /finite/i);
});

test("the autonomy-state and non-finite-ceiling denials still record with tool:null when the payload itself has no tool_name", () => {
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), "{ not json");
  const noToolAutonomy = fire({});
  assert.equal(noToolAutonomy.code, 2);
  assert.match(noToolAutonomy.err, /autonomy/i);

  stage();
  S.writeRunFiles({ ...contract, budget: { ...contract.budget, toolCalls: "many" } }, { runId: RUN, guardhookPath: HOOK });
  const noToolCeiling = fire({});
  assert.equal(noToolCeiling.code, 2);
  assert.match(noToolCeiling.err, /finite/i);
});

test("OI-019: the tool-call ceiling holds across CONCURRENT overlapping fires, not just sequential ones (AC-B1)", async () => {
  // Real Claude Code sessions fire multiple tool calls in parallel within one
  // turn, so ceiling enforcement must be safe against overlapping hook
  // processes racing each other, not just calls made one at a time like every
  // other test in this file. Fire well more than the ceiling (3) all at once.
  const fireAsync = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN) },
    });
    let err = "";
    child.stderr.on("data", (data) => { err += data; });
    child.on("error", reject);
    child.stdin.end(JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } }));
    child.on("close", (code) => resolve({ code, err }));
  });
  const results = await Promise.all(Array.from({ length: 60 }, fireAsync));
  for (const [index, result] of results.entries()) {
    assert.ok(result.code === 0 || result.code === 2,
      `fire ${index + 1} exited ${result.code}; stderr: ${result.err}`);
    if (result.code === 2) {
      assert.match(result.err, /tool-call ceiling/i,
        `fire ${index + 1} must be an ordinary ceiling denial, not an infrastructure failure`);
    }
  }
  const allowed = results.filter(({ code }) => code === 0).length;
  assert.equal(allowed, 3, `exactly the contract's toolCalls ceiling (3) may be allowed, got ${allowed} of 60 concurrent fires`);
  process.env.ACC_ROOT = ROOT;
  assert.deepEqual(L.decisionCounts(RUN), { allow: 3, deny: 57, total: 60 },
    "every fire must still be recorded exactly once — the lock must not drop or duplicate a decision");
});

test("a stored autonomy factor of null falls back to 1 in the decision record, not NaN or null", () => {
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor: null }));
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 0);
  const rows = fs.readFileSync(L.decisionsFile(RUN), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).autonomyFactor, 1);
});
