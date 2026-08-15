#!/usr/bin/env node
// Agentic Command Center - usage ledger.
// Reads Claude Code session transcripts and reports real token spend.
// Main sessions are <project>/<sid>.jsonl; subagent runs are
// <project>/<sid>/subagents/agent-*.jsonl (isSidechain=true).
// No dependencies. Read-only: never writes to the transcript tree.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./root.mjs";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = process.env.ACC_POLICY || path.join(HERE, "..", "policy.json");
const CACHE_PATH =
  process.env.ACC_SCAN_CACHE || path.join(HERE, "..", "runner", "state", "scan-cache.json");

// ---------------------------------------------------------------- policy

// Used ONLY when policy.json is missing or unparseable. Context matches the
// standing 400/600 (Kyle, 2026-07-31, set via the ACC dials; SUPERSEDES the
// 2026-07-30 100/150 standing) so a broken policy file cannot silently change
// the budget.
// week thresholds stay 0 = disabled ON PURPOSE: if we cannot read policy.json we
// do not know the real limits, and a guessed kill switch fails silently and
// expensively, while a disabled one fails visibly.
const DEFAULT_POLICY = {
  context: { softK: 400, hardK: 600 },
  week: { amberTokens: 0, redTokens: 0 },
  // Rates are $ per million tokens, applied to the model families below.
  // These are ESTIMATES for relative attribution, not billing truth - correct
  // them in policy.json and every report follows.
  rates: {
    opus: { in: 15, out: 75 },
    sonnet: { in: 3, out: 15 },
    fable: { in: 3, out: 15 },
    haiku: { in: 0.8, out: 4 },
    unknown: { in: 3, out: 15 },
  },
};

export function loadPolicy() {
  try {
    const raw = fs.readFileSync(POLICY_PATH, "utf8").replace(/^\uFEFF/, "");
    const p = JSON.parse(raw);
    return {
      ...DEFAULT_POLICY,
      ...p,
      context: { ...DEFAULT_POLICY.context, ...(p.context || {}) },
      week: { ...DEFAULT_POLICY.week, ...(p.week || {}) },
      rates: { ...DEFAULT_POLICY.rates, ...(p.rates || {}) },
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

// Sessions launched from the Command Center's "Start work" tab carry
// ACC_PROFILE in their environment; Claude Code spawns hooks and the status
// line as child processes, so the variable reaches every fire. budget.mjs and
// statusline.mjs BOTH resolve policy through this one function, so the budget
// on screen can never disagree with the budget enforced. Profiles scope
// subagents; context limits come from the base dials (single source of truth,
// 2026-07-31). A profile carrying a context block still wins for that session
// - the live policy.json deliberately has none. No profile = base policy.
export function applyProfile(policy) {
  const name = String(process.env.ACC_PROFILE || "").trim();
  if (!name) return policy;
  const prof = policy.profiles && policy.profiles[name];
  if (!prof) return policy; // unknown name must not silently weaken the limits
  return {
    ...policy,
    context: { ...policy.context, ...(prof.context || {}) },
    subagents: { ...policy.subagents, ...(prof.subagents || {}) },
    activeProfile: name,
  };
}

function family(model) {
  if (!model) return "unknown";
  const m = String(model).toLowerCase();
  for (const f of ["opus", "sonnet", "haiku", "fable"]) if (m.includes(f)) return f;
  return "unknown";
}

// Cache multipliers against the input rate (Anthropic standard ratios).
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

function costOf(u, model, rates) {
  const r = rates[family(model)] || rates.unknown;
  const w1h = u.cacheWrite1h;
  const w5m = u.cacheCreate - w1h;
  return (
    (u.input * r.in +
      u.cacheRead * r.in * CACHE_READ_MULT +
      Math.max(0, w5m) * r.in * CACHE_WRITE_5M_MULT +
      w1h * r.in * CACHE_WRITE_1H_MULT +
      u.output * r.out) /
    1e6
  );
}

// ---------------------------------------------------------------- scanning

function emptyAgg() {
  return {
    input: 0,
    cacheCreate: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    turns: 0,
    cost: 0,
    byModel: {},
  };
}

function addUsage(agg, u, model, rates) {
  const one = {
    input: u.input_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
    cacheWrite1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    output: u.output_tokens || 0,
  };
  agg.input += one.input;
  agg.cacheCreate += one.cacheCreate;
  agg.cacheWrite1h += one.cacheWrite1h;
  agg.cacheRead += one.cacheRead;
  agg.output += one.output;
  agg.turns += 1;
  agg.cost += costOf(one, model, rates);
  const f = family(model);
  agg.byModel[f] = (agg.byModel[f] || 0) + one.output;
}

export function totalTokens(a) {
  return a.input + a.cacheCreate + a.cacheRead + a.output;
}

// Streams a .jsonl and yields {usage, model, ts} for assistant turns.
function* turns(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line || line.charCodeAt(0) !== 123) continue; // fast '{' check
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "assistant" || !o.message || !o.message.usage) continue;
    yield { usage: o.message.usage, model: o.message.model, ts: o.timestamp };
  }
}

