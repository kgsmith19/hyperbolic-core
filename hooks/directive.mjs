#!/usr/bin/env node
// Agentic Command Center - the DIRECTIVE store. This is what makes ACC able to
// carry a piece of work across context resets instead of losing it.
//
// THE PROBLEM IT SOLVES: a long task outruns one context window. The directive
// lives in a FILE, not in context: the headless runner (runner/runner.mjs)
// relaunches `claude -p` per cycle with ACC_DIRECTIVE=<id>, budget.mjs's
// SessionStart hook injects the text + progress log into each fresh session,
// and the Stop hook appends the closing summary as the next cycle's handoff.
// The loop ends only when the model itself runs `done`/`blocked` (or a human
// closes it from the Command Center's Start-work page).
//
// THE THREAD OF CONTINUITY IS THE DIRECTIVE ID, carried in ACC_DIRECTIVE by
// every runner-spawned session. (The console-PID binding and keystroke kicks
// of the pre-SPEC-0005 era are gone.) A stale "active" directive nobody is
// running is curated by hand — the web list's Mark-finished / Stop-restarting
// buttons — never reaped automatically.
//
// Fails OPEN, like every other ACC hook helper: a broken directive store must
// cost auto-resume and nothing else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoot, isMainModule } from "./root.mjs";
import { notify } from "./notify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The whole -p bootstrap runner.mjs sends for a directive job (SPEC-0001).
// The real directive context (text, log tail, done/blocked protocol) is
// injected by budget.mjs's SessionStart hook; this string only wakes the
// session up.
export const KICK_TEXT = "Continue the active ACC directive.";
export const DONE_WHEN_MAX = 500;
export function directivesDir() {
  // resolveRoot(HERE) is called fresh here, never cached in a const: a test
  // process that imports this module once and runs many cases, each against
  // its own ACC_ROOT/ACC_DIRECTIVES_DIR sandbox, needs every call to see
  // whatever is current — a module-load-time const would leak the first
  // sandbox's ACC_ROOT into every later one.
  return process.env.ACC_DIRECTIVES_DIR || path.join(resolveRoot(HERE), "runner", "directives");
}
function doneDir() {
  return path.join(directivesDir(), "done");
}

const nowIso = () => new Date().toISOString();
export const MAX_DIRECTIVE_TAGS = 16;
export const DIRECTIVE_TAG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DIRECTIVE_TAG_RESERVED = new Set(["__proto__", "constructor", "prototype"]);

function normalizeBudgetValue(value, { name, integer = false } = {}) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  if (integer && !Number.isInteger(n)) throw new Error(`${name} must be a whole number`);
  return n;
}

function defaultBudget() {
  try {
    const raw = fs.readFileSync(process.env.ACC_POLICY || path.join(HERE, "..", "policy.json"), "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw).directives?.budget || {};
  } catch {
    return {};
  }
}

export function normalizeDirectiveBudget(budget = {}, defaults = defaultBudget()) {
  return {
    wallClockMin: normalizeBudgetValue(budget.wallClockMin ?? defaults.wallClockMin, { name: "wallClockMin" }),
    turns: normalizeBudgetValue(budget.turns ?? defaults.turns, { name: "turns", integer: true }),
    tokens: normalizeBudgetValue(budget.tokens ?? defaults.tokens, { name: "tokens", integer: true }),
    dollars: normalizeBudgetValue(budget.dollars ?? defaults.dollars, { name: "dollars" }),
  };
}

export function budgetSummary(budget = {}) {
  const parts = [];
  if (budget.wallClockMin > 0) parts.push(`wall ${budget.wallClockMin} min`);
  if (budget.turns > 0) parts.push(`turns ${budget.turns}`);
  if (budget.tokens > 0) parts.push(`tokens ${budget.tokens}`);
  if (budget.dollars > 0) parts.push(`$${budget.dollars} est`);
  return parts.join(", ");
}

function ensureDirs() {
  fs.mkdirSync(directivesDir(), { recursive: true });
  fs.mkdirSync(doneDir(), { recursive: true });
}

function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}

function directivePath(id) {
  return path.join(directivesDir(), `${safeId(id)}.json`);
}

export function logPath(id) {
  return path.join(directivesDir(), `${safeId(id)}.log.md`);
}

// Ids are used to build file paths and are echoed into injected context, so they
// are constrained here rather than trusted from a caller.
function safeId(id) {
  return String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}

function write(directive) {
  directive.tags = normalizeDirectiveTags(directive.tags);
  directive.updatedAt = nowIso();
  fs.writeFileSync(directivePath(directive.id), JSON.stringify(directive, null, 2) + "\n");
  return directive;
}

