#!/usr/bin/env node
// Agentic Command Center - context budget, waiting guard, subagent allowlist.
// One hook binary, dispatched by hook_event_name:
//   SessionStart     log start context, inject the budget line
//   UserPromptSubmit warn at softK
//   Stop             block ONCE at hardK to force a checkpoint; waiting guard
//   PreToolUse/Agent enforce the subagent allowlist and the kill switch
// Fails OPEN on any internal error: a broken budget hook must never wedge a
// session. Guard enforcement (guard.mjs) is the thing that fails closed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, contextOf, startContextOf, applyProfile, tierFor, tierWindowTotal } from "./usage.mjs";
import { bindSession, appendCycle, logTail, directiveForSession } from "./directive.mjs";
import { resolveRoot, readJson, readStdinJson, isMainModule } from "./root.mjs";
import { notify } from "./notify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ACC_ROOT redirects every runner/ path (state, logs, directives) at a
// throwaway tree. It exists so the tests can exercise THIS file instead of a
// copy, never the live state running sessions depend on.
const ROOT = () => resolveRoot(HERE);
const STATE = () => path.join(ROOT(), "runner", "state");
const LOGS = () => path.join(ROOT(), "runner", "logs");
const DIRECTIVESDIR = () => path.join(ROOT(), "runner", "directives");
const HEADLESS = () => process.env.CLAUDE_CODE_RUNNER === "1";

const K = (n) => Math.round(n / 1000) + "k";
const approaching = (ctx, hardK) =>
  `[ACC ctx ${K(ctx)}/${hardK}k] Approaching the context budget. Finish the unit of work you are on; do not start new work. Keep detail in scratchpad files, not in context.`;

const PROCESS_IO = {
  out: process.stdout.write.bind(process.stdout),
  err: process.stderr.write.bind(process.stderr),
  exit: process.exit.bind(process),
};

function ensureDirs() {
  for (const d of [STATE(), LOGS()]) fs.mkdirSync(d, { recursive: true });
}

function statePath(sid, suffix) {
  return path.join(STATE(), `${String(sid || "unknown").slice(0, 40)}.${suffix}`);
}


// ------------------------------------------------------------- hook output

// UserPromptSubmit / SessionStart: inject text into the session.
export function inject(event, text, io = PROCESS_IO) {
  io.out(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })
  );
  io.exit(0);
}

// Stop: force the model to keep going with an instruction.
export function blockStop(reason, io = PROCESS_IO) {
  io.out(JSON.stringify({ decision: "block", reason }));
  io.exit(0);
}

// PreToolUse: deny. exit 2 + stderr is the contract guard.mjs already uses.
export function deny(msg, io = PROCESS_IO) {
  io.err(msg);
  io.exit(2);
}

export const allow = (io = PROCESS_IO) => io.exit(0);

// ------------------------------------------------------------- kill switch

// Rolling-7-day tier without re-scanning every project on every hook fire:
// cached for 10 minutes in state/tier.json. The scan itself is usage.mjs's
// (bucket-cached, effectiveFrom-bounded — tierWindowTotal's comment explains
// why the window never reaches back past the day the discipline landed), so
// enforcement, the statusline, and the GUI all read ONE authority instead of
// the drift-prone copy that used to live here.
export function weekTier(policy, deps = {}) {
  const now = deps.now || Date.now;
  const tierForFn = deps.tierFor || tierFor;
  const tierWindowTotalFn = deps.tierWindowTotal || tierWindowTotal;
  const readJsonFn = deps.readJson || readJson;
  const writeFileSyncFn = deps.writeFileSync || fs.writeFileSync;
  if (!(policy.week.redTokens || 0) && !(policy.week.amberTokens || 0)) return { tier: "green", weekTokens: 0, pct: 0 };
  const cacheFile = path.join(STATE(), "tier.json");
  const cached = readJsonFn(cacheFile, null);
  if (cached && now() - cached.ts < 6e5) return cached;
  let out;
  try {
    out = { ...tierForFn(tierWindowTotalFn()), ts: now() };
  } catch {
    return { tier: "green", weekTokens: 0, pct: 0 };
  }
  try { writeFileSyncFn(cacheFile, JSON.stringify(out)); } catch {}
  return out;
}

