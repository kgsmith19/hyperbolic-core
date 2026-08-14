// node --test kernel/autonomy.test.mjs  (run from C:\code\guards)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTONOMY = path.join(HERE, "autonomy.mjs");

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-autonomy-"));
process.env.ACC_ROOT = path.join(BASE, "root");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({
  kernel: {
    budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 },
    hardCaps: { wallClockMin: 240 },
    autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 },
    checkpointMin: 20,
  },
}));

const A = await import("./autonomy.mjs");
const L = await import("./ledger.mjs");
const { loadKernelPolicy } = await import("./policy.mjs");

function seedRuns(outcomes) {
  outcomes.forEach((outcome, i) => {
    L.appendStarted({ runId: `s${i}`, startedAt: new Date(2026, 7, 3, 0, i).toISOString(), contract: {}, settingsSha256: "x" });
    L.appendFinalized({ runId: `s${i}`, finishedAt: new Date(2026, 7, 3, 0, i, 30).toISOString(),
      outcome, harness: { name: "fake", version: "1" }, criteria: [], decisions: {}, tokens: 0, wallClockMs: 1 });
  });
}

beforeEach(() => fs.rmSync(L.ledgerDir(), { recursive: true, force: true }));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("effective ceiling = min(contract, policy default, hard cap) x factor (AC-B6)", () => {
  const p = loadKernelPolicy();
  const contract = { budget: { wallClockMin: 30, toolCalls: 100, tokens: 200000 } };
  assert.deepEqual(A.effectiveCeilings(contract, p, { factor: 1 }),
    { wallClockMs: 30 * 60000, toolCalls: 100, tokens: 200000 });
  assert.deepEqual(A.effectiveCeilings(contract, p, { factor: 0.5 }),
    { wallClockMs: 15 * 60000, toolCalls: 50, tokens: 100000 });
  assert.deepEqual(A.effectiveCeilings({}, p, { factor: 1 }),
    { wallClockMs: 60 * 60000, toolCalls: 200, tokens: 500000 });
  assert.equal(A.effectiveCeilings({ budget: { wallClockMin: 9999 } }, p, { factor: 1 }).wallClockMs,
    240 * 60000, "the hard cap wins over a larger contract value");
});

test("crossing the rejected-rate threshold tightens the next N runs automatically (AC-B2)", () => {
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted",
            "accepted", "accepted", "rejected", "rejected", "aborted-by-budget"]);
  const { state, adjustment } = A.updateAfterRun();
  assert.equal(state.factor, 0.5);
  assert.equal(state.runsLeft, 5);
  assert.equal(adjustment.direction, "tighten");
  assert.match(adjustment.reason, /3\/10/);
});

test("a healthy window makes no adjustment", () => {
  seedRuns(["accepted", "accepted", "accepted", "accepted", "rejected"]);
  const { state, adjustment } = A.updateAfterRun();
  assert.equal(state.factor, 1);
  assert.equal(adjustment, null);
});

test("failed-to-start does not count as a rejection — tightening cannot fix a missing binary", () => {
  seedRuns(["failed-to-start", "failed-to-start", "failed-to-start", "failed-to-start",
            "accepted", "accepted", "accepted", "accepted", "accepted", "accepted"]);
  assert.equal(A.updateAfterRun().state.factor, 1);
});

test("a window of only failed-to-start runs makes no adjustment (empty counted window, no divide-by-zero)", () => {
  seedRuns(["failed-to-start", "failed-to-start", "failed-to-start"]);
  const { state, adjustment } = A.updateAfterRun();
  assert.equal(state.factor, 1);
  assert.equal(adjustment, null);
});

test("ceilings restore automatically once the window recovers (AC-B3)", () => {
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  assert.equal(A.updateAfterRun().state.factor, 0.5);
  A.writeAutonomy({ ...A.readAutonomy(), runsLeft: 1 });
  fs.rmSync(L.runsFile(), { force: true });
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted"]);
  const after2 = A.updateAfterRun();
  assert.equal(after2.state.factor, 1);
  assert.equal(after2.adjustment.direction, "restore");
});

test("mid-tightening runs are decremented without a new adjustment or log entry", () => {
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  assert.equal(A.updateAfterRun().state.factor, 0.5);
  assert.equal(A.readAutonomy().runsLeft, 5);
  fs.rmSync(L.runsFile(), { force: true });
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted"]);
  const { state, adjustment } = A.updateAfterRun();
  assert.equal(state.runsLeft, 4, "one run consumed from the tightening window, still not elapsed");
  assert.equal(state.factor, 0.5, "factor unchanged mid-tightening");
  assert.equal(adjustment, null);
});

test("if the window is still bad when the tightened runs elapse, tightening re-arms instead of silently sticking", () => {
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  assert.equal(A.updateAfterRun().state.factor, 0.5);
  A.writeAutonomy({ ...A.readAutonomy(), runsLeft: 1 });
  fs.rmSync(L.runsFile(), { force: true });
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  const after2 = A.updateAfterRun();
  assert.equal(after2.state.factor, 0.5, "still bad, so it must not silently restore");
  assert.equal(after2.state.runsLeft, 5, "re-armed for another full tightening window");
  assert.equal(after2.adjustment.direction, "tighten");
});

