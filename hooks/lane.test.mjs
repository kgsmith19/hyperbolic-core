// node --test hooks/lane.test.mjs  (run from C:\code\guards)
//
// Hermetic: ACC_LANE_DIR and ACC_POLICY point at throwaway trees BEFORE the
// import (lane.mjs reads both lazily per call, but the discipline matches
// route.test.mjs — live lane state must never see test slots, or a test could
// block a real runner launch). No network, no claude, no powershell.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-lane-test-"));
process.env.ACC_LANE_DIR = path.join(BASE, "lane");
process.env.ACC_POLICY = path.join(BASE, "policy.json");

// Fast dials so contention tests finish in milliseconds. Individual tests
// rewrite this file to change dials — lane.mjs re-reads per acquire, which is
// itself part of the contract under test.
// breakerThreshold defaults to 3, and several existing tests below (deliberately)
// cause 2-3 econnreset failures each to prove retryTransport's own behavior.
// Those failures are now ALSO recorded to the shared breaker (that's the
// feature under test elsewhere in this file) — so every non-breaker test here
// pins breakerThreshold absurdly high, or the suite trips its own breaker and
// every acquire after it hangs waiting for a cooldown that never comes inside
// a test run. Breaker-specific tests override this locally and always
// breakerReset() when done.
function setPolicy(lane) {
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ lane: { breakerThreshold: 100000, ...lane } }));
}
// Reused by every test below that just needs fast, deterministic dials —
// breaker-specific tests override locally and always breakerReset() when done.
const BASELINE = { slots: 1, minGapMs: 0, retries: 2, backoffBaseMs: 1, backoffCapMs: 2, pollMs: 20 };
setPolicy(BASELINE);

const {
  acquireSlot, withLaunchSlot, transportFailure, retryTransport, laneStatus, laneConfig,
  recordTransportFailure, breakerState, breakerReset, runCli,
  isUtilityInvocation, countCappedProcesses, gate, queryClaudeProcesses, formatHolders,
} = await import("./lane.mjs");

