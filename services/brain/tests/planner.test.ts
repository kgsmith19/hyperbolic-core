import { test } from "node:test";
import assert from "node:assert/strict";
import { planObjective } from "../src/planner.ts";
import { validateTaskContract } from "../src/contracts.ts";

const REPO = { url: "https://github.com/kgsmith19/hyperbolic-core", ref: "main" };

test("planObjective: produces a schema-valid contract for a plain objective", () => {
  const contract = planObjective({
    runId: "11111111-1111-1111-1111-111111111111",
    taskId: "22222222-2222-2222-2222-222222222222",
    objective: "add a health endpoint",
    repo: REPO,
    autonomy: 2,
  });
  const result = validateTaskContract(contract);
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("planObjective: deliverable.branch is brain/<task_id>, never a default branch", () => {
  const contract = planObjective({
    runId: "11111111-1111-1111-1111-111111111111",
    taskId: "22222222-2222-2222-2222-222222222222",
    objective: "x",
    repo: REPO,
    autonomy: 0,
  });
  assert.equal(contract.deliverable.branch, "brain/22222222-2222-2222-2222-222222222222");
});

test("planObjective: push/draft_pr are false below autonomy 2, true at or above it", () => {
  const base = { runId: "11111111-1111-1111-1111-111111111111", taskId: "22222222-2222-2222-2222-222222222222", objective: "x", repo: REPO };
  assert.equal(planObjective({ ...base, autonomy: 0 }).deliverable.push, false);
  assert.equal(planObjective({ ...base, autonomy: 1 }).deliverable.push, false);
  assert.equal(planObjective({ ...base, autonomy: 2 }).deliverable.push, true);
  assert.equal(planObjective({ ...base, autonomy: 3 }).deliverable.push, true);
});

test("planObjective: title is truncated to <= 120 chars for a long objective, full objective preserved in prompt.objective", () => {
  const objective = "x".repeat(200);
  const contract = planObjective({
    runId: "11111111-1111-1111-1111-111111111111",
    taskId: "22222222-2222-2222-2222-222222222222",
    objective,
    repo: REPO,
    autonomy: 0,
  });
  assert.ok(contract.title.length <= 120);
  assert.equal(contract.prompt.objective, objective);
  assert.equal(validateTaskContract(contract).valid, true);
});

test("planObjective: defaults context_refs/prompt_org_refs to empty arrays, not undefined", () => {
  const contract = planObjective({
    runId: "11111111-1111-1111-1111-111111111111",
    taskId: "22222222-2222-2222-2222-222222222222",
    objective: "x",
    repo: REPO,
    autonomy: 0,
  });
  assert.deepEqual(contract.prompt.context_refs, []);
  assert.deepEqual(contract.prompt.prompt_org_refs, []);
});

test("planObjective: harness.preferred defaults to null (no forced harness)", () => {
  const contract = planObjective({
    runId: "11111111-1111-1111-1111-111111111111",
    taskId: "22222222-2222-2222-2222-222222222222",
    objective: "x",
    repo: REPO,
    autonomy: 0,
  });
  assert.equal(contract.harness.preferred, null);
  assert.equal(validateTaskContract(contract).valid, true);
});
