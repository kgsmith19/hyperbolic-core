// node --test kernel/ledger.test.mjs  (run from C:\code\guards)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, "ledger.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-ledger-"));
process.env.ACC_ROOT = path.join(BASE, "root");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(process.env.ACC_POLICY, "{}");

const L = await import("./ledger.mjs");

beforeEach(() => fs.rmSync(L.ledgerDir(), { recursive: true, force: true }));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const started = (runId) => ({
  runId, startedAt: "2026-08-03T10:00:00.000Z",
  contract: { goal: "g", acceptanceCriteria: [{ id: "AC1" }] }, settingsSha256: "abc",
});
const finalized = (runId, outcome = "accepted") => ({
  runId, finishedAt: "2026-08-03T10:05:00.000Z", outcome,
  harness: { name: "claude-code", version: "9.9.9" },
  criteria: [{ id: "AC1", status: "pass" }],
  decisions: { allow: 3, deny: 1 }, tokens: 1234, wallClockMs: 300000,
});

test("one run writes exactly one started and one finalized line (AC-L1)", () => {
  L.appendStarted(started("r1"));
  L.appendFinalized(finalized("r1"));
  const rows = L.readRuns();
  assert.equal(rows.filter((r) => r.event === "run_started" && r.runId === "r1").length, 1);
  assert.equal(rows.filter((r) => r.event === "run_finalized" && r.runId === "r1").length, 1);
});

test("a repeated append with the same runId applies exactly once (AC-G4)", () => {
  assert.equal(L.appendStarted(started("r2")), true);
  assert.equal(L.appendStarted(started("r2")), false, "second append must be a no-op");
  L.appendFinalized(finalized("r2"));
  assert.equal(L.appendFinalized(finalized("r2", "rejected")), false);
  const rows = L.readRuns().filter((r) => r.runId === "r2");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.event === "run_finalized").outcome, "accepted",
    "the first finalize wins; a duplicate must not rewrite the outcome");
});

test("OI-019: a repeated append RACING from CONCURRENT real processes still applies exactly once (AC-G4)", async () => {
  // The launch lane retries transport failures (this file's own header
  // comment: "a resumed kernel must not double-write"), so two processes
  // genuinely can call appendStarted for the SAME runId at nearly the same
  // instant. appendOnce's read-then-append was not atomic across processes —
  // reproduced live: 20 concurrent callers produced 2 duplicate run_started
  // lines for one runId, not the single line AC-G4 promises. The natural
  // read-to-append window is a handful of microseconds, so forcing that
  // interleaving by chance is unreliable (observed both outcomes across
  // repeated runs) — ACC_LEDGER_APPEND_ONCE_DELAY_MS widens the window on
  // purpose so this proves the fix deterministically, not by luck.
  const script = path.join(BASE, "append-once-caller.mjs");
  fs.writeFileSync(script, `
    import { appendStarted } from ${JSON.stringify(pathToFileURL(LEDGER).href)};
    const ok = appendStarted({
      runId: "r-race", startedAt: "2026-08-06T00:00:00.000Z",
      contract: {}, settingsSha256: "a",
    });
    process.stdout.write(String(ok));
  `);
  const { spawn } = await import("node:child_process");
  const run = () => new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      env: { ...process.env, ACC_LEDGER_APPEND_ONCE_DELAY_MS: "50" },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`append-once-caller exited ${code}: ${err}`));
      else resolve(out === "true");
    });
  });
  const N = 5;
  const oks = await Promise.all(Array.from({ length: N }, run));
  assert.equal(oks.filter(Boolean).length, 1, "exactly one of N concurrent callers may believe it went first");
  assert.equal(L.readRuns().filter((r) => r.runId === "r-race" && r.event === "run_started").length, 1,
    "exactly one run_started line must land on disk, whatever N concurrent processes raced to write it");
});

test("an abort still writes a finalized line (AC-L1 covers failure and abort)", () => {
  L.appendStarted(started("r3"));
  L.appendFinalized(finalized("r3", "aborted-by-budget"));
  assert.equal(L.readRuns().find((r) => r.event === "run_finalized").outcome, "aborted-by-budget");
});

test("finalized carries outcome, harness, per-criterion results, counts, cost, wall-clock (AC-L5)", () => {
  L.appendStarted(started("r4"));
  L.appendFinalized(finalized("r4"));
  const f = L.readRuns().find((r) => r.event === "run_finalized");
  for (const k of ["outcome", "harness", "criteria", "decisions", "tokens", "wallClockMs"]) {
    assert.ok(f[k] !== undefined, `finalized must carry ${k}`);
  }
  assert.equal(f.harness.version, "9.9.9");
});

