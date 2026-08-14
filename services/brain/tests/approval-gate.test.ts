import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../src/store.ts";
import { createApprovalGate } from "../src/approval-gate.ts";
import { latestApprovalFor, resolveApproval } from "../src/approvals.ts";
import type { TaskContractV1 } from "../src/contracts.ts";
import type { Run, Task } from "../src/types.ts";

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brain-approval-gate-")), "brain.db");
}

function contractFor(overrides: Partial<TaskContractV1> = {}): TaskContractV1 {
  return {
    task_id: "task-1",
    run_id: "run-1",
    title: "x",
    repo: { url: "https://github.com/kgsmith19/hyperbolic-core", ref: "main" },
    harness: { preferred: "claude-code", fallback: [] },
    autonomy: 2,
    prompt: { objective: "x", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: ["**"], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "provider-only" },
    acceptance: [],
    deliverable: { type: "commit", branch: "brain/task-1", push: true, draft_pr: true },
    ...overrides,
  };
}

function seedTask(store: BrainStore, contract: TaskContractV1): Task {
  const now = new Date().toISOString();
  const run: Run = { id: contract.run_id, objective: contract.prompt.objective, autonomy: contract.autonomy, status: "running", createdAt: now, updatedAt: now };
  store.insertRun(run);
  const task: Task = {
    id: contract.task_id,
    runId: contract.run_id,
    title: contract.title,
    status: "pending",
    contractJson: JSON.stringify(contract),
    resultJson: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  store.insertTask(task);
  return task;
}

const NO_RESTRICTIONS = { repoAllowlist: [], perRunCeilingUsd: 5 };

test("createApprovalGate: an unremarkable A2 contract dispatches, no parking", async () => {
  const store = new BrainStore(tmpDbPath());
  const contract = contractFor();
  const task = seedTask(store, contract);
  const gate = createApprovalGate(store, undefined, NO_RESTRICTIONS);

  const decision = await gate(task);
  assert.equal(decision.needsApproval, false);
  assert.equal(store.getTask(task.id)?.status, "pending", "the gate itself must not change status when it doesn't park");
});

test("createApprovalGate: network:open parks the task and performs the state transition itself", async () => {
  const store = new BrainStore(tmpDbPath());
  const contract = contractFor({ constraints: { ...contractFor().constraints, network: "open" } });
  const task = seedTask(store, contract);
  const gate = createApprovalGate(store, undefined, NO_RESTRICTIONS);

  const decision = await gate(task);
  assert.equal(decision.needsApproval, true);
  assert.equal(store.getTask(task.id)?.status, "awaiting_approval");
  assert.equal(latestApprovalFor(store, task.id)?.status, "pending");
});

test("createApprovalGate: cumulative run cost over the ceiling parks the NEXT dispatch", async () => {
  const store = new BrainStore(tmpDbPath());
  const contract = contractFor();
  const task = seedTask(store, contract);
  store.insertCost({ id: "cost-1", taskId: task.id, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, usdEstimate: 6, recordedAt: new Date().toISOString() });

  const gate = createApprovalGate(store, undefined, { repoAllowlist: [], perRunCeilingUsd: 5 });
  const decision = await gate(task);
  assert.equal(decision.needsApproval, true);
  assert.match(latestApprovalFor(store, task.id)?.reason ?? "", /exceeds the per-run ceiling/);
});

test("createApprovalGate: an already-approved task is never re-parked, even though the same always-approve condition still literally applies", async () => {
  const store = new BrainStore(tmpDbPath());
  const contract = contractFor({ constraints: { ...contractFor().constraints, network: "open" } });
  const task = seedTask(store, contract);
  const gate = createApprovalGate(store, undefined, NO_RESTRICTIONS);

  await gate(task); // parks it
  resolveApproval(store, undefined, task.id, "approved", new Date().toISOString());
  // Task is back to `pending`; the contract STILL has network:open.
  const reloaded = store.getTask(task.id)!;
  const decision = await gate(reloaded);
  assert.equal(decision.needsApproval, false, "an approved task must dispatch on the next tick, not park again forever");
});

test("createApprovalGate: an A1 task with a write deliverable parks, does not dispatch", async () => {
  const store = new BrainStore(tmpDbPath());
  const contract = contractFor({ autonomy: 1, deliverable: { type: "commit", branch: "brain/task-1", push: true, draft_pr: true } });
  const task = seedTask(store, contract);
  const gate = createApprovalGate(store, undefined, NO_RESTRICTIONS);

  const decision = await gate(task);
  assert.equal(decision.needsApproval, true);
  assert.equal(store.getTask(task.id)?.status, "awaiting_approval");
});
