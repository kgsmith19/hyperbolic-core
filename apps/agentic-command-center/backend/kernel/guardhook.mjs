#!/usr/bin/env node
// The kernel's PreToolUse hook. Registered ONLY in a run's generated settings,
// so nothing about interactive sessions changes.
//
// Exit 0 = allow, exit 2 = deny with the reason on stderr — the convention
// hooks/guard.mjs already uses, and the one Claude Code feeds back to the
// model. Every path that cannot read what it needs DENIES (AC-G11): a guard
// that fails open is not a guard.
//
// Everything is re-read on every fire (contract, pin, policy) because that is
// what makes a live GUI edit apply to the next tool call (AC-G9/AC-U2) and a
// mid-run settings tamper deny everything (AC-G6).
import fs from "node:fs";
import path from "node:path";
import { decide } from "./guard.mjs";
import { verifySettingsPin } from "./settings.mjs";
import { loadKernelPolicy, alwaysDenyWriteRoots } from "./policy.mjs";
import { appendDecision, withDecisionLock } from "./ledger.mjs";
import { effectiveCeilings, readAutonomyStrict } from "./autonomy.mjs";

function deny(reason, runId, record) {
  if (runId && record) {
    try { appendDecision(runId, record); } catch { /* the denial still stands */ }
  }
  console.error(`kernel-guard: ${reason}`);
  process.exit(2);
}

// readFileSync(0) returns empty on Windows pipes — the same trap hooks/guard.mjs
// documents. Read asynchronously with a cap so a never-closing pipe cannot hold
// the tool call open until the hook timeout. The cap is env-overridable so a
// test can prove the timeout path fires without a real multi-second wait.
const STDIN_TIMEOUT_MS = Number(process.env.ACC_GUARDHOOK_STDIN_TIMEOUT_MS) || 4000;
// OI-028: a time cap alone bounds how LONG a hook fire can be held open, not
// how MUCH a misbehaving harness can make it buffer in that window (e.g. a
// Write/Edit call with a huge new_string) — unbounded growth is a memory-
// exhaustion vector on the hook process. 8MB is generous for any real tool
// payload (Claude Code's own hook payloads are tool params, not file
// contents wholesale) while still bounding worst case; env-overridable so a
// test can prove the deny path without allocating 8MB for real.
const STDIN_MAX_BYTES = Number(process.env.ACC_GUARDHOOK_STDIN_MAX_BYTES) || 8 * 1024 * 1024;
let stdinOversized = false;
const raw = await new Promise((resolve) => {
  let buf = "";
  const timer = setTimeout(() => resolve(buf), STDIN_TIMEOUT_MS);
  // "end" and "error" resolve identically (whatever is buffered so far) — one
  // shared handler, not two, because an unhandled stream "error" would
  // otherwise crash the process instead of failing closed via deny() below.
  const finish = () => { clearTimeout(timer); resolve(buf); };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    if (stdinOversized) return; // already deciding to deny; stop accumulating
    buf += c;
    if (buf.length > STDIN_MAX_BYTES) { stdinOversized = true; finish(); }
  });
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
});
if (stdinOversized) {
  deny(`hook payload exceeded ${STDIN_MAX_BYTES} bytes — failing closed`);
}

const dir = process.env.ACC_KERNEL_DIR;
if (!dir) deny("no ACC_KERNEL_DIR in the environment — refusing to allow an unguarded call");

let pin;
try {
  pin = JSON.parse(fs.readFileSync(path.join(dir, "pin.json"), "utf8"));
} catch (e) {
  deny(`cannot read the run pin (${e.message}) — failing closed`);
}

const integrity = verifySettingsPin(dir);
if (!integrity.ok) {
  deny(
    `settings integrity check FAILED (expected ${integrity.expected}, got ${integrity.actual}) — denying every action for run ${pin.runId}`,
    pin.runId,
    { tool: null, allow: false, rule: "integrity", reason: "generated settings changed mid-run", target: null, flagged: true }
  );
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  deny(`no readable hook payload on stdin (${raw.length} bytes) — failing closed`, pin.runId, {
    tool: null, allow: false, rule: "payload", reason: "unreadable stdin payload", target: null,
  });
}

let contract, policy;
try {
  contract = JSON.parse(fs.readFileSync(path.join(dir, "contract.json"), "utf8"));
  policy = loadKernelPolicy();
} catch (e) {
  deny(`cannot read the contract or kernel policy (${e.message}) — failing closed`, pin.runId, {
    tool: payload?.tool_name ?? null, allow: false, rule: "config", reason: "unreadable contract or policy", target: null,
  });
}

let autonomy;
try {
  autonomy = readAutonomyStrict();
} catch (e) {
  deny(`cannot read autonomy state (${e.message}) — failing closed`, pin.runId, {
    tool: payload?.tool_name ?? null, allow: false, rule: "config", reason: "unreadable autonomy state", target: null,
  });
}
// The SAME function the supervisor uses (run.mjs) — the two enforcement
// points cannot drift, and tightening applies on the very next fire (OI-024).
const ceiling = effectiveCeilings(contract, policy, autonomy).toolCalls;
if (!Number.isFinite(ceiling)) {
  deny(`no finite toolCalls ceiling from contract/policy (got ${ceiling}) — failing closed`, pin.runId, {
    tool: payload?.tool_name ?? null, allow: false, rule: "config", reason: "non-finite toolCalls ceiling", target: null,
  });
}

// The read of prior attempts, the ceiling decision, and the append of THIS
// decision must happen as one atomic unit (OI-019) — otherwise concurrent
// fires from a single parallel-tool-call turn can all read the same
// "attempts so far" and all pass a ceiling meant to allow only one more.
let d;
try {
  d = withDecisionLock(pin.runId, (attempts) => {
    // Attempts, not just successes: a harness looping on denied calls is
    // burning a real budget and must hit the same ceiling.
    const verdict = decide(payload, {
      contract, policy, attempts, ceiling,
      denyRoots: alwaysDenyWriteRoots(),
      stagingDir: dir,
    });
    appendDecision(pin.runId, {
      tool: verdict.tool, allow: verdict.allow, rule: verdict.rule, reason: verdict.reason, target: verdict.target,
      ceiling, autonomyFactor: autonomy.factor ?? 1,
    });
    return verdict;
  });
} catch (e) {
  // A decision that cannot be recorded (or a lock that can never be
  // acquired) is a decision that cannot be audited.
  deny(`cannot write the decision log (${e.message}) — failing closed`);
}

if (!d.allow) {
  console.error(`kernel-guard: ${d.reason} [${d.rule}]`);
  process.exit(2);
}
process.exit(0);
