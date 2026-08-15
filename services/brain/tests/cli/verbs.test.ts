import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../../src/store.ts";
import { RunJournal } from "../../src/journal.ts";
import {
  statusVerb,
  tasksVerb,
  approveVerb,
  rejectVerb,
  cancelVerb,
  resumeVerb,
  logsVerb,
  costVerb,
  configVerb,
} from "../../src/cli/verbs.ts";
import { parkForApproval } from "../../src/approvals.ts";
import { EXIT_OK, EXIT_NOT_FOUND } from "../../src/cli/result.ts";
import type { Run, Task } from "../../src/types.ts";
import type { BrainConfig } from "../../src/config.ts";

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brain-verbs-")), "brain.db");
}

function tmpJournal(): RunJournal {
  return new RunJournal(fs.mkdtempSync(path.join(os.tmpdir(), "brain-verbs-journal-")));
}

function seedRunAndTask(store: BrainStore, overrides: Partial<Task> = {}): { run: Run; task: Task } {
  const now = new Date().toISOString();
  const run: Run = { id: "run-1", objective: "ship it", autonomy: 2, status: "running", createdAt: now, updatedAt: now };
  store.insertRun(run);
  const task: Task = {
    id: "task-1",
    runId: "run-1",
    title: "ship it",
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
  return { run, task };
}

function fixtureConfig(overrides: Partial<BrainConfig> = {}): BrainConfig {
  return {
    // Required by BrainConfig and missing from this fixture: it was building a
    // config loadConfig() can never produce, which nothing caught while these
    // tests sat outside any type-check program.
    evalsCasesDir: "/nonexistent/eval-cases",
    port: 8100,
    dbPath: ":memory:",
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "brain-verbs-cfg-")),
    workspacesRoot: "/workspaces",
    kernelRunPath: "/nonexistent/kernel/run.mjs",
    accRoot: "/nonexistent/acc-root",
    accPolicy: "/nonexistent/acc-root/policy.json",
    accVault: "/nonexistent/acc-root/vault.json",
    repoAllowlist: [],
    perRunUsdCeiling: 5,
    approvalTtlMs: 7 * 24 * 60 * 60 * 1000,
    repoRoot: "/nonexistent/repo-root",
    ...overrides,
  };
}

test("statusVerb: no run_id lists every run, exit 0", () => {
  const store = new BrainStore(tmpDbPath());
  seedRunAndTask(store);
  const result = statusVerb(store);
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal((result.json as Run[]).length, 1);
});

test("statusVerb: an unknown run_id is not-found (exit 3)", () => {
  const store = new BrainStore(tmpDbPath());
  const result = statusVerb(store, "nope");
  assert.equal(result.exitCode, EXIT_NOT_FOUND);
});

test("statusVerb: a known run_id returns the run and its tasks", () => {
  const store = new BrainStore(tmpDbPath());
  const { run } = seedRunAndTask(store);
  const result = statusVerb(store, run.id);
  assert.equal(result.exitCode, EXIT_OK);
  const json = result.json as { run: Run; tasks: Task[] };
  assert.equal(json.run.id, run.id);
  assert.equal(json.tasks.length, 1);
});

test("tasksVerb: not-found for an unknown run", () => {
  const store = new BrainStore(tmpDbPath());
  assert.equal(tasksVerb(store, "nope").exitCode, EXIT_NOT_FOUND);
});

test("tasksVerb: includes verdicts parsed from resultJson", () => {
  const store = new BrainStore(tmpDbPath());
  const { run } = seedRunAndTask(store, { resultJson: JSON.stringify({ verdicts: [{ id: "AC-1", pass: true, exit: 0, output_tail: "" }] }) });
  const result = tasksVerb(store, run.id);
  const tasks = result.json as Array<{ verdicts: unknown[] }>;
  assert.equal(tasks[0]?.verdicts.length, 1);
});

test("approveVerb: no pending approval -- not-found", () => {
  const store = new BrainStore(tmpDbPath());
  const { task } = seedRunAndTask(store);
  const result = approveVerb(store, undefined, task.id);
  assert.equal(result.exitCode, EXIT_NOT_FOUND);
});

test("approveVerb: resolves a pending approval, task returns to pending", () => {
  const store = new BrainStore(tmpDbPath());
  const { task } = seedRunAndTask(store);
  parkForApproval(store, undefined, task, "x", new Date().toISOString());
  const result = approveVerb(store, undefined, task.id);
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(store.getTask(task.id)?.status, "pending");
});

test("rejectVerb: task moves to cancelled", () => {
  const store = new BrainStore(tmpDbPath());
  const { task } = seedRunAndTask(store);
  parkForApproval(store, undefined, task, "x", new Date().toISOString());
  const result = rejectVerb(store, undefined, task.id, "not needed");
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(store.getTask(task.id)?.status, "cancelled");
  assert.match(result.humanText, /not needed/);
});

test("cancelVerb: a task id cancels just that task", () => {
  const store = new BrainStore(tmpDbPath());
  const { task } = seedRunAndTask(store, { status: "running" });
  const result = cancelVerb(store, undefined, task.id);
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(store.getTask(task.id)?.status, "cancelled");
});

