// Broker soak report (hyperbolic-core#466). Reads the guards broker's own
// audit log and says whether the two log-only enforcement flips are safe:
//   - egress host-allowlist (#187): the broker logs `hostAllowed` per request
//     but never refuses on it. A flip is safe only when no KNOWN caller has
//     been denied by it, and the observed window is at least 7 days.
//   - budget 429 (#200): the broker logs `budgetWouldExceed` against
//     core.broker_call. A suggested per-caller cap is 2 x p99 of that
//     caller's daily spend, when the ledger is provisioned.
//
// Pure except for the optional spend read (a single GET against PostgREST,
// the only network call here). Only the fields below are ever copied into
// the report, so an unexpected field added to a broker log line cannot leak
// into the uploaded artifact. The report carries callers, hosts, counts,
// timestamps, and USD sums, and never anything read from the environment.
//
// CLI (run by ops-broker-soak-report.yml):
//   node docs/ops/broker-soak-report.mjs --log <docker-logs.txt> \
//     [--started-at-file <file>] [--since <iso>] --json <out.json> --markdown <out.md>

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AUDIT_EVENT = "broker_proxy_request";
export const MIN_WINDOW_DAYS = 7;
export const SPEND_LOOKBACK_DAYS = 90;
export const SPEND_PAGE_SIZE = 1000;
const MAX_SPEND_PAGES = 100;
const DAY_MS = 86_400_000;
const DOCKER_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/;
const ISO_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

/** Floors to two decimals; the epsilon absorbs float noise, and ms-granular inputs never sit within it of a boundary. */
function floor2(value) {
  return Math.floor(value * 100 + 1e-9) / 100;
}

/** RFC3339 (nanosecond-capable) to millisecond ISO-8601 UTC, or null. */
export function normalizeIso(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const millis = (match[2] ?? "0").padEnd(3, "0").slice(0, 3);
  const ms = Date.parse(`${match[1]}.${millis}${match[3]}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Parses `docker logs --timestamps` output. Each line is an RFC3339Nano docker
 * timestamp, a space, then the broker's own line. Non-JSON lines (the startup
 * banner, a truncated write) and JSON that is not an audit entry are counted
 * and skipped, never thrown on.
 */
export function parseAuditLog(text) {
  const counts = { lines: 0, auditEntries: 0, nonJsonLines: 0, otherEventLines: 0, malformedAuditLines: 0 };
  const entries = [];
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    counts.lines += 1;

    const docker = DOCKER_TIMESTAMP.exec(line);
    const dockerTimestamp = docker ? normalizeIso(docker[1]) : null;
    const body = docker ? docker[2] : line;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      counts.nonJsonLines += 1;
      continue;
    }
    if (!isObject(parsed)) {
      counts.nonJsonLines += 1;
      continue;
    }
    if (parsed.event !== AUDIT_EVENT) {
      counts.otherEventLines += 1;
      continue;
    }
    if (typeof parsed.caller !== "string" || typeof parsed.targetHost !== "string") {
      counts.malformedAuditLines += 1;
      continue;
    }
    counts.auditEntries += 1;
    // Explicit field pick: only what the report needs is ever kept.
    entries.push({
      caller: parsed.caller,
      targetHost: parsed.targetHost,
      knownCaller: parsed.knownCaller,
      hostAllowed: parsed.hostAllowed,
      credentialRequested: parsed.credentialRequested,
      credentialGranted: parsed.credentialGranted,
      estimatedCostUsd: parsed.estimatedCostUsd,
      spentTodayUsd: parsed.spentTodayUsd,
      budgetWouldExceed: parsed.budgetWouldExceed,
      timestamp: normalizeIso(parsed.timestamp) ?? dockerTimestamp,
    });
  }
  return { entries, counts };
}

/** One row per caller x targetHost. A would-be denial is hostAllowed === false, never its absence. */
export function summarizeCallers(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.caller}\u0000${entry.targetHost}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        caller: entry.caller,
        targetHost: entry.targetHost,
        knownCaller: entry.knownCaller === true,
        total: 0,
        hostAllowedFalse: 0,
        hostAllowedMissing: 0,
        knownCallerFalse: 0,
        budgetWouldExceedTrue: 0,
        estimatedCostUsdTotal: 0,
      };
      groups.set(key, group);
    }
    group.total += 1;
    if (entry.hostAllowed === false) group.hostAllowedFalse += 1;
    if (typeof entry.hostAllowed !== "boolean") group.hostAllowedMissing += 1;
    if (entry.knownCaller === false) group.knownCallerFalse += 1;
    if (entry.budgetWouldExceed === true) group.budgetWouldExceedTrue += 1;
    if (typeof entry.estimatedCostUsd === "number" && Number.isFinite(entry.estimatedCostUsd)) {
      group.estimatedCostUsdTotal = round4(group.estimatedCostUsdTotal + entry.estimatedCostUsd);
    }
  }
  return [...groups.values()].sort(
    (a, b) => a.caller.localeCompare(b.caller) || a.targetHost.localeCompare(b.targetHost),
  );
}

/**
 * The observed window runs from the first to the last audit entry, so it
 * counts only traffic actually seen in the logs. Log rotation can only shorten
 * it, which is the conservative direction for a flip decision. The container's
 * StartedAt is reported alongside but does not widen the window.
 */
export function observationWindow({ startedAt, since, entries }) {
  const times = entries
    .map((entry) => Date.parse(entry.timestamp ?? ""))
    .filter((ms) => Number.isFinite(ms));
  const first = times.length > 0 ? Math.min(...times) : null;
  const last = times.length > 0 ? Math.max(...times) : null;
  return {
    startedAt: normalizeIso(startedAt),
    since: typeof since === "string" && since !== "" ? since : null,
    firstEntryAt: first === null ? null : new Date(first).toISOString(),
    lastEntryAt: last === null ? null : new Date(last).toISOString(),
    days: first === null ? 0 : floor2((last - first) / DAY_MS),
  };
}

function egressRecommendation(windowInfo, callers, totalEntries) {
  const reasons = [];
  for (const row of callers) {
    if (row.knownCaller && row.hostAllowedFalse > 0) {
      reasons.push(
        `known caller "${row.caller}" would be denied ${row.hostAllowedFalse} time(s) for host "${row.targetHost}" (log-only #187)`,
      );
    }
  }
  for (const row of callers) {
    if (row.knownCaller && row.hostAllowedMissing > 0) {
      reasons.push(
        `${row.hostAllowedMissing} audit entries for known caller "${row.caller}" -> "${row.targetHost}" lack a boolean hostAllowed, so they are not evidence of safety`,
      );
    }
  }
  if (totalEntries === 0) {
    reasons.push("no audit entries observed");
  }
  if (windowInfo.days < MIN_WINDOW_DAYS) {
    reasons.push(`observation window ${windowInfo.days} days is below the ${MIN_WINDOW_DAYS}-day minimum`);
  }
  return { verdict: reasons.length === 0 ? "safe" : "not yet", reasons };
}