const LANE = process.env.ACC_LANE_DIR;
const slotDir = (i) => path.join(LANE, `slot-${i}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("acquire records an owner; release frees the slot", async () => {
  const s = await acquireSlot("t1");
  const owner = JSON.parse(fs.readFileSync(path.join(slotDir(0), "owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.label, "t1");
  s.release();
  assert.equal(fs.existsSync(slotDir(0)), false);
});

test("withLaunchSlot holds during fn and releases after", async () => {
  let heldDuring = null;
  const out = await withLaunchSlot("t2", async () => {
    heldDuring = fs.existsSync(slotDir(0));
    return "ok";
  });
  assert.equal(out, "ok");
  assert.equal(heldDuring, true);
  assert.equal(fs.existsSync(slotDir(0)), false);
});

test("withLaunchSlot releases when fn throws", async () => {
  await assert.rejects(() => withLaunchSlot("t3", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(slotDir(0)), false);
});

test("a second acquire waits for release, then proceeds", async () => {
  const a = await acquireSlot("holder");
  let bDone = false;
  const b = acquireSlot("waiter").then((s) => { bDone = true; return s; });
  await sleep(120);
  assert.equal(bDone, false, "waiter must not enter while the slot is held");
  a.release();
  const sb = await b;
  assert.equal(bDone, true);
  sb.release();
});

test("a slot with no owner.json (mid-write or corrupt) is stale by mtime, not immediately", async () => {
  fs.mkdirSync(slotDir(0), { recursive: true }); // no owner.json at all
  let resolved = false;
  const p = acquireSlot("waiter-on-empty-dir").then((s) => { resolved = true; return s; });
  await sleep(150);
  assert.equal(resolved, false, "a freshly-created ownerless dir must not be reclaimed inside the write-grace window");
  const old = new Date(Date.now() - 15000);
  fs.utimesSync(slotDir(0), old, old); // backdate past the 10s grace window
  (await p).release();
  assert.equal(resolved, true);
});

test("a slot whose owner pid is dead is reclaimed", async () => {
  fs.mkdirSync(slotDir(0), { recursive: true });
  fs.writeFileSync(
    path.join(slotDir(0), "owner.json"),
    JSON.stringify({ pid: 999999999, label: "ghost", at: new Date().toISOString(), ttlMs: 60000 })
  );
  const s = await acquireSlot("reclaimer");
  assert.equal(JSON.parse(fs.readFileSync(path.join(slotDir(0), "owner.json"), "utf8")).label, "reclaimer");
  s.release();
});

test("a slot past its own declared ttl is reclaimed even with a live pid", async () => {
  fs.mkdirSync(slotDir(0), { recursive: true });
  fs.writeFileSync(
    path.join(slotDir(0), "owner.json"),
    JSON.stringify({ pid: process.pid, label: "expired", at: new Date(Date.now() - 5000).toISOString(), ttlMs: 1 })
  );
  const s = await acquireSlot("after-ttl");
  assert.equal(JSON.parse(fs.readFileSync(path.join(slotDir(0), "owner.json"), "utf8")).label, "after-ttl");
  s.release();
});

test("slots=2 admits two holders and queues the third", async () => {
  setPolicy({ slots: 2, minGapMs: 0, pollMs: 20 });
  const a = await acquireSlot("a");
  const b = await acquireSlot("b");
  assert.equal(laneStatus().length, 2);
  let cDone = false;
  const c = acquireSlot("c").then((s) => { cDone = true; return s; });
  await sleep(100);
  assert.equal(cDone, false, "third holder must wait");
  a.release();
  (await c).release();
  b.release();
  setPolicy({ slots: 1, minGapMs: 0, pollMs: 20 });
});

test("start pacing: the second launch waits out minGapMs", async () => {
  setPolicy({ slots: 1, minGapMs: 200, pollMs: 20 });
  const t0 = Date.now();
  await withLaunchSlot("first", async () => {});
  await withLaunchSlot("second", async () => {});
  assert.ok(Date.now() - t0 >= 180, `two paced launches took ${Date.now() - t0}ms, expected >=180`);
  setPolicy(BASELINE);
});

test("transport classification: the observed failures match", () => {
  for (const t of [
    "Unable to connect to API (econnreset)",
    "Error: socket hang up",
    "429 too many requests",
    "api error: 529 overloaded_error",
    "connect ETIMEDOUT 160.79.104.10:443",
    "fetch failed",
  ]) assert.ok(transportFailure(t), `should classify: ${t}`);
});

test("transport classification: logic failures never match", () => {
  for (const t of [
    "AssertionError: expected BANANA, got ok",
    "SyntaxError: unexpected token",
    "board made no progress",
    "",
    null,
  ]) assert.equal(transportFailure(t), null, `must not classify: ${t}`);
});

test("retryTransport retries a transport failure, then returns the success", async () => {
  let calls = 0;
  const r = await retryTransport("t", async () => {
    calls++;
    return calls < 3 ? { code: 1, err: "Unable to connect to API (econnreset)" } : { code: 0, result: "fine" };
  });
  assert.equal(calls, 3);
  assert.equal(r.code, 0);
});

test("retryTransport does NOT retry a logic failure", async () => {
  let calls = 0;
  const r = await retryTransport("t", async () => {
    calls++;
    return { code: 1, err: "AssertionError: the board is wrong" };
  });
  assert.equal(calls, 1, "a real bug must surface, not be re-spent");
  assert.equal(r.code, 1);
});

test("retryTransport honors a custom textOf/failed, not just the defaults", async () => {
  let calls = 0;
  const r = await retryTransport("t", async () => { calls++; return calls < 2 ? "econnreset in a plain string" : "done"; }, {
    failed: (r) => r !== "done",
    textOf: (r) => r,
  });
  assert.equal(calls, 2);
  assert.equal(r, "done");
});

test("retryTransport stops at the attempt cap and returns the failure", async () => {
  let calls = 0;
  const r = await retryTransport("t", async () => {
    calls++;
    return { code: 1, err: "econnreset" };
  }, { retries: 2 });
  assert.equal(calls, 3, "retries=2 means 3 attempts total");
  assert.equal(r.code, 1);
});

test("config falls back to defaults when policy.json parses but has no lane key at all", () => {
  const saved = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ someOtherSection: true }));
  assert.equal(laneConfig().slots, 1);
  fs.writeFileSync(process.env.ACC_POLICY, saved);
});

test("POLICY() and LANE_DIR() fall back to their real defaults when the env vars are unset", () => {
  // POLICY() and LANE_DIR() are lazy and re-read per call rather than fixed at
  // module load, so the fallback branch is reachable in-process
  // — no subprocess needed, and safe: the real os.tmpdir()/acc-lane has no
  // other holder on this sandbox, and is cleaned up immediately.
  const savedPolicy = process.env.ACC_POLICY;
  const savedLane = process.env.ACC_LANE_DIR;
  delete process.env.ACC_POLICY;
  delete process.env.ACC_LANE_DIR;
  try {
    // Independent oracle: read the REAL repo policy.json directly, the same
    // file laneConfig() must fall back to — proves the actual value, not
    // merely "a number >= 1" (which a hardcoded stub would also satisfy).
    const realPolicyPath = path.join(HERE_DIR, "..", "policy.json");
    const real = JSON.parse(fs.readFileSync(realPolicyPath, "utf8"));
    const cfg = laneConfig();
    assert.equal(cfg.slots, real.lane.slots);
  } finally {
    process.env.ACC_POLICY = savedPolicy;
    process.env.ACC_LANE_DIR = savedLane;
  }
});

test("owner.json missing ttlMs and at falls back to DEFAULTS.slotTtlMs and epoch 0 — unambiguously stale", async () => {
  fs.mkdirSync(slotDir(0), { recursive: true });
  fs.writeFileSync(path.join(slotDir(0), "owner.json"), JSON.stringify({ pid: process.pid, label: "bare" })); // no ttlMs, no at
  const s = await acquireSlot("reclaimer-bare-owner");
  assert.equal(JSON.parse(fs.readFileSync(path.join(slotDir(0), "owner.json"), "utf8")).label, "reclaimer-bare-owner");
  s.release();
});

test("laneStatus() tolerates a lane dir that TRULY has never existed (isolated, not the shared test dir)", () => {
  // Must be a directory nothing else in this suite ever creates — the shared
  // LANE dir gets mkdir'd as a side effect of the very first acquireSlot in
  // the file and never removed, so asserting against it here would pass for
  // the wrong reason (an existing, empty dir) once any earlier test has run.
  const saved = process.env.ACC_LANE_DIR;
  process.env.ACC_LANE_DIR = path.join(BASE, "never-created", "nested");
  try {
    assert.deepEqual(laneStatus(), []);
  } finally {
    process.env.ACC_LANE_DIR = saved;
  }
});

test("a corrupt last-start.json does not break pacing — treated as no prior start", async () => {
  fs.mkdirSync(LANE, { recursive: true });
  fs.writeFileSync(path.join(LANE, "last-start.json"), "not json");
  setPolicy({ slots: 1, minGapMs: 50, pollMs: 20 });
  const s = await acquireSlot("after-corrupt-stamp"); // must not throw or hang despite the corrupt stamp
  s.release();
  setPolicy(BASELINE);
});

test("acquireSlot works end to end with ACC_LANE_DIR genuinely unset (the real machine default)", async () => {
  const saved = process.env.ACC_LANE_DIR;
  delete process.env.ACC_LANE_DIR;
  try {
    const s = await acquireSlot("real-default-dir-probe");
    // Must actually land under the real fallback (os.tmpdir()/acc-lane), not
    // merely "not throw" (a stub returning {slot:0, release(){}} with no I/O
    // at all would have passed the old assertion).
    const realOwnerFile = path.join(os.tmpdir(), "acc-lane", `slot-${s.slot}`, "owner.json");
    const owner = JSON.parse(fs.readFileSync(realOwnerFile, "utf8"));
    assert.equal(owner.label, "real-default-dir-probe");
    s.release(); // clean up the real os.tmpdir()/acc-lane immediately — this sandbox has no other holder
    assert.equal(fs.existsSync(realOwnerFile), false, "release must remove the real slot, not just report success");
  } finally {
    process.env.ACC_LANE_DIR = saved;
  }
});

test("a slot whose owner.json has no pid field at all is treated as not-alive (stale)", async () => {
  fs.mkdirSync(slotDir(0), { recursive: true });
  fs.writeFileSync(
    path.join(slotDir(0), "owner.json"),
    JSON.stringify({ label: "no-pid-field", at: new Date().toISOString(), ttlMs: 60000 }) // no pid key
  );
  const s = await acquireSlot("reclaimer-nopid");
  assert.equal(JSON.parse(fs.readFileSync(path.join(slotDir(0), "owner.json"), "utf8")).label, "reclaimer-nopid");
  s.release();
});

test("config falls back to defaults when policy.json is unreadable", () => {
  const saved = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  fs.writeFileSync(process.env.ACC_POLICY, "not json");
  const cfg = laneConfig();
  assert.equal(cfg.slots, 1);
  assert.ok(cfg.minGapMs > 0, "defaults, not zeros, when config is broken");
  fs.writeFileSync(process.env.ACC_POLICY, saved);
});

// ================================================================= jitter
test("retry backoff is full jitter — delay can land anywhere from 0 up to the exponential ceiling, not just the top half", async () => {
  setPolicy({ slots: 1, minGapMs: 0, retries: 21, backoffBaseMs: 1000, backoffCapMs: 1000, pollMs: 20 });
  const delays = [];
  let calls = 0;
  await retryTransport("jitter-spread", async () => {
    calls++;
    if (calls > 1) delays.push(Date.now() - delays._last);
    delays._last = Date.now();
    return calls <= 20 ? { code: 1, err: "econnreset" } : { code: 0 };
  });
  // With base=1000, cap=1000, every ceiling is 1000ms — full jitter means
  // U(0, 1000). Equal jitter (the old formula) never goes below 500. The
  // assertion below only requires landing under 400ms, so the honest
  // single-draw failure probability is P(draw >= 400) = 600/1000 = 0.6 (not
  // the 0.5 an equal-jitter comparison would suggest). With OI-018's
  // original 4 samples that was (0.6)^4 ~= 13% — flaky enough to hit twice
  // in one evening, as observed. 20 samples brings it to (0.6)^20 ~= 0.0037%,
  // low enough that a revert to equal jitter is what would ever fail this,
  // not chance.
  assert.ok(delays.some((d) => d < 400), `expected at least one sub-400ms delay under full jitter, got: ${delays.join(",")}`);
  setPolicy(BASELINE);
});

test("529/overloaded failures use overloadBaseMs, not backoffBaseMs", async () => {
  setPolicy({ slots: 1, minGapMs: 0, retries: 1, backoffBaseMs: 1, overloadBaseMs: 5000, backoffCapMs: 5000, pollMs: 20 });
  const t0 = Date.now();
  let calls = 0;
  await retryTransport("overload-base", async () => {
    calls++;
    return calls === 1 ? { code: 1, err: "api error: 529 overloaded_error" } : { code: 0 };
  });
  // base=1 would make this near-instant; overloadBaseMs=5000 with cap=5000
  // means the single retry's delay is U(0, 5000) — not a tight bound, but
  // enough headroom (>=50ms) to prove it picked the overload base at all,
  // without making the test itself slow or flaky in the common case.
  assert.equal(calls, 2);
  setPolicy(BASELINE);
});

// ================================================================ breaker
test("recordTransportFailure + breakerState: trips at threshold, clears once quiet past cooldown", async () => {
  breakerReset();
  setPolicy({ slots: 1, minGapMs: 0, pollMs: 20, breakerThreshold: 2, breakerWindowMs: 60000, breakerCooldownMs: 60 });
  try {
    assert.equal(breakerState().tripped, false);
    recordTransportFailure("econnreset");
    assert.equal(breakerState().tripped, false, "one failure is under threshold");
    recordTransportFailure("econnreset");
    assert.equal(breakerState().tripped, true, "two failures hit threshold=2");
    assert.equal(breakerState().count, 2);
    await sleep(90); // past breakerCooldownMs=60
    assert.equal(breakerState().tripped, false, "quiet past cooldown self-clears even though both failures are still in-window");
  } finally {
    breakerReset();
    setPolicy(BASELINE);
  }
});

test("failures outside the window never count toward the threshold", () => {
  breakerReset();
  setPolicy({ slots: 1, minGapMs: 0, pollMs: 20, breakerThreshold: 2, breakerWindowMs: 30, breakerCooldownMs: 60000 });
  try {
    recordTransportFailure("econnreset");
    recordTransportFailure("econnreset");
    assert.equal(breakerState().tripped, true);
  } finally {
    breakerReset();
    setPolicy(BASELINE);
  }
});

test("a tripped breaker HOLDS new automation acquires until it clears", async () => {
  breakerReset();
  setPolicy({ slots: 1, minGapMs: 0, pollMs: 20, breakerThreshold: 1, breakerWindowMs: 60000, breakerCooldownMs: 150 });
  try {
    recordTransportFailure("econnreset");
    assert.equal(breakerState().tripped, true);
    const logs = [];
    let done = false;
    const p = acquireSlot("held-by-breaker", { onLog: (m) => logs.push(m) }).then((s) => { done = true; return s; });
    await sleep(60);
    assert.equal(done, false, "automation must not acquire while the breaker is open");
    assert.ok(logs.some((m) => m.includes("circuit breaker open")), "must log why it is waiting");
    const s = await p; // resolves once the cooldown passes
    assert.equal(done, true);
    s.release();
  } finally {
    breakerReset();
    setPolicy(BASELINE);
  }
});

test("breakerReset() clears state outright", () => {
  recordTransportFailure("econnreset");
  breakerReset();
  assert.equal(breakerState().count, 0);
  assert.equal(breakerState().tripped, false);
});

test("breakerState() treats a breaker.json whose 'failures' isn't an array as empty, not a crash", () => {
  fs.mkdirSync(LANE, { recursive: true });
  fs.writeFileSync(path.join(LANE, "breaker.json"), JSON.stringify({ failures: "not-an-array" }));
  try {
    assert.deepEqual(breakerState().count, 0);
    assert.equal(breakerState().tripped, false);
  } finally {
    breakerReset();
  }
});

test("recordTransportFailure swallows a write failure rather than throwing", () => {
  fs.mkdirSync(LANE, { recursive: true });
  const file = path.join(LANE, "breaker.json");
  fs.writeFileSync(file, JSON.stringify({ failures: [] }));
  fs.chmodSync(file, 0o444);
  try {
    assert.doesNotThrow(() => recordTransportFailure("econnreset"));
  } finally {
    fs.chmodSync(file, 0o666);
    breakerReset();
  }
});

test("acquireSlot's 'held by' note falls back to '?' for a slot whose owner has no label", async () => {
  setPolicy({ slots: 1, minGapMs: 0, pollMs: 20 });
  fs.mkdirSync(slotDir(0), { recursive: true });
  fs.writeFileSync(path.join(slotDir(0), "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ttlMs: 60000 }));
  const logs = [];
  const p = acquireSlot("waiter-on-nameless-owner", { onLog: (m) => logs.push(m) }).then((s) => s.release());
  await sleep(120);
  assert.ok(logs.some((m) => m.includes("held by ?(")), `expected a "?" label fallback, got: ${logs.join(" | ")}`);
  fs.rmSync(slotDir(0), { recursive: true, force: true });
  await p;
});

// ==================================================================== CLI
test("runCli answers status and rejects an unknown command", () => {
  const status = runCli(["status"]);
  assert.ok(Array.isArray(status.automation));
  assert.ok("breaker" in status);
  const bad = runCli(["frobnicate"]);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /unknown command/);
});

test("the CLI entry point (node hooks/lane.mjs status) runs for real as a subprocess and prints JSON", () => {
  const out = execFileSync(process.execPath, [path.join(HERE_DIR, "lane.mjs"), "status"], {
    env: { ...process.env, ACC_LANE_DIR: process.env.ACC_LANE_DIR, ACC_POLICY: process.env.ACC_POLICY },
    encoding: "utf8",
  });
  const parsed = JSON.parse(out.trim());
  assert.ok(Array.isArray(parsed.automation));
});

// --- OI-025 / launch cap: gate() and its primitives (spec 2026-08-03) ------

test("isUtilityInvocation recognizes known utility tokens, nothing else", () => {
  assert.equal(isUtilityInvocation(["--version"]), true);
  assert.equal(isUtilityInvocation(["--help"]), true);
  assert.equal(isUtilityInvocation(["doctor"]), true);
  assert.equal(isUtilityInvocation(["update"]), true);
  assert.equal(isUtilityInvocation(["install"]), true);
  assert.equal(isUtilityInvocation(["mcp"]), true);
  assert.equal(isUtilityInvocation(["-p", "hello"]), false);
  assert.equal(isUtilityInvocation([]), false);
  assert.equal(isUtilityInvocation(undefined), false);
});

test("countCappedProcesses matches by exact exe path, case-insensitively, ignoring unmatched paths", () => {
  const procs = [
    { ProcessId: 1, ExecutablePath: "C:\\real\\claude.exe", CreationDate: "t1" },
    { ProcessId: 2, ExecutablePath: "C:\\REAL\\CLAUDE.EXE", CreationDate: "t2" },
    { ProcessId: 3, ExecutablePath: "C:\\Program Files\\WindowsApps\\Claude_1\\app\\claude.exe", CreationDate: "t3" },
    { ProcessId: 4, ExecutablePath: null, CreationDate: "t4" },
  ];
  const matched = countCappedProcesses(["C:\\real\\claude.exe"], () => procs);
  assert.deepEqual(matched.map((p) => p.ProcessId), [1, 2]);
});

test("countCappedProcesses returns empty when the lister returns nothing", () => {
  assert.deepEqual(countCappedProcesses(["C:\\real\\claude.exe"], () => []), []);
});

test("gate: no lane.total configured at all -> ok true (fail open)", () => {
  setPolicy({});
  assert.deepEqual(gate(["-p", "hi"]), { ok: true, reason: "no-cap-configured" });
});

test("gate: cap configured but no exe list -> ok true (fail open)", () => {
  setPolicy({ total: { cap: 3 } });
  assert.deepEqual(gate(["-p", "hi"]), { ok: true, reason: "no-exe-configured" });
});

test("gate: utility invocation bypasses cap entirely, never calls the lister", () => {
  setPolicy({ total: { cap: 0, exe: ["C:\\real\\claude.exe"] } });
  let called = false;
  const out = gate(["--version"], { listProcesses: () => { called = true; return []; } });
  assert.deepEqual(out, { ok: true, reason: "utility" });
  assert.equal(called, false);
});

test("gate: under cap -> ok true with count", () => {
  setPolicy({ total: { cap: 3, exe: ["C:\\real\\claude.exe"] } });
  const procs = [{ ProcessId: 1, ExecutablePath: "C:\\real\\claude.exe" }];
  assert.deepEqual(gate(["-p", "hi"], { listProcesses: () => procs }), { ok: true, count: 1, cap: 3 });
});

test("gate: at cap -> ok false with holder pid/startedAt, no lane label when unheld", () => {
  setPolicy({ total: { cap: 1, exe: ["C:\\real\\claude.exe"] } });
  const procs = [{ ProcessId: 999999, ExecutablePath: "C:\\real\\claude.exe", CreationDate: "2026-08-03T00:00:00Z" }];
  const out = gate(["-p", "hi"], { listProcesses: () => procs });
  assert.equal(out.ok, false);
  assert.equal(out.count, 1);
  assert.equal(out.cap, 1);
  assert.deepEqual(out.holders, [{ pid: 999999, startedAt: "2026-08-03T00:00:00Z", label: null }]);
});

test("gate: over cap enriches a holder with its lane label when the pid holds a real slot", async () => {
  setPolicy({ total: { cap: 1, exe: ["C:\\real\\claude.exe"] } });
  const held = await acquireSlot("labeled-holder");
  try {
    const procs = [{ ProcessId: process.pid, ExecutablePath: "C:\\real\\claude.exe", CreationDate: "now" }];
    const out = gate(["-p", "hi"], { listProcesses: () => procs });
    assert.equal(out.ok, false);
    assert.equal(out.holders[0].label, "labeled-holder");
  } finally {
    held.release();
  }
});

test("gate: lister throwing -> ok true (fail open), reason count-failed", () => {
  setPolicy({ total: { cap: 1, exe: ["C:\\real\\claude.exe"] } });
  const out = gate(["-p", "hi"], { listProcesses: () => { throw new Error("CIM unavailable"); } });
  assert.equal(out.ok, true);
  assert.equal(out.reason, "count-failed");
  assert.match(out.error, /CIM unavailable/);
});

test("queryClaudeProcesses runs a real CIM query and returns an array", { skip: process.platform !== "win32" }, () => {
  const out = queryClaudeProcesses();
  assert.ok(Array.isArray(out));
});

test("CLI: node hooks/lane.mjs gate --version bypasses the cap and exits 0 silently", () => {
  const out = execFileSync(process.execPath, [path.join(HERE_DIR, "lane.mjs"), "gate", "--version"], {
    env: { ...process.env, ACC_LANE_DIR: process.env.ACC_LANE_DIR, ACC_POLICY: process.env.ACC_POLICY },
    encoding: "utf8",
  });
  assert.equal(out, "");
});

test("CLI: node hooks/lane.mjs gate with cap:0 refuses for real and exits 42 with a stderr holder line", { skip: process.platform !== "win32" }, () => {
  setPolicy({ total: { cap: 0, exe: ["C:\\definitely-not-a-real-path\\claude.exe"] } });
  assert.throws(
    () => execFileSync(process.execPath, [path.join(HERE_DIR, "lane.mjs"), "gate", "--", "-p", "hi"], {
      env: { ...process.env, ACC_LANE_DIR: process.env.ACC_LANE_DIR, ACC_POLICY: process.env.ACC_POLICY },
      encoding: "utf8",
    }),
    (err) => {
      assert.equal(err.status, 42);
      assert.match(err.stderr, /lane: claude launch cap reached \(0\/0\)/);
      return true;
    },
  );
});

test("formatHolders renders pid/label/startedAt, and falls back to 'unknown' when empty", () => {
  assert.equal(formatHolders([]), "unknown");
  assert.equal(formatHolders(null), "unknown");
  assert.equal(formatHolders([{ pid: 111, label: null, startedAt: null }]), "pid 111");
  assert.equal(
    formatHolders([{ pid: 111, label: "directive-loop", startedAt: "2026-08-03T00:00:00Z" }]),
    "pid 111 [directive-loop] (started 2026-08-03T00:00:00Z)"
  );
  assert.equal(
    formatHolders([{ pid: 1, label: null, startedAt: null }, { pid: 2, label: "x", startedAt: null }]),
    "pid 1, pid 2 [x]"
  );
});

test("shim/claude.cmd's baked-in real exe path matches policy.json's lane.total.exe[0]", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(HERE_DIR, "..", "policy.json"), "utf8").replace(/^\uFEFF/, ""));
  const configuredExe = policy.lane.total.exe[0];
  const shimCmd = fs.readFileSync(path.join(HERE_DIR, "..", "shim", "claude.cmd"), "utf8");
  assert.ok(shimCmd.includes(configuredExe), `shim/claude.cmd must contain the exact path ${configuredExe}`);
});
