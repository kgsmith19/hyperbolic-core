// docs/ops/stage63-adoption-lib.mjs
//
// Stage 63 slice S1 (#419): the single-sourced mapping from the frozen v5
// context/docs/maps contract to hyperbolic-core's live runtime mechanisms,
// plus the honest disclosure of the elements that do not exist yet.
//
// The offline proofbed test imports this module, so the mapping is proven in
// CI by the tests and reused verbatim by any live read-back. No network
// access happens here.
//
// The contract constants below are transcribed byte-stable from
// agent-engineering-standard @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d
// (four modules: tools/repo_map.py, tools/ownership_map.py,
// tools/context_budget.py, tools/handoff_acceptance.py). The Standard is not
// vendored into this repo, so — exactly as stage61b-release-proofbed-lib.mjs
// did for the frozen 61a RULES tuple — the constants are transcribed here
// with this provenance note, and the test pins their frozen shape (contents,
// order, counts) so a drift is caught.
//
// S1 owns the context-rules rows only. Later Stage 63 slices (S2–S10,
// Issues #420–#428) extend ADOPTION with their own rows; the helpers below
// already operate over the whole map.

// --- Frozen contract: tools/repo_map.py ---
const REPO_MAP_PLANES = [
  "source", "generated", "artifact", "cache", "evidence", "protected",
];
const REPO_MAP_BUDGET = 60;
const REPO_MAP_GENERATED = ["Canonical/generated/"];
const REPO_MAP_ARTIFACT = [
  "Canonical/schemas/", "Canonical/capabilities.json", "Canonical/v4.2-preservation.csv",
];
const REPO_MAP_CACHE = [".worktrees/", "__pycache__/", ".evidence/cache"];
const REPO_MAP_EVIDENCE = [".evidence/"];
const REPO_MAP_PROTECTED = [
  ".github/workflows/pr-gate.yml", ".github/workflows/merge-policy.yml", "main",
];

// --- Frozen contract: tools/ownership_map.py ---
const OWNERSHIP_INVARIANTS = [
  "shared-schema", "global-state", "dynamic-wiring", "external-consumer", "security",
];
const OWNERSHIP_METADATA = ["roots", "interfaces", "direction", "commands"];
const OWNERSHIP_SCOPES = ["read", "edit", "impact"];

// --- Frozen contract: tools/context_budget.py ---
const BUDGET_STATUSES = [
  "HEALTHY", "EXPANSION_REQUIRES_REASON", "ROTATE_AT_BOUNDARY",
  "ROTATE_NOW_READ_ONLY", "RECOVERY_REQUIRED",
];
const BUDGET_CAPSULE_MAX = 24 * 1024;
const BUDGET_WORKING_WARN = 32 * 1024;
const BUDGET_WORKING_MAX = 48 * 1024;

// --- Frozen contract: tools/handoff_acceptance.py ---
const HAT_RULES = [
  "wrong-phase", "stale-head", "missing-decision", "protected-omitted",
  "guardrail-gap", "prompt-injection", "sat-required", "cross-provider",
];
const HAT_SEVERITIES = ["blocker", "major", "minor"];
const HAT_FIELDS = ["id", "rule", "finding", "severity", "excerpt"];
const HAT_SAT_TRIGGERS = [
  "new-provider", "high-risk", "privileged-path", "authority-change",
];

// --- Frozen contract: tools/thinness.py (slice S2, #420) ---
const THIN_AXES = [
  "independent_behaviors", "unknowns", "state_irreversibility",
  "external_boundary", "verification_burden", "write_overlap",
];
const THIN_HARD = [
  "one_sentence_outcome", "one_observable_boundary", "independent_merge_or_recovery",
  "one_writer", "one_reviewer_understands", "one_evidence_strategy",
  "one_to_five_claims", "non_goals_explicit", "no_write_overlap", "capsule_sufficient",
];
const THIN_BANDS = ["micro", "preferred", "medium", "large"];

// --- Frozen contract: tools/ready.py (slice S2, #420) ---
const DOR_FULL = [
  "outcome", "claims", "forbidden_outcomes", "non_goals", "risk",
  "autonomy_envelope", "focus_envelope", "allowed_paths", "protected_paths",
  "dependencies", "thinness_total", "disposition", "recovery",
  "owner_decisions", "evidence_strategy", "context_budget_ok", "extension_profile_ok",
];
const DOR_COMPACT = ["outcome", "scope", "proof"];

// --- Frozen contract: tools/disposition.py (slice S2, #420) ---
const DISP_OUTCOMES = [
  "IMPLEMENT", "NO_CHANGE", "INSUFFICIENT_EVIDENCE", "OWNER_DECISION",
];
const DISP_OBS_FIELDS = [
  "environment", "command", "head", "expected", "observed", "evidence",
];

