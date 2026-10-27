// Behavior tests for docs/ops/broker-soak-report.mjs (hyperbolic-core#466).
// The soak report reads the broker's own audit log lines and decides whether
// the two log-only enforcement flips (egress host-allowlist #187, budget 429
// #200) are safe to make live. Fixtures are produced by the broker's REAL
// serializer (services/broker/src/proxy.ts's defaultLog), never hand-written
// JSON, so a field rename in the broker fails here instead of silently
// producing an empty report. Each test names the defect it exists to catch.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { defaultLog } from "../../services/broker/src/proxy.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportModule = await import(pathToFileURL(path.join(root, "docs/ops/broker-soak-report.mjs")).href);
const {
  parseAuditLog,
  summarizeCallers,
  observationWindow,
  spendByCaller,
  spendConfigFromEnv,
  fetchSpendRows,
  generateReport,
  renderMarkdown,
  MIN_WINDOW_DAYS,
} = reportModule;

const DAY_MS = 86_400_000;
const DAY0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

/** The broker's exact audit line for one entry, via its real serializer. */
function auditLine(entry) {
  const captured = [];
  const original = console.log;
  console.log = (...args) => captured.push(args.join(" "));
  try {
    defaultLog(entry);
  } finally {
    console.log = original;
  }
  assert.equal(captured.length, 1, "defaultLog must emit exactly one line");
  return captured[0];
}

/** One docker logs --timestamps line: RFC3339Nano prefix, a space, then the broker's line. */
function dockerLine(text, dockerTs = "2026-10-01T00:00:00.123456789Z") {
  return `${dockerTs} ${text}`;
}

function entry({ caller = "llm-handler", targetHost = "api.anthropic.com", knownCaller = true, hostAllowed = true, atMs = DAY0, ...rest } = {}) {
  return { caller, targetHost, knownCaller, hostAllowed, timestamp: iso(atMs), ...rest };
}

function logText(entries, extraLines = []) {
  return [...entries.map((e) => dockerLine(auditLine(e), e.timestamp.replace("Z", "123456789Z"))), ...extraLines].join("\n");
}

// --- parser ---

test("parser: a real defaultLog line with a docker timestamp prefix parses to its audit fields", () => {
  const { entries, counts } = parseAuditLog(logText([entry()]));
  assert.equal(counts.auditEntries, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].caller, "llm-handler");
  assert.equal(entries[0].targetHost, "api.anthropic.com");
  assert.equal(entries[0].knownCaller, true);
  assert.equal(entries[0].hostAllowed, true);
  assert.equal(entries[0].timestamp, "2026-10-01T00:00:00.000Z");
});

test("parser: budget and credential fields emitted by the broker survive parsing (#186, #200)", () => {
  const withBudget = entry({ estimatedCostUsd: 0.25, spentTodayUsd: 9.5, budgetWouldExceed: true });
  const refused = entry({ caller: "rogue", knownCaller: false, hostAllowed: false, credentialRequested: "LLM_KEYS_ANTHROPIC", credentialGranted: false });
  const { entries } = parseAuditLog(logText([withBudget, refused]));
  assert.equal(entries[0].estimatedCostUsd, 0.25);
  assert.equal(entries[0].spentTodayUsd, 9.5);
  assert.equal(entries[0].budgetWouldExceed, true);
  assert.equal(entries[1].credentialRequested, "LLM_KEYS_ANTHROPIC");
  assert.equal(entries[1].credentialGranted, false);
});