// SessionStart, Stop, the runner, and a model run can all touch the same
// directive at once, and every mutator below was a bare read -> change ->
// write with nothing serializing it across processes -- a lost update looks
// exactly like the silent stall this whole mechanism exists to prevent
// (issue #14). Same fs-primitives shape kernel/ledger.mjs's withLock proves
// (exclusive-create + stale-mtime reap + Atomics.wait backoff), reimplemented
// here rather than imported: kernel and the directive loop are deliberately
// separate systems (kernel/README.md "Out of scope"), and the lock itself is
// small enough that a cross-module dependency would cost more than it saves.
function withLock(id, fn) {
  fs.mkdirSync(directivesDir(), { recursive: true });
  const file = path.join(directivesDir(), `${safeId(id)}.lock`);
  const deadline = Date.now() + 4000;
  for (;;) {
    try { fs.closeSync(fs.openSync(file, "wx")); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs > 5000) { fs.rmSync(file, { force: true }); continue; } } catch {}
      if (Date.now() > deadline) throw new Error(`timed out waiting for the "${id}" directive lock`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(file); } catch {} }
}

// read -> change -> write as one locked unit. The read happens AFTER the
// lock is held, not before, so a writer never acts on a copy another process
// has since changed. `change` returning literal `false` aborts without
// writing (a mutator whose own precondition, e.g. "still active", failed).
function mutate(id, change) {
  return withLock(id, () => {
    const directive = readDirective(id);
    if (!directive) return null;
    // Test seam ONLY (default 0, a no-op): the natural read-to-write window is
    // microseconds, so a lost-update race reproduces only rarely by chance.
    // Widening it on demand makes the regression test deterministic — same
    // pattern as kernel/ledger.mjs's ACC_LEDGER_APPEND_ONCE_DELAY_MS.
    const delay = Number(process.env.ACC_DIRECTIVE_MUTATE_DELAY_MS) || 0;
    if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    if (change(directive) === false) return null;
    return write(directive);
  });
}

export function readDirective(id) {
  const g = readJson(directivePath(id), null);
  return g && g.id ? normalizeStoredDirective(g) : null;
}

export function listDirectives() {
  try {
    return fs
      .readdirSync(directivesDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(path.join(directivesDir(), f), null))
      .filter((g) => g && g.id)
      .map(normalizeStoredDirective);
  } catch {
    return [];
  }
}

export function activeDirectives() {
  return listDirectives().filter((g) => g.status === "active");
}

export function directiveForSession(sessionId) {
  if (!sessionId) return null;
  return activeDirectives().find((g) => g.sessionId === sessionId) || null;
}

export function createDirective({ text, doneWhen, cwd, profile, budget, tags, routeTag }) {
  ensureDirs();
  const t = String(text || "").trim();
  if (!t) throw new Error("a directive needs text");
  const userTags = validateUserDirectiveTags(tags);
  const autoRouteTag = normalizeRouteTag(routeTag);
  const normalizedDoneWhen = normalizeDoneWhen(doneWhen);
  const normalizedBudget = normalizeDirectiveBudget(budget);
  const iso = new Date().toISOString(); // 2026-07-31T04:10:27.123Z
  const id =
    "d-" +
    iso.slice(0, 10).replace(/-/g, "") +
    "-" +
    iso.slice(11, 19).replace(/:/g, "") +
    "-" +
    Math.random().toString(36).slice(2, 6);
  const directive = {
    id,
    text: t,
    cwd: cwd || "",
    profile: profile || "",
    status: "active",
    sessionId: "",
    sessionIds: [],
    cycles: 0,
    tags: normalizeDirectiveTags(userTags, autoRouteTag ? [autoRouteTag] : []),
    budget: normalizedBudget,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (normalizedDoneWhen !== undefined) directive.doneWhen = normalizedDoneWhen;
  write(directive);
  fs.writeFileSync(
    logPath(id),
    `# Directive ${id}\n\n${t}\n\n- folder: ${directive.cwd || "(not set)"}\n- profile: ${directive.profile || "(default)"}\n- opened: ${directive.createdAt}\n` +
      (budgetSummary(normalizedBudget) ? `- hard ceiling: ${budgetSummary(normalizedBudget)}\n` : "") +
      "\n## Progress\n\n"
  );
  return directive;
}

export function normalizeDoneWhen(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("doneWhen must be a string");
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(value) || trimmed.length > DONE_WHEN_MAX) {
    throw new Error(`doneWhen must be a single line of 1..${DONE_WHEN_MAX} characters`);
  }
  return trimmed;
}