// Context size of a session = the input side of its LAST assistant turn.
// input + cache_read + cache_creation is exactly what was fed to the model.
export function contextOf(transcriptPath) {
  let last = null;
  for (const t of turns(transcriptPath)) last = t.usage;
  if (!last) return 0;
  return (
    (last.input_tokens || 0) +
    (last.cache_read_input_tokens || 0) +
    (last.cache_creation_input_tokens || 0)
  );
}

// First assistant turn's context - the session's true starting size.
export function startContextOf(transcriptPath) {
  for (const t of turns(transcriptPath)) {
    return (
      (t.usage.input_tokens || 0) +
      (t.usage.cache_read_input_tokens || 0) +
      (t.usage.cache_creation_input_tokens || 0)
    );
  }
  return 0;
}

function listProjects() {
  try {
    return fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(PROJECTS_DIR, d.name));
  } catch {
    return [];
  }
}

// Every session in every project: {sid, project, mainFile, subFiles[]}
function listSessions(projectFilter) {
  const out = [];
  for (const proj of listProjects()) {
    if (projectFilter && !proj.includes(projectFilter)) continue;
    let entries;
    try {
      entries = fs.readdirSync(proj, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const sid = e.name.slice(0, -6);
      const subDir = path.join(proj, sid, "subagents");
      let subFiles = [];
      try {
        subFiles = fs
          .readdirSync(subDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => path.join(subDir, f));
      } catch {
        /* no subagents */
      }
      out.push({ sid, project: path.basename(proj), mainFile: path.join(proj, e.name), subFiles });
    }
  }
  return out;
}

// ------------------------------------------------------ per-file bucket cache
//
// Re-parsing every transcript on every fire cost 11.0 s at 110 MB / 205 files,
// which OVERRAN the 10 s SessionStart timeout - the hook was failing on every
// session start. The 10-minute tier cache in budget.mjs masked the cost rather
// than removing it, and a session start almost always lands after it expires.
//
// Transcripts are append-only, so a file whose (size, mtime) is unchanged can
// reuse its previous aggregate. Aggregates are bucketed by UTC hour so any
// `since` window is recomposed by summing the buckets at or after it. `since`
// is floored to its own hour, which makes the window at most one hour
// over-inclusive: irrelevant against a billion-token weekly threshold, and it
// holds the number steady within the hour instead of drifting on every fire.
//
// Turns with no timestamp go in bucket "0" and are always counted, matching the
// pre-cache behaviour (`since && ms && ms < since` let ms=0 through).
const BUCKET_MS = 36e5;
const CACHE_VERSION = 1;

let CACHE = null;
let CACHE_DIRTY = false;

function loadCache(ratesKey) {
  if (CACHE) return CACHE;
  let c = null;
  try {
    c = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    /* absent or corrupt - rebuilt below */
  }
  // A rates change alters every cached cost, so it invalidates the whole file.
  if (!c || c.v !== CACHE_VERSION || c.rates !== ratesKey)
    c = { v: CACHE_VERSION, rates: ratesKey, files: {} };
  CACHE = c;
  return CACHE;
}

// Written atomically so concurrent hook fires cannot read a half-file. A write
// failure is swallowed on purpose: this is an optimisation, and the next fire
// simply recomputes. It cannot change any reported number.
function saveCache() {
  if (!CACHE_DIRTY || !CACHE) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(CACHE));
    fs.renameSync(tmp, CACHE_PATH);
    CACHE_DIRTY = false;
  } catch {
    /* recomputed next fire */
  }
}