test("cancelVerb: a run id cancels every non-terminal task in it and the run itself", () => {
  const store = new BrainStore(tmpDbPath());
  const { run } = seedRunAndTask(store, { id: "t1", status: "running" });
  store.insertTask({ id: "t2", runId: run.id, title: "x", status: "pending", contractJson: "{}", resultJson: null, createdAt: run.createdAt, updatedAt: run.createdAt, startedAt: null, finishedAt: null });
  store.insertTask({ id: "t3", runId: run.id, title: "x", status: "succeeded", contractJson: "{}", resultJson: null, createdAt: run.createdAt, updatedAt: run.createdAt, startedAt: null, finishedAt: null });

  const result = cancelVerb(store, undefined, run.id);
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(store.getTask("t1")?.status, "cancelled");
  assert.equal(store.getTask("t2")?.status, "cancelled");
  assert.equal(store.getTask("t3")?.status, "succeeded", "an already-terminal task is left alone");
  assert.equal(store.getRun(run.id)?.status, "cancelled");
});

test("cancelVerb: an id that is neither a run nor a task -- not-found", () => {
  const store = new BrainStore(tmpDbPath());
  assert.equal(cancelVerb(store, undefined, "nope").exitCode, EXIT_NOT_FOUND);
});

test("resumeVerb: requeues interrupted tasks in a run back to pending, journaled", () => {
  const store = new BrainStore(tmpDbPath());
  const journal = tmpJournal();
  const { run } = seedRunAndTask(store, { status: "interrupted" });

  const result = resumeVerb(store, journal, run.id);
  assert.equal(result.exitCode, EXIT_OK);
  assert.equal(store.getTask("task-1")?.status, "pending");
  assert.equal(journal.read(run.id).some((e) => e.kind === "task.requeued"), true);
});

test("resumeVerb: not-found for an unknown run", () => {
  const store = new BrainStore(tmpDbPath());
  assert.equal(resumeVerb(store, undefined, "nope").exitCode, EXIT_NOT_FOUND);
});

test("logsVerb: not-found for an unknown run", () => {
  const store = new BrainStore(tmpDbPath());
  const journal = tmpJournal();
  assert.equal(logsVerb(store, journal, "nope").exitCode, EXIT_NOT_FOUND);
});

test("logsVerb: returns every journaled event as an ndjson-ready line, optionally filtered by task", () => {
  const store = new BrainStore(tmpDbPath());
  const { run } = seedRunAndTask(store);
  const journal = tmpJournal();
  journal.append({ runId: run.id, kind: "run.submitted", taskId: "task-1" });
  journal.append({ runId: run.id, kind: "task.cancelled", taskId: "task-other" });

  const all = logsVerb(store, journal, run.id);
  assert.equal(all.lines.length, 2);
  JSON.parse(all.lines[0]!); // must be valid JSON per line

  const filtered = logsVerb(store, journal, run.id, "task-1");
  assert.equal(filtered.lines.length, 1);
});

test("costVerb: --run filters to one run and sums usd_estimate", () => {
  const store = new BrainStore(tmpDbPath());
  const { run, task } = seedRunAndTask(store);
  store.insertInvocation({ id: "inv-1", taskId: task.id, harness: "claude-code", sessionId: null, status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null });
  store.insertCost({ id: "c1", taskId: task.id, invocationId: "inv-1", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, usdEstimate: 0.5, recordedAt: "2026-01-01T00:00:00.000Z" });
  store.insertCost({ id: "c2", taskId: task.id, invocationId: "inv-1", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, usdEstimate: 0.25, recordedAt: "2026-01-02T00:00:00.000Z" });

  const result = costVerb(store, { runId: run.id });
  const json = result.json as { totalUsd: number };
  assert.equal(json.totalUsd, 0.75);
});

test("costVerb: --since filters by timestamp", () => {
  const store = new BrainStore(tmpDbPath());
  const { task } = seedRunAndTask(store);
  store.insertInvocation({ id: "inv-1", taskId: task.id, harness: "claude-code", sessionId: null, status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null });
  store.insertCost({ id: "c1", taskId: task.id, invocationId: "inv-1", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, usdEstimate: 1, recordedAt: "2026-01-01T00:00:00.000Z" });
  store.insertCost({ id: "c2", taskId: task.id, invocationId: "inv-1", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, usdEstimate: 2, recordedAt: "2026-02-01T00:00:00.000Z" });

  const result = costVerb(store, { since: "2026-01-15T00:00:00.000Z" });
  const json = result.json as { totalUsd: number };
  assert.equal(json.totalUsd, 2);
});

test("configVerb: bare call returns the whole effective config", () => {
  const config = fixtureConfig({ perRunUsdCeiling: 7 });
  const result = configVerb(config, {});
  assert.equal((result.json as { perRunUsdCeiling: number }).perRunUsdCeiling, 7);
});

test("configVerb: get <key> returns just that key", () => {
  const config = fixtureConfig({ perRunUsdCeiling: 9 });
  const result = configVerb(config, { action: "get", key: "perRunUsdCeiling" });
  assert.deepEqual(result.json, { perRunUsdCeiling: 9 });
});

test("configVerb: get <unknown key> is an error", () => {
  const config = fixtureConfig();
  const result = configVerb(config, { action: "get", key: "notAField" });
  assert.notEqual(result.exitCode, EXIT_OK);
});

test("configVerb: set <settable key> persists an override and reports success", () => {
  const config = fixtureConfig();
  const result = configVerb(config, { action: "set", key: "BRAIN_PER_RUN_USD_CEILING", value: "10" });
  assert.equal(result.exitCode, EXIT_OK);
  assert.ok(fs.existsSync(path.join(config.dataDir, "config-overrides.json")));
});

test("configVerb: set <non-settable key> is policy-refused", () => {
  const config = fixtureConfig();
  const result = configVerb(config, { action: "set", key: "dbPath", value: "/tmp/x" });
  assert.equal(result.exitCode, 2);
});
