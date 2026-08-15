import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../src/store.ts";
import { isDispatchable, Scheduler, MAX_CONCURRENT_DISPATCH } from "../src/scheduler.ts";
import type { Run, Task } from "../src/types.ts";
import { fixtureRun, fixtureTask } from "./support.ts";

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brain-scheduler-")), "brain.db");
}

test("MAX_CONCURRENT_DISPATCH is 2 (07 section 7.3/7.7's N=2 cap)", () => {
  assert.equal(MAX_CONCURRENT_DISPATCH, 2);
});

test("isDispatchable: a task with no parent edges is dispatchable once pending", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  const task = fixtureTask();
  store.insertTask(task);
  assert.equal(isDispatchable(store, task), true);
});

test("isDispatchable: false for a non-pending task regardless of its parents", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  const task = fixtureTask({ status: "running" });
  store.insertTask(task);
  assert.equal(isDispatchable(store, task), false);
});

test("isDispatchable: false while any parent has not reached succeeded", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask({ id: "parent", status: "running" }));
  const child = fixtureTask({ id: "child", status: "pending" });
  store.insertTask(child);
  store.insertTaskEdge({ parentTaskId: "parent", childTaskId: "child", kind: "sequence" });
  assert.equal(isDispatchable(store, child), false);
});

test("isDispatchable: true once every parent has reached succeeded", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask({ id: "parent", status: "succeeded" }));
  const child = fixtureTask({ id: "child", status: "pending" });
  store.insertTask(child);
  store.insertTaskEdge({ parentTaskId: "parent", childTaskId: "child", kind: "sequence" });
  assert.equal(isDispatchable(store, child), true);
});

test("isDispatchable: false if ANY of multiple parents is not succeeded (failed does not count)", () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask({ id: "p1", status: "succeeded" }));
  store.insertTask(fixtureTask({ id: "p2", status: "failed" }));
  const child = fixtureTask({ id: "child", status: "pending" });
  store.insertTask(child);
  store.insertTaskEdge({ parentTaskId: "p1", childTaskId: "child", kind: "sequence" });
  store.insertTaskEdge({ parentTaskId: "p2", childTaskId: "child", kind: "sequence" });
  assert.equal(isDispatchable(store, child), false);
});

test("Scheduler.tick dispatches every eligible pending task up to the concurrency cap, and journals the transition to running before dispatch() runs", async () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  for (const id of ["t1", "t2", "t3"]) store.insertTask(fixtureTask({ id }));

  const dispatchOrder: string[] = [];
  let resolveDispatch: (() => void) | undefined;
  const held = new Promise<void>((resolve) => (resolveDispatch = resolve));
  const scheduler = new Scheduler(store, async (task) => {
    // At the moment dispatch() is called, the store must ALREADY show
    // this task as running -- proving the status transition committed
    // before the side effect ran (07 section 7.3's journaled-before-
    // side-effects discipline), not after.
    assert.equal(store.getTask(task.id)?.status, "running");
    dispatchOrder.push(task.id);
    await held;
  });

  const dispatched = await scheduler.tick();
  assert.equal(dispatched.length, 2, "only 2 of 3 eligible tasks dispatch at once (N=2 cap)");
  assert.equal(scheduler.inFlightCount, 2);
  assert.equal(store.getTask("t3")?.status, "pending", "the third task stays pending until a slot frees");

  resolveDispatch?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.inFlightCount, 0, "both in-flight dispatches released their slot after resolving");
});

test("Scheduler.tick returns [] when already at the concurrency cap", async () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask({ id: "t1" }));
  store.insertTask(fixtureTask({ id: "t2" }));
  store.insertTask(fixtureTask({ id: "t3" }));

  let released: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (released = resolve));
  const scheduler = new Scheduler(store, async () => {
    await gate;
  });

  await scheduler.tick();
  assert.equal(scheduler.inFlightCount, 2);
  const second = await scheduler.tick();
  assert.deepEqual(second, [], "no budget left, so a second tick dispatches nothing even though t3 is eligible");

  released?.();
});

test("a task whose dispatch() rejects releases its in-flight slot and is marked failed, never left stuck running", async () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask({ id: "t1" }));
  const scheduler = new Scheduler(
    store,
    async () => {
      throw new Error("harness crashed");
    },
    1
  );
  await scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.inFlightCount, 0);
  const task = store.getTask("t1");
  assert.equal(task?.status, "failed");
  assert.match(task?.resultJson ?? "", /harness crashed/);
});

// m4-12: an ApprovalGate parks a task instead of dispatching it, without
// consuming concurrency budget -- 07 section 7.7's "independent DAG
// branches continue" while one task is parked.

test("Scheduler.tick: a task the approval gate parks never dispatches, and doesn't consume the concurrency budget", async () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask({ id: "t1" }));

  const dispatched: string[] = [];
  const scheduler = new Scheduler(
    store,
    async (task) => {
      dispatched.push(task.id);
    },
    2,
    async () => ({ needsApproval: true })
  );

  const result = await scheduler.tick();
  assert.deepEqual(result, []);
  assert.deepEqual(dispatched, []);
  assert.equal(scheduler.inFlightCount, 0);
  // The gate itself is responsible for the state transition (this fake
  // gate doesn't perform one) -- Scheduler's own contract is just "don't
  // dispatch it, don't count it against budget", verified above.
});

test("Scheduler.tick: while one task is parked, an independent sibling still dispatches in the SAME tick", async () => {
  const store = new BrainStore(tmpDbPath());
  store.insertRun(fixtureRun());
  store.insertTask(fixtureTask({ id: "parked" }));
  store.insertTask(fixtureTask({ id: "sibling" }));

  const dispatched: string[] = [];
  let resolveDispatch: (() => void) | undefined;
  const held = new Promise<void>((resolve) => (resolveDispatch = resolve));
  const scheduler = new Scheduler(
    store,
    async (task) => {
      dispatched.push(task.id);
      await held;
    },
    2,
    async (task) => ({ needsApproval: task.id === "parked" })
  );

  const result = await scheduler.tick();
  assert.deepEqual(result.map((t) => t.id), ["sibling"]);
  assert.equal(store.getTask("parked")?.status, "pending", "the parked task's status is the gate's job, not the scheduler's -- it just never became running");
  assert.equal(store.getTask("sibling")?.status, "running");

  resolveDispatch?.();
});
