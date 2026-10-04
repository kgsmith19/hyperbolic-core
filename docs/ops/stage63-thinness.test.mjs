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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

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
  const { ADOPTION } = await import("./stage63-adoption-lib.mjs");
  const s2rows = Object.keys(ADOPTION).filter((k) => k.startsWith("thinness:"));
  assert.equal(s2rows.length, 4, "S2 contributes exactly 4 rows");
  for (const key of s2rows) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null,
      `${key} must have exactly one of mechanism/gap (XOR)`);
  }
  // Cumulative mapped/gap counts are pinned in ONE place only —
  // stage63-adoption.test.mjs (the file every later slice extends) — to avoid
  // duplicated drift-prone assertions (AI Review round-1 advisory, PR #430).
});

// Round-1 BLOCK fix (PR #430, AI Review finding 1): the S2 mapping claims
// `thinness:dor-receipt` operates via .github/PULL_REQUEST_TEMPLATE.md, so a
// characterization test must read that template and prove the repository
// actually RECEIVES DoR receipt data through it. The template collects a
// REPRESENTATIVE SUBSET of FULL_FIELDS, and this test pins exactly that
// collected subset — never more (the residual fields remain judge-enforced
// by the Gate's checklist/labels, disclosed honestly below).
test("S2 · thin-PR practice: the PR template collects the DoR subset", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  const template = read(".github/PULL_REQUEST_TEMPLATE.md");
  // Structural: the five template sections (the same ones the
  // verify-pr-description gate enforces) exist.
  for (const heading of ["## 📋 Summary", "## 🔗 Related Issue", "## 🔨 Changes",
    "## 🧪 Verification", "## ✅ Scope Check"]) {
    assert.ok(template.includes(heading), `template missing section ${heading}`);
  }
  // The DoR FIELDS the template genuinely collects, each pinned to its
  // template evidence (FIELD → prompt text that collects it):
  const COLLECTED = {
    outcome: "Explain what changed and why.",            // Summary = outcome
    claims: "Describe the smallest meaningful set of changes.", // Changes = claims
    dependencies: "Closes #",                             // Related Issue = dependency reference
    evidence_strategy: "List each command or check run and its result.", // Verification = evidence
    non_goals: "Known limitations or checks not run are stated above.",  // Scope Check = limitations
  };
  for (const [field, marker] of Object.entries(COLLECTED)) {
    assert.ok(FROZEN.ready.FULL_FIELDS.includes(field),
      `${field} is not a DoR FULL_FIELD`);
    assert.ok(template.includes(marker),
      `DoR field ${field} is no longer collected by the PR template`);
  }
  // Honesty: fields the template does NOT collect literally. Asserting the
  // residual list rejects the failure mode where a slice drifts the mapping
  // to claim the template covers all 17 FULL_FIELDS.
  const NOT_COLLECTED = ["autonomy_envelope", "focus_envelope", "allowed_paths",
    "protected_paths", "thinness_total", "recovery", "owner_decisions",
    "context_budget_ok", "extension_profile_ok", "risk",
    "forbidden_outcomes", "disposition"];
  assert.equal(NOT_COLLECTED.length + Object.keys(COLLECTED).length,
    FROZEN.ready.FULL_FIELDS.length,
    "COLLECTED + NOT_COLLECTED must partition FULL_FIELDS exactly");
  for (const field of NOT_COLLECTED) {
    assert.ok(FROZEN.ready.FULL_FIELDS.includes(field),
    `residual ${field} renamed in the Standard — update the partition`);
  }
});
