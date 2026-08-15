// Platform cost dashboard (m6-02, docs/planning/issues/m6-02-feat-shell-
// cost-dashboard.md): read-only queries through the platform session
// against core.run/core.cost/core.llm_call, no new tables. Same raw-fetch
// PostgREST convention every other Shell data module uses (prompts.ts,
// intake.ts): explicit apikey/Authorization/*-Profile headers carrying the
// CALLER's own session JWT -- owner_rw RLS is the real authorization
// boundary, not this module.
//
// Scope note (m6-02 investigation): the issue's own wording asks for Brain
// cost "per run, per task, per harness, per day". core.cost's primary key
// is run_id -- literally one row per run -- so only per-run and per-day
// are things Postgres actually holds; per-task/per-harness granularity
// exists only in the Brain's own local SQLite (services/brain/src/store.ts)
// and has no HTTP route exposing it, so a browser-side reader has no path
// to it at all without a new table or a new Brain endpoint (out of this
// issue's "no new tables"/Shell-only scope, and the user's own call:
// narrow this panel to what core.cost genuinely supports today). Grouping
// (by day; by caller_app/purpose) is done client-side, matching prompts.ts's
// own established reasoning: no dependency on PostgREST's optional
// aggregate-embed feature, which is not guaranteed enabled on every
// project.
import { postgrestFor } from "./postgrest";

const postgrest = postgrestFor("cost-client", "core");

export interface BrainRunCost {
  runId: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  wallClockMs: number;
  usd: number;
}

export interface DailyBrainCost {
  date: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface LlmCallGroup {
  callerApp: string;
  purpose: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

interface RawRun {
  id: string;
  started_at: string;
  ended_at: string | null;
  status: string;
}

interface RawCost {
  run_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  wall_clock_ms: number;
  usd: number;
}

interface RawLlmCall {
  caller_app: string;
  purpose: string;
  input_tokens: number;
  output_tokens: number;
  usd_estimate: number | null;
}



/** core-mirror.ts's own literal call: `p_app_id: "brain", p_kind: "run"`
 * (services/brain/src/core-mirror.ts) -- the only rows this dashboard's
 * "Brain cost" half is about. Two separate queries, joined client-side by
 * run_id, rather than a `cost(...)` resource embed: core.cost.run_id is
 * core.run's own primary key reference, so an embed's to-one/to-many shape
 * is not worth depending on when a plain Map join is this cheap.
 *
 * Fired concurrently via Promise.all, not sequentially: the cost query
 * has no run_id filter (fetches every core.cost row, matching prompts.ts's
 * own established "over-fetch, join client-side" convention for
 * fetchUsageCounts) specifically so it never has to wait on the run
 * query's own result first. Two sequential round trips measured well
 * inside the 500ms p95 render budget in this sandbox but blew past it on
 * a slower/busier real CI runner -- removing the artificial sequencing
 * dependency, not raising the budget, is the actual fix. */
export async function listBrainRunCosts(limit = 200): Promise<BrainRunCost[]> {
  const [runsRes, costsRes] = await Promise.all([
    postgrest(`/run?app_id=eq.brain&kind=eq.run&select=id,started_at,ended_at,status&order=started_at.desc&limit=${limit}`),
    postgrest(`/cost?select=run_id,input_tokens,output_tokens,cache_read_tokens,wall_clock_ms,usd`),
  ]);
  const runs = (await runsRes.json()) as RawRun[];
  const costs = (await costsRes.json()) as RawCost[];
  const byRunId = new Map(costs.map((c) => [c.run_id, c]));

  return runs.map((run) => {
    const cost = byRunId.get(run.id);
    return {
      runId: run.id,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      status: run.status,
      inputTokens: cost?.input_tokens ?? 0,
      outputTokens: cost?.output_tokens ?? 0,
      cacheReadTokens: cost?.cache_read_tokens ?? 0,
      wallClockMs: cost?.wall_clock_ms ?? 0,
      usd: cost?.usd ?? 0,
    };
  });
}

/** started_at's own UTC calendar date, not the browser's local date --
 * core.run.started_at is a timestamptz; slicing its ISO representation
 * keeps "per day" grouping stable regardless of which timezone the
 * dashboard happens to be viewed from. */
function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

export function groupBrainCostByDay(runs: BrainRunCost[]): DailyBrainCost[] {
  const byDate = new Map<string, DailyBrainCost>();
  for (const run of runs) {
    const date = utcDate(run.startedAt);
    const bucket = byDate.get(date) ?? { date, runs: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    bucket.runs += 1;
    bucket.inputTokens += run.inputTokens;
    bucket.outputTokens += run.outputTokens;
    bucket.usd += run.usd;
    byDate.set(date, bucket);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** `sinceIso` bounds the window (default: last 30 days) -- core.llm_call
 * carries 180 days of retention (20260814140000_core_llm_call.sql's own
 * purge job), and this dashboard has no reason to pull the full window on
 * every render. */
export async function listLlmCallGroups(sinceIso?: string, limit = 2000): Promise<LlmCallGroup[]> {
  const since = sinceIso ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await postgrest(
    `/llm_call?ts=gte.${encodeURIComponent(since)}&select=caller_app,purpose,input_tokens,output_tokens,usd_estimate&order=ts.desc&limit=${limit}`
  );
  const rows = (await res.json()) as RawLlmCall[];

  const byKey = new Map<string, LlmCallGroup>();
  for (const row of rows) {
    // Composite map key. The separator is an escaped NUL rather than a
    // literal one: a literal NUL byte in the source makes git classify
    // this whole file as binary, so it gets no line-level diffs in review.
    // Same runtime key, and still a byte no caller_app or purpose can contain.
    const key = `${row.caller_app}\u0000${row.purpose}`;
    const bucket = byKey.get(key) ?? {
      callerApp: row.caller_app,
      purpose: row.purpose,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
    };
    bucket.calls += 1;
    bucket.inputTokens += row.input_tokens;
    bucket.outputTokens += row.output_tokens;
    bucket.usd += row.usd_estimate ?? 0;
    byKey.set(key, bucket);
  }
  return [...byKey.values()].sort((a, b) => b.usd - a.usd);
}
