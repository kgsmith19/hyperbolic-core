// node --test docs/ops/stage63-adoption.test.mjs (run from the repo root)
//
// Runtime basis: identical to stage61b-release-proofbed.test.mjs — the .mjs
// imports run natively under Node's built-in test runner (CI pins
// node-version "22.19.0" in .github/actions/verify-tests-shell, and the
// Platform lane executes exactly this file via `node --test
// docs/ops/*.test.mjs`). No loader, transpiler, or dist build is involved.
//
// Stage 63 slice S1 (#419): hyperbolic-core's context/docs/maps adoption
// slice. It binds the frozen v5 context/docs/maps contract (four modules in
// agent-engineering-standard @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d)
// to the hyperbolic-core runtime mechanisms that satisfy each element — and
// HONESTLY discloses the elements that do not exist yet as gaps tracked in
// their own slice Issues (#420–#428), rather than claiming a proof that is
// not there. Later Stage 63 slices extend this file's ADOPTION map; S1 owns
// the context-rules rows only.
//
// Three halves in one CI-provable file:
//   1. Contract fidelity: the transcribed frozen constants match their frozen
//      shape (contents, order, counts), so Standard drift is caught.
//   2. Grounded mapping: every mapped element names exactly one real on-disk
//      hyperbolic-core mechanism (verified via existsSync/readFileSync against
//      the repo, never via the lib's own exports).
//   3. Honesty pins: each disclosed gap genuinely does NOT exist yet, and the
//      aggregate S1 posture never claims coverage it does not have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FROZEN,
  ADOPTION,
  GAP_SLICES,
  gapsOf,
  mappedOf,
  provenance,
} from "./stage63-adoption-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

// --- Half 1: contract fidelity (frozen shape pinned; drift fails loudly) ---

test("S1 · repo_map PLANES frozen (6 planes, order-stable)", () => {
  assert.deepEqual([...FROZEN.repo_map.PLANES], [
    "source", "generated", "artifact", "cache", "evidence", "protected",
  ]);
});

test("S1 · repo_map budgets and patterns frozen", () => {
  assert.equal(FROZEN.repo_map.MAP_BUDGET_ENTRIES, 60);
  assert.deepEqual([...FROZEN.repo_map.GENERATED_PATTERNS], ["Canonical/generated/"]);
  assert.deepEqual([...FROZEN.repo_map.ARTIFACT_PATTERNS], [
    "Canonical/schemas/", "Canonical/capabilities.json", "Canonical/v4.2-preservation.csv",
  ]);
  assert.deepEqual([...FROZEN.repo_map.CACHE_PATTERNS], [
    ".worktrees/", "__pycache__/", ".evidence/cache",
  ]);
  assert.deepEqual([...FROZEN.repo_map.EVIDENCE_PATTERNS], [".evidence/"]);
  assert.deepEqual([...FROZEN.repo_map.PROTECTED_PATTERNS], [
    ".github/workflows/pr-gate.yml", ".github/workflows/merge-policy.yml", "main",
  ]);
});

test("S1 · ownership_map frozen triples", () => {
  assert.deepEqual([...FROZEN.ownership_map.INVARIANT_CLASSES], [
    "shared-schema", "global-state", "dynamic-wiring", "external-consumer", "security",
  ]);
  assert.deepEqual([...FROZEN.ownership_map.ENTRY_METADATA], [
    "roots", "interfaces", "direction", "commands",
  ]);
  assert.deepEqual([...FROZEN.ownership_map.SCOPE_KINDS], ["read", "edit", "impact"]);
});

test("S1 · context_budget frozen statuses and byte thresholds", () => {
  assert.deepEqual([...FROZEN.context_budget.STATUSES], [
    "HEALTHY", "EXPANSION_REQUIRES_REASON", "ROTATE_AT_BOUNDARY",
    "ROTATE_NOW_READ_ONLY", "RECOVERY_REQUIRED",
  ]);
  assert.equal(FROZEN.context_budget.CAPSULE_BYTES_MAX, 24 * 1024);
  assert.equal(FROZEN.context_budget.WORKING_BYTES_WARN, 32 * 1024);
  assert.equal(FROZEN.context_budget.WORKING_BYTES_MAX, 48 * 1024);
});

test("S1 · handoff_acceptance frozen rules and triggers", () => {
  assert.deepEqual([...FROZEN.handoff_acceptance.RULES], [
    "wrong-phase", "stale-head", "missing-decision", "protected-omitted",
    "guardrail-gap", "prompt-injection", "sat-required", "cross-provider",
  ]);
  assert.deepEqual([...FROZEN.handoff_acceptance.SEVERITIES], ["blocker", "major", "minor"]);
  assert.deepEqual([...FROZEN.handoff_acceptance.FINDING_FIELDS], [
    "id", "rule", "finding", "severity", "excerpt",
  ]);
  assert.deepEqual([...FROZEN.handoff_acceptance.SAT_TRIGGERS], [
    "new-provider", "high-risk", "privileged-path", "authority-change",
  ]);
});

test("S1 · provenance names the exact Standard SHA", () => {
  assert.match(provenance(), /9e50c9c3518e5bed2ba93e194cb157a78ee0278d/);
});

// --- Half 2: grounded mapping (every mapped element → one real on-disk path) ---

for (const key of mappedOf()) {
  test(`S1 · mapped element has a real mechanism on disk: ${key}`, () => {
    const entry = ADOPTION[key];
    assert.ok(entry && typeof entry.mechanism === "string" && entry.mechanism.length > 0,
      `${key} has no mechanism path`);
    assert.ok(existsSync(path.join(root, entry.mechanism)),
      `${key} maps to ${entry.mechanism}, which does not exist on disk`);
  });
}

test("S1 · context plane maps to the AGENTS.md router + per-app instruction files", () => {
  const body = read("AGENTS.md");
  assert.match(body, /Sources of truth/);
  assert.ok(existsSync(path.join(root, "apps/lifeos/AGENTS.md")) ||
    existsSync(path.join(root, "apps/shell/AGENTS.md")));
});

test("S1 · evidence plane maps to the docs/ops proofbed family", () => {
  assert.ok(existsSync(path.join(root, "docs/ops/stage61b-release-proofbed.test.mjs")));
  assert.ok(existsSync(path.join(root, "docs/ops/pr-verify-workflow.test.mjs")));
});

test("S1 · continuity plane maps to goal scratch + Work State marker convention", () => {
  const body = read("AGENTS.md");
  assert.match(body, /agent-engineering-standard:work-state:v1/);
});

// --- Half 3: honesty pins (gaps disclosed, never green-washed) ---

for (const key of gapsOf()) {
  test(`S1 · gap is honestly undisclosed-mechanism with a tracking slice: ${key}`, () => {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism, null);
    assert.ok(GAP_SLICES.includes(entry.gap),
      `${key} gap ${entry.gap} is not a tracked Stage 63 slice`);
  });
}

test("S1 · S1 posture never claims full v5 coverage", () => {
  assert.equal(mappedOf().length, 8, "S1 maps exactly 8 mechanisms");
  assert.equal(gapsOf().length, 4, "S1 discloses exactly 4 gaps");
  for (const key of Object.keys(ADOPTION)) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null,
      `${key} must have exactly one of mechanism/gap (XOR)`);
  }
});
