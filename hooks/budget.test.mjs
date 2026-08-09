// Tests for the Stop-gate precedence in hooks/budget.mjs (OI-011) and the
// SessionStart directive injection, post keystroke-stack retirement
// (SPEC-0005 PR-2).
//
// The OI-011 bug being pinned, reworded for the headless era: onStop
// early-allowed whenever stop_hook_active was set, so after the forced
// checkpoint turn the latched path (hand-off message + directive cycle) never
// ran — a /directive Stop hook that kept blocking pinned the session over the
// ceiling forever. Once the budget latch exists, budget must win on EVERY
// stop. What the latched path DOES changed with SPEC-0005 PR-2: no clear
// request, no clearbot — the message tells the human to /clear and names the
// exact headless resume command instead.
//
// Most cases call budget.mjs by direct import (main() + injected IO), so
// covgate can see coverage in this file. A small subprocess group remains to
// prove the real wrapper contract end-to-end (stdio + exit code). Policy comes
// from a sandbox file via ACC_POLICY so live dial edits can never change what
// these tests mean.
//
// Run: node --test hooks/budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as runBudgetMain, weekTier, lastAssistantText, runAsMain } from "./budget.mjs";
import { applyProfile } from "./usage.mjs";
// directive.mjs resolves its store from ACC_ROOT/ACC_DIRECTIVES_DIR on every call, not
// at import time (see hooks/directive.mjs), specifically so a single shared import
// works across many tests each pointed at their own sandbox -- important here
// beyond just tidiness: when covgate.mjs runs this file in the same node
// process as directive.test.mjs, a second, differently-parameterized import of
// directive.mjs would collide with directive.test.mjs's own coverage instance (node's
// lcov merge is last-write-wins per file path, not a union -- see OI-006).
import * as gm from "./directive.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "budget.mjs");

// Every execFileSync("node", [HOOK], ...) below spawns a SEPARATE budget.mjs
// process per test (dozens of them) with an env spread that would otherwise
// carry a live NODE_V8_COVERAGE straight through: --experimental-test-
// coverage auto-sets it on whichever process enables it first, and under
// `node hooks/covgate.mjs` that's the real, shared coverage run this file is
// part of. budget.mjs is not itself a gated file this session, so none of
// these dozens of incidental coverage dumps are wanted — left unfixed, their
// sheer volume in the shared directory measurably degraded an UNRELATED
// gated file's (hooks/lane.mjs) own merged branch coverage (found
// 2026-08-02: lane.mjs measured 91%+ branches in isolation, 87.9% once this
// file's subprocess spawns joined the same run — deterministic, reproduced
// with --test-concurrency=1, so not a race).
delete process.env.NODE_V8_COVERAGE;

// Small dials keep the fixture transcripts tiny. Shape mirrors the live
// policy.json (post-SPEC-0005: no autoClear/directives blocks; the checkpoint
// board is the cwd-relative .acc/BOARD.md).
const POLICY = {
  context: { softK: 40, hardK: 50 },
  week: { amberTokens: 0, redTokens: 0, effectiveFrom: "" },
  subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 6, exploreMaxReportLines: 80 },
  review: { fullLeanReview: "manual-only", maxFinders: 3 },
  runner: { stopOnRed: true, statusFile: ".acc/BOARD.md", waitingGuard: true },
};

// Real Claude Code session ids are UUIDs, and OI-006's bindSession guard now
// rejects anything else as a rebind source, so tests that seed a directive via
// bindSession (and later look it up by that exact sessionId) need one.
const SID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function sandbox(policyExtra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-budget-"));
  fs.mkdirSync(path.join(root, "runner", "state"), { recursive: true });
  fs.mkdirSync(path.join(root, "cfg"), { recursive: true });
  const policyPath = path.join(root, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({ ...POLICY, ...(policyExtra || {}) }));
  return { root, policyPath };
}

// One assistant turn in transcript shape. contextOf() reads input + cache_read
// + cache_creation of the LAST assistant line.
function turn(ctxTokens, text) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-31T12:00:00.000Z",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: ctxTokens,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text }],
    },
  });
}