function stopRunner(policy) {
  if (!policy.runner.stopOnRed) return;
  try {
    const stopDir = path.join(ROOT(), "runner", "stop");
    const stopFile = path.join(stopDir, "slice-runner.stop");
    // The stop-file's own prior absence IS the "haven't notified for this trip
    // yet" latch — no separate state needed. `unstop` removes it, so the next
    // red trip notifies again.
    const first = !fs.existsSync(stopFile);
    fs.mkdirSync(stopDir, { recursive: true });
    fs.writeFileSync(stopFile, `red tier ${new Date().toISOString()}\n`);
    if (first) notify("ACC kill switch", "Weekly spend hit the RED line — automated runs stopped.");
  } catch {}
}

// ------------------------------------------------------------- transcript

export function lastAssistantText(transcript) {
  let out = "";
  try {
    const lines = fs.readFileSync(transcript, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l || l.charCodeAt(0) !== 123) continue;
      let o;
      try {
        o = JSON.parse(l);
      } catch {
        continue;
      }
      if (o.type !== "assistant" || o.isSidechain || !o.message) continue;
      const c = o.message.content;
      if (Array.isArray(c)) out = c.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (out.trim()) return out;
    }
  } catch {}
  return out;
}

// ------------------------------------------------------------- handlers

// Bind this session to the directive that owns its console (or the one the Command
// Center launched it for) and hand the model everything it needs to carry on
// without a human retyping anything.
//
// THE LOOP ONLY ENDS BECAUSE THE MODEL ENDS IT. Nothing else can tell whether
// the work is finished, so the two exit commands are stated as the last thing in
// the block, in full, with the id already substituted - there is no id to look
// up and no ambiguity about what "done" means.
function directiveContext(p) {
  const directive = bindSession({
    sessionId: p.session_id,
    cwd: p.cwd,
    directiveId: process.env.ACC_DIRECTIVE || "",
  });
  if (!directive) return "";

  const cycle = Number(directive.cycles || 0);
  const head =
    cycle === 0
      ? `[ACC DIRECTIVE ${directive.id}] The Command Center started this session to do the following. Begin work on it now.`
      : `[ACC DIRECTIVE ${directive.id}] RESUMED - this is continuation ${cycle + 1}. The previous session hit the context budget and was cleared; you are the same work, not a new task. Pick up where the progress log stops.`;

  const parts = [head, "", directive.text, ""];
  if (typeof directive.doneWhen === "string" && directive.doneWhen.trim()) {
    parts.push(`[ACC DIRECTIVE ${directive.id}] Done when: ${directive.doneWhen}`, "");
  }
  if (directive.cwd) parts.push(`Working folder: ${directive.cwd}`);
  if (cycle > 0) {
    parts.push(
      "",
      `Progress so far (from ${path.join(DIRECTIVESDIR(), directive.id + ".log.md")}, most recent last):`,
      "",
      logTail(directive.id, 3000).trim()
    );
  }
  parts.push(
    "",
    `[ACC DIRECTIVE] How this ends. When the budget is reached you will be told to checkpoint; do that and stop. The Command Center's headless runner resumes this directive with your progress log (node ${path.join(ROOT(), "runner", "runner.mjs")} directive:${directive.id}) — do NOT stop early, do NOT ask whether to continue, and do NOT treat a stop as the end of the work.`,
    `  - finished, everything verified:  node ${path.join(ROOT(), "hooks", "directive.mjs")} done ${directive.id}`,
    `  - genuinely blocked on a human:   node ${path.join(ROOT(), "hooks", "directive.mjs")} blocked ${directive.id} --why "<one line>"`,
    `Until one of those runs, the directive stays active and resumable.`
  );
  return parts.join("\n");
}

