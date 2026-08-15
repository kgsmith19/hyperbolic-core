// Tests for the per-file bucket cache added to usage.mjs (OI-005).
//
// The cache exists to keep the transcript scan off the SessionStart critical
// path. What matters is that it cannot change a reported number, so every test
// here compares the cached path against an independent, deliberately naive
// aggregation of the same fixtures.
//
// Run: node --test hooks/usage.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";


// Each test gets its own throwaway CLAUDE_CONFIG_DIR and cache file, so runs
// never touch the real transcript tree or the live scan-cache.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-usage-"));
  const projects = path.join(dir, "projects", "proj");
  fs.mkdirSync(projects, { recursive: true });
  return { dir, projects, cache: path.join(dir, "scan-cache.json") };
}

// Import usage.mjs fresh so it re-reads the env for this sandbox. The cache is
// module-level state, so a cache-busting query string is required per load.
let loadSeq = 0;
async function loadUsage(sb) {
  process.env.CLAUDE_CONFIG_DIR = sb.dir;
  process.env.ACC_SCAN_CACHE = sb.cache;
  return import(`./usage.mjs?t=${++loadSeq}`);
}

// Minimal assistant turn in transcript shape.
function turn(ts, { input = 0, out = 0, read = 0, create = 0 } = {}, model = "claude-opus-5") {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      model,
      usage: {
        input_tokens: input,
        output_tokens: out,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: create,
      },
    },
  });
}

function writeSession(sb, sid, lines) {
  fs.writeFileSync(path.join(sb.projects, `${sid}.jsonl`), lines.join("\n") + "\n");
}

// Independent oracle: sum the raw file, no buckets, no cache.
function naiveTotal(file, since) {
  let total = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const o = JSON.parse(line);
    if (o.type !== "assistant" || !o.message?.usage) continue;
    const ms = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (since && ms && ms < since) continue;
    const u = o.message.usage;
    total +=
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
  }
  return total;
}

test("unwindowed totals match a naive sum of the same file", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn("2026-07-20T01:00:00.000Z", { input: 100, out: 10 }),
    turn("2026-07-20T02:00:00.000Z", { read: 500, create: 20 }),
    turn("2026-07-21T03:30:00.000Z", { input: 7, out: 3 }),
  ]);
  const file = path.join(sb.projects, "s1.jsonl");
  const got = u.totalTokens(u.totalsSince({ since: 0 }).main);
  assert.equal(got, naiveTotal(file, 0));
  assert.equal(got, 640);
});

test("a second scan hits the cache and returns the identical number", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn("2026-07-20T01:00:00.000Z", { input: 100, out: 10 }),
    turn("2026-07-20T02:00:00.000Z", { read: 500 }),
  ]);
  const first = u.totalTokens(u.totalsSince({ since: 0 }).main);
  assert.ok(fs.existsSync(sb.cache), "cache file written after a scan");
  const second = u.totalTokens(u.totalsSince({ since: 0 }).main);
  assert.equal(second, first);
});

test("appending to a transcript invalidates its cache entry", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const file = path.join(sb.projects, "s1.jsonl");
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 100 })]);
  assert.equal(u.totalTokens(u.totalsSince({ since: 0 }).main), 100);

  fs.appendFileSync(file, turn("2026-07-20T01:30:00.000Z", { input: 50 }) + "\n");
  assert.equal(u.totalTokens(u.totalsSince({ since: 0 }).main), 150);
});

test("a windowed total is exact when `since` lands on an hour boundary", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn("2026-07-20T01:00:00.000Z", { input: 100 }), // before
    turn("2026-07-20T03:00:00.000Z", { input: 40 }), // at/after
    turn("2026-07-20T04:15:00.000Z", { input: 2 }), // after
  ]);
  const since = Date.parse("2026-07-20T03:00:00.000Z");
  const file = path.join(sb.projects, "s1.jsonl");
  const got = u.totalTokens(u.totalsSince({ since }).main);
  assert.equal(got, naiveTotal(file, since));
  assert.equal(got, 42);
});