function nearestRank(sortedAscending, percentile) {
  // Integer arithmetic on purpose: 0.99 * n is not exact in floating point.
  const rank = Math.ceil((sortedAscending.length * percentile) / 100);
  return sortedAscending[Math.max(rank, 1) - 1];
}

/** Per caller: the p99 (nearest-rank) of its daily USD totals (UTC days with at least one row), and 2 x p99 as the suggested cap. */
export function spendByCaller(rows) {
  const perCaller = new Map();
  for (const row of rows) {
    const cost = Number(row?.cost_usd);
    const at = Date.parse(row?.ts ?? "");
    if (typeof row?.caller !== "string" || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(at)) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    if (!perCaller.has(row.caller)) perCaller.set(row.caller, new Map());
    const days = perCaller.get(row.caller);
    days.set(day, (days.get(day) ?? 0) + cost);
  }
  return [...perCaller.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([caller, days]) => {
      const totals = [...days.values()].map(round4).sort((a, b) => a - b);
      const p99DailyUsd = nearestRank(totals, 99);
      return {
        caller,
        days: totals.length,
        p99DailyUsd,
        suggestedMaxUsdPerDay: round4(2 * p99DailyUsd),
      };
    });
}

/** Both URL and key must be present, or spend stays dark. The values are only ever used to build the request. */
export function spendConfigFromEnv(env) {
  const supabaseUrl = env?.SUPABASE_URL;
  const serviceRoleKey = env?.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof supabaseUrl !== "string" || supabaseUrl === "" || typeof serviceRoleKey !== "string" || serviceRoleKey === "") {
    return null;
  }
  return { supabaseUrl, serviceRoleKey };
}

/**
 * Reads core.broker_call with GET only, through the core profile, paged by
 * limit/offset in id order. Throws on any non-OK response, with the status
 * alone (never the body or the request URL), so a failure can't echo a
 * secret into the log.
 */
export async function fetchSpendRows({ config, now = new Date(), fetchImpl = globalThis.fetch, pageSize = SPEND_PAGE_SIZE }) {
  const since = new Date(now.getTime() - SPEND_LOOKBACK_DAYS * DAY_MS).toISOString();
  const base = config.supabaseUrl.replace(/\/+$/, "");
  const rows = [];
  for (let page = 0; page < MAX_SPEND_PAGES; page += 1) {
    const url = new URL(`${base}/rest/v1/broker_call`);
    url.searchParams.set("select", "caller,ts,cost_usd");
    url.searchParams.set("ts", `gte.${since}`);
    url.searchParams.set("order", "id.asc");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        Accept: "application/json",
        "Accept-Profile": "core",
      },
    });
    if (!response.ok) {
      throw new Error(`spend query returned HTTP ${response.status}`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) {
      throw new Error("spend query returned a non-array body");
    }
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error("spend ledger exceeds the paging cap");
}