// Real Claude Code session ids are always UUIDs. bindSession is reachable by
// hand (piping a fake SessionStart payload into budget.mjs against live
// state), and a synthetic sessionId there would otherwise silently steal a
// live console's directive binding (OI-006, reproduced). A non-UUID sessionId is
// therefore treated exactly like none was passed at all.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Called from SessionStart. One way in: ACC_DIRECTIVE names the directive the
// Command Center (or the headless runner) launched this session for. Each
// fresh runner cycle rebinds the same directive to its new session id.
export function bindSession({ sessionId, cwd, directiveId }) {
  ensureDirs();
  // Unlocked lookup only decides WHICH directive to target; mutate() below
  // re-reads it fresh once the lock is held, so a candidate that went stale
  // between this search and the lock can never be written over.
  let found = directiveId ? readDirective(directiveId) : null;
  if (found && found.status !== "active") found = null;
  if (!found) return null;

  return mutate(found.id, (directive) => {
    if (directive.status !== "active") return false; // went inactive since the lookup
    // A non-UUID id (garbage, or simply absent) never touches sessionId (OI-006)
    // -- it is inert, not "no-op with side effects".
    const validId = sessionId && SESSION_ID_RE.test(String(sessionId)) ? sessionId : null;
    if (validId !== null) {
      directive.sessionId = validId;
      directive.sessionIds = Array.isArray(directive.sessionIds) ? directive.sessionIds : [];
      if (!directive.sessionIds.includes(validId)) directive.sessionIds.push(validId);
    }
    if (!directive.cwd && cwd) directive.cwd = cwd;
  });
}

export function appendCycle(id, { sessionId, ctx, text }) {
  const directive = mutate(id, (d) => { d.cycles = Number(d.cycles || 0) + 1; });
  if (!directive) return null;
  const body = String(text || "").trim().slice(0, 4000);
  try {
    fs.appendFileSync(
      logPath(id),
      `\n### Cycle ${directive.cycles} - ${nowIso()}\n` +
        `_session ${sessionId || "?"} ended at ${Math.round(Number(ctx || 0) / 1000)}k_\n\n` +
        (body || "_(no closing summary captured)_") +
        "\n"
    );
  } catch {}
  return directive;
}

// The stuck signal for a headless run (runner.mjs's directiveState hashes
// this): the BODY of the log's last section, with the header and _session_
// lines dropped — their timestamps change on every append, so hashing them
// would make every run read as progress and disarm the stuck brake entirely.
export function lastCycleBody(id) {
  let all = "";
  try { all = fs.readFileSync(logPath(id), "utf8"); } catch { return ""; }
  const i = all.lastIndexOf("### ");
  if (i < 0) return "";
  const lines = all.slice(i).split("\n").slice(1);
  if (/^_session .*_\s*$/.test(lines[0] || "")) lines.shift();
  return lines.join("\n").trim();
}

// The tail is what gets injected into the next session, so it is bounded here
// rather than at the call site: an unbounded log would grow until it ate the
// very context budget this whole mechanism exists to protect.
export function logTail(id, maxChars = 3000) {
  try {
    const all = fs.readFileSync(logPath(id), "utf8");
    if (all.length <= maxChars) return all;
    return "...(earlier progress trimmed)...\n" + all.slice(-maxChars);
  } catch {
    return "";
  }
}

export function setStatus(id, status, why) {
  const directive = mutate(id, (d) => {
    d.status = status;
    if (why) d.why = String(why).slice(0, 500);
  });
  if (!directive) return null;
  if (status === "done" || status === "blocked" || status === "dead") {
    try {
      fs.appendFileSync(logPath(id), `\n### ${status.toUpperCase()} - ${nowIso()}\n${why || ""}\n`);
    } catch {}
    notify(`ACC directive ${status}`, `${id}: ${(directive.text || "").slice(0, 120)}`);
    // Archive so the live directory only ever holds work in flight.
    try {
      ensureDirs();
      fs.renameSync(directivePath(id), path.join(doneDir(), `${safeId(id)}.json`));
      fs.renameSync(logPath(id), path.join(doneDir(), `${safeId(id)}.log.md`));
    } catch {}
  }
  return directive;
}

// ------------------------------------------------------------- CLI

function arg(argv, name, dflt = "") {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}
function optionalArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
}

// Directive text for `new`. --text-file exists because the caller that matters is the
// GUI, and the GUI's node shim strips double quotes and cannot pass a newline in
// a command line at all - so a multi-line directive typed in the box would arrive
// mangled or truncated. A file has neither problem.
export function textFromArgs(argv) {
  const file = arg(argv, "--text-file");
  if (file) return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return arg(argv, "--text");
}