export function onSessionStart(p, policy, io = PROCESS_IO) {
  ensureDirs();
  const start = p.transcript_path ? startContextOf(p.transcript_path) : 0;
  try {
    fs.appendFileSync(
      path.join(LOGS(), "context.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        sessionId: p.session_id,
        startContext: start,
        headless: HEADLESS(),
        cwd: p.cwd,
      }) + "\n"
    );
  } catch {}
  // Record the status file's mtime so the Stop waiting-guard can tell whether
  // this run actually checkpointed.
  try {
    const sf = path.join(p.cwd || process.cwd(), policy.runner.statusFile);
    fs.writeFileSync(statePath(p.session_id, "start"), JSON.stringify({ mtime: fs.statSync(sf).mtimeMs, sf }));
  } catch {}

  // Warm the tier cache so the status line shows "wk %" from the first prompt
  // of a session, not only after the first UserPromptSubmit refresh.
  try { weekTier(policy); } catch {}

  const { hardK, softK } = policy.context;
  const lines = [];
  if (policy.activeProfile) {
    lines.push(
      `[ACC] Profile: ${policy.activeProfile} (launched from the Command Center). Its helper limits apply to this session; the context budget comes from the Command Center dials.`
    );
  }
  // A directive is what makes this session a continuation rather than a fresh
  // start. It is bound by ACC_DIRECTIVE, so this fires identically on the
  // launch and on every fresh runner cycle. Failing here costs auto-resume
  // and nothing else - hooks fail open.
  try {
    const directive = directiveContext(p);
    if (directive) lines.push(directive);
  } catch {}

  lines.push(
    ...[
    `[ACC] Context budget: soft ${softK}k, hard ${hardK}k. Context is checked after EVERY tool call; past ${hardK}k you will be told to checkpoint and end the turn, and the Stop hook enforces it.`,
    `[ACC] Helper limits: allowed types ${JSON.stringify(policy.subagents.allow)}; session cap ${policy.subagents.maxPerSession}; temporary fan-out cap ${policy.review.maxFinders}.`,
    ]
  );
  inject("SessionStart", lines.join("\n"), io);
}

export function onUserPromptSubmit(p, policy, io = PROCESS_IO) {
  // Keep state/tier.json warm for the status line. weekTier() is otherwise only
  // called on the subagent-spawn path, and subagents are allowlisted down to
  // Explore - so the cache was almost never written and the status line silently
  // dropped its "wk %" segment. Must run BEFORE the early allow() below, which
  // exits the process. The 10-minute cache means the real scan runs at most once
  // per 10 min, not once per prompt.
  try { weekTier(policy); } catch {}
  if (!p.transcript_path) allow(io);
  const ctx = contextOf(p.transcript_path);
  const { softK, hardK } = policy.context;
  if (ctx < softK * 1000) allow(io);
  inject("UserPromptSubmit", approaching(ctx, hardK), io);
}

// The continuous watcher. Stop only fires at turn boundaries and
// UserPromptSubmit only when the operator types, so a long autonomous stretch
// (tool call after tool call, no turn end) can sail far past the ceiling with
// nothing checking - exactly how a session reached 178k against an 80k budget.
// PostToolUse fires on EVERY tool call, so this is the only event that tracks
// context continuously.
//
// It never blocks. Blocking here would also block the Write that the checkpoint
// needs, wedging the session at precisely the moment it must save its work.
// Pressure is applied as injected text; the Stop hook still does the hard halt.
export function onPostToolUse(p, policy, io = PROCESS_IO) {
  if (!p.transcript_path) allow(io);
  const ctx = contextOf(p.transcript_path);
  const { softK, hardK } = policy.context;
  if (ctx < softK * 1000) allow(io);

  const over = ctx >= hardK * 1000;
  if (!over) {
    // Below the ceiling: warn once per 10k band so this stays cheap.
    const band = Math.floor(ctx / 10000);
    const f = statePath(p.session_id, "band");
    if (Number(readJson(f, { band: 0 }).band || 0) >= band) allow(io);
    try {
      ensureDirs();
      fs.writeFileSync(f, JSON.stringify({ band }));
    } catch {}
    inject("PostToolUse", approaching(ctx, hardK), io);
  }

  // Over the ceiling: every tool call, until the session ends. ~40 tokens each
  // is the correct price for not silently running to 3x budget.
  inject(
    "PostToolUse",
    `[ACC ctx ${K(ctx)}/${hardK}k] OVER BUDGET. Stop starting new work NOW. ` +
      `Finish only what makes this session droppable: checkpoint ${policy.runner.statusFile} ` +
      `(board + RESUME, written so a COLD session resumes from that file alone), move long detail to a ` +
      `scratchpad and cite its path, then END YOUR TURN so the session can be cleared. ` +
      `Do not begin another task, review, or investigation.`,
    io
  );
}