test("parser: non-JSON lines, blank lines, truncated JSON, and other events are counted and skipped, never thrown on", () => {
  const text = logText([entry()], [
    "services/broker listening on 127.0.0.1:8300",
    "",
    dockerLine('{"event":"broker_proxy_request","caller":"llm-hand'),
    dockerLine('{"event":"something_else","caller":"x"}'),
    dockerLine('{"event":"broker_proxy_request","caller":42,"targetHost":"h","hostAllowed":true,"knownCaller":true}'),
  ]);
  const { entries, counts } = parseAuditLog(text);
  assert.equal(entries.length, 1, "only the one well-formed audit entry is kept");
  assert.equal(counts.auditEntries, 1);
  assert.equal(counts.nonJsonLines, 2, "the banner line and the truncated JSON line");
  assert.equal(counts.otherEventLines, 1);
  assert.equal(counts.malformedAuditLines, 1, "an audit line whose caller is not a string is skipped");
});

// --- aggregation ---

test("aggregation: per caller x targetHost counts total, would-be denials, unknown callers, and budget would-exceed exactly", () => {
  const entries = [
    entry({ hostAllowed: true, budgetWouldExceed: false }),
    entry({ hostAllowed: true }),
    entry({ hostAllowed: true }),
    entry({ hostAllowed: true, estimatedCostUsd: 0.5, spentTodayUsd: 9.8, budgetWouldExceed: true }),
    entry({ targetHost: "evil.example.com", hostAllowed: false }),
    entry({ targetHost: "evil.example.com", hostAllowed: false }),
    entry({ caller: "rogue", targetHost: "api.anthropic.com", knownCaller: false, hostAllowed: false }),
  ].map((e) => ({ ...e, timestamp: iso(DAY0) }));
  const rows = summarizeCallers(parseAuditLog(logText(entries)).entries);
  const byKey = Object.fromEntries(rows.map((r) => [`${r.caller}|${r.targetHost}`, r]));

  const anthropic = byKey["llm-handler|api.anthropic.com"];
  assert.equal(anthropic.total, 4);
  assert.equal(anthropic.hostAllowedFalse, 0, "hostAllowed:true must never count as a would-be denial");
  assert.equal(anthropic.budgetWouldExceedTrue, 1);
  assert.equal(anthropic.knownCaller, true);

  const evil = byKey["llm-handler|evil.example.com"];
  assert.equal(evil.total, 2);
  assert.equal(evil.hostAllowedFalse, 2);
  assert.equal(evil.knownCaller, true);

  const rogue = byKey["rogue|api.anthropic.com"];
  assert.equal(rogue.total, 1);
  assert.equal(rogue.hostAllowedFalse, 1);
  assert.equal(rogue.knownCaller, false);
  assert.equal(rows.length, 3);
});

test("aggregation: estimated cost is summed per row so the USD totals in the report are real", () => {
  const entries = [
    entry({ estimatedCostUsd: 0.1 }),
    entry({ estimatedCostUsd: 0.2 }),
    entry({}),
  ];
  const [row] = summarizeCallers(parseAuditLog(logText(entries)).entries);
  assert.equal(row.estimatedCostUsdTotal, 0.3);
});

// --- observation window ---

test("window: spans first to last audit entry timestamp and reports container StartedAt", () => {
  const entries = [entry({ atMs: DAY0 }), entry({ atMs: DAY0 + 3 * DAY_MS })];
  const window = observationWindow({
    startedAt: "2026-09-30T08:00:00.987654321Z",
    since: null,
    entries: parseAuditLog(logText(entries)).entries,
  });
  assert.equal(window.firstEntryAt, iso(DAY0));
  assert.equal(window.lastEntryAt, iso(DAY0 + 3 * DAY_MS));
  assert.equal(window.days, 3);
  assert.equal(window.startedAt, "2026-09-30T08:00:00.987Z", "StartedAt normalized to millisecond ISO");
});

test("window: an unreadable StartedAt degrades to null, never throws", () => {
  const window = observationWindow({ startedAt: "not-a-time", since: null, entries: [] });
  assert.equal(window.startedAt, null);
  assert.equal(window.days, 0);
});