test("`since` mid-hour is over-inclusive by at most that hour, never under", async () => {
  // The documented tradeoff: buckets are hourly, so `since` is floored to its
  // hour. A turn earlier in the same hour is counted. It must never DROP a turn
  // that belongs in the window - that would under-report spend and delay the
  // tier, which is the failure that actually costs money.
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn("2026-07-20T03:10:00.000Z", { input: 100 }), // same hour, before `since`
    turn("2026-07-20T03:50:00.000Z", { input: 40 }), // same hour, after `since`
  ]);
  const since = Date.parse("2026-07-20T03:30:00.000Z");
  const file = path.join(sb.projects, "s1.jsonl");
  const exact = naiveTotal(file, since); // 40
  const got = u.totalTokens(u.totalsSince({ since }).main);
  assert.equal(exact, 40);
  assert.equal(got, 140, "counts the whole hour");
  assert.ok(got >= exact, "never under-reports");
});

test("turns with no timestamp are always counted, windowed or not", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn(undefined, { input: 9 }),
    turn("2026-07-20T03:00:00.000Z", { input: 1 }),
  ]);
  const since = Date.parse("2026-07-20T03:00:00.000Z");
  assert.equal(u.totalTokens(u.totalsSince({ since }).main), 10);
});

test("a rates change invalidates the whole cache", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 1e6, out: 1e6 })]);
  const a = u.totalsSince({ since: 0 }).main.cost;
  assert.ok(a > 0, "cost is computed");

  const raw = JSON.parse(fs.readFileSync(sb.cache, "utf8"));
  raw.rates = "stale-rates-key";
  fs.writeFileSync(sb.cache, JSON.stringify(raw));

  const u2 = await loadUsage(sb);
  const b = u2.totalsSince({ since: 0 }).main.cost;
  assert.equal(b, a, "recomputed from source, same rates in policy, same cost");
});

test("a corrupt cache file is rebuilt rather than thrown on", async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.cache, "{not json");
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 42 })]);
  assert.equal(u.totalTokens(u.totalsSince({ since: 0 }).main), 42);
});

test("cache entries for deleted transcripts are pruned", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 1 })]);
  writeSession(sb, "s2", [turn("2026-07-20T01:00:00.000Z", { input: 1 })]);
  u.totalsSince({ since: 0 });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(sb.cache, "utf8")).files).length, 2);

  fs.unlinkSync(path.join(sb.projects, "s2.jsonl"));
  u.totalsSince({ since: 0 });
  const files = Object.keys(JSON.parse(fs.readFileSync(sb.cache, "utf8")).files);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith("s1.jsonl"));
});

// ---------------------------------------------------------------------------
// D-02: the rest of usage.mjs, beyond the bucket cache above. loadPolicy(),
// applyProfile(), contextOf/startContextOf, tierFor/tierWindowTotal, model-
// family cost attribution, listProjects/listSessions edge cases, and the
// week|sessions|check CLI itself were previously untested. Each test below
// still gets its own throwaway CLAUDE_CONFIG_DIR/cache (loadUsage's own
// discipline); tests that also care about policy.json's CONTENT additionally
// point ACC_POLICY at a sandboxed file before importing, since POLICY_PATH is
// resolved once at module load like every other env seam here — never at the
// live repo policy.json (AGENTS.md: hooks must not run against live state).
// ---------------------------------------------------------------------------

// Writes `policy` to a fresh file under sb.dir and points ACC_POLICY at it.
// Must run BEFORE loadUsage(sb) — POLICY_PATH is captured at import time.
function withPolicy(sb, policy) {
  const p = path.join(sb.dir, "policy.json");
  fs.writeFileSync(p, JSON.stringify(policy));
  process.env.ACC_POLICY = p;
  return p;
}

// ---------------------------------------------------- loadPolicy()

test("loadPolicy: a missing file falls back to the built-in defaults", async () => {
  const sb = sandbox();
  process.env.ACC_POLICY = path.join(sb.dir, "does-not-exist.json");
  const u = await loadUsage(sb);
  const p = u.loadPolicy();
  assert.deepEqual(p.context, { softK: 400, hardK: 600 });
  assert.deepEqual(p.week, { amberTokens: 0, redTokens: 0 });
  assert.equal(p.rates.opus.in, 15);
});

