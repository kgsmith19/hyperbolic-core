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
};

export function provenance() {
  return "tools/repo_map.py + tools/ownership_map.py + tools/context_budget.py + tools/handoff_acceptance.py @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d";
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
  // Continuity plane: rotation, capsule, handoff acceptance.
  "continuity:work-state": { mechanism: "AGENTS.md", gap: null },
  "continuity:goal-scratch": { mechanism: null, gap: 423 },
  "continuity:handoff-acceptance": { mechanism: null, gap: 423 },
  "continuity:context-budget": { mechanism: null, gap: 423 },
};

export function gapsOf() {
  return Object.keys(ADOPTION).filter((k) => ADOPTION[k].mechanism === null);
}

export function mappedOf() {
  return Object.keys(ADOPTION).filter((k) => ADOPTION[k].mechanism !== null);
}