test("window: the 7-day minimum is inclusive -- exactly 7 days qualifies, 6.9 days does not (edge 6.9 vs 7)", async () => {
  assert.equal(MIN_WINDOW_DAYS, 7);
  const sevenDays = [entry({ atMs: DAY0 }), entry({ atMs: DAY0 + 7 * DAY_MS })];
  const seven = await generateReport({ logText: logText(sevenDays), startedAt: null, since: null, env: {} });
  assert.equal(seven.report.recommendations.egress.verdict, "safe");

  const sixPointNine = [entry({ atMs: DAY0 }), entry({ atMs: DAY0 + 6.9 * DAY_MS })];
  const shy = await generateReport({ logText: logText(sixPointNine), startedAt: null, since: null, env: {} });
  assert.equal(shy.report.recommendations.egress.verdict, "not yet");
  assert.match(shy.report.recommendations.egress.reasons.join("\n"), /6\.9 days .* below the 7-day minimum/);
});

// --- recommendation rule (egress) ---

test("egress: a would-be denial from a KNOWN caller blocks 'safe' and names the host (edge: denial blocks despite a 30-day window)", async () => {
  const entries = [
    entry({ atMs: DAY0 }),
    entry({ atMs: DAY0 + 30 * DAY_MS }),
    entry({ targetHost: "partner.example.net", hostAllowed: false, atMs: DAY0 + 10 * DAY_MS }),
  ];
  const { report } = await generateReport({ logText: logText(entries), startedAt: null, since: null, env: {} });
  assert.equal(report.recommendations.egress.verdict, "not yet");
  assert.match(report.recommendations.egress.reasons.join("\n"), /llm-handler.*partner\.example\.net/);
});

test("egress: a would-be denial from an UNKNOWN caller does not block 'safe' on its own (it is reported, not the flip gate)", async () => {
  const entries = [
    entry({ atMs: DAY0 }),
    entry({ atMs: DAY0 + 8 * DAY_MS }),
    entry({ caller: "rogue", knownCaller: false, hostAllowed: false, atMs: DAY0 + 2 * DAY_MS }),
  ];
  const { report } = await generateReport({ logText: logText(entries), startedAt: null, since: null, env: {} });
  assert.equal(report.recommendations.egress.verdict, "safe");
  assert.equal(report.callers.find((c) => c.caller === "rogue").hostAllowedFalse, 1);
});

test("egress: a known-caller entry with no boolean hostAllowed is not evidence of safety and blocks 'safe'", async () => {
  const legacy = { caller: "llm-handler", targetHost: "api.anthropic.com", knownCaller: true, timestamp: iso(DAY0 + 8 * DAY_MS) };
  const entries = [entry({ atMs: DAY0 }), legacy];
  const { report } = await generateReport({ logText: logText(entries), startedAt: null, since: null, env: {} });
  assert.equal(report.recommendations.egress.verdict, "not yet");
  assert.match(report.recommendations.egress.reasons.join("\n"), /lack a boolean hostAllowed/);
});

test("egress: zero audit entries is 'not yet' with the insufficient-window reason, never 'safe'", async () => {
  const { report } = await generateReport({ logText: "services/broker listening on 127.0.0.1:8300", startedAt: null, since: null, env: {} });
  assert.equal(report.recommendations.egress.verdict, "not yet");
  assert.match(report.recommendations.egress.reasons.join("\n"), /below the 7-day minimum/);
  assert.equal(report.counts.nonJsonLines, 1);
});

// --- spend ---

test("spend: with no spend env the budget recommendation is exactly the dark message and no network call is made", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("must not fetch");
  };
  const { report, markdown } = await generateReport({
    logText: logText([entry()]),
    startedAt: null,
    since: null,
    env: { SUPABASE_URL: "https://only-url.supabase.co" },
    fetchImpl,
  });
  assert.equal(called, false, "one of the two env vars alone must not provision spend");
  assert.equal(report.spend.status, "not provisioned");
  assert.equal(report.recommendations.budget.verdict, "dark");
  assert.equal(report.recommendations.budget.reason, "spend not provisioned (budget check dark)");
  assert.match(markdown, /spend not provisioned \(budget check dark\)/);
});

