import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainDaemon, stubLiveProbe, type LiveProbeFn } from "../src/daemon.ts";
import { fixtureRun, fixtureTask } from "./support.ts";

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-daemon-"));
}

test("start() then health() reports ok with the state store writable", async () => {
  const dataDir = tmpDataDir();
  const daemon = new BrainDaemon({ dbPath: path.join(dataDir, "brain.db"), dataDir });
  await daemon.start();
  const health = await daemon.health();
  assert.equal(health.status, "ok");
  assert.equal(health.stateStoreWritable, true);
  assert.ok(health.uptimeMs >= 0);
  await daemon.shutdown();
});

test("health() reports degraded once the store is closed (shutdown already ran)", async () => {
  const dataDir = tmpDataDir();
  const daemon = new BrainDaemon({ dbPath: path.join(dataDir, "brain.db"), dataDir });
  await daemon.start();
  await daemon.shutdown();
  const health = await daemon.health();
  assert.equal(health.status, "degraded");
  assert.equal(health.stateStoreWritable, false);
});

// GU... no, this is BR-6/07 section 7.3's own crash-recovery contract:
// "on boot, any task in running is probed ... and either re-attached,
// resumed via harness session resume, or marked interrupted" -- and the
// acceptance criterion's own wording, "none shall remain running."
test("reconcile(): the stub liveProbe (no real adapter yet) marks every running task interrupted, never leaves one running", async () => {
  const dataDir = tmpDataDir();
  const daemon = new BrainDaemon({ dbPath: path.join(dataDir, "brain.db"), dataDir });
  daemon.store.insertRun(fixtureRun());
  daemon.store.insertTask(fixtureTask({ id: "t1", status: "running", startedAt: new Date().toISOString() }));
  daemon.store.insertTask(fixtureTask({ id: "t2", status: "running", startedAt: new Date().toISOString() }));
  daemon.store.insertTask(fixtureTask({ id: "t3", status: "pending" }));

  const result = await daemon.reconcile();
  assert.deepEqual(result, { reattached: 0, resumed: 0, interrupted: 2 });
  assert.equal(daemon.store.getTask("t1")?.status, "interrupted");
  assert.equal(daemon.store.getTask("t2")?.status, "interrupted");
  assert.equal(daemon.store.getTask("t3")?.status, "pending", "a task that was never running is untouched by reconcile");

  const running = daemon.store.listTasksByStatus("running");
  assert.equal(running.length, 0, "no task remains running after reconcile");
  await daemon.shutdown();
});

test("reconcile(): a live probe re-attaches instead of interrupting", async () => {
  const dataDir = tmpDataDir();
  const liveProbe: LiveProbeFn = async () => ({ live: true, resumable: false });
  const daemon = new BrainDaemon({ dbPath: path.join(dataDir, "brain.db"), dataDir, liveProbe });
  daemon.store.insertRun(fixtureRun());
  daemon.store.insertTask(fixtureTask({ id: "t1", status: "running" }));

  const result = await daemon.reconcile();
  assert.deepEqual(result, { reattached: 1, resumed: 0, interrupted: 0 });
  assert.equal(daemon.store.getTask("t1")?.status, "running", "a re-attached task's status is left as-is (it's still genuinely running)");
  await daemon.shutdown();
});

test("reconcile(): a resumable-but-not-live probe counts as resumed, not interrupted", async () => {
  const dataDir = tmpDataDir();
  const liveProbe: LiveProbeFn = async () => ({ live: false, resumable: true });
  const daemon = new BrainDaemon({ dbPath: path.join(dataDir, "brain.db"), dataDir, liveProbe });
  daemon.store.insertRun(fixtureRun());
  daemon.store.insertTask(fixtureTask({ id: "t1", status: "running" }));

  const result = await daemon.reconcile();
  assert.deepEqual(result, { reattached: 0, resumed: 1, interrupted: 0 });
  await daemon.shutdown();
});

test("reconcile(): an interrupted task's last invocation is marked orphaned", async () => {
  const dataDir = tmpDataDir();
  const daemon = new BrainDaemon({ dbPath: path.join(dataDir, "brain.db"), dataDir, liveProbe: stubLiveProbe });
  daemon.store.insertRun(fixtureRun());
  daemon.store.insertTask(fixtureTask({ id: "t1", status: "running" }));
  daemon.store.insertInvocation({ id: "inv-1", taskId: "t1", harness: "claude-code", sessionId: "sess-1", status: "running", startedAt: new Date().toISOString(), finishedAt: null });

  await daemon.reconcile();
  const invocation = daemon.store.listInvocationsForTask("t1").at(-1);
  assert.equal(invocation?.status, "orphaned");
  await daemon.shutdown();
});

// Kill-and-restart integration test (m4-08's own acceptance criterion):
// a fresh BrainDaemon instance opened against the SAME db file a "crashed"
// instance left behind must reconcile it correctly, since a real crash is
// exactly "the process is gone, a new one starts against the same file."
test("kill-and-restart: a fresh daemon instance reconciles tasks a prior instance left running, none remain running", async () => {
  const dataDir = tmpDataDir();
  const dbPath = path.join(dataDir, "brain.db");

  const first = new BrainDaemon({ dbPath, dataDir });
  await first.start();
  first.store.insertRun(fixtureRun());
  first.store.insertTask(fixtureTask({ id: "t1", status: "running", startedAt: new Date().toISOString() }));
  // Simulate a crash: no shutdown() call at all, no graceful drain -- just
  // close the file handle out from under it, the same way a killed process
  // would leave the WAL file exactly as it was at the last commit.
  first.store.close();

  const second = new BrainDaemon({ dbPath, dataDir });
  await second.start();
  const running = second.store.listTasksByStatus("running");
  assert.equal(running.length, 0, "the restarted daemon's own startup reconcile leaves nothing running");
  assert.equal(second.store.getTask("t1")?.status, "interrupted");
  await second.shutdown();
});

test("shutdown(): waits for in-flight dispatches up to the grace period, then marks any still-running task interrupted", async () => {
  const dataDir = tmpDataDir();
  let releaseDispatch: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (releaseDispatch = resolve));
  const daemon = new BrainDaemon({
    dbPath: path.join(dataDir, "brain.db"),
    dataDir,
    dispatch: async () => {
      await gate;
    },
    shutdownGraceMs: 50,
  });
  await daemon.start();
  daemon.store.insertRun(fixtureRun());
  daemon.store.insertTask(fixtureTask({ id: "t1", status: "pending" }));
  await daemon.scheduler.tick();
  assert.equal(daemon.scheduler.inFlightCount, 1);

  const result = await daemon.shutdown();
  assert.equal(result.interrupted, 1, "the grace period expired before dispatch() resolved, so the task is marked interrupted");
  releaseDispatch?.();
});

test("shutdown() closes the store: a write attempted afterward throws instead of hanging or silently no-op'ing", async () => {
  const dataDir = tmpDataDir();
  const daemon = new BrainDaemon({ dbPath: path.join(dataDir, "brain.db"), dataDir });
  await daemon.start();
  await daemon.shutdown();
  assert.equal(daemon.store.healthCheck(), false);
  assert.throws(() => daemon.store.insertRun(fixtureRun()));
});