// --- Frozen contract: tools/verification_mold.py (slice S3, #421) ---
const MOLD_RULES = [
  "missing-claim", "duplicate-weak-evidence",
  "implementation-coupled-oracle", "mocked-behavior-under-test",
  "overconstrained-internals", "unobservable-assertion",
];
const MOLD_RISKS = ["R0", "R1", "R2", "R3"];
const MOLD_SEVERITIES = ["blocker", "major", "minor"];
const MOLD_FINDING_FIELDS = ["id", "rule", "finding", "severity", "excerpt"];
const MOLD_TECHNIQUES = [
  "example_based", "property_based", "mutation_check",
  "contract_test", "scenario_test",
];
const MOLD_TECHNIQUE_MAP = {
  crud: "example_based",
  state: "scenario_test",
  auth: "example_based",
  parse: "property_based",
  migration: "scenario_test",
  workflow: "scenario_test",
  ui: "example_based",
  control_plane: "contract_test",
};
const MOLD_FAILURE_SHAPES = [
  "crud", "state", "auth", "parse", "migration", "workflow",
  "ui", "control_plane",
];
const MOLD_IMPLEMENTATION_MARKERS = [
  "library", "table", "column", "sql", "redis", "postgres",
  "orm", "framework", ".py", ".ts", ".json", "internal",
];
const MOLD_POSITIVE_CLASSES = [
  "crud", "retry", "auth", "parser", "migration", "workflow",
  "ui", "control-plane",
];
const MOLD_NEGATIVE_CLASSES = [
  "missing-claim", "duplicate-weak-evidence",
  "implementation-coupled-oracle", "mocked-behavior-under-test",
  "overconstrained-internals", "unobservable-assertion",
];

// --- Frozen contract: tools/mold_qualification.py (slice S3, #421) ---
const QUAL_RULES = [
  "skipped_or_filtered", "empty_or_placeholder", "hard_coded_example",
  "omitted_state", "swallowed_error", "mock_only_assertion",
  "setup_self_assertion", "structural_failure_not_red",
  "equivalent_mutant", "no_alternative_acceptance", "no_true_red",
];
const QUAL_RECEIPT_FIELDS = [
  "mold", "mold_digest", "head", "provider",
  "verdict", "run_digest", "qualified_by",
];
const QUAL_STATUSES = ["passed", "failed", "skipped", "filtered", "error"];
const QUAL_COVERAGE_KINDS = ["full", "empty", "placeholder"];

// --- Frozen contract: tools/verification_portfolio.py (slice S3, #421) ---
// Not transcribed: TECHNIQUE_COST_S / CHEAPEST_FIRST (Stage 32 cost
// estimates, explicitly recalibratable by Stages 40-41) — pinning mutable
// cost estimates as frozen would over-claim. Frozen surface is rules,
// classes, fields, techniques.
const PORT_RULES = ["budget_exceeded", "missing_command", "excessive_portfolio"];
const PORT_TECHNIQUES = [
  "example_based", "property_based", "mutation_check",
  "contract_test", "scenario_test", "fuzz",
  "e2e_focused", "state_matrix",
];
const PORT_KINDS = ["parser", "adapter", "ui", "auth", "state", "docs", "generic"];
const PORT_FAILURE_SHAPES = [
  "state", "auth", "parse", "migration", "workflow", "ui",
  "control_plane", "crud", "adapter", "docs",
];
const PORT_SELECTION_CLASSES = [
  "js", "python", "dotnet", "mixed", "parser", "adapter",
  "ui", "auth-state-matrix", "r0-docs",
];
const PORT_REJECTION_CLASSES = ["missing-command", "excessive-portfolio"];

export const FROZEN = {
  repo_map: {
    PLANES: REPO_MAP_PLANES,
    MAP_BUDGET_ENTRIES: REPO_MAP_BUDGET,
    GENERATED_PATTERNS: REPO_MAP_GENERATED,
    ARTIFACT_PATTERNS: REPO_MAP_ARTIFACT,
    CACHE_PATTERNS: REPO_MAP_CACHE,
    EVIDENCE_PATTERNS: REPO_MAP_EVIDENCE,
    PROTECTED_PATTERNS: REPO_MAP_PROTECTED,
  },
  ownership_map: {
    INVARIANT_CLASSES: OWNERSHIP_INVARIANTS,
    ENTRY_METADATA: OWNERSHIP_METADATA,
    SCOPE_KINDS: OWNERSHIP_SCOPES,
  },
  context_budget: {
    STATUSES: BUDGET_STATUSES,
    CAPSULE_BYTES_MAX: BUDGET_CAPSULE_MAX,
    WORKING_BYTES_WARN: BUDGET_WORKING_WARN,
    WORKING_BYTES_MAX: BUDGET_WORKING_MAX,
  },
  handoff_acceptance: {
    RULES: HAT_RULES,
    SEVERITIES: HAT_SEVERITIES,
    FINDING_FIELDS: HAT_FIELDS,
    SAT_TRIGGERS: HAT_SAT_TRIGGERS,
  },
  thinness: {
    AXES: THIN_AXES,
    HARD_CONDITIONS: THIN_HARD,
    BANDS: THIN_BANDS,
  },
  ready: {
    FULL_FIELDS: DOR_FULL,
    COMPACT_FIELDS: DOR_COMPACT,
  },
  disposition: {
    DISPOSITIONS: DISP_OUTCOMES,
    OBSERVATION_FIELDS: DISP_OBS_FIELDS,
  },
  mold: {
    RULES: MOLD_RULES,
    RISKS: MOLD_RISKS,
    SEVERITIES: MOLD_SEVERITIES,
    FINDING_FIELDS: MOLD_FINDING_FIELDS,
    TECHNIQUES: MOLD_TECHNIQUES,
    TECHNIQUE_MAP: MOLD_TECHNIQUE_MAP,
    FAILURE_SHAPES: MOLD_FAILURE_SHAPES,
    IMPLEMENTATION_MARKERS: MOLD_IMPLEMENTATION_MARKERS,
    POSITIVE_CLASSES: MOLD_POSITIVE_CLASSES,
    NEGATIVE_CLASSES: MOLD_NEGATIVE_CLASSES,
  },
  qualification: {
    RULES: QUAL_RULES,
    RECEIPT_FIELDS: QUAL_RECEIPT_FIELDS,
    STATUSES: QUAL_STATUSES,
    COVERAGE_KINDS: QUAL_COVERAGE_KINDS,
  },
  portfolio: {
    RULES: PORT_RULES,
    TECHNIQUES: PORT_TECHNIQUES,
    KINDS: PORT_KINDS,
    FAILURE_SHAPES: PORT_FAILURE_SHAPES,
    SELECTION_CLASSES: PORT_SELECTION_CLASSES,
    REJECTION_CLASSES: PORT_REJECTION_CLASSES,
  },
};

