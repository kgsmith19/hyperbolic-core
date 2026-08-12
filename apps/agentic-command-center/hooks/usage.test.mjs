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
