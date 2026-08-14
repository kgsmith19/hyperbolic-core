import { test } from "node:test";
import assert from "node:assert/strict";
import { alwaysApproveReason, autonomyPermits, determineApproval, hasWriteDeliverable, AUTONOMY_PLAN, AUTONOMY_READ, AUTONOMY_EXECUTE, AUTONOMY_CHAIN } from "../src/autonomy.ts";
import type { TaskContractV1 } from "../src/contracts.ts";

function fixtureContract(overrides: Partial<TaskContractV1> = {}): TaskContractV1 {
  return {
    task_id: "22222222-2222-2222-2222-222222222222",
    run_id: "11111111-1111-1111-1111-111111111111",
    title: "x",
    repo: { url: "https://github.com/kgsmith19/hyperbolic-core", ref: "main" },
    harness: { preferred: "claude-code", fallback: [] },
    autonomy: 2,
    prompt: { objective: "x", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: ["**"], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "provider-only" },
    acceptance: [],
    deliverable: { type: "commit", branch: "brain/22222222-2222-2222-2222-222222222222", push: true, draft_pr: true },
    ...overrides,
  };
}

const NO_RESTRICTIONS = { cumulativeCostUsd: 0, perRunCeilingUsd: 5, repoAllowlist: [] };

test("hasWriteDeliverable: report is the only non-write deliverable type", () => {
  assert.equal(hasWriteDeliverable(fixtureContract({ deliverable: { type: "report", branch: "brain/x", push: false, draft_pr: false } })), false);
  assert.equal(hasWriteDeliverable(fixtureContract({ deliverable: { type: "commit", branch: "brain/x", push: true, draft_pr: true } })), true);
  assert.equal(hasWriteDeliverable(fixtureContract({ deliverable: { type: "patch", branch: "brain/x", push: false, draft_pr: false } })), true);
});

test("autonomyPermits: A0 never permits dispatch, regardless of deliverable", () => {
  assert.equal(autonomyPermits(fixtureContract({ deliverable: { type: "report", branch: "brain/x", push: false, draft_pr: false } }), AUTONOMY_PLAN), false);
  assert.equal(autonomyPermits(fixtureContract(), AUTONOMY_PLAN), false);
});

test("autonomyPermits: A1 permits only a task with no write deliverable", () => {
  assert.equal(autonomyPermits(fixtureContract({ deliverable: { type: "report", branch: "brain/x", push: false, draft_pr: false } }), AUTONOMY_READ), true);
  assert.equal(autonomyPermits(fixtureContract({ deliverable: { type: "commit", branch: "brain/x", push: true, draft_pr: true } }), AUTONOMY_READ), false);
});

test("autonomyPermits: A2/A3 permit full task execution", () => {
  assert.equal(autonomyPermits(fixtureContract(), AUTONOMY_EXECUTE), true);
  assert.equal(autonomyPermits(fixtureContract(), AUTONOMY_CHAIN), true);
});

test("alwaysApproveReason: network open always triggers, independent of autonomy level (checked separately by determineApproval)", () => {
  const contract = fixtureContract({ constraints: { ...fixtureContract().constraints, network: "open" } });
  assert.ok(alwaysApproveReason(contract, NO_RESTRICTIONS));
});

test("alwaysApproveReason: a default-branch deliverable always triggers (defense in depth; unreachable via a schema-validated contract)", () => {
  const contract = fixtureContract({ deliverable: { type: "commit", branch: "main", push: true, draft_pr: true } });
  assert.ok(alwaysApproveReason(contract, NO_RESTRICTIONS));
});

test("alwaysApproveReason: cumulative cost over the per-run ceiling triggers", () => {
  const contract = fixtureContract();
  assert.equal(alwaysApproveReason(contract, { cumulativeCostUsd: 4.99, perRunCeilingUsd: 5, repoAllowlist: [] }), null);
  assert.ok(alwaysApproveReason(contract, { cumulativeCostUsd: 5.01, perRunCeilingUsd: 5, repoAllowlist: [] }));
});

test("alwaysApproveReason: a repo not in a CONFIGURED allowlist triggers; an unconfigured (empty) allowlist never does", () => {
  const contract = fixtureContract();
  assert.equal(alwaysApproveReason(contract, NO_RESTRICTIONS), null, "empty allowlist = unconfigured = no restriction");
  assert.ok(alwaysApproveReason(contract, { ...NO_RESTRICTIONS, repoAllowlist: ["https://github.com/someone-else/other-repo"] }));
  assert.equal(alwaysApproveReason(contract, { ...NO_RESTRICTIONS, repoAllowlist: [contract.repo.url] }), null);
});

test("alwaysApproveReason: a fully unremarkable contract never triggers", () => {
  assert.equal(alwaysApproveReason(fixtureContract(), NO_RESTRICTIONS), null);
});

test("determineApproval: a write-deliverable task at A1 parks, reason cites the level", () => {
  const contract = fixtureContract({ autonomy: AUTONOMY_READ, deliverable: { type: "commit", branch: "brain/x", push: true, draft_pr: true } });
  const decision = determineApproval(contract, AUTONOMY_READ, NO_RESTRICTIONS);
  assert.equal(decision.needsApproval, true);
  assert.match(decision.reason ?? "", /autonomy level 1/);
});

test("determineApproval: a write-deliverable task at A1 never dispatches -- needsApproval is unconditional at that level", () => {
  const contract = fixtureContract({ autonomy: AUTONOMY_READ });
  assert.equal(determineApproval(contract, AUTONOMY_READ, NO_RESTRICTIONS).needsApproval, true);
});

test("determineApproval: an always-approve condition parks the task EVEN AT A3 (regardless of level)", () => {
  const contract = fixtureContract({ autonomy: AUTONOMY_CHAIN, constraints: { ...fixtureContract().constraints, network: "open" } });
  const decision = determineApproval(contract, AUTONOMY_CHAIN, NO_RESTRICTIONS);
  assert.equal(decision.needsApproval, true);
  assert.match(decision.reason ?? "", /network is open/);
});

test("determineApproval: a normal A2 task with nothing remarkable never needs approval", () => {
  const decision = determineApproval(fixtureContract({ autonomy: AUTONOMY_EXECUTE }), AUTONOMY_EXECUTE, NO_RESTRICTIONS);
  assert.deepEqual(decision, { needsApproval: false, reason: null });
});
