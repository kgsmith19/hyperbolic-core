// node --test docs/ops/stage63-molds.test.mjs (run from the repo root)
//
// S3 EXTENSION (slice S3, #421): Verification Molds rows. The S1 file
// owns the contract-fidelity + grounded-mapping + honesty-pin structure;
// S2 appended the thinness-contract fidelity pins; S3 appends the
// Verification Mold family fidelity pins and extends ADOPTION with the
// molds-plane rows. This header block documents the S3 delta; the S1
// header above remains authoritative for the file's basis.
//
// Frozen sources (std @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d):
//   tools/verification_mold.py (Stage 29: RULES x6, TECHNIQUES x5,
//     TECHNIQUE_MAP, FAILURE_SHAPES x8, IMPLEMENTATION_MARKERS x12,
//     POSITIVE_CLASSES x8, NEGATIVE_CLASSES x6)
//   tools/mold_qualification.py (Stage 31: RULES x11, RECEIPT_FIELDS x7,
//     STATUSES x5, COVERAGE_KINDS x3)
//   tools/verification_portfolio.py (Stage 32: RULES x3, TECHNIQUES x8,
//     KINDS x7, FAILURE_SHAPES x10, SELECTION_CLASSES x9,
//     REJECTION_CLASSES x2)
//
// Deliberately NOT transcribed: TECHNIQUE_COST_S + CHEAPEST_FIRST (Stage 32
// cost estimates, explicitly recalibratable in Stages 40-41 — pinning them
// as frozen would over-claim), DEFAULT_* dicts, NO_OP_COMMANDS markers,
// STACK_TECHNIQUE_COMMANDS. The frozen surface is rules, classes, fields,
// techniques, maps, and markers only.
//
// The 59b/60b/61b substrate read for this slice: the 59b mold binding is
// docs/ops/stage59b-review-adoption-lib.mjs (15 frozen rules -> live
// review-lane mechanisms); the 61b mold binding is
// docs/ops/stage61b-release-proofbed-lib.mjs (14 frozen rules -> live
// release mechanisms, zero gaps remaining). The 60b exact-head pins live in
// docs/ops/pr-verify-workflow.test.mjs and are owned by slice S9 (Gate /
// evidence, #427) — read for context, not transcribed here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const onDisk = (rel) => existsSync(path.join(root, rel));

// --- S3: Stage 29 verification_mold contract fidelity ---

test("S3 · mold RULES frozen (6 rules, order-stable)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.mold.RULES], [
    "missing-claim", "duplicate-weak-evidence",
    "implementation-coupled-oracle", "mocked-behavior-under-test",
    "overconstrained-internals", "unobservable-assertion",
  ]);
});

test("S3 · mold risks, severities, finding fields frozen", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.mold.RISKS], ["R0", "R1", "R2", "R3"]);
  assert.deepEqual([...FROZEN.mold.SEVERITIES], ["blocker", "major", "minor"]);
  assert.deepEqual([...FROZEN.mold.FINDING_FIELDS], [
    "id", "rule", "finding", "severity", "excerpt",
  ]);
});

test("S3 · mold techniques + failure-shape map frozen", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.mold.TECHNIQUES], [
    "example_based", "property_based", "mutation_check",
    "contract_test", "scenario_test",
  ]);
  assert.deepEqual({ ...FROZEN.mold.TECHNIQUE_MAP }, {
    crud: "example_based",
    state: "scenario_test",
    auth: "example_based",
    parse: "property_based",
    migration: "scenario_test",
    workflow: "scenario_test",
    ui: "example_based",
    control_plane: "contract_test",
  });
  assert.deepEqual([...FROZEN.mold.FAILURE_SHAPES], [
    "crud", "state", "auth", "parse", "migration", "workflow",
    "ui", "control_plane",
  ]);
});

test("S3 · mold implementation markers frozen (12 markers)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.mold.IMPLEMENTATION_MARKERS], [
    "library", "table", "column", "sql", "redis", "postgres",
    "orm", "framework", ".py", ".ts", ".json", "internal",
  ]);
});

test("S3 · mold corpus classes frozen (8 positive, 6 negative)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.mold.POSITIVE_CLASSES], [
    "crud", "retry", "auth", "parser", "migration", "workflow",
    "ui", "control-plane",
  ]);
  assert.deepEqual([...FROZEN.mold.NEGATIVE_CLASSES], [
    "missing-claim", "duplicate-weak-evidence",
    "implementation-coupled-oracle", "mocked-behavior-under-test",
    "overconstrained-internals", "unobservable-assertion",
  ]);
});

// --- S3: Stage 31 mold_qualification contract fidelity ---

test("S3 · qualification RULES frozen (11 rules, order-stable)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.qualification.RULES], [
    "skipped_or_filtered", "empty_or_placeholder", "hard_coded_example",
    "omitted_state", "swallowed_error", "mock_only_assertion",
    "setup_self_assertion", "structural_failure_not_red",
    "equivalent_mutant", "no_alternative_acceptance", "no_true_red",
  ]);
});

