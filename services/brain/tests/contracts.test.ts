import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaskContract, validateResultContract, type TaskContractV1, type ResultContractV1 } from "../src/contracts.ts";

function validContract(overrides: Partial<TaskContractV1> = {}): TaskContractV1 {
  return {
    task_id: "22222222-2222-2222-2222-222222222222",
    run_id: "11111111-1111-1111-1111-111111111111",
    title: "do the thing",
    repo: { url: "https://github.com/kgsmith19/hyperbolic-core", ref: "main" },
    harness: { preferred: "claude-code", fallback: ["claude-code"] },
    autonomy: 2,
    prompt: { objective: "ship it", context_refs: [], prompt_org_refs: [] },
    constraints: {
      allowed_paths: ["**"],
      denied_paths: [],
      vault_keys: [],
      max_turns: 40,
      wall_clock_min: 60,
      token_budget: 500_000,
      network: "provider-only",
    },
    acceptance: [],
    deliverable: { type: "commit", branch: "brain/22222222-2222-2222-2222-222222222222", push: true, draft_pr: true },
    ...overrides,
  };
}

function validResult(overrides: Partial<ResultContractV1> = {}): ResultContractV1 {
  return {
    task_id: "22222222-2222-2222-2222-222222222222",
    status: "succeeded",
    verdicts: [{ id: "AC-1", pass: true, exit: 0, output_tail: "ok" }],
    commits: ["abc1234"],
    branch: "brain/22222222-2222-2222-2222-222222222222",
    pr_url: null,
    cost: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, usd_estimate: 0.01 },
    duration_s: 12.5,
    transcript_ref: "runs/11111111.events.ndjson",
    ledger_ref: "ledger/11111111.jsonl",
    ...overrides,
  };
}

test("validateTaskContract: a well-formed contract validates", () => {
  const result = validateTaskContract(validContract());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateTaskContract: rejects deliverable.branch === 'main'", () => {
  const result = validateTaskContract(validContract({ deliverable: { type: "commit", branch: "main", push: true, draft_pr: true } }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("branch")), `expected a branch-related error, got: ${result.errors.join("; ")}`);
});

test("validateTaskContract: rejects deliverable.branch === 'master'", () => {
  const result = validateTaskContract(validContract({ deliverable: { type: "commit", branch: "master", push: true, draft_pr: true } }));
  assert.equal(result.valid, false);
});

test("validateTaskContract: a non-default branch name still validates", () => {
  const result = validateTaskContract(validContract({ deliverable: { type: "commit", branch: "brain/some-task", push: true, draft_pr: true } }));
  assert.equal(result.valid, true);
});

test("validateTaskContract: rejects a missing required field", () => {
  const contract = validContract() as Record<string, unknown>;
  delete contract.repo;
  const result = validateTaskContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("validateTaskContract: rejects an unknown top-level property (additionalProperties: false)", () => {
  const result = validateTaskContract({ ...validContract(), unexpected: true });
  assert.equal(result.valid, false);
});

test("validateTaskContract: rejects a malformed task_id (not a uuid)", () => {
  const result = validateTaskContract(validContract({ task_id: "not-a-uuid" }));
  assert.equal(result.valid, false);
});

test("validateTaskContract: rejects autonomy out of 0..3 range", () => {
  const result = validateTaskContract(validContract({ autonomy: 4 }));
  assert.equal(result.valid, false);
});

test("validateTaskContract: rejects an unresolved prompt_org_refs entry with no @version/@latest", () => {
  const result = validateTaskContract(
    validContract({ prompt: { objective: "x", context_refs: [], prompt_org_refs: ["idea-optimizer"] } })
  );
  assert.equal(result.valid, false);
});

test("validateTaskContract: accepts a pinned prompt_org_refs entry", () => {
  const result = validateTaskContract(
    validContract({ prompt: { objective: "x", context_refs: [], prompt_org_refs: ["idea-optimizer@3"] } })
  );
  assert.equal(result.valid, true);
});

test("validateResultContract: a well-formed result validates", () => {
  const result = validateResultContract(validResult());
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateResultContract: rejects an unknown status value", () => {
  const result = validateResultContract(validResult({ status: "done" as ResultContractV1["status"] }));
  assert.equal(result.valid, false);
});

test("validateResultContract: pr_url may be null", () => {
  const result = validateResultContract(validResult({ pr_url: null }));
  assert.equal(result.valid, true);
});

test("validateResultContract: cost.usd_estimate may be null", () => {
  const result = validateResultContract(validResult({ cost: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, usd_estimate: null } }));
  assert.equal(result.valid, true);
});