test("loadPolicy: malformed JSON falls back to defaults rather than throwing", async () => {
  const sb = sandbox();
  const p = path.join(sb.dir, "policy.json");
  fs.writeFileSync(p, "{not valid json");
  process.env.ACC_POLICY = p;
  const u = await loadUsage(sb);
  assert.deepEqual(u.loadPolicy().context, { softK: 400, hardK: 600 });
});

test("loadPolicy: a UTF-8 BOM prefix does not break parsing", async () => {
  const sb = sandbox();
  const p = path.join(sb.dir, "policy.json");
  fs.writeFileSync(p, "﻿" + JSON.stringify({ context: { softK: 11, hardK: 22 } }));
  process.env.ACC_POLICY = p;
  const u = await loadUsage(sb);
  assert.deepEqual(u.loadPolicy().context, { softK: 11, hardK: 22 });
});

test("loadPolicy: partial overrides merge per-section instead of replacing wholesale", async () => {
  const sb = sandbox();
  withPolicy(sb, { week: { redTokens: 500 } });
  const u = await loadUsage(sb);
  const p = u.loadPolicy();
  assert.equal(p.week.redTokens, 500, "override applied");
  assert.equal(p.week.amberTokens, 0, "default backfilled for the untouched sibling key");
  assert.deepEqual(p.context, { softK: 400, hardK: 600 }, "untouched section keeps its default wholesale");
});

// ---------------------------------------------------- applyProfile()

test("applyProfile: no ACC_PROFILE set returns the exact same policy object", async () => {
  const sb = sandbox();
  delete process.env.ACC_PROFILE;
  const u = await loadUsage(sb);
  const policy = { context: { softK: 1, hardK: 2 } };
  assert.equal(u.applyProfile(policy), policy);
});

test("applyProfile: a policy with no profiles table at all is left unchanged", async () => {
  const sb = sandbox();
  process.env.ACC_PROFILE = "Heavy";
  const u = await loadUsage(sb);
  const policy = { context: { softK: 1 } }; // no `profiles` key
  assert.equal(u.applyProfile(policy), policy);
  delete process.env.ACC_PROFILE;
});

test("applyProfile: an unknown profile name never silently weakens the limits", async () => {
  const sb = sandbox();
  process.env.ACC_PROFILE = "DoesNotExist";
  const u = await loadUsage(sb);
  const policy = { context: { softK: 1 }, profiles: { Normal: { context: { softK: 999 } } } };
  assert.equal(u.applyProfile(policy), policy);
  delete process.env.ACC_PROFILE;
});

test("applyProfile: a known profile merges subagents/context and records activeProfile", async () => {
  const sb = sandbox();
  process.env.ACC_PROFILE = "Heavy";
  const u = await loadUsage(sb);
  const policy = {
    context: { softK: 400 },
    subagents: { maxPerSession: 6 },
    profiles: { Heavy: { subagents: { maxPerSession: 12 } } },
  };
  const out = u.applyProfile(policy);
  assert.equal(out.activeProfile, "Heavy");
  assert.equal(out.subagents.maxPerSession, 12);
  assert.equal(out.context.softK, 400, "context untouched when the profile carries no context block");
  delete process.env.ACC_PROFILE;
});

// ---------------------------------------------------- contextOf / startContextOf

test("contextOf/startContextOf: an empty transcript returns 0", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const file = path.join(sb.projects, "empty.jsonl");
  fs.writeFileSync(file, "");
  assert.equal(u.contextOf(file), 0);
  assert.equal(u.startContextOf(file), 0);
});

test("contextOf/startContextOf: a nonexistent file yields 0 rather than throwing", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const file = path.join(sb.dir, "nope.jsonl");
  assert.equal(u.contextOf(file), 0);
  assert.equal(u.startContextOf(file), 0);
});