// {size, mtime, lastTs, buckets:{hourIndex: agg}} for one transcript, or null.
function bucketsOf(file, rates, ratesKey) {
  const cache = loadCache(ratesKey);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = cache.files[file];
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit;

  const buckets = {};
  let lastTs = 0;
  for (const t of turns(file)) {
    const ms = t.ts ? Date.parse(t.ts) : 0;
    if (ms > lastTs) lastTs = ms;
    const key = ms ? String(Math.floor(ms / BUCKET_MS)) : "0";
    if (!buckets[key]) buckets[key] = emptyAgg();
    addUsage(buckets[key], t.usage, t.model, rates);
  }
  const entry = { size: st.size, mtime: st.mtimeMs, lastTs, buckets };
  cache.files[file] = entry;
  CACHE_DIRTY = true;
  return entry;
}

// Aggregate one session, optionally windowed to turns at/after `since` (ms).
function aggregateSession(s, rates, ratesKey, since) {
  const sinceBucket = since ? Math.floor(since / BUCKET_MS) : 0;
  const main = emptyAgg();
  const sub = emptyAgg();
  let lastTs = 0;
  const collect = (file, agg) => {
    const e = bucketsOf(file, rates, ratesKey);
    if (!e) return;
    if (e.lastTs > lastTs) lastTs = e.lastTs;
    for (const [k, b] of Object.entries(e.buckets)) {
      if (sinceBucket && k !== "0" && Number(k) < sinceBucket) continue;
      sumInto(agg, b);
    }
  };
  collect(s.mainFile, main);
  for (const f of s.subFiles) collect(f, sub);
  return { ...s, main, sub, lastTs, agents: s.subFiles.length };
}

function scan({ since, project } = {}) {
  const rates = loadPolicy().rates;
  const ratesKey = JSON.stringify(rates);
  const sessions = listSessions(project);
  const out = sessions
    .map((s) => aggregateSession(s, rates, ratesKey, since))
    .filter((s) => s.main.turns > 0 || s.sub.turns > 0);
  // Drop entries for transcripts that no longer exist, so the cache tracks the
  // transcript tree instead of growing forever. Only safe on a full scan.
  if (CACHE && !project) {
    const live = new Set(sessions.flatMap((s) => [s.mainFile, ...s.subFiles]));
    for (const f of Object.keys(CACHE.files))
      if (!live.has(f)) {
        delete CACHE.files[f];
        CACHE_DIRTY = true;
      }
  }
  saveCache();
  return out;
}

// ---------------------------------------------------------------- output

const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n / 1000) + "k");
const fmt$ = (n) => "$" + n.toFixed(2);

function sumInto(target, src) {
  for (const k of ["input", "cacheCreate", "cacheWrite1h", "cacheRead", "output", "turns", "cost"])
    target[k] += src[k];
  for (const [m, v] of Object.entries(src.byModel)) target.byModel[m] = (target.byModel[m] || 0) + v;
}

// Exported as the seam the cache tests aggregate through, so they exercise the
// same path the week report and the tier both use rather than a parallel one.
export function totalsSince({ since = 0, project } = {}) {
  const sessions = scan({ since, project });
  const main = emptyAgg();
  const sub = emptyAgg();
  for (const s of sessions) {
    sumInto(main, s.main);
    sumInto(sub, s.sub);
  }
  return { sessions, main, sub, since };
}