function writeTranscript(sb, sid, ctxTokens) {
  const f = path.join(sb.root, `${sid}.jsonl`);
  fs.writeFileSync(f, turn(ctxTokens, "checkpoint written, board updated") + "\n");
  return f;
}

function runHookRaw(sb, input, envExtra = {}, argv = []) {
  const env = {
    ACC_ROOT: sb.root,
    ACC_POLICY: sb.policyPath,
    ACC_DIRECTIVES_DIR: "",
    ACC_PROFILE: "",
    ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
    CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"),
    CLAUDE_CODE_RUNNER: "",
    ACC_DIRECTIVE: "",
    ...envExtra,
  };
  const old = {};
  for (const [k, v] of Object.entries(env)) {
    old[k] = process.env[k];
    process.env[k] = String(v);
  }
  const policy = applyProfile(JSON.parse(fs.readFileSync(sb.policyPath, "utf8")));
  let out = "";
  let err = "";
  let code = null;
  const io = {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    exit: (c) => { code = c; throw new Error(`__exit__${c}`); },
  };
  try {
    try {
      runBudgetMain({ argv, payload: input, io, policy });
    } catch (e) {
      if (!String(e && e.message || "").startsWith("__exit__")) throw e;
    }
  } finally {
    for (const k of Object.keys(env)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
  return { out, err, code };
}

function runHook(sb, input, envExtra = {}, argv = []) {
  const r = runHookRaw(sb, input, envExtra, argv);
  assert.equal(r.code, 0, r.err || "budget hook did not exit cleanly");
  return r.out;
}

function runHookSubprocess(sb, input, envExtra = {}) {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify(input),
    env: {
      ...process.env,
      ACC_ROOT: sb.root,
      ACC_POLICY: sb.policyPath,
      ACC_DIRECTIVES_DIR: "",
      ACC_PROFILE: "",
      ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
      CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"),
      CLAUDE_CODE_RUNNER: "",
      ACC_DIRECTIVE: "",
      ...envExtra,
    },
    encoding: "utf8",
  });
}

function runStop(sb, { sid, transcript, active, profile }) {
  return runHook(
    sb,
    { hook_event_name: "Stop", session_id: sid, transcript_path: transcript, stop_hook_active: !!active, cwd: sb.root },
    { ACC_PROFILE: profile || "" }
  );
}

function runPrompt(sb, { sid, transcript, profile }) {
  return runHook(
    sb,
    { hook_event_name: "UserPromptSubmit", session_id: sid, transcript_path: transcript, cwd: sb.root },
    { ACC_PROFILE: profile || "" }
  );
}

function runPostTool(sb, { sid, transcript, profile }) {
  return runHook(
    sb,
    { hook_event_name: "PostToolUse", session_id: sid, transcript_path: transcript, cwd: sb.root },
    { ACC_PROFILE: profile || "" }
  );
}

const statePath = (sb, sid, suffix) => path.join(sb.root, "runner", "state", `${sid}.${suffix}`);
// The clear-request channel is DEAD (SPEC-0005 PR-2): nothing may ever write
// into it again, whatever the stop's state. Missing dir = trivially empty.
const clearRequests = (sb) => {
  try { return fs.readdirSync(path.join(sb.root, "runner", "clear-requests")); } catch { return []; }
};

// Seed a directive in the sandbox and bind this session to it, as SessionStart
// does (by explicit id — the console-pid thread of continuity is gone).
function seedDirective(sb, sid) {
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_DIRECTIVES_DIR = "";
  const g = gm.createDirective({ text: "keep going", cwd: sb.root });
  gm.bindSession({ sessionId: sid, directiveId: g.id });
  return gm.readDirective(g.id);
}

test("over hard, no latch: blocks once to force the checkpoint, naming the board file", () => {
  const sb = sandbox();
  const sid = "s-first";
  const t = writeTranscript(sb, sid, 60000);
  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.match(out, /"decision":"block"/);
  assert.match(out, /\.acc\/BOARD\.md/, "the checkpoint instruction names the statusFile dial");
  assert.ok(fs.existsSync(statePath(sb, sid, "budget")), "budget latch written");
  assert.equal(clearRequests(sb).length, 0);
});