test("contextOf reads the LAST assistant turn; startContextOf reads the FIRST", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const file = path.join(sb.projects, "s1.jsonl");
  fs.writeFileSync(
    file,
    [
      turn("2026-07-20T01:00:00.000Z", { input: 10, read: 5 }),
      turn("2026-07-20T02:00:00.000Z", { input: 100, read: 50, create: 3 }),
    ].join("\n") + "\n"
  );
  assert.equal(u.startContextOf(file), 15); // first turn: 10 + 5
  assert.equal(u.contextOf(file), 153); // last turn: 100 + 50 + 3
});

test("turns() parsing: malformed JSON, wrong type, and missing usage are all skipped without throwing", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const file = path.join(sb.projects, "messy.jsonl");
  fs.writeFileSync(
    file,
    [
      "not even json-ish", // fast-path skip: doesn't start with '{'
      "{broken json", // starts with '{' but JSON.parse throws
      JSON.stringify({ type: "user", message: { usage: { input_tokens: 999 } } }), // wrong type
      JSON.stringify({ type: "assistant" }), // no .message at all
      JSON.stringify({ type: "assistant", message: {} }), // .message present, no .usage
      "", // blank line
      turn("2026-07-20T01:00:00.000Z", { input: 7 }), // the only real turn
    ].join("\n") + "\n"
  );
  assert.equal(u.contextOf(file), 7);
});

// ---------------------------------------------------- model-family cost attribution

test("cost attribution: each model family buckets output tokens and applies its own rate", async () => {
  const sb = sandbox();
  withPolicy(sb, {
    rates: {
      opus: { in: 10, out: 10 },
      sonnet: { in: 1, out: 1 },
      haiku: { in: 1, out: 1 },
      fable: { in: 1, out: 1 },
      unknown: { in: 1, out: 1 },
    },
  });
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn("2026-07-20T01:00:00.000Z", { out: 1e6 }, "claude-opus-5"),
    turn("2026-07-20T01:05:00.000Z", { out: 1e6 }, "some-totally-unrecognized-model"),
    turn("2026-07-20T01:10:00.000Z", { out: 1e6 }, null), // a session line with no model at all
  ]);
  const { main } = u.totalsSince({ since: 0 });
  assert.equal(main.byModel.opus, 1e6);
  assert.equal(main.byModel.unknown, 2e6, "an unrecognized name and a missing model both fall into unknown");
  assert.equal(main.cost, 12, "opus out-rate 10 + two unknown out-rates 1 each, per 1e6 tokens");
});

test("cost attribution: the 1h cache-write share is split from the 5m share and never goes negative", async () => {
  const sb = sandbox();
  withPolicy(sb, { rates: { opus: { in: 1, out: 0 } } });
  const u = await loadUsage(sb);
  // cache_creation_input_tokens (5m+1h combined) is SMALLER than the reported
  // 1h-only sub-field -- an inconsistent transcript. w5m = cacheCreate - w1h
  // would go negative; Math.max(0, w5m) must clamp it instead of undercharging.
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-20T01:00:00.000Z",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_1h_input_tokens: 40 },
      },
    },
  });
  fs.writeFileSync(path.join(sb.projects, "s1.jsonl"), line + "\n");
  const { main } = u.totalsSince({ since: 0 });
  // w1h=40 costs 40*1*2.0=80; clamped w5m=0 costs 0. Total 80/1e6.
  assert.equal(main.cost, 80 / 1e6);
});

// ---------------------------------------------------- tierFor() / tierWindowTotal()

test("tierFor: green below amber, amber between thresholds, red at or above", async () => {
  const sb = sandbox();
  withPolicy(sb, { week: { amberTokens: 100, redTokens: 200 } });
  const u = await loadUsage(sb);
  assert.equal(u.tierFor(50).tier, "green");
  assert.equal(u.tierFor(100).tier, "amber");
  assert.equal(u.tierFor(199).tier, "amber");
  const red = u.tierFor(200);
  assert.equal(red.tier, "red");
  assert.equal(red.pct, 100);
  assert.equal(red.redTokens, 200);
});