function budgetFromArgs(argv) {
  return {
    wallClockMin: arg(argv, "--wall-clock-min"),
    turns: arg(argv, "--turns"),
    tokens: arg(argv, "--tokens"),
    dollars: arg(argv, "--dollars"),
  };
}

function tagsFromArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tag" && argv[i + 1] !== undefined) out.push(argv[++i]);
    else if (argv[i] === "--tags" && argv[i + 1] !== undefined) {
      out.push(...String(argv[++i]).split(",").map((t) => t.trim()).filter(Boolean));
    }
  }
  return out;
}

// Positional id, falling back to the single active directive. Every command a MODEL
// is told to run takes an explicit id (SessionStart injects it), so this fallback
// only serves a human at a prompt.
function resolveId(argv) {
  const pos = argv.find((a) => /^d-/.test(a));
  if (pos) return pos;
  const act = activeDirectives();
  return act.length === 1 ? act[0].id : "";
}

export function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "list";

  if (cmd === "new") {
    const g = createDirective({
      text: textFromArgs(argv),
      doneWhen: optionalArg(argv, "--done-when"),
      cwd: arg(argv, "--cwd"),
      profile: arg(argv, "--profile"),
      budget: budgetFromArgs(argv),
      tags: tagsFromArgs(argv),
      routeTag: arg(argv, "--route-tag"),
    });
    console.log(JSON.stringify(g));
    return;
  }
  if (cmd === "list") {
    console.log(JSON.stringify(activeDirectives(), null, 2));
    return;
  }
  if (cmd === "show") {
    const g = readDirective(resolveId(argv));
    console.log(g ? JSON.stringify(g, null, 2) : "no active directive");
    return;
  }
  if (cmd === "log") {
    const id = resolveId(argv);
    // --text-file exists so the web guidance box (gui/server.mjs
    // /api/directives/note) can append multi-line text the same safe way
    // `new` already does — textFromArgs handles both --text-file and --text;
    // the positional-words fallback stays for a human typing at a prompt.
    const text = textFromArgs(argv) || argv.slice(1).filter((a) => !/^d-/.test(a)).join(" ");
    const g = readDirective(id);
    if (!g) return console.log("no active directive");
    try {
      fs.appendFileSync(logPath(id), `\n- ${nowIso()} ${text}\n`);
    } catch {}
    console.log(`logged to ${logPath(id)}`);
    return;
  }
  if (cmd === "done" || cmd === "blocked" || cmd === "paused") {
    const id = resolveId(argv);
    if (!id) return console.log("no active directive (pass the id)");
    setStatus(id, cmd === "paused" ? "paused" : cmd, arg(argv, "--why"));
    console.log(`directive ${id} -> ${cmd}`);
    return;
  }
  console.log(
    "usage: directive.mjs new (--text T | --text-file F) [--done-when W] [--cwd D] [--profile P] [--tag T] [--tags a,b] [--route-tag T] [--wall-clock-min N] [--turns N] [--tokens N] [--dollars N] | list | show [id] | log [id] --text T | done [id] [--why W] | blocked [id] --why W | paused [id]"
  );
}

if (isMainModule(import.meta.url)) main();

export function normalizeDirectiveTag(tag) {
  const t = String(tag || "").trim().toLowerCase();
  return DIRECTIVE_TAG_RE.test(t) && !DIRECTIVE_TAG_RESERVED.has(t) ? t : "";
}

export function normalizeRouteTag(tag) {
  const t = String(tag || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalizeDirectiveTag(t);
}

export function normalizeDirectiveTags(tags = [], extra = []) {
  const out = [];
  const seen = new Set();
  const all = [...(Array.isArray(tags) ? tags : []), ...(Array.isArray(extra) ? extra : [])];
  for (const raw of all) {
    const t = normalizeDirectiveTag(raw);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_DIRECTIVE_TAGS) break;
  }
  return out;
}

function normalizeStoredDirective(directive) {
  return { ...directive, tags: normalizeDirectiveTags(directive.tags) };
}

export function validateUserDirectiveTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw new Error("tags must be an array");
  if (tags.length > MAX_DIRECTIVE_TAGS) throw new Error(`tags must have at most ${MAX_DIRECTIVE_TAGS} entries`);
  for (const t of tags) {
    if (typeof t !== "string") throw new Error("every tag must be a string");
    if (!normalizeDirectiveTag(t)) throw new Error(`invalid tag: ${JSON.stringify(t)}`);
  }
  return tags;
}
