// Autonomy that tightens itself. Two rules, both automatic and both logged:
//
//   1. Every run gets a ceiling on wall-clock, tool calls, and tokens.
//   2. When the recent record is bad, the ceilings shrink on their own, and
//      they restore on their own once it recovers. No human in either loop.
//
// A run counts against the record when its outcome is `rejected` or
// `aborted-by-budget`. `failed-to-start` is excluded on purpose: a smaller
// ceiling does not fix a harness that will not launch, and counting it would
// throttle the system for an infrastructure fault.
import fs from "node:fs";
import path from "node:path";
import { readRuns, autonomyFile, withLock, sleepSync } from "./ledger.mjs";
import { loadKernelPolicy } from "./policy.mjs";

const NOT_DELIVERED = new Set(["rejected", "aborted-by-budget"]);
const FRESH = { factor: 1, runsLeft: 0, log: [] };

export function readAutonomy() {
  try {
    return { ...FRESH, ...JSON.parse(fs.readFileSync(autonomyFile(), "utf8")) };
  } catch {
    return { ...FRESH, log: [] };
  }
}

// Strict read for ENFORCEMENT points (guardhook). ENOENT = fresh state (the
// first-run case). Anything else THROWS: an enforcement point that treats a
// corrupt state file as "no tightening" fails open, and readAutonomy's
// lenient fallback is exactly that. Reporting paths keep readAutonomy.
export function readAutonomyStrict() {
  let raw;
  try {
    raw = fs.readFileSync(autonomyFile(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { ...FRESH, log: [] };
    throw e;
  }
  return { ...FRESH, ...JSON.parse(raw) };
}

export function writeAutonomy(state) {
  fs.mkdirSync(path.dirname(autonomyFile()), { recursive: true });
  fs.writeFileSync(autonomyFile(), JSON.stringify(state, null, 2));
  return state;
}

export function effectiveCeilings(contract, policy, state = readAutonomy()) {
  const b = contract?.budget || {};
  const factor = state.factor ?? 1;
  const wallMin = Math.min(b.wallClockMin ?? policy.budget.wallClockMin, policy.hardCaps.wallClockMin);
  return {
    wallClockMs: Math.round(wallMin * 60000 * factor),
    toolCalls: Math.round((b.toolCalls ?? policy.budget.toolCalls) * factor),
    tokens: Math.round((b.tokens ?? policy.budget.tokens) * factor),
  };
}

function windowOutcomes(size) {
  const finals = readRuns().filter((r) => r.event === "run_finalized");
  return finals.slice(-size).map((r) => r.outcome);
}

// OI-019: readAutonomy() -> mutate -> writeAutonomy() is a read-modify-write
// with no synchronization, the same shape as the guardhook.mjs/ledger.mjs
// races found earlier this session. Nothing in this module (or run.mjs)
// guarantees only one kernel process is ever mid-run at once — that's an
// ADAPTER-level property of kernel/adapters/claude-code.mjs's lane, not a
// run.mjs/autonomy.mjs invariant, and this file's own header advertises
// "swapping harnesses is one value in policy.json plus one new file."
// Reproduced live: 15 concurrent callers against a state that should
// transition "tighten" exactly once produced 3-4 duplicate log entries, and
// in one run 4 processes each believed they logged a decision while only 3
// landed on disk — a genuine lost write, not just a duplicate decision.
// withLock("autonomy", ...) makes the whole read-decide-write sequence
// atomic, same primitive and same fix shape as the other two races.
//
// Call once after every finalized run.
export function updateAfterRun(policy = null) {
  return withLock("autonomy", () => {
    const cfg = (policy || loadKernelPolicy()).autonomy;
    const state = readAutonomy();
    // Test seam ONLY (default 0, a no-op): widens the read-to-write window on
    // demand so kernel/autonomy.test.mjs can force the interleaving this lock
    // guards against deterministically, instead of relying on a timing coin
    // flip — same pattern as ledger.mjs's ACC_LEDGER_APPEND_ONCE_DELAY_MS.
    const delay = Number(process.env.ACC_AUTONOMY_UPDATE_DELAY_MS) || 0;
    if (delay) sleepSync(delay);
    const window = windowOutcomes(cfg.window);
    const counted = window.filter((o) => o !== "failed-to-start");
    const bad = counted.filter((o) => NOT_DELIVERED.has(o)).length;
    const rate = counted.length ? bad / counted.length : 0;
    const log = (direction, reason) => {
      const entry = { at: new Date().toISOString(), direction, factor: state.factor, runsLeft: state.runsLeft, reason, window };
      state.log = [...(state.log || []), entry];
      writeAutonomy(state);
      return entry;
    };

    if (state.runsLeft > 0) {
      state.runsLeft -= 1;
      if (state.runsLeft === 0 && rate < cfg.rejectRate) {
        state.factor = 1;
        return { state, adjustment: log("restore", `recent record recovered (${bad}/${counted.length} not delivered, under the ${cfg.rejectRate} threshold)`) };
      }
      if (state.runsLeft === 0) {
        // Still bad when the tightened window elapsed: fall through so the
        // block below re-arms tightening instead of sticking at factor<1
        // forever with no further log entries.
      } else {
        writeAutonomy(state);
        return { state, adjustment: null };
      }
    }

    if (rate >= cfg.rejectRate && counted.length > 0) {
      state.factor = cfg.factor;
      state.runsLeft = cfg.runs;
      return { state, adjustment: log("tighten", `${bad}/${counted.length} recent runs did not deliver, at or over the ${cfg.rejectRate} threshold — ceilings x${cfg.factor} for the next ${cfg.runs} runs`) };
    }

    writeAutonomy(state);
    return { state, adjustment: null };
  });
}

// The automated milestone check. This is re-evaluation, never a human
// interrupt: it either lets the run continue or stops it, and says which
// dimension made the call.
export function checkpointVerdict({ elapsedMs, ceilings, tokens, attemptsNow, attemptsAtLastCheckpoint, checkpointDue }) {
  if (elapsedMs > ceilings.wallClockMs) return { stop: true, dimension: "wallClock", reason: `wall-clock ceiling ${Math.round(ceilings.wallClockMs / 60000)} min reached` };
  if (tokens > ceilings.tokens) return { stop: true, dimension: "tokens", reason: `token ceiling ${ceilings.tokens} reached` };
  if (attemptsNow >= ceilings.toolCalls) return { stop: true, dimension: "toolCalls", reason: `tool-call ceiling ${ceilings.toolCalls} reached` };
  if (checkpointDue && attemptsNow <= attemptsAtLastCheckpoint) {
    return { stop: true, dimension: "stalled", reason: "no tool call in a whole checkpoint interval" };
  }
  return { stop: false, dimension: null, reason: "" };
}