test("tierFor: unset thresholds (0) mean always green with pct 0", async () => {
  const sb = sandbox();
  withPolicy(sb, { week: { amberTokens: 0, redTokens: 0 } });
  const u = await loadUsage(sb);
  const r = u.tierFor(999999);
  assert.equal(r.tier, "green");
  assert.equal(r.pct, 0);
});

test("tierWindowTotal: bounds the window at week.effectiveFrom when more recent than 7 days ago", async () => {
  const sb = sandbox();
  const effectiveFrom = new Date(Date.now() - 2 * 864e5).toISOString(); // 2 days ago
  withPolicy(sb, { week: { effectiveFrom } });
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn(new Date(Date.now() - 4 * 864e5).toISOString(), { input: 500 }), // before effectiveFrom
    turn(new Date(Date.now() - 1 * 864e5).toISOString(), { input: 7 }), // after effectiveFrom
  ]);
  assert.equal(u.tierWindowTotal(), 7);
});

test("tierWindowTotal: honors a project filter", async () => {
  const sb = sandbox();
  const other = path.join(sb.dir, "projects", "other");
  fs.mkdirSync(other, { recursive: true });
  process.env.ACC_POLICY = path.join(sb.dir, "no-policy.json");
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn(new Date().toISOString(), { input: 3 })]);
  fs.writeFileSync(path.join(other, "s2.jsonl"), turn(new Date().toISOString(), { input: 40 }) + "\n");
  assert.equal(u.tierWindowTotal("other"), 40);
});

// ---------------------------------------------------- listProjects / listSessions

test("listProjects: a missing CLAUDE projects directory yields zero sessions, never throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-usage-noproj-"));
  process.env.CLAUDE_CONFIG_DIR = dir; // note: no "projects" subdirectory created
  process.env.ACC_SCAN_CACHE = path.join(dir, "cache.json");
  process.env.ACC_POLICY = path.join(dir, "no-policy.json");
  const u = await import(`./usage.mjs?t=${++loadSeq}`);
  const { sessions, main } = u.totalsSince({ since: 0 });
  assert.deepEqual(sessions, []);
  assert.equal(u.totalTokens(main), 0);
});

test("listSessions: subagents count only when a subagents/ dir exists; stray non-.jsonl files are ignored", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "solo", [turn("2026-07-20T01:00:00.000Z", { input: 2 })]); // no subagents dir
  fs.writeFileSync(path.join(sb.projects, "notes.txt"), "hello"); // must be ignored
  writeSession(sb, "withsub", [turn("2026-07-20T01:00:00.000Z", { input: 3 })]);
  const subDir = path.join(sb.projects, "withsub", "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "agent-1.jsonl"), turn("2026-07-20T01:00:00.000Z", { input: 9 }) + "\n");

  const { sessions, sub } = u.totalsSince({ since: 0 });
  assert.equal(sessions.length, 2);
  const withsub = sessions.find((s) => s.sid === "withsub");
  assert.equal(withsub.agents, 1);
  const solo = sessions.find((s) => s.sid === "solo");
  assert.equal(solo.agents, 0);
  assert.equal(u.totalTokens(sub), 9);
});

test("totalsSince: a project filter matches only project directories containing that substring", async () => {
  const sb = sandbox(); // sb.projects = <dir>/projects/proj
  const other = path.join(sb.dir, "projects", "other-proj");
  fs.mkdirSync(other, { recursive: true });
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 10 })]);
  fs.writeFileSync(path.join(other, "s2.jsonl"), turn("2026-07-20T01:00:00.000Z", { input: 999 }) + "\n");
  const filtered = u.totalsSince({ since: 0, project: "other" });
  assert.equal(filtered.sessions.length, 1);
  assert.equal(u.totalTokens(filtered.main), 999);
});