export function provenance() {
  return "tools/repo_map.py + tools/ownership_map.py + tools/context_budget.py + tools/handoff_acceptance.py + tools/thinness.py + tools/ready.py + tools/disposition.py + tools/verification_mold.py + tools/mold_qualification.py + tools/verification_portfolio.py @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d";
}

// Slices S2–S10 extend ADOPTION with their own rows; S1 owns context-rules.
export const GAP_SLICES = [420, 421, 422, 423, 424, 425, 426, 427, 428];

// Each ADOPTION row: exactly one of `mechanism` (real on-disk path, relative
// to repo root) or `gap` (tracking Stage 63 slice number) must be set.
export const ADOPTION = {
  // Context plane: instruction routing and sources of truth.
  "context:router-table": { mechanism: "AGENTS.md", gap: null },
  "context:per-app-instructions": { mechanism: "apps/shell/AGENTS.md", gap: null },
  "context:ownership-scopes": { mechanism: "AGENTS.md", gap: null },
  // Docs plane: contract/proof artifacts that ARE the map.
  "docs:proofbed-family": { mechanism: "docs/ops/stage61b-release-proofbed.test.mjs", gap: null },
  "docs:gate-oracles": { mechanism: "docs/ops/pr-verify-workflow.test.mjs", gap: null },
  "docs:bounded-map-artifact": { mechanism: null, gap: 420 },
  // Maps plane: live topology and relevance.
  "maps:lane-relevance": { mechanism: ".github/workflows/pr-verify.yml", gap: null },
  "maps:repo-topology": { mechanism: "project.yaml", gap: null },
  // Thinness plane (slice S2, #420): thinness/DoR/NO_CHANGE contract.
  "thinness:axes-bands": { mechanism: "docs/ops/stage63-thinness.test.mjs", gap: null },
  "thinness:hard-conditions": { mechanism: "docs/ops/stage63-thinness.test.mjs", gap: null },
  "thinness:dor-receipt": { mechanism: ".github/PULL_REQUEST_TEMPLATE.md", gap: null },
  "thinness:disposition": { mechanism: ".github/workflows/pr-verify.yml", gap: null },
  // Continuity plane: rotation, capsule, handoff acceptance.
  "continuity:work-state": { mechanism: "AGENTS.md", gap: null },
  "continuity:goal-scratch": { mechanism: null, gap: 423 },
  "continuity:handoff-acceptance": { mechanism: null, gap: 423 },
  "continuity:context-budget": { mechanism: null, gap: 423 },
  // Molds plane (slice S3, #421): the v5 Verification Mold family —
  // critique (Stage 29), qualification (Stage 31), portfolio router
  // (Stage 32), and the mold substrates 59b/61b already bind.
  "molds:critique-rules": { mechanism: "docs/ops/stage63-molds.test.mjs", gap: null },
  "molds:qualification-rules": { mechanism: "docs/ops/stage63-molds.test.mjs", gap: null },
  "molds:portfolio-router": { mechanism: "docs/ops/stage63-molds.test.mjs", gap: null },
  "molds:release-substrate": { mechanism: "docs/ops/stage61b-release-proofbed-lib.mjs", gap: null },
  "molds:proof-invalidation": { mechanism: null, gap: 428 },
};

export function gapsOf() {
  return Object.keys(ADOPTION).filter((k) => ADOPTION[k].mechanism === null);
}

export function mappedOf() {
  return Object.keys(ADOPTION).filter((k) => ADOPTION[k].mechanism !== null);
}
