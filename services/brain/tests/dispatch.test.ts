// Fake-adapter tests (this issue's own verification bullets): "two
// transport failures reroute; journal records the requeue decision" and
// "logic failure ends the task failed with zero retries". Uses a real
// BrainStore, RunJournal, and git worktree (against a local throwaway
// fixture repo, same convention as worktree.test.ts) so the whole
// dispatch() path runs for real except for the harness itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../src/store.ts";
import { RunJournal } from "../src/journal.ts";
import { BrainLogger } from "../src/log.ts";
import { createDispatchFn } from "../src/dispatch.ts";
import { estimateUsd } from "../src/pricing.ts";
import type { AdapterRegistry } from "../src/router.ts";
import type { AdapterInvocation, HarnessAdapter, HarnessId, HarnessSession, ProbeResult } from "../src/adapters/types.ts";
import type { TaskContractV1 } from "../src/contracts.ts";
import type { Run, Task } from "../src/types.ts";

function initSourceRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-src-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  run(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "initial"]);
  return dir;
}

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-db-")), "brain.db");
}

/** Records every attempt (harness id + ordinal) and returns canned
 * HarnessSessions/throws in sequence, per test scenario. */
class ScriptedAdapter implements HarnessAdapter {
  readonly id: HarnessId;
  #script: Array<(inv: AdapterInvocation) => Promise<HarnessSession>>;
  attempts: AdapterInvocation[] = [];

  constructor(id: HarnessId, script: Array<(inv: AdapterInvocation) => Promise<HarnessSession>>) {
    this.id = id;
    this.#script = script;
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, version: "1.0.0" };
  }

  async start(inv: AdapterInvocation): Promise<HarnessSession> {
    this.attempts.push(inv);
    const step = this.#script[this.attempts.length - 1];
    if (!step) throw new Error(`ScriptedAdapter(${this.id}): no script step for attempt ${this.attempts.length}`);
    return step(inv);
  }

  async resume(): Promise<HarnessSession> {
    throw new Error("not used in this test");
  }

  async cancel(): Promise<void> {}
}

function contractFor(repoUrl: string, taskId: string, runId: string, fallback: HarnessId[], acceptance: TaskContractV1["acceptance"] = []): TaskContractV1 {
  return {
    task_id: taskId,
    run_id: runId,
    title: "fixture task",
    repo: { url: repoUrl, ref: "main" },
    harness: { preferred: "claude-code", fallback },
    autonomy: 2,
    prompt: { objective: "do the thing", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: ["**"], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "none" },
    acceptance,
    deliverable: { type: "commit", branch: `brain/${taskId}`, push: false, draft_pr: false },
  };
}

function seedRunAndTask(store: BrainStore, contract: TaskContractV1): Task {
  const now = new Date().toISOString();
  const run: Run = { id: contract.run_id, objective: contract.prompt.objective, autonomy: contract.autonomy, status: "running", createdAt: now, updatedAt: now };
  store.insertRun(run);
  const task: Task = {
    id: contract.task_id,
    runId: contract.run_id,
    title: contract.title,
    status: "running",
    contractJson: JSON.stringify(contract),
    resultJson: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  };
  store.insertTask(task);
  return task;
}

