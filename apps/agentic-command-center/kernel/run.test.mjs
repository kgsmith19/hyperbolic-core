// node --test kernel/run.test.mjs  (run from C:\code\guards)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, "run.mjs");

// Platform-skip pattern already used by hooks/route.test.mjs: this one test
// below resolves the REAL claude-code adapter (no fake injected) and calls
// its real identity() probe, which shells out to an actual installed `claude`
// binary. CI runners (and any hermetic sandbox) do not have that binary on
// PATH, so the probe fails with a spawn error rather than proving anything
// about adapter resolution — skip cleanly rather than fail for the wrong
// reason, exactly as route.test.mjs skips its four fixture-path tests off Windows.
let claudeCliOnPath = true;
try {
  execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true, shell: true });
} catch {
  claudeCliOnPath = false;
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-run-"));
process.env.ACC_ROOT = path.join(BASE, "root");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_LANE_DIR = path.join(BASE, "lane");
fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({
  kernel: { harness: "claude-code", hardCaps: { wallClockMin: 240 } },
  lane: { slots: 1, minGapMs: 0, pollMs: 10, breakerThreshold: 100000 },
}));

const R = await import("./run.mjs");
const L = await import("./ledger.mjs");

const contractFile = (c) => {
  const f = path.join(BASE, `c-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(c));
  return f;
};
const good = () => ({
  goal: "g", constraints: ["do not touch files outside the workspace"],
  allowedActions: { readRoots: [path.join(BASE, "work")], writeRoots: [], bashPatterns: [], networkHosts: [], vaultKeys: [], subagents: [] },
  budget: { wallClockMin: 30, toolCalls: 100, tokens: 200000 },
  acceptanceCriteria: [{ id: "AC1", ears: "x", verify: { method: "file_exists", path: path.join(BASE, "work", "out.txt") } }],
  rollbackPlan: "none",
});
const fakeAdapter = (over = {}) => ({
  id: "fake", identity: () => ({ name: "fake", version: "1.0.0" }),
  startTask: async () => ({ pid: 1, done: Promise.resolve({ code: 0, events: [] }) }),
  sendStep: async () => {}, readState: () => ({ toolCalls: 0, tokens: 0, sessionId: null }),
  stopTask: async () => {}, ...over,
});

beforeEach(() => fs.rmSync(L.ledgerDir(), { recursive: true, force: true }));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("an incomplete contract is refused with NO ledger entry and no harness (AC-C1)", async () => {
  const c = good(); delete c.acceptanceCriteria;
  let probed = false;
  const r = await R.runTask(contractFile(c), { adapter: fakeAdapter({ identity: () => { probed = true; return {}; } }) });
  assert.equal(r.outcome, "refused");
  assert.ok(r.errors.join(" ").includes("acceptanceCriteria"));
  assert.equal(probed, false, "a harness must never be probed for an invalid contract");
  assert.equal(L.readRuns().length, 0, "a refused contract is not a run and gets no ledger entry");
});

test("a harness that cannot start is recorded as failed-to-start, fail closed (AC-A3, AC-L1)", async () => {
  const adapter = fakeAdapter({ identity: () => { throw new Error("ENOENT"); } });
  const r = await R.runTask(contractFile(good()), { adapter });
  assert.equal(r.outcome, "failed-to-start");
  const rows = L.readRuns();
  assert.equal(rows.filter((x) => x.event === "run_started").length, 1);
  const f = rows.find((x) => x.event === "run_finalized");
  assert.equal(f.outcome, "failed-to-start");
  assert.match(f.error, /ENOENT/);
});

test("OI-019: an adapter that cannot be RESOLVED is recorded as failed-to-start, not an uncaught crash (AC-A3)", async () => {
  // Every existing "failed-to-start" test injects a fake adapter, which
  // skips resolveAdapter() entirely (adapter || await resolveAdapter()) and
  // only exercises identity()/startTask() throwing. resolveAdapter() itself
  // — reached whenever no adapter is injected, i.e. real production usage —
  // was called with no try/catch, BEFORE runId/staged files/appendStarted
  // even exist. A policy.json kernel.harness naming an adapter module that
  // doesn't exist (a plausible operator typo, not a hypothetical) crashed
  // runTask's own promise with no ledger entry at all — not even the
  // "failed-to-start... IS a run and it gets the full started/finalized
  // pair" this file's own header promises for every other post-contract
  // failure. Deliberately does NOT inject an adapter, to hit the real
  // resolveAdapter() path; a nonexistent module name fails identically
  // whether or not the `claude` CLI happens to be on PATH.
  const badPolicy = path.join(BASE, "bad-harness-policy.json");
  fs.writeFileSync(badPolicy, JSON.stringify({
    kernel: { harness: "no-such-harness", hardCaps: { wallClockMin: 240 } },
    lane: { slots: 1, minGapMs: 0, pollMs: 10, breakerThreshold: 100000 },
  }));
  const saved = process.env.ACC_POLICY;
  process.env.ACC_POLICY = badPolicy;
  try {
    const r = await R.runTask(contractFile(good()));
    assert.equal(r.outcome, "failed-to-start");
    const rows = L.readRuns().filter((x) => x.runId === r.runId);
    assert.equal(rows.filter((x) => x.event === "run_started").length, 1, "still gets the full started/finalized pair");
    const f = rows.find((x) => x.event === "run_finalized");
    assert.equal(f.outcome, "failed-to-start");
    assert.match(f.error, /no-such-harness/);
  } finally {
    process.env.ACC_POLICY = saved;
  }
});

test("harness identity and version reach the ledger for every run (AC-A2)", async () => {
  await R.runTask(contractFile(good()), { adapter: fakeAdapter() });
  const f = L.readRuns().find((x) => x.event === "run_finalized");
  assert.deepEqual(f.harness, { name: "fake", version: "1.0.0" });
});

test("the contract is stored verbatim in the started line (AC-C3)", async () => {
  const c = good();
  await R.runTask(contractFile(c), { adapter: fakeAdapter() });
  assert.deepEqual(L.readRuns().find((x) => x.event === "run_started").contract, c);
});

test("runTask resolves a real adapter when none is injected", { skip: !claudeCliOnPath }, async () => {
  // A vault key the (empty) test vault doesn't have makes envForKeys throw
  // and fail closed AFTER identity() but BEFORE startTask() — proving real
  // adapter resolution without ever spawning a live `claude -p` process.
  const c = good();
  c.allowedActions.vaultKeys = ["NOT_IN_VAULT_XYZ"];
  const r = await R.runTask(contractFile(c));
  assert.equal(r.harness.name, "claude-code");
  assert.equal(r.outcome, "failed-to-start");
});

test("run ids are unique", () => {
  assert.notEqual(R.newRunId(), R.newRunId());
  assert.match(R.newRunId(), /^r-\d{8}T\d{6}-[0-9a-f]{6}$/);
});

// The isMain guard only runs via a real process invocation, never via
// `node --test` import (the same shape kernel/ledger.mjs proves itself).
test("end-to-end: the CLI with no contract argument prints usage and exits 2", () => {
  assert.throws(
    () => execFileSync("node", [RUN], { encoding: "utf8", env: process.env }),
    (err) => /usage: node kernel\/run\.mjs/.test(err.stderr) && err.status === 2
  );
});

test("end-to-end: the CLI refuses an invalid contract and exits 2", () => {
  const f = contractFile({ goal: "g" });
  assert.throws(
    () => execFileSync("node", [RUN, f], { encoding: "utf8", env: process.env }),
    (err) => {
      const out = JSON.parse(err.stdout);
      return out.outcome === "refused" && err.status === 2;
    }
  );
});

const S = await import("./settings.mjs");
const workDir = path.join(BASE, "work");
fs.mkdirSync(workDir, { recursive: true });
process.env.ACC_VAULT = path.join(BASE, "vault.json");
fs.writeFileSync(process.env.ACC_VAULT, JSON.stringify({ TASK_KEY: "sk-live-LEDGER-SENTINEL" }));

// A fake harness that records how it was launched and can act on the workspace.
function recordingAdapter({ onLaunch, exitCode = 0, events = [] } = {}) {
  const seen = {};
  return {
    adapter: {
      id: "fake", identity: () => ({ name: "fake", version: "1.0.0" }),
      startTask: async (opts) => {
        Object.assign(seen, opts);
        if (onLaunch) await onLaunch(opts);
        return { pid: 1, events, done: Promise.resolve({ code: exitCode, events }) };
      },
      sendStep: async () => {}, stopTask: async () => {},
      readState: (evts) => ({ toolCalls: evts.length, tokens: 42, sessionId: "s" }),
    },
    seen,
  };
}

test("the harness is launched with the run's staging dir and the pinned settings (AC-G5)", async () => {
  const { adapter, seen } = recordingAdapter();
  const c = good();
  const r = await R.runTask(contractFile(c), { adapter });
  assert.equal(seen.env.ACC_KERNEL_DIR, S.runDir(r.runId));
  assert.match(seen.settingsPath, /settings\.json$/);
  assert.deepEqual(seen.tools.sort(), ["Glob", "Grep", "Read", "TodoWrite"].sort());
  const started = L.readRuns().find((x) => x.event === "run_started");
  assert.match(started.settingsSha256, /^[0-9a-f]{64}$/);
});

test("contract-listed vault keys reach the child env and NOTHING else (AC-L4)", async () => {
  const c = good();
  c.allowedActions.vaultKeys = ["TASK_KEY"];
  const { adapter, seen } = recordingAdapter();
  const r = await R.runTask(contractFile(c), { adapter });
  assert.equal(seen.env.TASK_KEY, "sk-live-LEDGER-SENTINEL", "the value must reach the child env");

  // The real assertion: the value exists nowhere on disk under the ledger.
  for (const f of fs.readdirSync(L.ledgerDir())) {
    const text = fs.readFileSync(path.join(L.ledgerDir(), f), "utf8");
    assert.equal(text.includes("LEDGER-SENTINEL"), false, `${f} contains a credential value`);
    assert.equal(text.includes("sk-live"), false, `${f} contains a credential value`);
  }
  assert.ok(JSON.stringify(L.readRuns()).includes("TASK_KEY"), "key NAMES are recorded, values are not");
  assert.equal(r.outcome === "accepted" || r.outcome === "rejected", true);
});

test("a vault key the contract asks for but the vault lacks fails closed", async () => {
  const c = good();
  c.allowedActions.vaultKeys = ["NOT_IN_VAULT"];
  const r = await R.runTask(contractFile(c), { adapter: recordingAdapter().adapter });
  assert.equal(r.outcome, "failed-to-start");
  assert.match(L.readRuns().find((x) => x.event === "run_finalized").error, /NOT_IN_VAULT/);
});

test("settings tampered BEFORE launch refuse to launch (AC-G5)", async () => {
  let launched = false;
  const adapter = recordingAdapter({ onLaunch: () => { launched = true; } }).adapter;
  const r = await R.runTask(contractFile(good()), {
    adapter,
    afterStage: (dir) => {                       // test seam: mutate between pin and launch
      const f = path.join(dir, "settings.json");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8") + "\n");
    },
  });
  assert.equal(launched, false, "a failed integrity check must happen BEFORE the harness starts");
  assert.equal(r.outcome, "failed-to-start");
  assert.match(L.readRuns().find((x) => x.event === "run_finalized").error, /integrity/i);
});

test("verification runs only after the harness process has exited (AC-V3)", async () => {
  const out = path.join(workDir, "out.txt");
  fs.rmSync(out, { force: true });
  // The criterion can only pass if the verifier ran AFTER the harness finished.
  const { adapter } = recordingAdapter({ onLaunch: () => fs.writeFileSync(out, "done") });
  const r = await R.runTask(contractFile(good()), { adapter });
  assert.equal(r.outcome, "accepted");
  assert.deepEqual(r.criteria.map((c) => [c.id, c.status]), [["AC1", "pass"]]);
});

test("a criterion that does not hold makes the run rejected (AC-V2, AC-L5)", async () => {
  fs.rmSync(path.join(workDir, "out.txt"), { force: true });
  const r = await R.runTask(contractFile(good()), { adapter: recordingAdapter().adapter });
  assert.equal(r.outcome, "rejected");
  const f = L.readRuns().find((x) => x.event === "run_finalized");
  assert.equal(f.criteria[0].status, "fail");
  assert.equal(f.tokens, 42);
  assert.ok(f.wallClockMs >= 0);
});

test("a contract that omits every optional field still runs with sensible defaults", async () => {
  const c = good();
  delete c.allowedActions.writeRoots;
  delete c.allowedActions.readRoots;
  delete c.allowedActions.vaultKeys;
  delete c.budget.wallClockMin;
  const { adapter, seen } = recordingAdapter();
  const r = await R.runTask(contractFile(c), { adapter });
  assert.equal(seen.cwd, process.cwd(), "workspaceOf falls back to cwd when no roots are named");
  assert.equal(seen.env.TASK_KEY, undefined, "no vaultKeys means no credentials injected");
  assert.equal(seen.ttlMs, 60 * 60 * 1000, "wallClockMin defaults to 60 minutes");
  assert.equal(r.outcome === "accepted" || r.outcome === "rejected", true);
});

test("a harness whose startTask itself throws is recorded as failed-to-start (AC-A3)", async () => {
  const adapter = { ...recordingAdapter().adapter, startTask: async () => { throw new Error("spawn ENOENT"); } };
  const r = await R.runTask(contractFile(good()), { adapter });
  assert.equal(r.outcome, "failed-to-start");
  assert.match(L.readRuns().find((x) => x.event === "run_finalized").error, /spawn ENOENT/);
});

test("the staging directory is removed on every exit path (AC-G3)", async () => {
  fs.writeFileSync(path.join(workDir, "out.txt"), "done");
  const okRun = await R.runTask(contractFile(good()), { adapter: recordingAdapter().adapter });
  assert.equal(fs.existsSync(S.runDir(okRun.runId)), false);
  const badRun = await R.runTask(contractFile(good()), {
    adapter: { ...recordingAdapter().adapter, identity: () => { throw new Error("ENOENT"); } },
  });
  assert.equal(fs.existsSync(S.runDir(badRun.runId)), false);
});

test("a run over its wall-clock ceiling is stopped and marked aborted-by-budget (AC-B1)", async () => {
  let stopped = false;
  const c = good();
  c.budget.wallClockMin = 0.001;                    // 60 ms
  const adapter = {
    id: "fake", identity: () => ({ name: "fake", version: "1.0.0" }),
    startTask: async () => {
      let resolveDone;
      const done = new Promise((r) => (resolveDone = r));
      return { pid: 1, events: [], done, stop: async () => { stopped = true; resolveDone({ code: 143, events: [] }); } };
    },
    sendStep: async () => {}, stopTask: async (h) => h.stop(),
    readState: () => ({ toolCalls: 0, tokens: 0, sessionId: "s" }),
  };
  const r = await R.runTask(contractFile(c), { adapter, tickMs: 10 });
  assert.equal(stopped, true, "the harness must actually be stopped");
  assert.equal(r.outcome, "aborted-by-budget");
  assert.equal(r.dimension, "wallClock");
  assert.equal(L.readRuns().find((x) => x.event === "run_finalized").dimension, "wallClock");
});

test("a stopTask that itself throws while enforcing a breach is swallowed, not crashed (AC-B1 fault tolerance, OI-019)", async () => {
  const c = good();
  c.budget.wallClockMin = 0.001;                    // 60 ms
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const adapter = {
    id: "fake", identity: () => ({ name: "fake", version: "1.0.0" }),
    startTask: async () => ({ pid: 1, events: [], done }),
    sendStep: async () => {},
    // Models a harness whose own stop path fails (e.g. an already-dead
    // process) while the OS-level kill still lands moments later — the
    // kernel's abort must not depend on stopTask() resolving cleanly.
    stopTask: async () => { setTimeout(() => resolveDone({ code: 143, events: [] }), 5); throw new Error("kill failed"); },
    readState: () => ({ toolCalls: 0, tokens: 0, sessionId: "s" }),
  };
  const r = await R.runTask(contractFile(c), { adapter, tickMs: 10 });
  assert.equal(r.outcome, "aborted-by-budget");
  assert.equal(r.dimension, "wallClock");
});

test("OI-019: an adapter's readState() throwing inside a supervisor tick fails the RUN closed, not the whole process (AC-B1 fault tolerance)", async () => {
  // Must run out-of-process: an uncaught exception inside run.mjs's
  // setInterval callback is NOT caught by the enclosing async function (timer
  // callbacks are not try/catch'd by their creator's call frame) — it becomes
  // a real uncaughtException that kills the whole node process. Reproducing
  // that in-process would take this entire test file down with it.
  const c = good();
  c.budget.wallClockMin = 10; // long enough that only the injected fault stops it
  const cFile = contractFile(c);
  const script = path.join(BASE, "run-crash-caller.mjs");
  fs.writeFileSync(script, `
    import { runTask } from ${JSON.stringify(pathToFileURL(RUN).href)};
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const adapter = {
      id: "fake", identity: () => ({ name: "fake", version: "1.0.0" }),
      startTask: async () => ({ pid: 1, events: [], done }),
      sendStep: async () => {},
      stopTask: async () => { resolveDone({ code: 143, events: [] }); },
      readState: () => { throw new Error("readState blew up"); },
    };
    const r = await runTask(process.argv[2], { adapter, tickMs: 10 });
    process.stdout.write(JSON.stringify(r));
  `);
  const { spawn } = await import("node:child_process");
  const { code, out, err } = await new Promise((resolve) => {
    const child = spawn("node", [script, cFile], { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
  assert.equal(code, 0, `the process must not crash uncaught; stderr:\n${err}`);
  const r = JSON.parse(out);
  assert.equal(r.outcome, "aborted-by-budget");
  assert.equal(r.dimension, "supervisor-fault");
  assert.match(r.error, /readState blew up/);
  const f = L.readRuns().find((x) => x.runId === r.runId && x.event === "run_finalized");
  assert.ok(f, "a finalized ledger entry must exist even though the harness adapter is broken");
});

test("a run over its token ceiling is stopped, using the LIVE event stream (AC-B1)", async () => {
  const c = good();
  c.budget.tokens = 10;
  const events = [];
  const adapter = {
    id: "fake", identity: () => ({ name: "fake", version: "1.0.0" }),
    startTask: async () => {
      let resolveDone;
      const done = new Promise((r) => (resolveDone = r));
      setTimeout(() => events.push({ type: "assistant", message: { usage: { output_tokens: 999 }, content: [] } }), 15);
      return { pid: 1, events, done, stop: async () => resolveDone({ code: 143, events }) };
    },
    sendStep: async () => {}, stopTask: async (h) => h.stop(),
    readState: (evts) => ({ toolCalls: 0, tokens: evts.length * 999, sessionId: "s" }),
  };
  const r = await R.runTask(contractFile(c), { adapter, tickMs: 10 });
  assert.equal(r.outcome, "aborted-by-budget");
  assert.equal(r.dimension, "tokens");
});

test("the autonomy window is updated after every finalized run (AC-B2 wiring)", async () => {
  const A = await import("./autonomy.mjs");
  fs.rmSync(path.join(L.ledgerDir(), "autonomy.json"), { force: true });
  fs.rmSync(path.join(workDir, "out.txt"), { force: true });
  for (let i = 0; i < 4; i++) await R.runTask(contractFile(good()), { adapter: recordingAdapter().adapter });
  assert.equal(A.readAutonomy().factor, 0.5, "four rejected runs must have tightened the ceilings");
  assert.equal(A.readAutonomy().log.at(-1).direction, "tighten");
});