test("latched + stop_hook_active: the hand-off still fires — manual /clear, no clear request, no clearbot (OI-011 reworded)", () => {
  const sb = sandbox();
  const sid = "s-latched";
  const t = writeTranscript(sb, sid, 60000);
  runStop(sb, { sid, transcript: t, active: false }); // block + latch
  const out = runStop(sb, { sid, transcript: t, active: true });
  assert.match(out, /systemMessage/, "hand-off message reaches the operator despite stop_hook_active");
  assert.match(out, />>> TYPE \/clear NOW <<</);
  assert.doesNotMatch(out, /auto-clear|clearbot/i, "the keystroke chain is gone — no auto-clear promise, no watcher hints");
  assert.equal(clearRequests(sb).length, 0, "the clear-request channel is dead");
});

test("latched with an active directive: the message names the exact headless resume command; the cycle is one-shot", () => {
  const sb = sandbox();
  const sid = SID(1);
  const g = seedDirective(sb, sid);
  const t = writeTranscript(sb, sid, 60000);

  runStop(sb, { sid, transcript: t, active: false }); // block + latch
  const out1 = runStop(sb, { sid, transcript: t, active: true }); // latched stop 1
  assert.match(out1, new RegExp(`runner\\.mjs directive:${g.id}`), "the resume path is the headless runner, spelled out");
  const out2 = runStop(sb, { sid, transcript: t, active: true }); // latched stop 2 (stuck turn)
  assert.match(out2, /systemMessage/);
  assert.equal(gm.readDirective(g.id).cycles, 1, "cycle logged exactly once across latched stops");
  assert.equal(clearRequests(sb).length, 0, "no clear-request entry ever appears");
});

test("latched without a directive: the message names the board re-prime path and drops the dead CLI hints", () => {
  const sb = sandbox();
  const sid = "s-noboard";
  const t = writeTranscript(sb, sid, 60000);
  runStop(sb, { sid, transcript: t, active: false });
  const out = runStop(sb, { sid, transcript: t, active: true });
  assert.match(out, /\.acc\/BOARD\.md/, "a directive-less session re-primes from the board file");
  assert.doesNotMatch(out, /clearbot-status|usage\.mjs clears/, "hints to deleted CLI verbs must not survive");
});

test("under hard: stop passes silently", () => {
  const sb = sandbox();
  const sid = "s-under";
  const t = writeTranscript(sb, sid, 10000);
  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.equal(out.trim(), "");
});

test("under budget with an active directive: plain allow — no store mutation, no output (the kick re-arm died with clearbot)", () => {
  const sb = sandbox();
  const sid = SID(2);
  const before = seedDirective(sb, sid);
  const t = writeTranscript(sb, sid, 10000);
  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.equal(out.trim(), "", "still silent");
  assert.deepEqual(gm.readDirective(before.id), before,
    "an under-budget turn end must not touch the directive store — the headless runner owns continuation now");
});

// Single source of truth (2026-07-31): the Command Center dials are the budget
// for every session. A profile may scope subagents but must not shadow the dials.
test("profile without a context block: the base dials still govern", () => {
  const sb = sandbox({
    profiles: { Normal: { subagents: { allow: ["Explore"], maxPerSession: 6 } } },
  });
  const sid = "s-prof-nocontext";
  const t = writeTranscript(sb, sid, 60000); // over base hardK 50
  const out = runStop(sb, { sid, transcript: t, active: false, profile: "Normal" });
  assert.match(out, /"decision":"block"/, "base hardK enforced despite ACC_PROFILE");
});

test("profile context (when present) still overrides for that session", () => {
  const sb = sandbox({
    profiles: { Big: { context: { softK: 70, hardK: 80 } } },
  });
  const sid = "s-prof-context";
  const t = writeTranscript(sb, sid, 60000); // over base 50, under profile 80
  const out = runStop(sb, { sid, transcript: t, active: false, profile: "Big" });
  assert.equal(out.trim(), "", "profile hardK 80 applied, 60k passes");
});