test("two consecutive transport failures on the selected harness requeue against the first viable fallback, journaled", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const journal = new RunJournal(fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-journal-")));
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-ws-"));

  const transportFailure = async (): Promise<HarnessSession> => ({ sessionId: "s", outcome: "failed-to-start", raw: { error: "429 rate limited" } });
  const claudeCode = new ScriptedAdapter("claude-code", [transportFailure, transportFailure]);
  const codex = new ScriptedAdapter("codex", [async () => ({ sessionId: "s2", outcome: "accepted", raw: { criteria: [], tokens: 0 } })]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode, codex };

  const contract = contractFor(repo, "task-transport", "run-transport", ["codex"]);
  const task = seedRunAndTask(store, contract);

  const dispatch = createDispatchFn(store, { adapters, workspacesRoot, journal });
  await dispatch(task);

  assert.equal(claudeCode.attempts.length, 2, "exactly two attempts on the originally-selected harness before requeuing");
  assert.equal(codex.attempts.length, 1, "exactly one attempt on the fallback");

  const finalTask = store.getTask(task.id);
  assert.equal(finalTask?.status, "succeeded");

  const invocations = store.listInvocationsForTask(task.id);
  assert.equal(invocations.length, 3);
  assert.deepEqual(invocations.map((i) => i.harness), ["claude-code", "claude-code", "codex"]);

  const events = journal.read(contract.run_id);
  const fallbackEvent = events.find((e) => e.kind === "task.harness_fallback");
  assert.ok(fallbackEvent, "the harness switch must be journaled, never silent");
  assert.equal(fallbackEvent?.from, "claude-code");
  assert.equal(fallbackEvent?.to, "codex");
});

test("a logic failure (rejected: non-zero verdicts) ends the task failed after exactly one attempt, no retry, no fallback", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const journal = new RunJournal(fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-journal-")));
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-ws-"));

  const rejected = async (): Promise<HarnessSession> => ({
    sessionId: "s",
    outcome: "rejected",
    raw: { criteria: [{ id: "AC-1", method: "command", status: "fail", detail: "exit 1" }] },
  });
  const claudeCode = new ScriptedAdapter("claude-code", [rejected]);
  const codex = new ScriptedAdapter("codex", [async () => ({ sessionId: "never", outcome: "accepted", raw: {} })]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode, codex };

  const contract = contractFor(repo, "task-logic", "run-logic", ["codex"]);
  const task = seedRunAndTask(store, contract);

  const dispatch = createDispatchFn(store, { adapters, workspacesRoot, journal });
  await dispatch(task);

  assert.equal(claudeCode.attempts.length, 1, "a logic failure must never be retried");
  assert.equal(codex.attempts.length, 0, "a logic failure must never fall back to a different harness either");

  const finalTask = store.getTask(task.id);
  assert.equal(finalTask?.status, "failed");
  const result = JSON.parse(finalTask!.resultJson!);
  assert.equal(result.verdicts[0].pass, false);

  const events = journal.read(contract.run_id);
  assert.equal(events.some((e) => e.kind === "task.harness_fallback"), false);
});

test("dispatch: a succeeded task's invocation row is marked completed, worktree removed after result persistence", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-ws-"));

  const accepted = async (): Promise<HarnessSession> => ({ sessionId: "s", outcome: "accepted", raw: { criteria: [], tokens: 42 } });
  const claudeCode = new ScriptedAdapter("claude-code", [accepted]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode };

  const contract = contractFor(repo, "task-ok", "run-ok", []);
  const task = seedRunAndTask(store, contract);

  const dispatch = createDispatchFn(store, { adapters, workspacesRoot });
  await dispatch(task);

  const [invocation] = store.listInvocationsForTask(task.id);
  assert.equal(invocation?.status, "completed");
  assert.equal(store.getTask(task.id)?.status, "succeeded");
});

// m4-11: the Brain's own independent verification (BR-2) is authoritative
// once the harness has run to completion -- these exercise it end to end
// through dispatch(), not just verify.ts in isolation.

test("m4-11: an adapter reporting accepted with NO criteria of its own falls back to the Brain's own verification, which catches a real `false` command", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-ws-"));

  // Reports accepted with an EMPTY criteria array -- as if the adapter
  // itself did no verification at all (a future non-kernel harness, or a
  // kernel edge case). dispatch() must not just trust "accepted" blindly.
  const claudeCode = new ScriptedAdapter("claude-code", [async () => ({ sessionId: "s", outcome: "accepted", raw: { criteria: [], tokens: 0 } })]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode };

  const contract = contractFor(repo, "task-false-verify", "run-false-verify", [], [
    { id: "AC-1", statement: "never passes", verify: { command: "false", cwd: "worktree", expect_exit: 0, timeout_s: 5 } },
  ]);
  const task = seedRunAndTask(store, contract);

  const dispatch = createDispatchFn(store, { adapters, workspacesRoot });
  await dispatch(task);

  const finalTask = store.getTask(task.id);
  assert.equal(finalTask?.status, "failed", "the adapter said accepted, but the Brain's OWN verification must be authoritative (BR-2)");
  const result = JSON.parse(finalTask!.resultJson!);
  assert.equal(result.verdicts[0].id, "AC-1");
  assert.equal(result.verdicts[0].pass, false);
});

