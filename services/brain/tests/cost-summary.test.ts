// m6-02: pure grouping logic, no database. The bar this file exists to
// meet: a bug here could silently drop or merge a bucket (two different
// runs collapsing into one row, or a harness never appearing at all) and
// nothing downstream would notice -- so every grouping dimension gets its
// own assertion against a fixture set that deliberately spans more than
// one value per dimension.
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCostDetails } from "../src/cost-summary.ts";
import type { CostDetail } from "../src/store.ts";

function detail(overrides: Partial<CostDetail>): CostDetail {
  return {
    id: "cost-1",
    taskId: "task-1",
    invocationId: "inv-1",
    runId: "run-1",
    harness: "claude-code",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    usdEstimate: 0.5,
    recordedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function findBucket(buckets: { key: string }[], key: string) {
  const bucket = buckets.find((b) => b.key === key);
  assert.ok(bucket, `expected a bucket for key "${key}"`);
  return bucket!;
}

test("summarizeCostDetails: a single row appears once in every one of the four breakdowns", () => {
  const summary = summarizeCostDetails([detail({})]);
  assert.equal(summary.byRun.length, 1);
  assert.equal(summary.byTask.length, 1);
  assert.equal(summary.byHarness.length, 1);
  assert.equal(summary.byDay.length, 1);
});

test("summarizeCostDetails: sums tokens/usd/count correctly within a shared bucket", () => {
  const rows = [
    detail({ id: "c1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, usdEstimate: 0.5 }),
    detail({ id: "c2", inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, usdEstimate: 0.1 }),
  ];
  const summary = summarizeCostDetails(rows);
  const bucket = findBucket(summary.byRun, "run-1");
  assert.equal(bucket.count, 2);
  assert.equal(bucket.inputTokens, 120);
  assert.equal(bucket.outputTokens, 55);
  assert.equal(bucket.cacheReadTokens, 10);
  assert.equal(bucket.usdEstimate, 0.6);
});

test("summarizeCostDetails: two distinct runs never merge into one bucket", () => {
  const rows = [detail({ id: "c1", runId: "run-1" }), detail({ id: "c2", runId: "run-2" })];
  const summary = summarizeCostDetails(rows);
  assert.equal(summary.byRun.length, 2);
  assert.ok(summary.byRun.some((b) => b.key === "run-1"));
  assert.ok(summary.byRun.some((b) => b.key === "run-2"));
});

test("summarizeCostDetails: per-task breakdown, including a retried task with two invocations under the same task", () => {
  const rows = [
    detail({ id: "c1", taskId: "task-1", invocationId: "inv-1", inputTokens: 100 }),
    detail({ id: "c2", taskId: "task-1", invocationId: "inv-2", inputTokens: 200 }),
    detail({ id: "c3", taskId: "task-2", invocationId: "inv-3", inputTokens: 50 }),
  ];
  const summary = summarizeCostDetails(rows);
  assert.equal(summary.byTask.length, 2);
  assert.equal(findBucket(summary.byTask, "task-1").inputTokens, 300);
  assert.equal(findBucket(summary.byTask, "task-1").count, 2);
  assert.equal(findBucket(summary.byTask, "task-2").inputTokens, 50);
});

test("summarizeCostDetails: per-harness breakdown separates a harness-fallback retry from its original attempt", () => {
  const rows = [
    detail({ id: "c1", harness: "codex", invocationId: "inv-1" }),
    detail({ id: "c2", harness: "codex", invocationId: "inv-2" }),
    detail({ id: "c3", harness: "gemini", invocationId: "inv-3" }),
  ];
  const summary = summarizeCostDetails(rows);
  assert.equal(summary.byHarness.length, 2);
  assert.equal(findBucket(summary.byHarness, "codex").count, 2);
  assert.equal(findBucket(summary.byHarness, "gemini").count, 1);
});

test("summarizeCostDetails: per-day breakdown groups by UTC calendar date, not by exact timestamp", () => {
  const rows = [
    detail({ id: "c1", recordedAt: "2026-01-01T00:00:01.000Z" }),
    detail({ id: "c2", recordedAt: "2026-01-01T23:59:59.999Z" }),
    detail({ id: "c3", recordedAt: "2026-01-02T00:00:00.000Z" }),
  ];
  const summary = summarizeCostDetails(rows);
  assert.equal(summary.byDay.length, 2);
  assert.equal(findBucket(summary.byDay, "2026-01-01").count, 2);
  assert.equal(findBucket(summary.byDay, "2026-01-02").count, 1);
});

test("summarizeCostDetails: a null usdEstimate contributes zero, never NaN", () => {
  const summary = summarizeCostDetails([detail({ usdEstimate: null })]);
  assert.equal(summary.byRun[0]!.usdEstimate, 0);
});

test("summarizeCostDetails: an empty input produces four empty breakdowns, not an error", () => {
  const summary = summarizeCostDetails([]);
  assert.deepEqual(summary, { byRun: [], byTask: [], byHarness: [], byDay: [] });
});