test("S3 · qualification receipt fields, statuses, coverage frozen", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.qualification.RECEIPT_FIELDS], [
    "mold", "mold_digest", "head", "provider",
    "verdict", "run_digest", "qualified_by",
  ]);
  assert.deepEqual([...FROZEN.qualification.STATUSES], [
    "passed", "failed", "skipped", "filtered", "error",
  ]);
  assert.deepEqual([...FROZEN.qualification.COVERAGE_KINDS], [
    "full", "empty", "placeholder",
  ]);
});

// --- S3: Stage 32 verification_portfolio contract fidelity ---

test("S3 · portfolio RULES frozen (3 rules, order-stable)", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.portfolio.RULES], [
    "budget_exceeded", "missing_command", "excessive_portfolio",
  ]);
});

test("S3 · portfolio techniques + claim kinds frozen", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.portfolio.TECHNIQUES], [
    "example_based", "property_based", "mutation_check",
    "contract_test", "scenario_test", "fuzz",
    "e2e_focused", "state_matrix",
  ]);
  assert.deepEqual([...FROZEN.portfolio.KINDS], [
    "parser", "adapter", "ui", "auth", "state", "docs", "generic",
  ]);
});

test("S3 · portfolio failure shapes + selection/rejection classes frozen", async () => {
  const { FROZEN } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.portfolio.FAILURE_SHAPES], [
    "state", "auth", "parse", "migration", "workflow", "ui",
    "control_plane", "crud", "adapter", "docs",
  ]);
  assert.deepEqual([...FROZEN.portfolio.SELECTION_CLASSES], [
    "js", "python", "dotnet", "mixed", "parser", "adapter",
    "ui", "auth-state-matrix", "r0-docs",
  ]);
  assert.deepEqual([...FROZEN.portfolio.REJECTION_CLASSES], [
    "missing-command", "excessive-portfolio",
  ]);
});

test("S3 · provenance names the mold modules at the exact Standard SHA", async () => {
  const { provenance } = await import("./stage63-adoption-lib.mjs");
  const text = provenance();
  assert.match(text, /tools\/verification_mold\.py/);
  assert.match(text, /tools\/mold_qualification\.py/);
  assert.match(text, /tools\/verification_portfolio\.py/);
  assert.match(text, /9e50c9c3518e5bed2ba93e194cb157a78ee0278d/);
});

// --- S3: molds-plane rows grounded or honestly gapped ---

test("S3 · S3 rows grounded or honestly gapped", async () => {
  const { ADOPTION, GAP_SLICES } = await import("./stage63-adoption-lib.mjs");
  const s3rows = Object.keys(ADOPTION).filter((k) => k.startsWith("molds:"));
  assert.equal(s3rows.length, 5, "S3 contributes exactly 5 rows");
  for (const key of s3rows) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null,
      `${key} must have exactly one of mechanism/gap (XOR)`);
    if (entry.gap !== null) {
      assert.ok(GAP_SLICES.includes(entry.gap),
        `${key} gap ${entry.gap} is not a tracked Stage 63 slice`);
    } else {
      assert.ok(typeof entry.mechanism === "string" && entry.mechanism.length > 0,
        `${key} has no mechanism path`);
      assert.ok(onDisk(entry.mechanism),
        `${key} maps to ${entry.mechanism}, which does not exist on disk`);
    }
  }
  // Cumulative mapped/gap counts are pinned in ONE place only —
  // stage63-adoption.test.mjs (the file every later slice extends) — to avoid
  // duplicated drift-prone assertions (AI Review round-1 advisory, PR #430).
});

// --- S3: substrate totality (the 59b/61b mold bindings S3 frames) ---

test("S3 · review-mold substrate is total: 59b binds all 15 frozen rules", async () => {
  const frozen = await import("./stage59b-review-adoption-lib.mjs");
  assert.equal(frozen.FROZEN_RULES.length, 15);
  for (const rule of frozen.FROZEN_RULES) {
    const entry = frozen.ADOPTION[rule];
    assert.ok(entry, `59b rule ${rule} has no ADOPTION entry`);
    assert.ok(typeof entry.path === "string" && entry.path.length > 0,
      `59b rule ${rule} has no mechanism path`);
    assert.ok(onDisk(entry.path),
      `59b rule ${rule} maps to ${entry.path}, which does not exist on disk`);
  }
});

test("S3 · release-mold substrate is total: 61b binds all 14 frozen rules", async () => {
  const frozen = await import("./stage61b-release-proofbed-lib.mjs");
  assert.equal(frozen.FROZEN_RULES.length, 14);
  assert.deepEqual(frozen.GAP_ISSUES, [],
    "61b still carries open gaps — S3 frames a zero-gap release mold");
  for (const rule of frozen.FROZEN_RULES) {
    const entry = frozen.ADOPTION[rule];
    assert.ok(entry, `61b rule ${rule} has no ADOPTION entry`);
    const paths = [...(entry.paths ?? []), entry.path].filter(Boolean);
    assert.ok(paths.length > 0, `61b rule ${rule} has no mechanism path`);
    for (const p of paths) {
      assert.ok(onDisk(p),
        `61b rule ${rule} maps to ${p}, which does not exist on disk`);
    }
  }
});