function cmdWeek(project) {
  const { sessions, main, sub } = totalsSince({ since: Date.now() - 7 * 864e5, project });
  const mt = totalTokens(main);
  const st = totalTokens(sub);
  const total = mt + st;
  const cost = main.cost + sub.cost;
  const pctTok = total ? (st / total) * 100 : 0;
  const pctCost = cost ? (sub.cost / cost) * 100 : 0;

  console.log("ROLLING 7-DAY USAGE" + (project ? `  (project filter: ${project})` : ""));
  console.log("-".repeat(64));
  const row = (label, a) =>
    console.log(
      `  ${label.padEnd(10)} in ${fmtK(a.input).padStart(6)}  cache-w ${fmtK(a.cacheCreate).padStart(6)}` +
        `  cache-r ${fmtK(a.cacheRead).padStart(7)}  out ${fmtK(a.output).padStart(6)}` +
        `  = ${fmtK(totalTokens(a)).padStart(7)}  ${fmt$(a.cost).padStart(9)}`
    );
  row("main", main);
  row("subagent", sub);
  console.log("-".repeat(64));
  console.log(`  TOTAL      ${fmtK(total).padStart(8)} tokens   ${fmt$(cost)}   over ${sessions.length} sessions`);
  console.log(`  subagent share: ${pctTok.toFixed(1)}% of tokens, ${pctCost.toFixed(1)}% of cost`);
  const models = Object.entries(sub.byModel).sort((a, b) => b[1] - a[1]);
  if (models.length)
    console.log(`  subagent output by model: ${models.map(([m, v]) => `${m} ${fmtK(v)}`).join(", ")}`);
  console.log("");
  console.log("  cost is ESTIMATED from policy.json rates; token counts are exact.");
  const { tier, pct, redTokens } = tierFor(tierWindowTotal(project));
  console.log(`  tier: ${tier.toUpperCase()}` + (redTokens ? `  (${pct.toFixed(0)}% of red line)` : "  (thresholds not set)"));
}

function cmdSessions(project, top) {
  const since = Date.now() - 7 * 864e5;
  const sessions = scan({ since, project })
    .map((s) => ({ ...s, total: totalTokens(s.main) + totalTokens(s.sub), cost: s.main.cost + s.sub.cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, top);
  console.log("TOP SESSIONS (rolling 7 days, by estimated cost)");
  console.log("-".repeat(78));
  console.log("  sid       tokens    cost      sub%   agents  when");
  for (const s of sessions) {
    const st = totalTokens(s.sub);
    const pct = s.total ? ((st / s.total) * 100).toFixed(0) : "0";
    const when = s.lastTs ? new Date(s.lastTs).toISOString().slice(5, 16).replace("T", " ") : "?";
    console.log(
      `  ${s.sid.slice(0, 8)}  ${fmtK(s.total).padStart(7)}  ${fmt$(s.cost).padStart(8)}  ${(pct + "%").padStart(5)}  ${String(s.agents).padStart(6)}  ${when}`
    );
  }
}

// Tokens inside the TIER window: the rolling 7 days, but never reaching back
// past week.effectiveFrom. Reporting above still shows the true 7 days; only the
// tier is bounded, so the kill switch cannot fire retroactively on burn from
// before the budget discipline existed. budget.mjs's weekTier() calls THESE
// exports (plus its own 10-minute cache), so enforcement, statusline, and GUI
// cannot disagree — the copy that once lived in budget.mjs is gone.
export function tierWindowTotal(project) {
  const from = Date.parse(loadPolicy().week.effectiveFrom || "") || 0;
  const since = Math.max(Date.now() - 7 * 864e5, from);
  const main = emptyAgg();
  const sub = emptyAgg();
  for (const s of scan({ since, project })) {
    sumInto(main, s.main);
    sumInto(sub, s.sub);
  }
  return totalTokens(main) + totalTokens(sub);
}

export function tierFor(weekTokens) {
  const w = loadPolicy().week;
  const red = w.redTokens || 0;
  const amber = w.amberTokens || 0;
  let tier = "green";
  if (red && weekTokens >= red) tier = "red";
  else if (amber && weekTokens >= amber) tier = "amber";
  return { tier, weekTokens, pct: red ? (weekTokens / red) * 100 : 0, redTokens: red };
}

function cmdCheck(project) {
  console.log(JSON.stringify(tierFor(tierWindowTotal(project))));
}

// ---------------------------------------------------------------- cli

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const getFlag = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const project = getFlag("--project", undefined);
  switch (cmd) {
    case "week":
      cmdWeek(project);
      break;
    case "sessions":
      cmdSessions(project, Number(getFlag("--top", 10)));
      break;
    case "check":
      cmdCheck(project);
      break;
    default:
      console.log("usage.mjs week|sessions [--top N]|check  [--project <substr>]");
      process.exit(cmd ? 1 : 0);
  }
}