// --- SessionStart, post keystroke-retirement -------------------------------
// The window-capture / clearbot machinery is gone: a session binds its
// directive by ACC_DIRECTIVE alone, and no watcher warning can ever fire.

function runSessionStart(sb, sid, envExtra) {
  return runHook(sb, { hook_event_name: "SessionStart", session_id: sid, cwd: sb.root }, envExtra);
}

test("SessionStart with ACC_DIRECTIVE binds by id and injects the directive with the headless resume framing", () => {
  const sb = sandbox();
  const sid = SID(3);
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_DIRECTIVES_DIR = "";
  const g = gm.createDirective({ text: "do the long thing", cwd: sb.root });
  // A stale-looking watcher heartbeat must be MEANINGLESS now — the warning
  // path died with clearbot.
  fs.mkdirSync(path.join(sb.root, "watcher"), { recursive: true });
  fs.writeFileSync(path.join(sb.root, "watcher", "clearbot.heartbeat"), "old");
  const past = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(sb.root, "watcher", "clearbot.heartbeat"), past, past);

  const out = runSessionStart(sb, sid, { ACC_DIRECTIVE: g.id });
  assert.match(out, /\[ACC DIRECTIVE/, "the directive context is injected");
  assert.match(out, /runner\.mjs directive:/, "the how-this-ends block names the headless resume, not an auto-clear promise");
  assert.doesNotMatch(out, /clearbot|watcher|start-clearbot|resumes you automatically/i);
  assert.equal(gm.readDirective(g.id).sessionId, sid, "bound by ACC_DIRECTIVE alone");
  assert.ok(!fs.existsSync(statePath(sb, sid, "window")), "no window record is ever captured");
});

test("SessionStart without ACC_DIRECTIVE injects the budget lines only — no window machinery, no warnings", () => {
  const sb = sandbox();
  const sid = "s-plain-start";
  const out = runSessionStart(sb, sid, {});
  assert.match(out, /Context budget: soft 40k, hard 50k/);
  assert.doesNotMatch(out, /clearbot|watcher/i);
  assert.ok(!fs.existsSync(statePath(sb, sid, "window")));
});

test("SessionStart includes profile framing when active", () => {
  const sb = sandbox({
    profiles: { Normal: { subagents: { allow: ["Explore"], maxPerSession: 6 } } },
  });
  const sid = "s-profile-start";
  const out = runSessionStart(sb, sid, { ACC_PROFILE: "Normal" });
  assert.match(out, /\[ACC\] Profile: Normal/);
});

test("SessionStart resumed directive includes progress-tail framing", () => {
  const sb = sandbox();
  const sid = SID(9);
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_DIRECTIVES_DIR = "";
  const g = gm.createDirective({ text: "resume me", cwd: sb.root });
  gm.appendCycle(g.id, { sessionId: sid, ctx: 50000, text: "cycle-1" });
  const out = runSessionStart(sb, sid, { ACC_DIRECTIVE: g.id });
  assert.match(out, /RESUMED - this is continuation 2/);
  assert.match(out, /Progress so far/);
});

test("SessionStart includes doneWhen distinctly when the directive has one", () => {
  const sb = sandbox();
  const sid = SID(10);
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_DIRECTIVES_DIR = "";
  const g = gm.createDirective({ text: "resume me", doneWhen: "all acceptance tests are green" });
  const out = runSessionStart(sb, sid, { ACC_DIRECTIVE: g.id });
  assert.match(out, /\[ACC DIRECTIVE\] Done when: all acceptance tests are green/);
});