function budgetRecommendation(spend) {
  if (spend.status === "not provisioned") {
    return { verdict: "dark", reason: "spend not provisioned (budget check dark)", callers: [] };
  }
  if (spend.status === "query failed") {
    return { verdict: "dark", reason: "spend query failed (budget check dark)", callers: [] };
  }
  if (spend.callers.length === 0) {
    return { verdict: "not yet", reason: "no spend rows in the lookback (nothing to size a cap from)", callers: [] };
  }
  return { verdict: "suggested", reason: null, callers: spend.callers };
}

/**
 * Builds the report from one broker log. Spend is read only when both
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are present; a failed read
 * degrades to "query failed", never to a failed report.
 */
export async function generateReport({ logText, startedAt = null, since = null, env = {}, fetchImpl = globalThis.fetch, now = new Date() }) {
  if (since !== null && since !== "" && !ISO_INPUT.test(since)) {
    throw new Error("since must be an ISO-8601 timestamp");
  }
  const { entries, counts } = parseAuditLog(logText);
  const windowInfo = observationWindow({ startedAt, since, entries });
  const callers = summarizeCallers(entries);

  let spend;
  const config = spendConfigFromEnv(env);
  if (config === null) {
    spend = { status: "not provisioned", lookbackDays: SPEND_LOOKBACK_DAYS, callers: [] };
  } else {
    try {
      const rows = await fetchSpendRows({ config, now, fetchImpl });
      spend = { status: "provisioned", lookbackDays: SPEND_LOOKBACK_DAYS, callers: spendByCaller(rows) };
    } catch {
      spend = { status: "query failed", lookbackDays: SPEND_LOOKBACK_DAYS, callers: [] };
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    window: windowInfo,
    counts,
    callers,
    spend,
    recommendations: {
      egress: egressRecommendation(windowInfo, callers, entries.length),
      budget: budgetRecommendation(spend),
    },
  };
  return {
    report,
    markdown: renderMarkdown(report),
    json: `${JSON.stringify(report, null, 2)}\n`,
  };
}

/** Caller-supplied strings reach the table, so pipes, backticks, and control characters are neutralized. */
function cell(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'");
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("## Broker soak report (#466)", "");
  lines.push(`- Container started: ${cell(report.window.startedAt ?? "unknown")}`);
  lines.push(`- Log window: ${cell(report.window.firstEntryAt ?? "no audit entries")} to ${cell(report.window.lastEntryAt ?? "no audit entries")} (${report.window.days} days)`);
  if (report.window.since) lines.push(`- Read since: ${cell(report.window.since)}`);
  lines.push(
    `- Log lines: ${report.counts.lines} read, ${report.counts.auditEntries} audit entries, skipped ${report.counts.nonJsonLines} non-JSON, ${report.counts.otherEventLines} other-event, ${report.counts.malformedAuditLines} malformed`,
    "",
  );

  lines.push(`### Egress allowlist (#187, log-only): **${report.recommendations.egress.verdict}**`, "");
  if (report.recommendations.egress.reasons.length === 0) {
    lines.push("- No known caller would have been denied, and the window meets the minimum.");
  } else {
    for (const reason of report.recommendations.egress.reasons) lines.push(`- ${cell(reason)}`);
  }
  lines.push("", "| caller | host | known | total | would-deny | unknown caller | budget would-exceed | est. USD |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  if (report.callers.length === 0) {
    lines.push("| _no audit entries_ | | | | | | | |");
  }
  for (const row of report.callers) {
    lines.push(
      `| ${cell(row.caller)} | ${cell(row.targetHost)} | ${row.knownCaller ? "yes" : "no"} | ${row.total} | ${row.hostAllowedFalse} | ${row.knownCallerFalse} | ${row.budgetWouldExceedTrue} | ${row.estimatedCostUsdTotal} |`,
    );
  }

  lines.push("", `### Budget (#200): **${report.recommendations.budget.verdict}**`, "");
  if (report.recommendations.budget.reason) {
    lines.push(cell(report.recommendations.budget.reason));
  } else {
    lines.push(`Lookback ${report.spend.lookbackDays} days. Suggested cap is 2 x p99 of daily spend.`, "");
    lines.push("| caller | days with spend | p99 daily (USD) | suggested maxUsdPerDay (USD) |", "| --- | --- | --- | --- |");
    for (const row of report.recommendations.budget.callers) {
      lines.push(`| ${cell(row.caller)} | ${row.days} | ${row.p99DailyUsd} | ${row.suggestedMaxUsdPerDay} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`expected --flag value pairs, got "${flag}"`);
    }
    args[flag.slice(2)] = value;
  }
  for (const required of ["log", "json", "markdown"]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const logText = readFileSync(args.log, "utf8");
  const startedAt = args["started-at-file"] ? readFileSync(args["started-at-file"], "utf8").trim() : null;
  const { report, markdown, json } = await generateReport({
    logText,
    startedAt,
    since: args.since ?? null,
    env: process.env,
  });
  writeFileSync(args.json, json);
  writeFileSync(args.markdown, `${markdown}\n`);
  process.stdout.write(
    `broker soak report: egress=${report.recommendations.egress.verdict} budget=${report.recommendations.budget.verdict} spend=${report.spend.status}\n`,
  );
}
