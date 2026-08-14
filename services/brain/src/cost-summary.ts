/**
 * Pure aggregation over `store.ts`'s `CostDetail` rows (m6-02, 07-brain-
 * architecture.md section 7.9's "Cost dashboard... per run, per task, per
 * harness, per day"). Separated from the store/HTTP layers for the same
 * reason `registry.ts`'s `buildListToolsParams` is separately exported in
 * `packages/platform-client`: this is exactly the kind of grouping logic a
 * bug could silently drop a bucket from, so it is tested against plain
 * objects, no database required.
 *
 * This is the ONE place in the whole Brain cost model that can answer "per
 * task" or "per harness" at all -- the platform `core` mirror
 * (core-mirror.ts) only ever receives one row per RUN (a single summed
 * total), because `core.cost` has no task/harness columns and never will
 * (m6-02's own scope note: "no new tables"). Anything finer than "per run"
 * exists only in this SQLite database, which is why the dashboard reads it
 * from Brain's own HTTP API rather than through the platform session.
 */
import type { CostDetail } from "./store.ts";

export interface CostBucket {
  key: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  usdEstimate: number;
}

export interface CostSummary {
  byRun: CostBucket[];
  byTask: CostBucket[];
  byHarness: CostBucket[];
  byDay: CostBucket[];
}

function emptyBucket(key: string): CostBucket {
  return { key, count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, usdEstimate: 0 };
}

function addInto(bucket: CostBucket, row: CostDetail): void {
  bucket.count += 1;
  bucket.inputTokens += row.inputTokens;
  bucket.outputTokens += row.outputTokens;
  bucket.cacheReadTokens += row.cacheReadTokens;
  bucket.usdEstimate += row.usdEstimate ?? 0;
}

/** Groups by an arbitrary key function, preserving first-seen order (rows
 * arrive pre-sorted by `recorded_at asc` from the store, so this reads as
 * "oldest run/task/harness/day first" without a separate sort step). */
function groupBy(rows: CostDetail[], keyOf: (row: CostDetail) => string): CostBucket[] {
  const byKey = new Map<string, CostBucket>();
  for (const row of rows) {
    const key = keyOf(row);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = emptyBucket(key);
      byKey.set(key, bucket);
    }
    addInto(bucket, row);
  }
  return [...byKey.values()];
}

/** UTC calendar date the cost row was recorded on. `recordedAt` is always
 * an ISO-8601 string with a `Z`/offset suffix (every writer in this
 * codebase uses `new Date().toISOString()`), so the first 10 characters
 * are exactly `YYYY-MM-DD` in UTC -- no `Date` parsing/re-formatting
 * needed, and no local-timezone ambiguity to get wrong. */
function dayKey(recordedAt: string): string {
  return recordedAt.slice(0, 10);
}

export function summarizeCostDetails(rows: CostDetail[]): CostSummary {
  return {
    byRun: groupBy(rows, (r) => r.runId),
    byTask: groupBy(rows, (r) => r.taskId),
    byHarness: groupBy(rows, (r) => r.harness),
    byDay: groupBy(rows, (r) => dayKey(r.recordedAt)),
  };
}