const WAITING_RE =
  /\b(waiting (on|for)|i'?ll resume when|once it'?s green|once ci|when the .{0,40} completes?|waiting for its completion|will resume)\b/i;

export function onStop(p, policy, io = PROCESS_IO) {
  ensureDirs();

  // --- waiting guard (headless only: nothing re-invokes a -p session) ---
  // stop_hook_active means a Stop hook (this one or another) already blocked
  // this turn once; the guard must not re-block its own continuation.
  if (HEADLESS() && policy.runner.waitingGuard && !p.stop_hook_active) {
    const latch = statePath(p.session_id, "waiting");
    if (!fs.existsSync(latch)) {
      const text = lastAssistantText(p.transcript_path);
      if (WAITING_RE.test(text)) {
        const st = readJson(statePath(p.session_id, "start"), null);
        let checkpointed = false;
        try {
          if (st && st.sf) checkpointed = fs.statSync(st.sf).mtimeMs > st.mtime;
        } catch {}
        if (!checkpointed) {
          try {
            fs.writeFileSync(latch, "1");
          } catch {}
          blockStop(
            "Nothing re-invokes a headless (-p) session. You cannot wait for CI, a background suite, or any external event -- " +
              "ending the turn here burns the run with no board progress (this cost runs 8, 10 and 12 of the 2026-07-30 queue). " +
              "Do ONE of these now: (a) poll in the FOREGROUND with an explicit timeout and finish the work, or " +
              "(b) checkpoint the status file (board + RESUME, so a cold session resumes from it alone) and then end.",
            io
          );
        }
      }
    }
  }

  // --- context budget ---
  if (!p.transcript_path) allow(io);
  const ctx = contextOf(p.transcript_path);
  const { hardK } = policy.context;
  if (ctx < hardK * 1000) allow(io);

  const latch = statePath(p.session_id, "budget");
  if (!fs.existsSync(latch)) {
    try {
      fs.writeFileSync(latch, String(ctx));
    } catch {}
    blockStop(
      `[ACC] CONTEXT BUDGET REACHED - ${K(ctx)} of ${hardK}k. Start NO new work. ` +
        `Finish only what is needed to make this session droppable, then: ` +
        `(1) checkpoint the status file (${policy.runner.statusFile}) - board + RESUME, written so a COLD session resumes from that file alone; ` +
        `(2) move any long detail into a scratchpad file and cite its path; ` +
        `(3) state in one line where you are and what the next action is. Then stop.`,
      io
    );
  }

  // Latched: the checkpoint turn is done. Budget WINS from here (OI-011): a
  // /directive Stop hook may keep blocking the turn, so this path must fire on
  // every Stop until the clear actually lands - stop_hook_active no longer
  // short-circuits it. appendCycle is one-shot so blocked loops don't spam.
  if (HEADLESS()) allow(io); // the runner relaunch IS the clear

  // If a directive owns this session, its closing summary IS the handoff to the next
  // continuation. Captured automatically from the checkpoint turn the block above
  // just forced, so the model carries no extra burden and cannot forget to do it.
  let directive = null;
  try {
    directive = directiveForSession(p.session_id);
    const cycled = statePath(p.session_id, "cycled");
    if (directive && !fs.existsSync(cycled)) {
      appendCycle(directive.id, { sessionId: p.session_id, ctx, text: lastAssistantText(p.transcript_path) });
      fs.writeFileSync(cycled, "1");
    }
  } catch {}

  // Interactive: hooks cannot clear context, and nothing types keystrokes for
  // us anymore (SPEC-0005 PR-2) - tell the human exactly what to do, and name
  // the headless resume path that carries the work forward.
  io.out(
    JSON.stringify({
      systemMessage:
        `\n[ACC ctx ${K(ctx)}/${hardK}k] BUDGET REACHED - checkpoint written.\n` +
        `\n    >>> TYPE /clear NOW <<<\n\n` +
        (directive
          ? `  Directive ${directive.id} is active - cycle logged. Resume it headless:\n` +
            `    node ${path.join(ROOT(), "runner", "runner.mjs")} directive:${directive.id}\n` +
            `  (or the Command Center Start-work page: http://127.0.0.1:43117/guards)\n`
          : `  The next session re-primes itself from ${policy.runner.statusFile}.\n`),
    })
  );
  io.exit(0);
}