test("the contract is stored byte-identically alongside the run (AC-C3)", () => {
  const c = { goal: "exact", nested: { list: [1, 2, 3] }, acceptanceCriteria: [{ id: "AC1" }] };
  L.appendStarted({ ...started("r5"), contract: c });
  assert.deepEqual(L.readRuns().find((r) => r.event === "run_started").contract, c);
});

test("guard decisions stream to a per-run sidecar and are counted", () => {
  L.appendDecision("r6", { tool: "Bash", allow: false, rule: "bashPatterns", reason: "no match", target: "rm -rf /" });
  L.appendDecision("r6", { tool: "Read", allow: true, rule: "readRoots", target: "C:/x/a.txt" });
  assert.deepEqual(L.decisionCounts("r6"), { allow: 1, deny: 1, total: 2 });
  assert.equal(fs.existsSync(L.decisionsFile("r6")), true);
});

test("readDecisions returns the full parsed rows, not just counts", () => {
  L.appendDecision("r7", { tool: "Edit", allow: false, rule: "writeRoots", reason: "not granted", target: "C:/x/b.txt" });
  assert.deepEqual(L.readDecisions("r7").map((d) => [d.tool, d.allow, d.rule, d.target]),
    [["Edit", false, "writeRoots", "C:/x/b.txt"]]);
  assert.equal(L.readDecisions("nope-no-such-run").length, 0, "a run with no decisions reads as empty, not an error");
});

test("OI-019: withDecisionLock serializes callers — each sees the attempts count left by every prior call, in order", () => {
  const seen = [];
  for (let i = 0; i < 5; i++) {
    L.withDecisionLock("r8", (attempts) => {
      seen.push(attempts);
      L.appendDecision("r8", { tool: "Read", allow: true, rule: "readRoots", target: `x${i}` });
    });
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
});

test("withDecisionLock releases its lock file after a normal return", () => {
  L.withDecisionLock("r9", () => {});
  assert.equal(fs.existsSync(path.join(L.ledgerDir(), "r9.decisions.lock")), false);
});

test("withDecisionLock releases its lock file even when fn throws — a held lock must not survive the caller's own error", () => {
  assert.throws(() => L.withDecisionLock("r10", () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(path.join(L.ledgerDir(), "r10.decisions.lock")), false);
});

test("a lock file abandoned by a dead process (stale) is reaped, not waited out forever", () => {
  const file = path.join(L.ledgerDir(), "r11.decisions.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "orphaned");
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file, past, past); // older than the stale threshold
  let ran = false;
  L.withDecisionLock("r11", () => { ran = true; });
  assert.equal(ran, true, "a stale lock must be reaped rather than block the caller forever");
});

test("exclusive-create EPERM contention is retried and the acquired lock is still released", () => {
  const file = path.join(L.ledgerDir(), "r11-ep.decisions.lock");
  const realOpenSync = fs.openSync;
  let attempts = 0;
  let ran = false;
  fs.openSync = (...args) => {
    if (args[0] === file && attempts++ === 0) {
      const error = new Error("simulated exclusive-create contention");
      error.code = "EPERM";
      throw error;
    }
    return realOpenSync(...args);
  };
  try {
    L.withDecisionLock("r11-ep", () => { ran = true; });
  } finally {
    fs.openSync = realOpenSync;
  }
  assert.equal(ran, true);
  assert.equal(attempts, 2, "the second exclusive-create attempt must acquire the lock");
  assert.equal(fs.existsSync(file), false, "the acquired lock must still be released");
});

test("a lock held by a live, recent holder is NOT reaped as stale — acquisition blocks until it times out and throws", () => {
  const file = path.join(L.ledgerDir(), "r12.decisions.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "held"); // fresh mtime — a genuine in-progress holder
  process.env.ACC_LEDGER_LOCK_TIMEOUT_MS = "50";
  try {
    assert.throws(() => L.withDecisionLock("r12", () => {}), /timed out waiting for the "r12\.decisions" lock/);
  } finally {
    delete process.env.ACC_LEDGER_LOCK_TIMEOUT_MS;
    fs.rmSync(file, { force: true });
  }
});

test("OI-019 end-to-end: real concurrent OS processes calling withDecisionLock each get a distinct, gap-free attempts count", async () => {
  // Windows drive-letter paths ("D:\\a\\...") are not valid bare ESM import
  // specifiers — Node's resolver only special-cases absolute POSIX-style
  // paths. Using pathToFileURL().href is the cross-platform-safe way to
  // reference LEDGER from generated script text (found via a real Windows CI
  // failure: every one of the 15 children below silently crashed on import
  // before writing anything, and coercing the empty stdout with Number("")
  // masked it as a plausible-looking "attempts: 0" instead of a real error).
  const script = path.join(BASE, "lock-caller.mjs");
  fs.writeFileSync(script, `
    import { withDecisionLock, appendDecision } from ${JSON.stringify(pathToFileURL(LEDGER).href)};
    withDecisionLock(process.argv[2], (attempts) => {
      appendDecision(process.argv[2], { tool: "Read", allow: true, rule: "readRoots", target: String(attempts) });
      process.stdout.write(String(attempts));
    });
  `);
  const { spawn } = await import("node:child_process");
  const run = () => new Promise((resolve, reject) => {
    const child = spawn("node", [script, "r13"], { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`lock-caller exited ${code}: ${err}`));
      else resolve(Number(out));
    });
  });
  const N = 15;
  const attemptsSeen = await Promise.all(Array.from({ length: N }, run));
  assert.deepEqual([...attemptsSeen].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i),
    "N concurrent real processes must see exactly 0..N-1 with no duplicate and no gap");
  assert.deepEqual(L.decisionCounts("r13"), { allow: N, deny: 0, total: N });
});