test("SessionStart stays safe for legacy directives that omit doneWhen", () => {
  const sb = sandbox();
  const sid = SID(11);
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_DIRECTIVES_DIR = "";
  const g = gm.createDirective({ text: "resume me", doneWhen: "temporary value" });
  const p = path.join(sb.root, "runner", "directives", `${g.id}.json`);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  delete raw.doneWhen;
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
  const out = runSessionStart(sb, sid, { ACC_DIRECTIVE: g.id });
  assert.match(out, /\[ACC DIRECTIVE/);
  assert.doesNotMatch(out, /\[ACC DIRECTIVE\] Done when:/);
});

test("UserPromptSubmit warns at or above softK", () => {
  const sb = sandbox();
  const sid = "s-prompt-warn";
  const t = writeTranscript(sb, sid, 40000);
  const out = runPrompt(sb, { sid, transcript: t });
  assert.match(out, /Approaching the context budget/);
});

test("PostToolUse warns once per band and escalates over hardK", () => {
  const sb = sandbox();
  const sid = "s-posttool";
  const under = writeTranscript(sb, sid, 45000);
  const warn1 = runPostTool(sb, { sid, transcript: under });
  assert.match(warn1, /Approaching the context budget/);
  const warn2 = runPostTool(sb, { sid, transcript: under });
  assert.equal(warn2.trim(), "", "same band is suppressed");
  const over = writeTranscript(sb, sid, 70000);
  const out = runPostTool(sb, { sid, transcript: over });
  assert.match(out, /OVER BUDGET/);
});

test("headless waiting-guard blocks a waiting stop before checkpoint", () => {
  const sb = sandbox();
  const sid = "s-waiting";
  const t = path.join(sb.root, `${sid}.jsonl`);
  fs.writeFileSync(
    t,
    turn(10000, "I will resume when CI is green") + "\n"
  );
  const board = path.join(sb.root, ".acc", "BOARD.md");
  fs.mkdirSync(path.dirname(board), { recursive: true });
  fs.writeFileSync(board, "board");
  fs.writeFileSync(statePath(sb, sid, "start"), JSON.stringify({ mtime: Number.MAX_SAFE_INTEGER, sf: board }));
  const out = runHook(
    sb,
    { hook_event_name: "Stop", session_id: sid, transcript_path: t, stop_hook_active: false, cwd: sb.root },
    { CLAUDE_CODE_RUNNER: "1" }
  );
  assert.match(out, /Nothing re-invokes a headless \(-p\) session/);
});

test("PreToolUse Agent path enforces allowlist, cap, and red-tier kill switch", () => {
  const sb = sandbox({
    week: { amberTokens: 1, redTokens: 2, effectiveFrom: "" },
    subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 1, exploreMaxReportLines: 80 },
  });
  fs.mkdirSync(path.join(sb.root, "runner", "state"), { recursive: true });
  const tierFile = path.join(sb.root, "runner", "state", "tier.json");
  fs.writeFileSync(tierFile, JSON.stringify({ tier: "green", weekTokens: 0, ts: Date.now() }));
  const denyPayload = { hook_event_name: "PreToolUse", session_id: "s-agent-deny", tool_name: "Agent", tool_input: { subagent_type: "task" } };
  const allowPayload = { hook_event_name: "PreToolUse", session_id: "s-agent-cap", tool_name: "Agent", tool_input: { subagent_type: "Explore" } };

  let r = runHookRaw(sb, denyPayload);
  assert.equal(r.code, 2);
  assert.match(r.err, /not on the allowlist/);

  r = runHookRaw(sb, allowPayload);
  assert.equal(r.code, 0);
  r = runHookRaw(sb, allowPayload);
  assert.equal(r.code, 2);
  assert.match(r.err, /Subagent cap reached/);

  fs.writeFileSync(tierFile, JSON.stringify({ tier: "red", weekTokens: 3_000_000, ts: Date.now() }));
  r = runHookRaw(sb, allowPayload);
  assert.equal(r.code, 2);
  assert.match(r.err, /KILL SWITCH/);
  assert.ok(fs.existsSync(path.join(sb.root, "runner", "stop", "slice-runner.stop")));
});