export function onPreToolUseAgent(p, policy, io = PROCESS_IO) {
  const input = p.tool_input || {};
  const type = input.subagent_type || "general-purpose";

  // Kill switch.
  const { tier, weekTokens } = weekTier(policy);
  if (tier === "red") {
    stopRunner(policy);
    deny(
      `[ACC KILL SWITCH] Rolling 7-day usage is at the RED line (${Math.round(weekTokens / 1e6)}M tokens). ` +
        `Subagent spawns are blocked and the runner is stopped. Main-thread work continues normally. ` +
        `Clear it in the Command Center GUI (Process tab) or raise week.redTokens in ${path.join(ROOT(), "policy.json")}.`,
      io
    );
  }

  // Explicit time-boxed fan-out grant (GUI / engine.mjs fanout <minutes>).
  const grant = readJson(path.join(STATE(), "fanout.json"), null);
  const granted = grant && grant.until > Date.now();

  if (!granted && policy.subagents.mode === "allowlist" && !policy.subagents.allow.includes(type)) {
    deny(
      `[ACC] Subagent type "${type}" is not on the allowlist (${policy.subagents.allow.join(", ")}).\n` +
        `Adjust the allowed helper types in the Command Center, or grant a time-boxed window with ` +
        `\`node ${path.join(ROOT(), "hooks", "budget.mjs")} fanout 30\` or the Command Center Process tab.`,
      io
    );
  }

  // Per-session spawn cap.
  const cnt = statePath(p.session_id, "agents");
  const n = Number(readJson(cnt, { n: 0 }).n || 0) + 1;
  const cap = granted ? policy.review.maxFinders : policy.subagents.maxPerSession;
  if (n > cap) {
    deny(
      `[ACC] Subagent cap reached for this session (${cap}). ` +
        `${granted ? "The temporary fan-out cap was reached." : "Adjust the limit or start a fresh session."}`,
      io
    );
  }
  try {
    ensureDirs();
    fs.writeFileSync(cnt, JSON.stringify({ n }));
  } catch {}
  allow(io);
}

// ------------------------------------------------------------- entry

// applyProfile lives in usage.mjs so budget.mjs and statusline.mjs resolve
// policy identically - the budget on screen is the budget enforced.
export function main({ argv = process.argv.slice(2), policy = applyProfile(loadPolicy()), payload = readStdinJson(), io = PROCESS_IO } = {}) {

  // CLI helpers (not hook paths).
  if (argv[0] === "fanout") {
    ensureDirs();
    const mins = Number(argv[1] || 30);
    fs.writeFileSync(
      path.join(STATE(), "fanout.json"),
      JSON.stringify({ until: Date.now() + mins * 60000, granted: new Date().toISOString() })
    );
    console.log(`fan-out granted for ${mins} min (max ${policy.review.maxFinders} finders)`);
    return;
  }
  if (argv[0] === "unstop") {
    try {
      fs.unlinkSync(path.join(ROOT(), "runner", "stop", "slice-runner.stop"));
    } catch {}
    try {
      fs.unlinkSync(path.join(STATE(), "tier.json"));
    } catch {}
    console.log("runner stop-file cleared, tier cache flushed");
    return;
  }

  const event = payload.hook_event_name || "";
  if (event === "SessionStart") return onSessionStart(payload, policy, io);
  if (event === "UserPromptSubmit") return onUserPromptSubmit(payload, policy, io);
  if (event === "PostToolUse") return onPostToolUse(payload, policy, io);
  if (event === "Stop") return onStop(payload, policy, io);
  if (event === "PreToolUse") {
    if ((payload.tool_name || "") !== "Agent") allow(io);
    return onPreToolUseAgent(payload, policy, io);
  }
  allow(io);
}

function appendBudgetError(line) {
  fs.appendFileSync(path.join(LOGS(), "budget-errors.log"), line);
}

export function runAsMain(opts = {}) {
  const run = opts.run || main;
  const exit = opts.exit || process.exit.bind(process);
  const appendError = opts.appendError || appendBudgetError;
  try {
    run();
  } catch (e) {
    // Fail open, but leave a trace.
    try {
      ensureDirs();
      appendError(`${new Date().toISOString()} ${e && e.stack}\n`);
    } catch {}
    exit(0);
  }
}

if (isMainModule(import.meta.url)) runAsMain();