test("m4-11: the kernel's own already-independent criteria are trusted (not silently re-run) when non-empty", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-ws-"));

  // The adapter (standing in for the kernel's own verifyAll()) already
  // reports a PASSING criterion, even though the REAL command below
  // (if the Brain re-ran it itself) would fail -- proving dispatch()
  // trusts the existing report rather than re-executing.
  const claudeCode = new ScriptedAdapter("claude-code", [
    async () => ({ sessionId: "s", outcome: "accepted", raw: { criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 0 } }),
  ]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode };

  const contract = contractFor(repo, "task-trust-existing", "run-trust-existing", [], [
    { id: "AC-1", statement: "would fail if re-run", verify: { command: "false", cwd: "worktree", expect_exit: 0, timeout_s: 5 } },
  ]);
  const task = seedRunAndTask(store, contract);

  const dispatch = createDispatchFn(store, { adapters, workspacesRoot });
  await dispatch(task);

  assert.equal(store.getTask(task.id)?.status, "succeeded");
});

test("m4-11: a dirty (uncommitted) worktree fails the task even when every verdict passes (completed condition 2)", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-ws-"));

  // The adapter simulates a harness that leaves an uncommitted change
  // behind in the worktree it was handed (real access via
  // AdapterInvocation.worktreePath, exactly what a real harness would
  // touch) while still reporting a fully passing criterion -- proving
  // dispatch() doesn't just trust the verdicts, condition 2 (worktree
  // clean or committed) is checked independently.
  const claudeCode = new ScriptedAdapter("claude-code", [
    async (inv: AdapterInvocation): Promise<HarnessSession> => {
      fs.writeFileSync(path.join(inv.worktreePath, "left-uncommitted.txt"), "oops");
      return { sessionId: "s", outcome: "accepted", raw: { criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 0 } };
    },
  ]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode };

  const contract = contractFor(repo, "task-dirty", "run-dirty", []);
  const task = seedRunAndTask(store, contract);

  const dispatch = createDispatchFn(store, { adapters, workspacesRoot });
  await dispatch(task);

  const finalTask = store.getTask(task.id);
  assert.equal(finalTask?.status, "failed", "every verdict passed, but the worktree was left dirty -- condition 2 of the completed definition");
});

// m4-17: BR-5 cost accounting, run finalization, and the run_id -> task_id
// -> invocation_id join key, exercised through the real dispatch() path
// (not just result-mapper.ts/pricing.ts in isolation).

test("m4-17: a succeeded invocation gets its own cost row (non-null tokens and dollars), and the run itself finalizes to completed", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-ws-"));

  const accepted = async (): Promise<HarnessSession> => ({ sessionId: "s", outcome: "accepted", raw: { criteria: [], tokens: 2000 } });
  const claudeCode = new ScriptedAdapter("claude-code", [accepted]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode };

  const contract = contractFor(repo, "task-cost", "run-cost", []);
  const task = seedRunAndTask(store, contract);

  const dispatch = createDispatchFn(store, { adapters, workspacesRoot });
  await dispatch(task);

  const [invocation] = store.listInvocationsForTask(task.id);
  const [costRow] = store.listCostsForInvocation(invocation!.id);
  assert.ok(costRow, "BR-5: every Brain-initiated harness invocation shall have cost accounting attributed to it");
  assert.equal(costRow!.taskId, task.id);
  assert.equal(costRow!.inputTokens, 2000);
  assert.equal(costRow!.usdEstimate, estimateUsd(2000, 0, 0));
  assert.ok(costRow!.usdEstimate! > 0, "non-null, non-zero dollars for a real token count");

  const run = store.getRun(contract.run_id);
  assert.equal(run?.status, "completed", "07 section 7.6: run/cost summaries roll up after run completion");
});

