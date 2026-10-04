// node --test docs/ops/stage63-adoption.test.mjs (run from the repo root)
//
// S2 EXTENSION (slice S2, #420): thinness/DoR/NO_CHANGE rows. The S1 file
// owns the contract-fidelity + grounded-mapping + honesty-pin structure;
// S2 appends the thinness-contract fidelity pins and extends ADOPTION with
// the thinness/DoR/disposition rows. This header block documents the S2
// delta; the S1 header above remains authoritative for the file's basis.
//
// Frozen sources (std @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d):
//   tools/thinness.py (AXES ×6, HARD_CONDITIONS ×10, bands micro/preferred/medium/large)
//   tools/ready.py (FULL_FIELDS ×17, COMPACT_FIELDS ×3)
//   tools/disposition.py (DISPOSITIONS ×4, OBSERVATION_FIELDS ×6)

import { test } from "node:test";
import assert from "node:assert/strict";

// --- S2: thinness contract fidelity ---

test("S2 · thinness AXES frozen (6 axes, order-stable)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.thinness.AXES], [
    "independent_behaviors", "unknowns", "state_irreversibility",
    "external_boundary", "verification_burden", "write_overlap",
  ]);
});

test("S2 · thinness HARD_CONDITIONS frozen (10 conditions, order-stable)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.thinness.HARD_CONDITIONS], [
    "one_sentence_outcome", "one_observable_boundary", "independent_merge_or_recovery",
    "one_writer", "one_reviewer_understands", "one_evidence_strategy",
    "one_to_five_claims", "non_goals_explicit", "no_write_overlap", "capsule_sufficient",
  ]);
});

test("S2 · thinness bands frozen (micro/preferred/medium/large)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.thinness.BANDS], ["micro", "preferred", "medium", "large"]);
});

test("S2 · DoR FULL_FIELDS frozen (17 fields, order-stable)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.ready.FULL_FIELDS], [
    "outcome", "claims", "forbidden_outcomes", "non_goals", "risk",
    "autonomy_envelope", "focus_envelope", "allowed_paths", "protected_paths",
    "dependencies", "thinness_total", "disposition", "recovery",
    "owner_decisions", "evidence_strategy", "context_budget_ok", "extension_profile_ok",
  ]);
});

test("S2 · DoR COMPACT_FIELDS frozen (outcome/scope/proof)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.ready.COMPACT_FIELDS], ["outcome", "scope", "proof"]);
});

test("S2 · disposition outcomes + observation fields frozen", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.disposition.DISPOSITIONS], [
    "IMPLEMENT", "NO_CHANGE", "INSUFFICIENT_EVIDENCE", "OWNER_DECISION",
  ]);
  assert.deepEqual([...FROZEN.disposition.OBSERVATION_FIELDS], [
    "environment", "command", "head", "expected", "observed", "evidence",
  ]);
});

test("S2 · S2 rows grounded or honestly gapped", async () => {
  const { ADOPTION, gapsOf, mappedOf } = await import("./stage63-adoption-lib.mjs");
  const s2rows = Object.keys(ADOPTION).filter((k) => k.startsWith("thinness:"));
  assert.ok(s2rows.length >= 4, `S2 contributes >=4 rows, got ${s2rows.length}`);
  for (const key of s2rows) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null,
      `${key} must have exactly one of mechanism/gap (XOR)`);
  }
  assert.equal(mappedOf().length, 12, "S1+S2 map exactly 12 mechanisms");
  assert.equal(gapsOf().length, 4, "S2 discloses the same 4 gaps (no new gaps, none hidden)");
});