test("spend: p99 uses nearest-rank over per-UTC-day totals; 100 days of 1..100 USD gives p99 = 99 and suggestion 198", () => {
  const rows = [];
  for (let day = 1; day <= 100; day += 1) {
    rows.push({ caller: "llm-handler", ts: iso(DAY0 + day * DAY_MS), cost_usd: day });
  }
  const [summary] = spendByCaller(rows);
  assert.equal(summary.caller, "llm-handler");
  assert.equal(summary.days, 100);
  assert.equal(summary.p99DailyUsd, 99);
  assert.equal(summary.suggestedMaxUsdPerDay, 198);
});

test("spend: rows on the same UTC day are summed before the percentile, and callers are kept apart", () => {
  const rows = [
    { caller: "llm-handler", ts: iso(DAY0 + 1000), cost_usd: "1.5" },
    { caller: "llm-handler", ts: iso(DAY0 + 2000), cost_usd: "2.5" },
    { caller: "brain", ts: iso(DAY0 + 3000), cost_usd: 0.75 },
  ];
  const summaries = Object.fromEntries(spendByCaller(rows).map((s) => [s.caller, s]));
  assert.equal(summaries["llm-handler"].days, 1);
  assert.equal(summaries["llm-handler"].p99DailyUsd, 4, "string numerics from PostgREST are summed as numbers");
  assert.equal(summaries["llm-handler"].suggestedMaxUsdPerDay, 8);
  assert.equal(summaries.brain.p99DailyUsd, 0.75);
});

test("spend: a provisioned ledger produces per-caller suggestions and the budget verdict is 'suggested'", async () => {
  const rows = [0, 1, 2].map((d) => ({ caller: "llm-handler", ts: iso(DAY0 + d * DAY_MS), cost_usd: 3 }));
  const { report } = await generateReport({
    logText: logText([entry()]),
    startedAt: null,
    since: null,
    env: { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" },
    fetchImpl: pagedFetch(rows),
    now: new Date(DAY0 + 10 * DAY_MS),
  });
  assert.equal(report.spend.status, "provisioned");
  assert.equal(report.recommendations.budget.verdict, "suggested");
  assert.equal(report.spend.callers[0].suggestedMaxUsdPerDay, 6);
});

test("spend: the ledger is read with GET only, against the core-profile broker_call table, paged, with a lookback filter", async () => {
  const requests = [];
  const rows = [{ caller: "llm-handler", ts: iso(DAY0), cost_usd: 1 }];
  const fetchImpl = async (url, init) => {
    requests.push({ url: new URL(url), method: init?.method ?? "GET", headers: init?.headers ?? {} });
    return jsonResponse(rows);
  };
  await fetchSpendRows({
    config: { supabaseUrl: "https://ref.supabase.co", serviceRoleKey: "k" },
    now: new Date(DAY0 + 10 * DAY_MS),
    fetchImpl,
  });
  assert.equal(requests.length, 1);
  const [req] = requests;
  assert.equal(req.method, "GET");
  assert.equal(req.url.pathname, "/rest/v1/broker_call");
  assert.equal(req.url.searchParams.get("select"), "caller,ts,cost_usd");
  assert.match(req.url.searchParams.get("ts") ?? "", /^gte\.\d{4}-\d{2}-\d{2}T/);
  assert.equal(req.headers["Accept-Profile"], "core");
  assert.equal(req.headers["Content-Profile"], undefined);
});

test("spend: pages until a short page, so a ledger larger than one page is read in full", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ caller: "llm-handler", ts: iso(DAY0 + i * DAY_MS), cost_usd: 1 }));
  const fetched = await fetchSpendRows({
    config: { supabaseUrl: "https://ref.supabase.co", serviceRoleKey: "k" },
    now: new Date(DAY0 + 10 * DAY_MS),
    fetchImpl: pagedFetch(rows),
    pageSize: 2,
  });
  assert.equal(fetched.length, 5);
});