test("m4-17: two harness attempts (transport retry) each get their own distinct cost row, keyed by invocation not just task", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const journal = new RunJournal(fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-journal-")));
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-ws-"));

  const transportFailure = async (): Promise<HarnessSession> => ({ sessionId: "s", outcome: "failed-to-start", raw: { error: "429 rate limited", tokens: 10 } });
  const claudeCode = new ScriptedAdapter("claude-code", [transportFailure, transportFailure]);
  const codex = new ScriptedAdapter("codex", [async () => ({ sessionId: "s2", outcome: "accepted", raw: { criteria: [], tokens: 900 } })]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode, codex };

  const contract = contractFor(repo, "task-multi-cost", "run-multi-cost", ["codex"]);
  const task = seedRunAndTask(store, contract);

  const dispatch = createDispatchFn(store, { adapters, workspacesRoot, journal });
  await dispatch(task);

  const invocations = store.listInvocationsForTask(task.id);
  assert.equal(invocations.length, 3);
  const perInvocationCosts = invocations.map((inv) => store.listCostsForInvocation(inv.id));
  assert.ok(perInvocationCosts.every((rows) => rows.length === 1), "every invocation, including the two failed transport attempts, gets its own cost row");
  assert.deepEqual(
    perInvocationCosts.map((rows) => rows[0]!.inputTokens),
    [10, 10, 900]
  );

  const runCosts = store.listCostsForRun(contract.run_id);
  assert.equal(runCosts.length, 3, "listCostsForRun sees every invocation's cost, not just the last one");
});

test("m4-17: run_id -> task_id -> invocation_id is one join key resolvable across the Brain journal, the store, AND the log -- a fixture-run trace-join test", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const journal = new RunJournal(fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-journal-")));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-log-"));
  const logger = new BrainLogger(dataDir);
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-ws-"));

  const accepted = async (): Promise<HarnessSession> => ({ sessionId: "kernel-session-1", outcome: "accepted", raw: { criteria: [], tokens: 777 } });
  const claudeCode = new ScriptedAdapter("claude-code", [accepted]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode };

  const contract = contractFor(repo, "task-join", "run-join", []);
  const task = seedRunAndTask(store, contract);

  const dispatch = createDispatchFn(store, { adapters, workspacesRoot, journal, logger });
  await dispatch(task);

  const [invocation] = store.listInvocationsForTask(task.id);
  const invocationId = invocation!.id;

  // 1. The store: cost is attributed to exactly this run/task/invocation.
  const [costRow] = store.listCostsForInvocation(invocationId);
  assert.equal(costRow?.taskId, task.id);

  // 2. The log: an ndjson line carries the SAME invocation_id, task_id, run_id.
  const logLines = fs
    .readFileSync(logger.file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const costLogLine = logLines.find((l) => l.event === "invocation.cost_recorded" && l.invocation_id === invocationId);
  assert.ok(costLogLine, "the log's own invocation_id must resolve to the same invocation the store recorded cost against");
  assert.equal(costLogLine.run_id, contract.run_id);
  assert.equal(costLogLine.task_id, task.id);

  // 3. The journal: run.finalized carries the same run_id (and, per its
  // additive 7.9 shape, parses with the same required fields as the log).
  const events = journal.read(contract.run_id);
  const finalizedEvent = events.find((e) => e.kind === "run.finalized");
  assert.ok(finalizedEvent);
  assert.equal(finalizedEvent?.run_id, contract.run_id);
  assert.equal(finalizedEvent?.level, "info");
});
