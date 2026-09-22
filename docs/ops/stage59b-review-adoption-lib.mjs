// docs/ops/stage59b-review-adoption-lib.mjs
//
// Stage 59b (#388): the single-sourced adoption mapping from the frozen
// Stage 59a contract (15 rules, tools/independent_review.py @ 207d112 in
// agent-engineering-standard) to hyperbolic-core's live review-lane
// mechanism, plus the native-authority predicate.
//
// The offline test and any live re-check both import this module, so the
// mapping is proven in CI by the tests and reused verbatim elsewhere. No
// network access happens here.

// The 15 frozen Stage 59a rules, in check order. Byte-identical to
// tools/independent_review.py's RULES tuple.
export const FROZEN_RULES = [
  "clean",
  "p1-block",
  "p2-advisory",
  "fake-citation",
  "oracle-weakening",
  "prompt-injection",
  "malformed-input",
  "reviewer-outage",
  "stale-head",
  "same-provider",
  "verdict-shopping",
  "scope-creep",
  "dispute",
  "repeat-non-engage",
  "owner-override",
];

// One hyperbolic-core mechanism per frozen rule. path must exist on disk
// (the test enforces it); note states the observable behavior. Where the
// lane deliberately differs from the deterministic oracle (fake-citation),
// the note says so — the pair of pins (cited blocks / uncited does not)
// is the control, not silent equivalence.
export const ADOPTION = {
  "clean": {
    path: "packages/review/src/validate.ts",
    note: "validateVerdict returns pass on zero valid blocking findings.",
  },
  "p1-block": {
    path: "packages/review/src/validate.ts",
    note: "validateVerdict recomputes the verdict from findings: any valid blocking finding blocks.",
  },
  "p2-advisory": {
    path: "packages/review/src/validate.ts",
    note: "advisory findings are reported in findings but excluded from the block decision.",
  },
  "fake-citation": {
    path: "packages/review/src/validate.ts",
    note: "DISCLOSED DELTA: an uncited finding is discarded fail-open (never blocks), where the 59a oracle BLOCKs the review as untrustworthy. Rationale: model prose, not a deterministic oracle — a confused model must not stall work (AGENTS.md > Independent LLM Review).",
  },
  "oracle-weakening": {
    path: "packages/review/src/prompt.ts",
    note: "rubric point 5 pins weakened/deleted oracles as a finding; dev-agent instructions forbid weakening a test to turn the gate green.",
  },
  "prompt-injection": {
    path: "packages/review/src/prompt.ts",
    note: "DATA_NOT_INSTRUCTIONS_RULE plus per-run nonced fences; an injection attempt is itself a blocking injection-category finding.",
  },
  "malformed-input": {
    path: "packages/review/src/validate.ts",
    note: "malformed() returns a flagged non-blocking verdict: a model that cannot answer has not found a defect.",
  },
  "reviewer-outage": {
    path: "packages/review/src/review.ts",
    note: "ReviewInfrastructureError throws (missing credential, transport error, no tool call); the CLI exits 2, never green.",
  },
  "stale-head": {
    path: ".github/workflows/llm-review-recheck.yml",
    note: "review and recheck bind to the exact PR head; a moved head re-runs rather than trusting a stale verdict.",
  },
  "same-provider": {
    path: "packages/review/src/config.ts",
    note: "resolveConfig REFUSES when reviewer and builder resolve to the same provider family; verify-llm-review names an empty builder identity and fails before any credential is imported.",
  },
  "verdict-shopping": {
    path: "packages/review/src/prompt.ts",
    note: "SCOPE LOCK: every blocking finding after round one must map to a prior-round finding; a fresh block on a re-review is demoted to advisory.",
  },
  "scope-creep": {
    path: "packages/review/src/prompt.ts",
    note: "SCOPE LOCK judges resolution against the finding's ORIGINAL ask; holding a finding open on a stricter re-shaped ask is forbidden.",
  },
  "dispute": {
    path: ".github/workflows/dev-agent-dispatch.yml",
    note: "dev agent fixes, rebuts with citation-grounded reasoning, or proposes out-of-scope; only the reviewer can mark outOfScope, only in response to an explicit proposal.",
  },
  "repeat-non-engage": {
    path: "packages/review/src/validate.ts",
    note: "resolution-by-citation: on a re-review round a continued block without deliberation engaging the latest evidence is demoted to advisory and marked resolvedByDefault.",
  },
  "owner-override": {
    path: ".github/workflows/pr-verify.yml",
    note: "main protection retains owner bypass: no agent review may block the owner; the gate fails visibly but the owner may merge over it.",
  },
};

// The adopted-policy-clean input: zero native approvals, zero code-owner
// gating, exactly one required check, AGENTS.md reworded past tense-free.
export function cleanAdoption() {
  return {
    approvals: 0,
    codeOwnerReview: false,
    requiredChecks: ["PR Gate"],
    agentsRequiresCodeOwner: false,
    agentsStatesZeroGating: true,
  };
}

// Pure predicate: returns the list of native-authority drifts for an input.
export function nativeDrift(input) {
  const findings = [];
  if (input.approvals !== 0) findings.push("native-approval-drift");
  if (input.codeOwnerReview === true) findings.push("code-owner-review-gating");
  const checks = input.requiredChecks ?? [];
  if (checks.length !== 1 || checks[0] !== "PR Gate")
    findings.push("second-required-check");
  if (input.agentsRequiresCodeOwner === true)
    findings.push("agents-md-requires-code-owner");
  if (input.agentsStatesZeroGating !== true)
    findings.push("agents-md-missing-zero-gating");
  return findings;
}
