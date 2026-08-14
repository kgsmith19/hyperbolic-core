import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../src/store.ts";
import { RunJournal } from "../src/journal.ts";
import { submitRun, submitContract } from "../src/run-service.ts";
import type { TaskContractV1 } from "../src/contracts.ts";

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brain-run-service-")), "brain.db");
}

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-run-service-journal-"));
}

const REPO = { url: "https://github.com/kgsmith19/hyperbolic-core", ref: "main" };

test("submitRun: a valid objective plans, validates, and journals a run row before any invocation exists", () => {
  const store = new BrainStore(tmpDbPath());
  const result = submitRun(store, { objective: "add a health endpoint", repo: REPO, autonomy: 2 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(store.getRun(result.run.id)?.id, result.run.id);
  assert.equal(store.listInvocationsForTask(result.tasks[0]!.id).length, 0, "no invocation row exists yet -- dry planning never dispatches");
  assert.equal(result.contracts.length, 1);
  assert.equal(result.contracts[0]!.run_id, result.run.id);
  assert.equal(store.getTask(result.tasks[0]!.id)?.status, "pending");
});

test("submitRun: the journaled task row's contractJson round-trips the exact contract returned", () => {
  const store = new BrainStore(tmpDbPath());
  const result = submitRun(store, { objective: "x", repo: REPO });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const stored = store.getTask(result.tasks[0]!.id);
  assert.deepEqual(JSON.parse(stored!.contractJson), result.contracts[0]);
});

test("submitRun: defaults autonomy to 0 when unspecified", () => {
  const store = new BrainStore(tmpDbPath());
  const result = submitRun(store, { objective: "x", repo: REPO });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.run.autonomy, 0);
  assert.equal(result.contracts[0]!.deliverable.push, false, "autonomy 0 must never default to a push-capable deliverable");
});

test("submitContract: an invalid contract (default-branch deliverable) is refused with zero store writes", () => {
  const store = new BrainStore(tmpDbPath());
  const invalid: TaskContractV1 = {
    task_id: "44444444-4444-4444-4444-444444444444",
    run_id: "33333333-3333-3333-3333-333333333333",
    title: "bad",
    repo: REPO,
    harness: { preferred: null, fallback: [] },
    autonomy: 2,
    prompt: { objective: "x", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: [], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "none" },
    acceptance: [],
    deliverable: { type: "commit", branch: "main", push: true, draft_pr: true },
  };

  const result = submitContract(store, invalid);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.length > 0);
  assert.equal(store.getRun(invalid.run_id), null, "no run row in a dispatchable state -- here, no run row at all");
  assert.equal(store.getTask(invalid.task_id), null);
});

test("submitContract: a valid pre-built contract journals using ITS OWN run_id/task_id (fixture-driven submission path)", () => {
  const store = new BrainStore(tmpDbPath());
  const valid: TaskContractV1 = {
    task_id: "22222222-2222-2222-2222-222222222222",
    run_id: "11111111-1111-1111-1111-111111111111",
    title: "fixture",
    repo: REPO,
    harness: { preferred: "claude-code", fallback: ["claude-code"] },
    autonomy: 0,
    prompt: { objective: "fixture objective", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: [], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "none" },
    acceptance: [],
    deliverable: { type: "report", branch: "brain/22222222-2222-2222-2222-222222222222", push: false, draft_pr: false },
  };

  const result = submitContract(store, valid);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.run.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(store.getRun("11111111-1111-1111-1111-111111111111")?.objective, "fixture objective");
});

test("submitRun: appends a run.submitted journal event when a RunJournal is supplied", () => {
  const store = new BrainStore(tmpDbPath());
  const journal = new RunJournal(tmpDataDir());
  const result = submitRun(store, { objective: "x", repo: REPO }, journal);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const events = journal.read(result.run.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "run.submitted");
});

test("submitContract: an invalid contract never touches the journal either", () => {
  const store = new BrainStore(tmpDbPath());
  const journal = new RunJournal(tmpDataDir());
  const invalid: TaskContractV1 = {
    task_id: "44444444-4444-4444-4444-444444444444",
    run_id: "33333333-3333-3333-3333-333333333333",
    title: "bad",
    repo: REPO,
    harness: { preferred: null, fallback: [] },
    autonomy: 2,
    prompt: { objective: "x", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: [], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "none" },
    acceptance: [],
    deliverable: { type: "commit", branch: "master", push: true, draft_pr: true },
  };
  submitContract(store, invalid, journal);
  assert.deepEqual(journal.read(invalid.run_id), []);
});