test("spend: a failed spend query degrades to 'query failed' and never fails the report", async () => {
  const { report, markdown } = await generateReport({
    logText: logText([entry()]),
    startedAt: null,
    since: null,
    env: { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" },
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  assert.equal(report.spend.status, "query failed");
  assert.equal(report.recommendations.budget.verdict, "dark");
  assert.match(markdown, /spend query failed/);
});

test("spend config: only a complete URL + key pair provisions spend; the values come only from the given env", () => {
  assert.equal(spendConfigFromEnv({}), null);
  assert.equal(spendConfigFromEnv({ SUPABASE_URL: "https://x" }), null);
  assert.equal(spendConfigFromEnv({ SUPABASE_SERVICE_ROLE_KEY: "k" }), null);
  assert.deepEqual(spendConfigFromEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }), {
    supabaseUrl: "https://x.supabase.co",
    serviceRoleKey: "k",
  });
});

// --- rendering and secrets ---

test("rendering: Markdown table cells are escaped, so a caller-supplied pipe or newline cannot break or forge the table", async () => {
  const hostile = entry({ caller: "evil|caller\n## forged", targetHost: "a`b.example" });
  const { markdown } = await generateReport({ logText: logText([hostile]), startedAt: null, since: null, env: {} });
  assert.doesNotMatch(markdown, /\n## forged/);
  assert.match(markdown, /evil\\\|caller/);
});

test("no secrets: env-like values, including a secret that appears in a fetch error, never reach the Markdown or JSON output", async () => {
  const env = {
    SUPABASE_URL: "https://secret-project-ref.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_TESTVALUE_123",
  };
  const failing = await generateReport({
    logText: logText([entry()]),
    startedAt: null,
    since: null,
    env,
    fetchImpl: async () => {
      throw new Error("connect failed: https://secret-project-ref.supabase.co sb_secret_TESTVALUE_123");
    },
  });
  const succeeding = await generateReport({
    logText: logText([entry({ estimatedCostUsd: 0.1 })]),
    startedAt: null,
    since: null,
    env,
    fetchImpl: pagedFetch([{ caller: "llm-handler", ts: iso(DAY0), cost_usd: 1 }]),
  });
  for (const output of [failing, succeeding]) {
    const everything = `${output.markdown}\n${output.json}`;
    assert.doesNotMatch(everything, /sb_secret_TESTVALUE_123/);
    assert.doesNotMatch(everything, /secret-project-ref/);
    assert.doesNotMatch(everything, /SUPABASE_SERVICE_ROLE_KEY/);
  }
});

test("report JSON is stable: schemaVersion, window, counts, callers, spend and recommendations are present, and no env-derived key is", async () => {
  const { report, json } = await generateReport({ logText: logText([entry()]), startedAt: null, since: "2026-10-01T00:00:00Z", env: {} });
  assert.equal(report.schemaVersion, 1);
  for (const key of ["generatedAt", "window", "counts", "callers", "spend", "recommendations"]) {
    assert.ok(key in report, `missing ${key}`);
  }
  assert.equal(report.window.since, "2026-10-01T00:00:00Z");
  assert.deepEqual(Object.keys(report).sort(), ["callers", "counts", "generatedAt", "recommendations", "schemaVersion", "spend", "window"]);
  assert.equal(JSON.parse(json).schemaVersion, 1);
  assert.equal(renderMarkdown(report).includes("| caller |"), true);
});

// --- helpers ---

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A PostgREST-shaped fake honoring limit/offset, so paging is exercised for real. */
function pagedFetch(rows) {
  return async (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit") ?? rows.length);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    return jsonResponse(rows.slice(offset, offset + limit));
  };
}