test("main CLI fanout/unstop helpers mutate state files", () => {
  const sb = sandbox();
  const stopDir = path.join(sb.root, "runner", "stop");
  fs.mkdirSync(stopDir, { recursive: true });
  fs.writeFileSync(path.join(stopDir, "slice-runner.stop"), "x");
  fs.mkdirSync(path.join(sb.root, "runner", "state"), { recursive: true });
  fs.writeFileSync(path.join(sb.root, "runner", "state", "tier.json"), "{}");

  const fanout = runHookRaw(sb, {}, {}, ["fanout", "5"]);
  assert.equal(fanout.code, null, "CLI helper returns without exit()");
  assert.ok(fs.existsSync(path.join(sb.root, "runner", "state", "fanout.json")));

  const unstop = runHookRaw(sb, {}, {}, ["unstop"]);
  assert.equal(unstop.code, null, "CLI helper returns without exit()");
  assert.ok(!fs.existsSync(path.join(sb.root, "runner", "stop", "slice-runner.stop")));
  assert.ok(!fs.existsSync(path.join(sb.root, "runner", "state", "tier.json")));
});

test("main allow paths: unknown events and non-Agent PreToolUse fall through to allow", () => {
  const sb = sandbox();
  const unknown = runHookRaw(sb, { hook_event_name: "SomethingElse", session_id: "s-unknown" });
  assert.equal(unknown.code, 0);
  const nonAgent = runHookRaw(sb, { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s-nonagent" });
  assert.equal(nonAgent.code, 0);
});

test("weekTier populates cache and lastAssistantText tolerates malformed lines", () => {
  const sb = sandbox({ week: { amberTokens: 1, redTokens: 2, effectiveFrom: "" } });
  const oldRoot = process.env.ACC_ROOT;
  process.env.ACC_ROOT = sb.root;
  try {
    const tier = weekTier({ week: { amberTokens: 1, redTokens: 2 } });
    assert.equal(typeof tier.tier, "string");
    assert.ok(fs.existsSync(path.join(sb.root, "runner", "state", "tier.json")));
    const transcript = path.join(sb.root, "bad.jsonl");
    fs.writeFileSync(transcript, "{\"oops\"\n" + turn(10000, "") + "\n");
    assert.equal(lastAssistantText(transcript), "");
    const fallback = weekTier(
      { week: { amberTokens: 1, redTokens: 2 } },
      { readJson: () => null, tierFor: () => { throw new Error("no scan"); }, tierWindowTotal: () => ({}) }
    );
    assert.equal(fallback.tier, "green");
    const noWrite = weekTier(
      { week: { amberTokens: 1, redTokens: 2 } },
      {
        readJson: () => null,
        tierFor: () => ({ tier: "amber", weekTokens: 12, pct: 50 }),
        tierWindowTotal: () => ({}),
        writeFileSync: () => { throw new Error("disk"); },
      }
    );
    assert.equal(noWrite.tier, "amber");
  } finally {
    if (oldRoot === undefined) delete process.env.ACC_ROOT;
    else process.env.ACC_ROOT = oldRoot;
  }
});

test("runAsMain fail-open path logs and exits 0", () => {
  const sb = sandbox();
  const oldRoot = process.env.ACC_ROOT;
  process.env.ACC_ROOT = sb.root;
  let exited = null;
  try {
    runAsMain({
      run: () => { throw new Error("boom"); },
      exit: (code) => { exited = code; },
    });
    assert.equal(exited, 0);
    const log = fs.readFileSync(path.join(sb.root, "runner", "logs", "budget-errors.log"), "utf8");
    assert.match(log, /boom/);
  } finally {
    if (oldRoot === undefined) delete process.env.ACC_ROOT;
    else process.env.ACC_ROOT = oldRoot;
  }
});

test("subprocess wrapper still emits Stop block payload end-to-end", () => {
  const sb = sandbox();
  const sid = "s-wrapper-stop";
  const t = writeTranscript(sb, sid, 60000);
  const out = runHookSubprocess(
    sb,
    { hook_event_name: "Stop", session_id: sid, transcript_path: t, stop_hook_active: false, cwd: sb.root }
  );
  assert.match(out, /"decision":"block"/);
});

test("subprocess wrapper still returns exit 2 for denied Agent spawns", () => {
  const sb = sandbox();
  assert.throws(
    () =>
      runHookSubprocess(sb, {
        hook_event_name: "PreToolUse",
        session_id: "s-wrapper-pretool",
        tool_name: "Agent",
        tool_input: { subagent_type: "task" },
      }),
    /Subagent type "task" is not on the allowlist/
  );
});
