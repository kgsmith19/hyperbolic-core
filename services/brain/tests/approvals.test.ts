import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../src/store.ts";
import { RunJournal } from "../src/journal.ts";
import { parkForApproval, latestApprovalFor, resolveApproval, sweepExpiredApprovals } from "../src/approvals.ts";
import type { Run, Task } from "../src/types.ts";

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brain-approvals-")), "brain.db");
}

function tmpJournal(): RunJournal {
  return new RunJournal(fs.mkdtempSync(path.join(os.tmpdir(), "brain-approvals-journal-")));
}

function seedTask(store: BrainStore, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const run: Run = { id: "run-1", objective: "x", autonomy: 1, status: "running", createdAt: now, updatedAt: now };
  store.insertRun(run);
  const task: Task = {
    id: "task-1",
    runId: "run-1",
    title: "x",
    status: "pending",
    contractJson: "{}",
    resultJson: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
  store.insertTask(task);
  return task;
}

test("parkForApproval: inserts a pending approval and moves the task to awaiting_approval, journaled", () => {
  const store = new BrainStore(tmpDbPath());
  const journal = tmpJournal();
  const task = seedTask(store);

  parkForApproval(store, journal, task, "constraints.network is open", "2026-01-01T00:00:00.000Z");

  assert.equal(store.getTask(task.id)?.status, "awaiting_approval");
  const [approval] = store.listPendingApprovals();
  assert.equal(approval?.taskId, task.id);
  assert.equal(approval?.reason, "constraints.network is open");
  assert.equal(approval?.status, "pending");

  const events = journal.read("run-1");
  assert.equal(events.some((e) => e.kind === "task.parked_for_approval"), true);
});

test("parkForApproval: expiresAt is requestedAt + ttlMs (default 7 days)", () => {
  const store = new BrainStore(tmpDbPath());
  const task = seedTask(store);
  parkForApproval(store, undefined, task, "x", "2026-01-01T00:00:00.000Z");
  const [approval] = store.listPendingApprovals();
  assert.equal(approval?.expiresAt, "2026-01-08T00:00:00.000Z");
});

test("parkForApproval: a custom ttlMs is honored", () => {
  const store = new BrainStore(tmpDbPath());
  const task = seedTask(store);
  parkForApproval(store, undefined, task, "x", "2026-01-01T00:00:00.000Z", 60_000);
  const [approval] = store.listPendingApprovals();
  assert.equal(approval?.expiresAt, "2026-01-01T00:01:00.000Z");
});

test("latestApprovalFor: null when no approval exists; the most recent row once one does", () => {
  const store = new BrainStore(tmpDbPath());
  const task = seedTask(store);
  assert.equal(latestApprovalFor(store, task.id), null);
  parkForApproval(store, undefined, task, "x", "2026-01-01T00:00:00.000Z");
  assert.equal(latestApprovalFor(store, task.id)?.status, "pending");
});

test("resolveApproval: approved -- approval row marked approved, task returns to pending (dispatchable again)", () => {
  const store = new BrainStore(tmpDbPath());
  const journal = tmpJournal();
  const task = seedTask(store);
  parkForApproval(store, journal, task, "x", "2026-01-01T00:00:00.000Z");

  const resolved = resolveApproval(store, journal, task.id, "approved", "2026-01-02T00:00:00.000Z");
  assert.equal(resolved, true);
  assert.equal(store.getTask(task.id)?.status, "pending");
  assert.equal(latestApprovalFor(store, task.id)?.status, "approved");
  assert.equal(journal.read("run-1").some((e) => e.kind === "task.approval_approved"), true);
});

test("resolveApproval: rejected -- task moves straight to cancelled, never back to pending", () => {
  const store = new BrainStore(tmpDbPath());
  const task = seedTask(store);
  parkForApproval(store, undefined, task, "x", "2026-01-01T00:00:00.000Z");

  resolveApproval(store, undefined, task.id, "rejected", "2026-01-02T00:00:00.000Z");
  assert.equal(store.getTask(task.id)?.status, "cancelled");
  assert.equal(latestApprovalFor(store, task.id)?.status, "rejected");
});

test("resolveApproval: a task with no pending approval returns false, changes nothing", () => {
  const store = new BrainStore(tmpDbPath());
  const task = seedTask(store);
  const resolved = resolveApproval(store, undefined, task.id, "approved", "2026-01-02T00:00:00.000Z");
  assert.equal(resolved, false);
  assert.equal(store.getTask(task.id)?.status, "pending");
});

test("sweepExpiredApprovals: a still-live approval (expiresAt in the future) is untouched", () => {
  const store = new BrainStore(tmpDbPath());
  const task = seedTask(store);
  parkForApproval(store, undefined, task, "x", "2026-01-01T00:00:00.000Z");
  const expired = sweepExpiredApprovals(store, undefined, "2026-01-05T00:00:00.000Z");
  assert.equal(expired, 0);
  assert.equal(store.getTask(task.id)?.status, "awaiting_approval");
});

test("sweepExpiredApprovals: an expired approval moves the task to cancelled, journals a rationale (clock-injected TTL test)", () => {
  const store = new BrainStore(tmpDbPath());
  const journal = tmpJournal();
  const task = seedTask(store);
  parkForApproval(store, journal, task, "constraints.network is open", "2026-01-01T00:00:00.000Z");

  // Move the injected clock past the default 7-day TTL, never sleeping.
  const expired = sweepExpiredApprovals(store, journal, "2026-01-09T00:00:00.000Z");

  assert.equal(expired, 1);
  assert.equal(store.getTask(task.id)?.status, "cancelled");
  assert.equal(latestApprovalFor(store, task.id)?.status, "expired");

  const events = journal.read("run-1");
  const expiryEvent = events.find((e) => e.kind === "task.approval_ttl_expired");
  assert.ok(expiryEvent, "the expiry must be journaled");
  assert.match(String(expiryEvent?.rationale ?? ""), /TTL expired/);
});

test("sweepExpiredApprovals: sweeps every expired approval in one pass, leaves unrelated pending ones alone", () => {
  const store = new BrainStore(tmpDbPath());
  const now = new Date().toISOString();
  const run: Run = { id: "run-1", objective: "x", autonomy: 1, status: "running", createdAt: now, updatedAt: now };
  store.insertRun(run);
  const taskA: Task = { id: "task-a", runId: "run-1", title: "a", status: "pending", contractJson: "{}", resultJson: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
  const taskB: Task = { id: "task-b", runId: "run-1", title: "b", status: "pending", contractJson: "{}", resultJson: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
  store.insertTask(taskA);
  store.insertTask(taskB);

  parkForApproval(store, undefined, taskA, "expired soon", "2026-01-01T00:00:00.000Z", 1000);
  parkForApproval(store, undefined, taskB, "not expiring soon", "2026-01-01T00:00:00.000Z", 100 * 24 * 60 * 60 * 1000);

  const expired = sweepExpiredApprovals(store, undefined, "2026-01-01T00:00:02.000Z");
  assert.equal(expired, 1);
  assert.equal(store.getTask("task-a")?.status, "cancelled");
  assert.equal(store.getTask("task-b")?.status, "awaiting_approval");
});
