import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../src/store.ts";
import type { Approval, Cost, Invocation, Run, Task, TaskEdge } from "../src/types.ts";

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brain-store-")), "brain.db");
}

function fixtureRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return { id: "run-1", objective: "ship the thing", autonomy: 2, status: "planning", createdAt: now, updatedAt: now, ...overrides };
}

function fixtureTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    runId: "run-1",
    title: "do the thing",
    status: "pending",
    contractJson: JSON.stringify({ task_id: "task-1" }),
    resultJson: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

test("insertRun/getRun round-trips every field", () => {
  const store = new BrainStore(tmpDbPath());
  const run = fixtureRun();
  store.insertRun(run);
  assert.deepEqual(store.getRun(run.id), run);
  assert.equal(store.getRun("nope"), null);
});

test("updateRunStatus changes status and updatedAt only", () => {
  const store = new BrainStore(tmpDbPath());
  const run = fixtureRun();
  store.insertRun(run);
  store.updateRunStatus(run.id, "running", "2026-01-01T00:00:00.000Z");
  const reloaded = store.getRun(run.id);
  assert.equal(reloaded?.status, "running");
  assert.equal(reloaded?.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(reloaded?.objective, run.objective);
});

test("insertTask/getTask round-trips, and updateTaskStatus preserves fields it wasn't given", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  const task = fixtureTask();
  store.insertTask(task);
  assert.deepEqual(store.getTask(task.id), task);

  store.updateTaskStatus(task.id, "running", "2026-01-01T00:00:00.000Z", { startedAt: "2026-01-01T00:00:00.000Z" });
  const running = store.getTask(task.id);
  assert.equal(running?.status, "running");
  assert.equal(running?.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(running?.finishedAt, null);
  assert.equal(running?.contractJson, task.contractJson, "fields not passed to updateTaskStatus must survive unchanged");

  store.updateTaskStatus(task.id, "succeeded", "2026-01-01T01:00:00.000Z", {
    finishedAt: "2026-01-01T01:00:00.000Z",
    resultJson: JSON.stringify({ status: "succeeded" }),
  });
  const done = store.getTask(task.id);
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.startedAt, "2026-01-01T00:00:00.000Z", "startedAt set earlier must survive a later update that doesn't touch it");
  assert.equal(done?.resultJson, JSON.stringify({ status: "succeeded" }));
});

test("updateTaskStatus throws for an unknown task id rather than silently no-op'ing", () => {
  const store = new BrainStore(tmpDbPath());
  assert.throws(() => store.updateTaskStatus("nope", "running", new Date().toISOString()));
});

test("listTasksForRun returns only that run's tasks, oldest first", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun({ id: "run-a" }));
  store.insertRun(fixtureRun({ id: "run-b" }));
  store.insertTask(fixtureTask({ id: "t1", runId: "run-a", createdAt: "2026-01-01T00:00:00.000Z" }));
  store.insertTask(fixtureTask({ id: "t2", runId: "run-a", createdAt: "2026-01-01T00:01:00.000Z" }));
  store.insertTask(fixtureTask({ id: "t3", runId: "run-b" }));
  const forA = store.listTasksForRun("run-a");
  assert.deepEqual(forA.map((t) => t.id), ["t1", "t2"]);
});

test("listTasksByStatus filters correctly", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask({ id: "t1", status: "pending" }));
  store.insertTask(fixtureTask({ id: "t2", status: "running" }));
  store.insertTask(fixtureTask({ id: "t3", status: "pending" }));
  assert.deepEqual(store.listTasksByStatus("pending").map((t) => t.id).sort(), ["t1", "t3"]);
  assert.deepEqual(store.listTasksByStatus("running").map((t) => t.id), ["t2"]);
});

test("task_edge: parentsOf/childrenOf round-trip the DAG", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask({ id: "t1" }));
  store.insertTask(fixtureTask({ id: "t2" }));
  const edge: TaskEdge = { parentTaskId: "t1", childTaskId: "t2", kind: "sequence" };
  store.insertTaskEdge(edge);
  assert.deepEqual(store.parentsOf("t2"), [edge]);
  assert.deepEqual(store.childrenOf("t1"), [edge]);
  assert.deepEqual(store.parentsOf("t1"), []);
});

test("invocation: insert, updateInvocationStatus, listInvocationsForTask ordering", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask());
  const inv: Invocation = { id: "inv-1", taskId: "task-1", harness: "claude-code", sessionId: "sess-1", status: "running", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null };
  store.insertInvocation(inv);
  assert.deepEqual(store.listInvocationsForTask("task-1"), [inv]);
  store.updateInvocationStatus("inv-1", "orphaned", "2026-01-01T00:05:00.000Z");
  const [reloaded] = store.listInvocationsForTask("task-1");
  assert.equal(reloaded?.status, "orphaned");
  assert.equal(reloaded?.finishedAt, "2026-01-01T00:05:00.000Z");
});

test("approval: insert, updateApprovalStatus, listPendingApprovals excludes resolved ones", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask());
  const approval: Approval = {
    id: "appr-1",
    taskId: "task-1",
    reason: "default-branch push",
    status: "pending",
    requestedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
    expiresAt: "2026-01-08T00:00:00.000Z",
  };
  store.insertApproval(approval);
  assert.deepEqual(store.listPendingApprovals(), [approval]);
  store.updateApprovalStatus("appr-1", "approved", "2026-01-01T00:10:00.000Z");
  assert.deepEqual(store.listPendingApprovals(), []);
});

test("cost: insertCost, listCostsForRun joins through task, listCostsForInvocation", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask());
  store.insertInvocation({ id: "inv-1", taskId: "task-1", harness: "claude-code", sessionId: null, status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null });
  const cost: Cost = { id: "cost-1", taskId: "task-1", invocationId: "inv-1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, usdEstimate: 0.05, recordedAt: "2026-01-01T00:00:00.000Z" };
  store.insertCost(cost);
  assert.deepEqual(store.listCostsForRun("run-1"), [cost]);
  assert.deepEqual(store.listCostsForRun("run-nonexistent"), []);
  assert.deepEqual(store.listCostsForInvocation("inv-1"), [cost]);
  assert.deepEqual(store.listCostsForInvocation("inv-nonexistent"), []);
});

test("eval_case/eval_result: insert and list by case", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertEvalCase({ id: "case-1", name: "basic addition", specJson: JSON.stringify({ prompt: "2+2" }), createdAt: "2026-01-01T00:00:00.000Z" });
  store.insertEvalResult({ id: "res-1", evalCaseId: "case-1", runId: null, passed: true, outputJson: JSON.stringify({ answer: 4 }), recordedAt: "2026-01-01T00:01:00.000Z" });
  const results = store.listEvalResultsForCase("case-1");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.passed, true);
});

test("healthCheck returns true against a writable store", () => {
  const store = new BrainStore(tmpDbPath());
  assert.equal(store.healthCheck(), true);
});

test("healthCheck returns false once the store is closed", () => {
  const store = new BrainStore(tmpDbPath());
  store.close();
  assert.equal(store.healthCheck(), false);
});

test("WAL mode is actually active (not just requested)", () => {
  const dbPath = tmpDbPath();
  const store = new BrainStore(dbPath);
  store.insertRun(fixtureRun());
  // WAL mode creates a -wal sidecar file alongside the main db file the
  // moment a write transaction happens; its presence is the real proof
  // (over asserting "no error was thrown" on the pragma itself, which
  // SQLite would also do for an unsupported pragma value in some builds).
  assert.equal(fs.existsSync(`${dbPath}-wal`), true);
});