test("OI-019: concurrent updateAfterRun calls from real processes do not lose or duplicate a tighten decision (AC-B2/AC-B4 fault tolerance)", async () => {
  // updateAfterRun's readAutonomy() -> mutate -> writeAutonomy() is a
  // read-modify-write with no synchronization. Nothing in this module
  // guarantees only one kernel process is ever mid-run at once (that's an
  // ADAPTER-level property of the lane, per kernel/adapters/claude-code.mjs
  // — a future/third-party adapter need not use it at all, and this file's
  // own header advertises "swapping harnesses is one value in policy.json").
  // Reproduced live: 15 concurrent callers against a state that should
  // transition "tighten" exactly once produced 3-4 duplicate log entries,
  // and in one run 4 processes each believed they logged a decision while
  // only 3 landed on disk — a genuine lost write, not just a duplicate
  // decision. The natural race window is a few syscalls wide and reproduces
  // inconsistently by chance, so ACC_AUTONOMY_UPDATE_DELAY_MS (same test-seam
  // pattern as guardhook.mjs's ACC_GUARDHOOK_STDIN_TIMEOUT_MS and ledger.mjs's
  // ACC_LEDGER_APPEND_ONCE_DELAY_MS) widens it on demand for a deterministic
  // regression test instead of a timing coin flip.
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted",
            "accepted", "accepted", "rejected", "rejected", "aborted-by-budget"]);
  const script = path.join(BASE, "update-caller.mjs");
  fs.writeFileSync(script, `
    import { updateAfterRun } from ${JSON.stringify(pathToFileURL(AUTONOMY).href)};
    const { adjustment } = updateAfterRun();
    process.stdout.write(adjustment ? "logged" : "no-op");
  `);
  const { spawn } = await import("node:child_process");
  const run = () => new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      env: { ...process.env, ACC_AUTONOMY_UPDATE_DELAY_MS: "50" },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`update-caller exited ${code}: ${err}`));
      else resolve(out === "logged");
    });
  });
  const N = 5;
  const logged = await Promise.all(Array.from({ length: N }, run));
  assert.equal(logged.filter(Boolean).length, 1, "exactly one of N concurrent callers may log the tighten decision");
  const state = A.readAutonomy();
  assert.equal(state.log.length, 1, "exactly one log entry must land on disk, whatever N concurrent processes raced to write it");
  assert.equal(state.factor, 0.5);
  // Correct serialized behavior, not a relaxed expectation: only the FIRST
  // of the N calls trips "tighten" (runsLeft: 0 -> 5, the policy's cfg.runs);
  // each of the other N-1, properly serialized, sees runsLeft > 0 and
  // decrements it by one — the same semantics the sequential "mid-tightening
  // runs are decremented" test above already proves. Deterministic regardless
  // of which of the N identical calls happens to go first.
  assert.equal(state.runsLeft, 5 - (N - 1), "runsLeft must reflect exactly one tighten plus (N-1) serialized decrements, not be stomped by a lost concurrent write");
});

test("every adjustment is logged with its trigger reason and window (AC-B4)", () => {
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  A.updateAfterRun();
  const entry = A.readAutonomy().log.at(-1);
  assert.equal(entry.direction, "tighten");
  assert.equal(entry.factor, 0.5);
  assert.ok(entry.at);
  assert.deepEqual(entry.window, ["rejected", "rejected", "rejected", "accepted", "accepted"]);
});

test("a checkpoint stops a run that made no tool call in a whole interval (AC-B5)", () => {
  const ceilings = { wallClockMs: 60 * 60000, toolCalls: 200, tokens: 500000 };
  const live = { elapsedMs: 60000, ceilings, tokens: 10, attemptsNow: 5, attemptsAtLastCheckpoint: 3, checkpointDue: true };
  assert.equal(A.checkpointVerdict(live).stop, false);
  const stalled = { ...live, attemptsAtLastCheckpoint: 5 };
  assert.equal(A.checkpointVerdict(stalled).stop, true);
  assert.equal(A.checkpointVerdict(stalled).dimension, "stalled");
  assert.equal(A.checkpointVerdict({ ...stalled, checkpointDue: false }).stop, false,
    "the stall test only applies on a checkpoint boundary");
});

test("a checkpoint stops a run over any ceiling, naming the dimension (AC-B1)", () => {
  const ceilings = { wallClockMs: 1000, toolCalls: 5, tokens: 100 };
  const base = { ceilings, elapsedMs: 0, tokens: 0, attemptsNow: 0, attemptsAtLastCheckpoint: 0, checkpointDue: false };
  assert.equal(A.checkpointVerdict({ ...base, elapsedMs: 1001 }).dimension, "wallClock");
  assert.equal(A.checkpointVerdict({ ...base, tokens: 101 }).dimension, "tokens");
  assert.equal(A.checkpointVerdict({ ...base, attemptsNow: 5 }).dimension, "toolCalls");
  assert.equal(A.checkpointVerdict(base).stop, false);
});

test("readAutonomyStrict: missing file is fresh, corrupt file THROWS (never fails open)", () => {
  fs.rmSync(L.autonomyFile(), { force: true });
  assert.equal(A.readAutonomyStrict().factor, 1);
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), "{ not json");
  assert.throws(() => A.readAutonomyStrict());
  fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor: 0.5, runsLeft: 3 }));
  assert.equal(A.readAutonomyStrict().factor, 0.5);
});