test("autonomyFile lives beside the runs file, under the ledger dir", () => {
  assert.equal(path.dirname(L.autonomyFile()), L.ledgerDir());
  assert.equal(path.basename(L.autonomyFile()), "autonomy.json");
});

test("a truncated trailing line does not lose the records before it", () => {
  L.appendStarted(started("r7"));
  fs.appendFileSync(L.runsFile(), '{"event":"run_fina');
  assert.equal(L.readRuns().length, 1);
});

function seed() {
  L.appendStarted({ runId: "q1", startedAt: "2026-08-01T00:00:00.000Z", contract: {}, settingsSha256: "a" });
  L.appendFinalized({ runId: "q1", finishedAt: "2026-08-01T01:00:00.000Z", outcome: "accepted",
    harness: { name: "claude-code", version: "1" }, criteria: [], decisions: {}, tokens: 1, wallClockMs: 1 });
  L.appendStarted({ runId: "q2", startedAt: "2026-08-05T00:00:00.000Z", contract: {}, settingsSha256: "a" });
  L.appendFinalized({ runId: "q2", finishedAt: "2026-08-05T01:00:00.000Z", outcome: "rejected",
    harness: { name: "codex", version: "2" }, criteria: [], decisions: {}, tokens: 1, wallClockMs: 1 });
  L.appendStarted({ runId: "q3", startedAt: "2026-08-06T00:00:00.000Z", contract: {}, settingsSha256: "a" });
}

test("query filters by status, harness, and date range (AC-L3)", () => {
  seed();
  assert.deepEqual(L.query({ status: "rejected" }).map((r) => r.runId), ["q2"]);
  assert.deepEqual(L.query({ harness: "claude-code" }).map((r) => r.runId), ["q1"]);
  assert.deepEqual(L.query({ since: "2026-08-04" }).map((r) => r.runId), ["q2", "q3"]);
  assert.deepEqual(L.query({ since: "2026-08-04", until: "2026-08-05T23:59:59Z" }).map((r) => r.runId), ["q2"]);
});

test("a started run with no finalized line reads as interrupted (AC-L2)", () => {
  seed();
  assert.equal(L.query({}).find((r) => r.runId === "q3").status, "interrupted");
  assert.deepEqual(L.query({ status: "interrupted" }).map((r) => r.runId), ["q3"]);
});

test("the CLI returns the same rows the API does", () => {
  seed();
  assert.deepEqual(
    L.runCli(["query", "--status", "accepted"]).map((r) => r.runId),
    L.query({ status: "accepted" }).map((r) => r.runId)
  );
  assert.throws(() => L.runCli(["bogus"]), /usage: ledger\.mjs query/);
});

// The isMain guard only runs via a real process invocation, never via
// `node --test` import — proven here as an actual subprocess (inherits
// process.env, including a live NODE_V8_COVERAGE, so it counts toward this
// file's own coverage the same way hooks/covgate.mjs proves itself).
test("end-to-end: the CLI prints JSON lines and exits 0 for a real query", () => {
  seed();
  const out = execFileSync("node", [LEDGER, "query", "--status", "accepted"], {
    encoding: "utf8", env: process.env,
  });
  assert.deepEqual(out.trim().split("\n").map((l) => JSON.parse(l).runId), ["q1"]);
});

test("end-to-end: an unknown CLI command prints usage to stderr and exits 1", () => {
  assert.throws(
    () => execFileSync("node", [LEDGER, "bogus"], { encoding: "utf8", env: process.env }),
    /usage: ledger\.mjs query/
  );
});