test("scan: cache pruning is skipped on a project-filtered call, only a full scan may prune", async () => {
  const sb = sandbox();
  const other = path.join(sb.dir, "projects", "other");
  fs.mkdirSync(other, { recursive: true });
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 1 })]);
  fs.writeFileSync(path.join(other, "s2.jsonl"), turn("2026-07-20T01:00:00.000Z", { input: 1 }) + "\n");
  u.totalsSince({ since: 0 }); // full scan: populates cache entries for both files
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(sb.cache, "utf8")).files).length, 2);

  fs.unlinkSync(path.join(other, "s2.jsonl"));
  u.totalsSince({ since: 0, project: "proj" }); // project-scoped: must not prune s2's stale entry
  const files = Object.keys(JSON.parse(fs.readFileSync(sb.cache, "utf8")).files);
  assert.equal(files.length, 2, "a project-filtered scan must not prune entries outside its own filter");
});

// ---------------------------------------------------- defensive save path

test("saveCache: an uncreatable cache directory fails silently; the reported total is unaffected", async () => {
  const sb = sandbox();
  const blocker = path.join(sb.dir, "blocker"); // a FILE, not a directory
  fs.writeFileSync(blocker, "x");
  process.env.CLAUDE_CONFIG_DIR = sb.dir;
  const cachePath = path.join(blocker, "sub", "cache.json"); // parent path has a FILE component
  process.env.ACC_SCAN_CACHE = cachePath;
  process.env.ACC_POLICY = path.join(sb.dir, "no-policy.json");
  const u = await import(`./usage.mjs?t=${++loadSeq}`);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 5 })]);
  assert.equal(u.totalTokens(u.totalsSince({ since: 0 }).main), 5, "a save failure must not change the reported total");
  assert.ok(!fs.existsSync(cachePath), "the cache file was never actually written");
});

// ---------------------------------------------------------------------------
// CLI entry point (real subprocess: argv parsing, isMainModule, exit codes) --
// mirrors hooks/engine.test.mjs's own "subprocess:" group.
// ---------------------------------------------------------------------------

const USAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "usage.mjs");

// Fresh sandboxed CLAUDE_CONFIG_DIR/policy per call; runs usage.mjs as the
// real process entry point (argv, isMainModule, actual exit code).
function runCli(argv, { policy = {}, sessions = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-usage-cli-"));
  const projects = path.join(dir, "projects", "proj");
  fs.mkdirSync(projects, { recursive: true });
  for (const [sid, lines] of Object.entries(sessions)) {
    fs.writeFileSync(path.join(projects, `${sid}.jsonl`), lines.join("\n") + "\n");
  }
  const policyPath = path.join(dir, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy));
  const r = spawnSync(process.execPath, [USAGE_PATH, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: dir,
      ACC_SCAN_CACHE: path.join(dir, "cache.json"),
      ACC_POLICY: policyPath,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("subprocess: `week` prints the rolling 7-day report and a tier line", () => {
  const r = runCli(["week"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /ROLLING 7-DAY USAGE/);
  assert.match(r.out, /tier: GREEN/);
});

test("subprocess: `week --project` labels the header with the filter", () => {
  const r = runCli(["week", "--project", "xyz"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /project filter: xyz/);
});

test("subprocess: `sessions` prints the top-sessions table, honoring --top", () => {
  // cmdSessions windows to the rolling 7 days from `Date.now()`, unlike the
  // fixture timestamps used elsewhere in this file (unwindowed via since:0)
  // -- this fixture must be recent or the session is filtered out before the
  // per-row print loop ever runs.
  const now = new Date().toISOString();
  const r = runCli(["sessions", "--top", "1"], {
    sessions: { s1: [turn(now, { input: 5, out: 5 })] },
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /TOP SESSIONS/);
  assert.match(r.out, /s1/, "the session row itself must be printed, not just the header");
});

test("subprocess: `check` prints the tier verdict as one JSON line", () => {
  const r = runCli(["check"], { policy: { week: { amberTokens: 0, redTokens: 0 } } });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.tier, "green");
});

test("subprocess: no command prints usage and exits 0", () => {
  const r = runCli([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage\.mjs week\|sessions/);
});

test("subprocess: an unknown command prints usage and exits 1", () => {
  const r = runCli(["bogus"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /usage\.mjs week\|sessions/);
});
