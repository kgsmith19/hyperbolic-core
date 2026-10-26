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

import { createHash } from "node:crypto";

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
// Keep the upstream fixture literal private. The public frozen contract uses
// the repository-wide failure-shape vocabulary, so consumers cannot observe
// or compare two spellings for the same semantic token.
const MOLD_SOURCE_POSITIVE_CLASSES = [
  "crud", "retry", "auth", "parser", "migration", "workflow",
  "ui", "control-plane",
];
const MOLD_CANONICAL_TOKENS = Object.freeze({
  "control-plane": "control_plane",
});
const canonicalMoldToken = (token) => MOLD_CANONICAL_TOKENS[token] ?? token;
const MOLD_POSITIVE_CLASSES = MOLD_SOURCE_POSITIVE_CLASSES.map(canonicalMoldToken);
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

// --- Frozen contract: tools/quality_eval.py (slice S4, #422) ---
// This is a characterization oracle only. It evaluates supplied plain data
// locally; it is intentionally not wired to a workflow gate or deployment.
const QUALITY_DIMENSIONS = [
  "correctness", "charter", "quality", "plane", "dependency", "parsimony",
];
const QUALITY_SEVERITIES = ["blocker", "major", "minor"];
const QUALITY_FINDING_FIELDS = ["id", "rule", "finding", "severity", "excerpt"];

const qualityFinding = (rule, finding, excerpt, severity = "major") => ({
  id: `${rule}-1`,
  rule,
  finding,
  severity,
  excerpt: String(excerpt).slice(0, 200),
});

const normalizedQualitySolution = (solution) => {
  const item = solution && typeof solution === "object" ? solution : {};
  const numericLoc = Number(item.owned_loc || 0);
  return {
    id: String(item.id || ""),
    correct: Boolean(item.correct),
    charter_clean: Boolean(item.charter_clean),
    quality_ok: Boolean(item.quality_ok),
    plane_clean: Boolean(item.plane_clean),
    dependency_ok: Boolean(item.dependency_ok),
    owned_loc: Number.isFinite(numericLoc) ? Math.trunc(numericLoc) : 0,
    reviewers_agree: Boolean(item.reviewers_agree),
  };
};

// Mirrors quality_eval.score: correctness gates every later quality signal;
// only a correct solution can be a winner, regardless of its owned LOC.
export function scoreQuality(solution) {
  const item = normalizedQualitySolution(solution);
  if (!item.correct) {
    return {
      points: 0,
      wins: false,
      findings: [qualityFinding(
        "correctness",
        "incorrect solution loses however small: no shortness reward, ever",
        item.id || "(solution)",
        "blocker",
      )],
    };
  }
  let points = 100;
  const findings = [];
  for (const [dimension, conforms] of [
    ["charter", item.charter_clean],
    ["quality", item.quality_ok],
    ["plane", item.plane_clean],
    ["dependency", item.dependency_ok],
  ]) {
    if (!conforms) {
      points -= 10;
      findings.push(qualityFinding(
        dimension,
        `${dimension} non-conformance costs 10 points`,
        item.id || "(solution)",
      ));
    }
  }
  points -= Math.min(40, Math.trunc(item.owned_loc / 50));
  if (!item.reviewers_agree) {
    points -= 5;
    findings.push(qualityFinding(
      "parsimony",
      "reviewers disagree: agreement costs 5 points until rule-grounded consensus",
      item.id || "(solution)",
    ));
  }
  return { points: Math.max(0, points), wins: true, findings };
}

const compareQualityRank = (left, right) => {
  if (left.wins !== right.wins) return left.wins ? -1 : 1;
  const pointDelta = right.points - left.points;
  if (pointDelta !== 0) return pointDelta;
  const ownershipDelta = left.owned_loc - right.owned_loc;
  if (ownershipDelta !== 0) return ownershipDelta;
  return left.id.localeCompare(right.id);
};

// Mirrors quality_eval.rank. The final ID tie-breaker makes the proof
// reproducible without treating the score as an enforcement mechanism.
export function rankQuality(solutions) {
  const input = Array.isArray(solutions) ? solutions : [];
  return input.map((solution) => {
    const item = normalizedQualitySolution(solution);
    return { ...scoreQuality(solution), id: item.id, owned_loc: item.owned_loc };
  }).sort(compareQualityRank).map(({ id, points, wins }) => ({ id, points, wins }));
}

// --- Frozen contract: continuity plane (slice S5, #423) ---
// tools/context_rotation.py (Stage 48), tools/context_budget.py,
// tools/handoff_acceptance.py (Stage 45) and tools/capsule.py. The ports
// below are offline characterization only; no workflow or gate consumes them.
// Their oracle is stage63-continuity-golden.json, computed by the upstream
// Python at the pinned SHA, so every Python-ism they reproduce (truthiness,
// str(None) === "None", %r quoting, code-point slicing, json.dumps defaults)
// is proven against the real thing.
const ROTATION_SEQUENCE = [
  "checkpointed", "lease-handed", "capsule-written", "session-fresh", "accepted", "resumed",
];
const ROTATION_VERDICTS = ["ROTATE", "HOLD", "FREEZE", "RECOVER"];
const ROTATION_RULES = [
  "compacted", "polluted", "read-only-bound", "boundary-due", "imminent-compact",
  "overflow-output", "missing-checkpoint", "provider-switch", "canary-missing", "clean-rotate",
];
const ROTATION_RULE_VERDICTS = Object.freeze({
  compacted: "FREEZE", polluted: "RECOVER", "read-only-bound": "ROTATE",
  "boundary-due": "ROTATE", "imminent-compact": "ROTATE", "overflow-output": "ROTATE",
  "missing-checkpoint": "HOLD", "provider-switch": "ROTATE", "canary-missing": "HOLD",
  "clean-rotate": "ROTATE",
});
const CAPSULE_VERSION = "5.0.0";
const CAPSULE_BYTES_MIN = 16 * 1024;
const CAPSULE_BYTES_MAX = 24 * 1024;
const CAPSULE_FIELDS = [
  "schema", "version", "issue", "outcome", "remaining_claims", "phase", "role", "risk",
  "focus_envelope", "allowed_paths", "protected_paths", "branch", "base", "head", "pr",
  "lease", "extensions", "rule_ids", "last_verification", "blocker", "next_action",
  "stop_conditions", "source_hashes", "redacted", "expires", "producer",
];

// Python semantics the upstream modules rely on.
const pyBool = (value) => {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value) || Number.isNaN(value);
};
const pyStr = (value) => {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
};
const pyGetStr = (item, key) => (key in item ? pyStr(item[key]) : ""); // str(d.get(k, ""))
const pyOrStr = (item, key) => (pyBool(item[key]) ? pyStr(item[key]) : ""); // str(d.get(k, "") or "")
const pyList = (value) => (Array.isArray(value) ? [...value] : []);
const pySlice = (text, n) => [...text].slice(0, n).join("");
// repr() of JSON plain data: str quoting rules, None/True/False, list and dict forms.
// A str escapes exactly what str.isprintable() rejects (categories Cc, Cf, Cs,
// Co, Cn, Zl, Zp and every Zs but the ASCII space) as \xNN, \uNNNN or
// \UNNNNNNNN. The categories come from the runtime's Unicode tables, so only
// code points one Unicode version leaves unassigned can render differently.
const PY_NONPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const pyRepr = (value) => {
  if (typeof value !== "string") {
    if (value === null || value === undefined || typeof value === "boolean") return pyStr(value);
    if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
    if (typeof value === "object") {
      return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(", ")}}`;
    }
    return String(value);
  }
  const text = value;
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const body = [...text].map((ch) => {
    const code = ch.codePointAt(0);
    if (ch === "\\") return "\\\\";
    if (ch === quote) return `\\${quote}`;
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, "0")}`;
    if (code > 0x7f && PY_NONPRINTABLE_RE.test(ch)) {
      if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
      return code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\U${code.toString(16).padStart(8, "0")}`;
    }
    return ch;
  }).join("");
  return quote + body + quote;
};

// json.dumps(value, sort_keys=..., indent=..., ensure_ascii=...) for JSON plain data.
const pyJsonString = (text, ensureAscii) => {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const escapes = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
    if (escapes[ch]) out += escapes[ch];
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) {
      // One \uXXXX per UTF-16 unit: astral characters become a surrogate pair, as in Python.
      for (let unit = 0; unit < ch.length; unit += 1) {
        out += `\\u${ch.charCodeAt(unit).toString(16).padStart(4, "0")}`;
      }
    } else out += ch;
  }
  return `${out}"`;
};
const pyJsonDumps = (value, {
  sortKeys = false, indent = null, ensureAscii = true, separators = [", ", ": "],
} = {}, level = 0) => {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyJsonString(value, ensureAscii);
  const options = { sortKeys, indent, ensureAscii, separators };
  const entries = Array.isArray(value)
    ? value.map((item) => pyJsonDumps(item, options, level + 1))
    : (sortKeys ? Object.keys(value).sort() : Object.keys(value))
      .map((key) => `${pyJsonString(key, ensureAscii)}${separators[1]}${pyJsonDumps(value[key], options, level + 1)}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return open + close;
  if (indent === null) return open + entries.join(separators[0]) + close;
  const pad = " ".repeat(indent * (level + 1));
  return `${open}\n${pad}${entries.join(`,\n${pad}`)}\n${" ".repeat(indent * level)}${close}`;
};

const continuityFinding = (rule, finding, excerpt, severity = "major") => ({
  id: `${rule}-1`, rule, finding, severity, excerpt: pySlice(excerpt, 200),
});
const leadingExcerpt = (text, fallback) => (text.trim() ? pySlice(text, 200) : fallback);

// Mirrors context_rotation.decide: the first matching frozen rule decides.
export function decideRotation(signal) {
  const raw = signal && typeof signal === "object" && !Array.isArray(signal) ? signal : {};
  const item = {
    transition: pyGetStr(raw, "transition"),
    footprint_status: pyOrStr(raw, "footprint_status"),
  };
  for (const key of ["boundary", "compaction_imminent", "compaction_done", "polluted",
    "tool_overflow", "checkpointed", "provider_switch", "canaries_passed", "automatic"]) {
    item[key] = pyBool(raw[key]);
  }
  const tag = leadingExcerpt(item.transition, "(rotation)");
  const decide = (rule, message, severity = "major") => ({
    verdict: ROTATION_RULE_VERDICTS[rule], rule,
    findings: [continuityFinding(rule, message, tag, severity)],
  });
  if (item.compaction_done) {
    return decide("compacted",
      "compaction already occurred: FREEZE mutation until wake/reconciliation proves state", "blocker");
  }
  if (item.polluted) return decide("polluted", "polluted history: RECOVER from the capsule, never summarize");
  if (item.footprint_status === "ROTATE_NOW_READ_ONLY") {
    return decide("read-only-bound", "footprint at the read-only bound: rotate now, read-only until rotated");
  }
  if (item.boundary) {
    return decide("boundary-due", `role/phase boundary ${pyRepr(item.transition)}: rotate at the boundary with checkpoint, lease, capsule, acceptance`);
  }
  if (item.compaction_imminent) {
    return decide("imminent-compact", "provider compaction imminent: rotate now before the tripwire fires");
  }
  if (item.tool_overflow) return decide("overflow-output", "tool-output overflow: rotate with a bounded capsule");
  if (!item.checkpointed) return decide("missing-checkpoint", "rotation without checkpoint: checkpoint first, then rotate");
  if (item.provider_switch) {
    return decide("provider-switch", "provider switch mid-flight: rotate with cross-provider acceptance");
  }
  if (item.automatic && !item.canaries_passed) {
    return decide("canary-missing", "automatic mode without passed provider canaries: HOLD in advisory/controlled mode");
  }
  return decide("clean-rotate",
    "planned rotation: checkpoint, lease, capsule, fresh session, acceptance, resume", "minor");
}

// Mirrors context_budget.govern(footprint, expansions, unresolved, polluted,
// missing_load_bearing, phase_change).
export function governBudget(footprint, options = {}) {
  const {
    expansions = 0, unresolved = 0, polluted = false,
    missing_load_bearing: missingLoadBearing = false, phase_change: phaseChange = false,
  } = options;
  const total = Object.values(footprint ?? {}).reduce((sum, bytes) => sum + bytes, 0);
  if (pyBool(missingLoadBearing) || pyBool(polluted)) {
    return {
      status: "RECOVERY_REQUIRED", total_bytes: total,
      reasons: [pyBool(missingLoadBearing) ? "missing load-bearing fact"
        : "polluted history: recover from capsule, never summarize"],
      action: "recover from last capsule; new session",
    };
  }
  if (total >= BUDGET_WORKING_MAX) {
    return {
      status: "ROTATE_NOW_READ_ONLY", total_bytes: total,
      reasons: [`working set ${total} bytes at hard max: read-only until rotation`],
      action: "read-only; rotate with capsule now",
    };
  }
  if (pyBool(phaseChange)) {
    return {
      status: "ROTATE_AT_BOUNDARY", total_bytes: total,
      reasons: ["mandatory rotation at role/phase boundary"], action: "rotate with capsule at boundary",
    };
  }
  const reasons = total >= BUDGET_WORKING_WARN
    ? [`working set ${total} bytes in warn band: expand only for a named unresolved question`] : [];
  if (expansions > 0 && unresolved <= 0) {
    return {
      status: "EXPANSION_REQUIRES_REASON", total_bytes: total,
      reasons: [`${expansions} expansion(s) with no unresolved question: name one or roll back`],
      action: "name the question or roll back the expansion",
    };
  }
  if (reasons.length > 0) {
    return { status: "ROTATE_AT_BOUNDARY", total_bytes: total, reasons, action: "plan rotation at next boundary" };
  }
  return { status: "HEALTHY", total_bytes: total, reasons: [], action: "continue" };
}

const INJECTION_RE = /(ignore (previous|all) instructions|disregard .*instructions|override .*rules?|bypass .*gate|reveal .*prompt|system prompt)/i;

// Mirrors handoff_acceptance.accept: the first frozen rule hit refuses.
export function acceptHandoff(attempt) {
  const raw = attempt && typeof attempt === "object" && !Array.isArray(attempt) ? attempt : {};
  const item = {
    role: pyGetStr(raw, "role"), risk: pyOrStr(raw, "risk"), compact: pyBool(raw.compact),
    stated_phase: pyGetStr(raw, "stated_phase"), replayed_phase: pyGetStr(raw, "replayed_phase"),
    stated_head: pyGetStr(raw, "stated_head"), reconciled_head: pyGetStr(raw, "reconciled_head"),
    owner_decision_recorded: pyBool(raw.owner_decision_recorded),
    owner_decision_required: pyBool(raw.owner_decision_required),
    protected_paths: pyList(raw.protected_paths), accepted_scope: pyList(raw.accepted_scope),
    provider_guardrails: pyBool(raw.provider_guardrails), prompt_text: pyOrStr(raw, "prompt_text"),
    stated_rules: pyList(raw.stated_rules), route_rules: pyList(raw.route_rules),
    sat_triggers: pyList(raw.sat_triggers), sat_passed: pyBool(raw.sat_passed),
  };
  const tag = leadingExcerpt(item.role, "(attempt)");
  const refuse = (rule, message, kind = "HAT", severity = "blocker") => ({
    accepted: false, kind, findings: [continuityFinding(rule, message, tag, severity)],
  });
  if (item.stated_phase !== item.replayed_phase || !item.stated_phase) {
    return refuse("wrong-phase", `stated phase ${pyRepr(item.stated_phase)} != replayed phase ${pyRepr(item.replayed_phase)}: prove the exact task from replayed state`);
  }
  if (item.stated_head !== item.reconciled_head || !item.stated_head) {
    return refuse("stale-head", "stated head != reconciled head: prove the exact state before writing");
  }
  if (item.owner_decision_required && !item.owner_decision_recorded) {
    return refuse("missing-decision", "required owner decision not recorded: record it before writing");
  }
  for (const protectedPath of item.protected_paths) {
    if (!item.accepted_scope.includes(protectedPath)) {
      return refuse("protected-omitted", `protected path ${pyRepr(pyStr(protectedPath))} missing from the accepted scope: accept the full scope`);
    }
  }
  if (!item.provider_guardrails) {
    return refuse("guardrail-gap", "provider lacks required guard rails: only guard-railed providers write");
  }
  if (INJECTION_RE.test(item.prompt_text)) {
    return refuse("prompt-injection", "prompt content overrides task, state, rules, or action: reject injected instructions");
  }
  const known = item.sat_triggers.filter((trigger) => HAT_SAT_TRIGGERS.includes(trigger));
  const needed = !(item.compact || item.risk === "R0") && known.length > 0;
  if (needed && !item.sat_passed) {
    return refuse("sat-required", `SAT trigger ${pyRepr(pyStr(known[0]))} present but SAT not passed: pass SAT before writing`);
  }
  const route = new Set(item.route_rules);
  const stated = new Set(item.stated_rules);
  const sameRules = route.size === stated.size && [...route].every((rule) => stated.has(rule));
  if (route.size > 0 && !sameRules) {
    return refuse("cross-provider", "cross-provider restatement diverges from the Standards route: restate exactly",
      needed ? "SAT" : "HAT", "major");
  }
  let kind = (needed && item.sat_passed) || (item.sat_passed && item.sat_triggers.length > 0) ? "SAT" : "HAT";
  if (item.sat_triggers.length > 0 && !item.compact && item.risk !== "R0" && !item.sat_passed) kind = "HAT";
  return { accepted: true, kind, findings: [] };
}

const CAPSULE_SECRET_RE = /(api[_-]?key\s*[:=]\s*\S+|secret\s*[:=]\s*\S+|password\s*[:=]\s*\S+|private[_-]?key\s*[:=]\s*\S+|bearer\s+\S+|gh[pousr]_[A-Za-z0-9]+|xox[bpas]-[A-Za-z0-9-]+)/i;
const CAPSULE_ABSPATH_RE = /(?<![\w.-])([A-Za-z]:\\|\/)[\w./\\-]*/;
const CAPSULE_SESSION_RE = /(session[_-]?id|conversation[_-]?id)/i;

// Mirrors capsule.scan_forbidden: repair strings, empty means clean.
export function scanCapsule(capsule) {
  const repairs = [];
  const blob = pyJsonDumps(capsule, { sortKeys: true });
  if (CAPSULE_SECRET_RE.test(blob)) {
    repairs.push("capsule carries secret-like material: redact it; capsules never hold credentials");
  }
  const scanned = Object.fromEntries(["next_action", "blocker", "allowed_paths", "protected_paths"]
    .map((key) => [key, key in capsule ? capsule[key] : ""]));
  if (CAPSULE_ABSPATH_RE.test(pyJsonDumps(scanned))) {
    repairs.push("capsule carries local absolute paths: use repo-relative paths; canonical state is portable");
  }
  if (CAPSULE_SESSION_RE.test(blob)) {
    repairs.push("capsule requires vendor session IDs: canonical state cannot depend on them");
  }
  for (const key of ["reasoning", "chain_of_thought", "hidden"]) {
    if (key in capsule) repairs.push(`capsule carries hidden reasoning field ${pyRepr(key)}: remove it`);
  }
  return repairs;
}

// Mirrors capsule.build: deterministic, canonical, and split (never truncated) when oversize.
export function buildCapsule(fields) {
  const missing = CAPSULE_FIELDS.filter((field) => !(field in fields));
  if (missing.length > 0) throw new Error(`capsule missing fields: ${missing.join(", ")}`);
  const capsule = Object.fromEntries(CAPSULE_FIELDS.map((field) => [field, fields[field]]));
  const repairs = scanCapsule(capsule);
  if (repairs.length > 0) throw new Error(repairs.join("; "));
  const size = Buffer.byteLength(renderCapsule(capsule), "utf8");
  if (size > CAPSULE_BYTES_MAX) {
    throw new Error(`capsule is ${size} bytes, over the ${CAPSULE_BYTES_MAX}-byte pilot budget: split the task instead of truncating load-bearing fields`);
  }
  return { ...capsule, _bytes: size };
}

// Mirrors capsule.render: sorted keys, two-space indent, LF, UTF-8, private keys dropped.
export function renderCapsule(capsule) {
  const clean = Object.fromEntries(Object.entries(capsule).filter(([key]) => !key.startsWith("_")));
  return `${pyJsonDumps(clean, { sortKeys: true, indent: 2, ensureAscii: false })}\n`;
}

// --- Frozen contract: extension profiles (slice S6, #424) ---
// tools/mcp_profile.py (Stage 21b), tools/extensions_registry.py and
// tools/profile_compiler.py (Stage 20b). Offline characterization only; the
// oracle is stage63-profiles-golden.json, computed by the upstream Python at
// the pinned SHA. profile_compiler's JIT body activation is not ported: bodies
// live in agent-extensions, which owns that half.
const MCP_SERVER_FIELDS = [
  "name", "transport", "endpoint", "capabilities", "kind", "schema_bytes", "idempotent",
  "activated_at", "ttl_seconds",
];
const MCP_TRANSPORTS = ["stdio", "http"];
const MCP_KINDS = ["read", "write"];
const MCP_PHASES = ["research", "task"];
const MCP_TRANSPORT_KEYS = Object.freeze({ claude: "url", codex: "serverUrl", antigravity: "serverUrl", local: "url" });
const MCP_EGRESS_ALLOWLIST = ["localhost", "127.0.0.1", "github.com", "api.anthropic.com"];
const MCP_SECRET_MARKERS = [
  ["sk-ant-", "anthropic"], ["sk-", "api key"], ["xoxb-", "slack token"], ["xoxp-", "slack token"],
  ["ghp_", "github token"], ["AKIA", "aws access key"], ["AIza", "google api key"],
];
const MCP_ADVISORY_LIMITS = Object.freeze({ active_max: 2, candidate_max: 5, pilot_cap: 12, schema_bytes_max: 64 * 1024 });
const REGISTRY_RESERVED_KEYS = ["adapters", "profile"];
const REGISTRY_REQUIRED = ["catalog", "profile", "lock"];
const DESCRIPTOR_FIELDS = [
  "name", "semantic_id", "description", "body_bytes", "body_tokens_est", "dependencies",
  "body_digest", "source_path",
];
const PROCESS_PLUS_DOMAIN_BUDGET = 2;

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKey = (mapping, key) => Object.prototype.hasOwnProperty.call(mapping, key);
const pyGet = (mapping, key, fallback) => (hasKey(mapping, key) ? mapping[key] : fallback);
const pyIsInt = (value) => Number.isInteger(value);
const pyInt = (value) => (typeof value === "boolean" ? Number(value) : Math.trunc(Number(value)));
const pyLen = (text) => [...text].length;
const pyIter = (value) => {
  if (!pyBool(value)) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  return Object.keys(value);
};
// datetime.fromisoformat for the ISO shapes the activation stamp uses; a
// value without an offset is UTC, as mcp_profile assumes.
const pyIsoTimestamp = (text) => {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?))?([+-]\d{2}:\d{2})?$/.exec(text);
  if (!match) return null;
  const millis = Date.parse(`${match[1]}T${match[2] ?? "00:00"}${match[3] ?? "+00:00"}`);
  return Number.isNaN(millis) ? null : millis / 1000;
};

// Mirrors mcp_profile.validate_server: repairs against the Stage 21a McpServer schema.
const validateMcpServer = (server) => {
  const repairs = [];
  const name = pyRepr(pyGet(server, "name", "<unnamed>"));
  for (const field of MCP_SERVER_FIELDS) {
    if (!hasKey(server, field)) repairs.push(`server ${name} missing required field ${pyRepr(field)}`);
  }
  const { transport, kind } = server;
  if (transport !== undefined && transport !== null && !MCP_TRANSPORTS.includes(transport)) {
    repairs.push(`server ${name}: transport must be one of ${pyRepr(MCP_TRANSPORTS)}, got ${pyRepr(transport)}`);
  }
  if (kind !== undefined && kind !== null && !MCP_KINDS.includes(kind)) {
    repairs.push(`server ${name}: kind must be one of ${pyRepr(MCP_KINDS)}, got ${pyRepr(kind)}`);
  }
  if (hasKey(server, "schema_bytes") && !pyIsInt(server.schema_bytes)) {
    repairs.push(`server ${name}: schema_bytes must be a non-negative int`);
  }
  return repairs;
};

const mcpEgressFinding = (endpoint) => {
  if (!endpoint || endpoint.startsWith("stdio:") || endpoint.startsWith("cmd:")) return "";
  const host = endpoint.replaceAll("https://", "").replaceAll("http://", "").split("/")[0].split(":")[0];
  if (MCP_EGRESS_ALLOWLIST.includes(host)) return "";
  return `egress violation: ${pyRepr(host)} not in allowlist ${pyRepr(MCP_EGRESS_ALLOWLIST)}`;
};

const mcpStaleFinding = (server) => {
  const activatedAt = pyGet(server, "activated_at", null);
  const ttlSeconds = pyGet(server, "ttl_seconds", null);
  if (!pyBool(activatedAt) || !pyBool(ttlSeconds)) return "";
  const activated = pyIsoTimestamp(pyStr(activatedAt).replaceAll("Z", "+00:00"));
  if (activated === null) return `server ${pyRepr(pyGet(server, "name", null))}: unparseable activated_at`;
  if (activated + pyInt(ttlSeconds) <= Date.now() / 1000) {
    return `stale session: server ${pyRepr(pyGet(server, "name", null))} activation expired`;
  }
  return "";
};

const mcpAdvisoryWarnings = (active, candidates) => {
  const warnings = [];
  if (active.length > MCP_ADVISORY_LIMITS.active_max) {
    warnings.push(`advisory: ${active.length} active servers over pilot suggestion ${MCP_ADVISORY_LIMITS.active_max}`);
  }
  if (candidates.length > MCP_ADVISORY_LIMITS.candidate_max) {
    warnings.push(`advisory: ${candidates.length} candidate servers over pilot suggestion ${MCP_ADVISORY_LIMITS.candidate_max}`);
  }
  if (active.length + candidates.length > MCP_ADVISORY_LIMITS.pilot_cap) {
    warnings.push("advisory: pilot cap exceeded (informational only)");
  }
  for (const server of [...active, ...candidates]) {
    if (pyInt(pyGet(server, "schema_bytes", 0)) > MCP_ADVISORY_LIMITS.schema_bytes_max) {
      warnings.push(`advisory: server ${pyRepr(pyGet(server, "name", null))} has a giant schema; consider pruning`);
    }
  }
  const unused = candidates.filter((server) => !pyBool(server.capabilities)).map((server) => pyStr(pyGet(server, "name", null)));
  if (unused.length > 0) warnings.push(`advisory: unused capabilities: ${pyRepr(unused)}`);
  return warnings;
};

// Mirrors mcp_profile.validate_activation: findings refuse (fail closed); warnings are advisory.
export function validateActivation(server, profile) {
  const findings = validateMcpServer(server);
  const name = pyStr(pyGet(server, "name", "<unnamed>"));
  const capabilities = pyIter(pyGet(server, "capabilities", []));
  const endpoint = pyStr(pyGet(server, "endpoint", ""));
  const scanned = `${endpoint} ${capabilities.map(pyStr).join(" ")}`;
  const secret = MCP_SECRET_MARKERS.find(([marker]) => scanned.includes(marker));
  if (secret) findings.push(`secret exposure in ${name}: ${secret[0]} ${secret[1]}…`);
  const egress = mcpEgressFinding(endpoint);
  if (egress) findings.push(`${name}: ${egress}`);
  const phase = pyStr(pyGet(profile, "phase", "task"));
  if (phase === "research" && server.kind === "write") {
    findings.push(`write connector ${name} activated during research phase`);
  }
  if (server.kind === "write" && !pyBool(server.idempotent)) {
    findings.push(`write connector ${name} must declare idempotency`);
  }
  const stale = mcpStaleFinding(server);
  if (stale) findings.push(stale);
  const native = pyIter(profile.native_capabilities);
  for (const capability of capabilities) {
    if (native.includes(capability)) {
      findings.push(`duplicate capability ${pyStr(capability)}: native tool wins over MCP ${name}`);
    }
  }
  const provider = pyStr(pyGet(profile, "provider", "local"));
  if (server.transport === "http" && !hasKey(MCP_TRANSPORT_KEYS, provider)) {
    findings.push(`server ${name}: no MCP transport key for provider ${pyRepr(provider)}`);
  }
  const warnings = mcpAdvisoryWarnings(pyIter(profile.active_servers), pyIter(profile.candidate_servers));
  return { findings, warnings };
}

// Mirrors mcp_profile.validate_profile: zero standing servers is binding; counts stay advisory.
export function validateMcpProfile(profile) {
  const findings = [];
  const standing = pyIter(profile.standing_servers);
  if (standing.length > 0) {
    findings.push(`standing_servers must be empty: zero standing MCPs is the default posture (${standing.length} declared)`);
  }
  const active = pyIter(profile.active_servers);
  const candidates = pyIter(profile.candidate_servers);
  for (const server of [...active, ...candidates]) findings.push(...validateMcpServer(server));
  return { findings, warnings: mcpAdvisoryWarnings(active, candidates) };
}

const REGISTRY_MISMATCH = "catalog/profile/lock mismatch";

// Mirrors extensions_registry.check_registry_set: catalog, profile and lock agree as a set.
export function checkRegistrySet(registry) {
  if (!isMapping(registry)) return ["registry record must be a mapping"];
  const violations = Object.keys(registry).sort().filter((key) => !REGISTRY_REQUIRED.includes(key))
    .map((key) => `unknown registry key ${pyRepr(key)}: catalog/profile/lock only`);
  const { catalog, profile, lock } = registry;
  if (!Array.isArray(catalog)) return [...violations, "catalog must be a list of entries"];
  if (!Array.isArray(profile)) return [...violations, "profile must be a list of selections"];
  if (!isMapping(lock)) return [...violations, "lock must be a mapping of pins"];
  const catalogIds = new Set(catalog.filter(isMapping).map((entry) => pyStr(pyGet(entry, "id", ""))));
  for (const selection of profile) {
    const name = pyStr(selection);
    if (!catalogIds.has(name)) violations.push(`profile selects ${pyRepr(name)} missing from the catalog: ${REGISTRY_MISMATCH}`);
    if (!hasKey(lock, name)) violations.push(`profile selects ${pyRepr(name)} missing from the lock: ${REGISTRY_MISMATCH}`);
  }
  const selected = new Set(profile.map(pyStr));
  for (const pinned of Object.keys(lock).sort()) {
    if (!selected.has(pinned)) violations.push(`lock pins ${pyRepr(pinned)} with no profile selection: ${REGISTRY_MISMATCH}`);
  }
  return violations;
}

// Mirrors extensions_registry.check_capability_exists.
export function checkCapabilityExists(selection, registry) {
  if (!isMapping(selection)) return ["capability selection must be a mapping"];
  const declared = new Set((Array.isArray(registry) ? registry : isMapping(registry) ? Object.keys(registry) : []).map(pyStr));
  const violations = [];
  for (const key of Object.keys(selection).sort()) {
    for (const capability of Array.isArray(selection[key]) ? selection[key] : [selection[key]]) {
      if (!declared.has(pyStr(capability))) {
        violations.push(`edition/flag ${pyRepr(key)} references unknown capability ${pyRepr(capability)}: it must exist in the capability registry`);
      }
    }
  }
  return violations;
}

// Mirrors extensions_registry.check_reserved_keys (Q8: adapters/profile stay reserved).
export function checkReservedKeys(config) {
  if (!isMapping(config)) return ["config must be a mapping"];
  return REGISTRY_RESERVED_KEYS.filter((key) => hasKey(config, key))
    .map((key) => `reserved key ${pyRepr(key)} is not a schema key; it is held for a later stage (Q8)`);
}

const SUPPLY_MARKERS = ["extensions/adapters/", "extensions/supply/", "Canonical/sibling-contract.json"];

// Mirrors extensions_registry.check_supply_boundary: supply-side files belong in agent-extensions.
export function checkSupplyBoundary(files) {
  if (!Array.isArray(files)) return ["diff file list must be a list"];
  return files.filter((file) => SUPPLY_MARKERS.some((marker) => pyStr(file).startsWith(marker)))
    .map((file) => `supply-side file ${pyRepr(file)} belongs in the linked native agent-extensions issue, not this repo`);
}

const DESCRIPTOR_STRING_FIELDS = ["name", "semantic_id", "description", "body_digest", "source_path"];
const DESCRIPTOR_INT_FIELDS = ["body_bytes", "body_tokens_est"];
const SEMANTIC_ID_RE = /^capability\.[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Mirrors profile_compiler.validate_descriptor (Stage 20a descriptor shape).
export function validateDescriptor(record) {
  const repairs = DESCRIPTOR_FIELDS.filter((field) => !hasKey(record, field))
    .map((field) => `descriptor missing ${pyRepr(field)}: Stage 20a descriptors need it`);
  for (const field of DESCRIPTOR_STRING_FIELDS) {
    if (hasKey(record, field) && !pyOrStr(record, field).trim()) {
      repairs.push(`descriptor field ${pyRepr(field)} must be a non-empty string`);
    }
  }
  for (const field of DESCRIPTOR_INT_FIELDS) {
    if (hasKey(record, field) && (!pyIsInt(record[field]) || record[field] < 0)) {
      repairs.push(`descriptor field ${pyRepr(field)} must be a non-negative int`);
    }
  }
  if (hasKey(record, "dependencies") && !Array.isArray(record.dependencies)) {
    repairs.push("descriptor field 'dependencies' must be a list");
  }
  const semanticId = pyGetStr(record, "semantic_id");
  if (semanticId && !SEMANTIC_ID_RE.test(semanticId)) repairs.push(`semantic_id ${pyRepr(semanticId)} is not capability.<slug>`);
  return repairs;
}

// Mirrors profile_compiler.select_candidates: metadata-first selection, never bodies.
export function selectCandidates(descriptors, capabilities, { budgetTokens = null, provider = "claude" } = {}) {
  const table = new Map();
  for (const descriptor of descriptors) {
    const semanticId = pyGetStr(descriptor, "semantic_id");
    if (table.has(semanticId)) throw new Error(`duplicate capability in discovery index: ${semanticId}`);
    table.set(semanticId, descriptor);
  }
  const discoveryTokens = Math.floor(descriptors.reduce((chars, d) => chars
    + pyLen(pyGetStr(d, "name")) + pyLen(pyGetStr(d, "semantic_id")) + pyLen(pyGetStr(d, "description")), 0) / 4);
  const findings = [];
  const resolved = [];
  const resolve = (request) => {
    if (table.has(request)) return [request];
    if (table.has(`capability.${request}`)) return [`capability.${request}`];
    const term = request.toLowerCase();
    return [...table].filter(([, d]) => pyGetStr(d, "name").toLowerCase().includes(term)
      || pyGetStr(d, "description").toLowerCase().includes(term)).map(([id]) => id).sort();
  };
  for (const request of capabilities) {
    const candidates = resolve(pyStr(request));
    if (candidates.length === 0) {
      findings.push(`capability ${pyRepr(request)} absent from discovery index: repair the catalog or correct the request`);
    } else if (candidates.length > 1) {
      findings.push(`ambiguous descriptor ${pyRepr(request)}: ${candidates.length} candidates (${candidates.join(", ")}); disambiguate by semantic ID`);
    } else if (!resolved.includes(candidates[0])) {
      resolved.push(candidates[0]);
    }
  }
  if (resolved.length > PROCESS_PLUS_DOMAIN_BUDGET) {
    findings.push(`${resolved.length} top-level capabilities exceed the one-process-plus-one-domain policy (${PROCESS_PLUS_DOMAIN_BUDGET}); narrow the selection`);
  }
  let selected = [];
  const visited = new Set();
  const trail = [];
  const expand = (semanticId) => {
    if (visited.has(semanticId)) {
      if (trail.includes(semanticId)) {
        findings.push(`dependency cycle detected: ${[...trail, semanticId].join(" -> ")}; refuse binding`);
      }
      return;
    }
    visited.add(semanticId);
    trail.push(semanticId);
    const descriptor = table.get(semanticId);
    for (const dep of pyIter(pyGet(descriptor, "dependencies", []))) {
      const depId = pyStr(dep).startsWith("capability.") ? dep : `capability.${pyStr(dep)}`;
      if (table.has(depId)) expand(depId);
    }
    trail.pop();
    selected.push({ ...descriptor });
  };
  for (const semanticId of resolved) expand(semanticId);
  const bodyTokensEst = selected.reduce((sum, d) => sum + pyInt(pyGet(d, "body_tokens_est", 0)), 0);
  if (budgetTokens !== null && budgetTokens !== undefined && bodyTokensEst > budgetTokens) {
    findings.push(`over budget: activated set needs ${bodyTokensEst} tokens, budget is ${budgetTokens}; selection rejected, not truncated`);
    selected = [];
  }
  return {
    selected, findings, discovery_tokens: discoveryTokens, body_tokens_est: bodyTokensEst,
    provider, requested: [...capabilities], ok: findings.length === 0,
  };
}

// --- Python Unicode semantics the S7 boundary modules rely on ------------------
// Exhaustively proven against golden tables computed by CPython, so a JS
// built-in that differs (String.prototype.trim, /i, `.`, Array.prototype.sort)
// never stands in for its Python namesake.

// str.strip(): exactly the code points str.isspace() names. Unlike trim(), the
// BOM (U+FEFF) stays and U+001C..U+001F and NEL (U+0085) go.
const PY_SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");
const pyStrip = (text) => text.replace(PY_STRIP_RE, "");
// re.IGNORECASE against an ASCII pattern: ASCII letters fold to lower case, and
// so do the four non-ASCII code points CPython also matches against an ASCII
// letter (dotted capital I, dotless i, long s, Kelvin sign). Matching a
// lower-case pattern against the folded text reproduces Python exactly.
const PY_ASCII_FOLDS = Object.freeze({ "\u{130}": "i", "\u{131}": "i", "\u{17f}": "s", "\u{212a}": "k" });
const pyFoldAscii = (text) => text.replace(/[A-Z\u{130}\u{131}\u{17f}\u{212a}]/gu,
  (ch) => PY_ASCII_FOLDS[ch] ?? ch.toLowerCase());
// sorted() over str: code point order, not UTF-16 unit order.
const pyCompareCodePoints = (left, right) => {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const diff = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
};
const pySorted = (values) => [...values].sort(pyCompareCodePoints);
const sameList = (left, right) => left.length === right.length && left.every((value, i) => value === right[i]);
// str() of JSON plain data: containers render as their repr, scalars as str.
const pyStrAny = (value) => (value !== null && typeof value === "object" ? pyRepr(value) : pyStr(value));
const pyOrStrAny = (mapping, key) => {
  const value = pyGet(mapping, key, "");
  return pyBool(value) ? pyStrAny(value) : "";
};
// isinstance(value, (str, int, float)): bool is an int in Python.
const isPyScalar = (value) => ["string", "number", "boolean"].includes(typeof value);
const pyScalarStrs = (value) => (Array.isArray(value) ? value.filter(isPyScalar).map(pyStr) : []);
// text.encode("utf-8") raises on a lone surrogate; so does this.
const pyUtf8 = (text) => {
  if (/[\u{d800}-\u{dfff}]/u.test(text)) {
    const error = new Error(`'utf-8' codec can't encode a surrogate in ${pyRepr(text)}`);
    error.name = "UnicodeEncodeError";
    throw error;
  }
  return Buffer.from(text, "utf8");
};
const sha256Hex16 = (text) => createHash("sha256").update(pyUtf8(text)).digest("hex").slice(0, 16);
// A plain object can carry any rule id as an own key, "__proto__" included.
const setOwn = (mapping, key, value) => Object.defineProperty(mapping, key,
  { value, enumerable: true, writable: true, configurable: true });
const scalarExcerpt = (item, keys, fallback) => {
  for (const key of keys) {
    const value = item[key];
    if (isPyScalar(value) && pyStrip(pyStr(value))) return pySlice(pyStr(value), 200);
  }
  return fallback;
};

export const pythonSemantics = Object.freeze({
  strip: pyStrip, foldAscii: pyFoldAscii, compareCodePoints: pyCompareCodePoints, repr: pyRepr,
});

// --- Frozen contract: tools/standards_route.py (Stage 52) ---
const ROUTE_CLASSES = ["AWARE", "ACK", "GUARD", "VERIFY", "GATE", "OWNER"];
const ROUTE_RULES = [
  "duplicate-id", "missing-id", "orphan-rule", "stale-hash", "contradictory-triggers", "path-expansion",
  "missing-capability", "registry-overload", "malicious-task", "critical-demotion", "minimal-route",
];
const ROUTE_MIN = 5;
const ROUTE_MAX = 15;
const ROUTE_INDEX = [
  ["thin-outcome", ["implement"], "ACK", false],
  ["one-writer", ["implement", "parallel"], "GATE", true],
  ["exact-head", ["implement", "verify", "merge"], "GUARD", true],
  ["lease-fencing", ["implement", "parallel"], "GATE", true],
  ["no-resident-skill", ["implement"], "ACK", false],
  ["plane-source", ["implement"], "GUARD", false],
  ["plane-generated", ["implement"], "GUARD", false],
  ["lint-real", ["implement", "verify"], "VERIFY", false],
  ["dead-code", ["implement"], "VERIFY", false],
  ["duplication", ["implement"], "VERIFY", false],
  ["dependency-decision", ["implement"], "ACK", false],
  ["charter-clean", ["implement", "review"], "ACK", false],
  ["checkpoint-finalize", ["checkpoint", "resume"], "GATE", true],
  ["journal-order", ["resume", "replay"], "GUARD", true],
  ["wake-verdict", ["resume", "wake"], "GATE", true],
  ["hat-sat", ["resume", "handoff"], "GATE", true],
  ["idempotent-retry", ["execute", "retry"], "GUARD", true],
  ["safe-parallel", ["parallel"], "GATE", true],
  ["one-producer", ["orchestrate"], "ACK", false],
  ["route-minimal", ["plan"], "AWARE", false],
  ["receipt-accept", ["verify", "review"], "VERIFY", false],
  ["no-shortness-reward", ["evaluate"], "ACK", false],
  ["owner-escalation", ["escalate", "merge"], "OWNER", true],
  ["gate-aggregator", ["merge"], "GATE", true],
  ["evidence-index", ["merge", "verify"], "VERIFY", false],
];
// Lower-case and `.` written as [^\n], matched against pyFoldAscii(text).
const ROUTE_INJECTION_RE = /(ignore (previous|all) instructions|disregard [^\n]*instructions|override [^\n]*rules?|bypass [^\n]*gate|reveal [^\n]*prompt|system prompt|__[a-z_]+__)/u;

// Mirrors standards_route.default_index: the canonical index entries.
export function defaultRouteIndex() {
  return ROUTE_INDEX.map(([id, triggers, cls, critical]) => ({
    id, home: `standards/${id.replaceAll("-", "_")}.md`, triggers: [...triggers], class: cls, critical,
    source_hash: sha256Hex16(id),
  }));
}

const normalizeRouteIndex = (entries) => (Array.isArray(entries) ? entries.filter(isMapping).map((entry) => {
  const triggers = pyGet(entry, "triggers");
  return {
    id: pyStrAny(pyGet(entry, "id", "")),
    home: pyOrStrAny(entry, "home"),
    triggers: Array.isArray(triggers) ? [...triggers] : [],
    class: pyOrStrAny(entry, "class"),
    critical: pyBool(pyGet(entry, "critical", false)),
    source_hash: pyOrStrAny(entry, "source_hash"),
  };
}) : []);

// Mirrors standards_route._check_index: unique named homed rules, known classes, fresh hashes.
const checkRouteIndex = (entries) => {
  const findings = [];
  const seen = new Map();
  entries.forEach((entry, index) => {
    const rid = entry.id;
    if (!rid) {
      findings.push(continuityFinding("missing-id", `entries[${index}] has no id: every normative rule needs one`,
        `entries[${index}]`, "blocker"));
      return;
    }
    if (seen.has(rid)) {
      findings.push(continuityFinding("duplicate-id",
        `duplicate rule id ${pyRepr(rid)} (entries ${seen.get(rid)} and ${index})`, rid, "blocker"));
      return;
    }
    seen.set(rid, index);
    if (!entry.home) {
      findings.push(continuityFinding("orphan-rule", `rule ${pyRepr(rid)} has no normative home: every rule lives somewhere`, rid));
    }
    if (!ROUTE_CLASSES.includes(entry.class)) {
      findings.push(continuityFinding("contradictory-triggers",
        `rule ${pyRepr(rid)} names unknown class ${pyRepr(entry.class)}: use one of ${ROUTE_CLASSES.join(", ")}`, rid));
    }
    const expected = sha256Hex16(rid);
    if (entry.source_hash && entry.source_hash !== expected) {
      findings.push(continuityFinding("stale-hash", `rule ${pyRepr(rid)} source hash drifted: re-derive the index`, rid));
    }
  });
  return findings;
};

const normalizeRouteTask = (task) => {
  const raw = isMapping(task) ? task : {};
  const criticalCaps = pyGet(raw, "critical_caps");
  return {
    kind: pyStrAny(pyGet(raw, "kind", "")),
    paths: pyScalarStrs(pyGet(raw, "paths")),
    phase: pyOrStrAny(raw, "phase"),
    risk: pyOrStrAny(raw, "risk"),
    capabilities: pyScalarStrs(pyGet(raw, "capabilities")),
    critical_caps: Array.isArray(criticalCaps) ? criticalCaps.map(pyStrAny) : [],
  };
};

// Mirrors standards_route.compile: one task to its minimal rule-ID route.
export function compileRoute(task, { entries = null, index = null } = {}) {
  const none = (value) => value === null || value === undefined;
  const raw = none(entries) && none(index) ? defaultRouteIndex() : (none(entries) ? index : entries);
  const normalized = normalizeRouteIndex(pyBool(raw) ? raw : []);
  const findings = checkRouteIndex(normalized);
  if (findings.length > 0) return { route: [], classes: {}, findings };
  const item = normalizeRouteTask(task);
  const tag = scalarExcerpt(item, ["kind"], "(route)");
  const refuse = (rule, finding) => ({ route: [], classes: {}, findings: [continuityFinding(rule, finding, tag, "blocker")] });
  const blob = pyJsonDumps({ kind: item.kind, paths: item.paths, phase: item.phase }, { sortKeys: true });
  if (ROUTE_INJECTION_RE.test(pyFoldAscii(blob)) || ROUTE_INJECTION_RE.test(pyFoldAscii(item.kind))) {
    return refuse("malicious-task", "task data carries injection or template tokens: refuse before routing");
  }
  for (const cap of item.critical_caps) {
    if (!item.capabilities.includes(cap)) {
      return refuse("missing-capability",
        `critical capability ${pyRepr(cap)} absent from the provider profile: route nothing until it resolves`);
    }
  }
  const route = [];
  const classes = {};
  const highRisk = ["R2", "R3"].includes(item.risk);
  for (const entry of normalized) {
    const hit = entry.triggers.includes(item.kind) || entry.triggers.includes(item.phase)
      || item.paths.some((p) => entry.triggers.includes(p)) || (highRisk && entry.critical);
    if (!hit) continue;
    route.push(entry.id);
    let cls = entry.class;
    if (entry.critical && cls === "AWARE") {
      findings.push(continuityFinding("critical-demotion",
        `critical rule ${pyRepr(entry.id)} reduced to AWARE-only: critical rules keep at least ACK`, tag, "blocker"));
      cls = "ACK";
    }
    setOwn(classes, entry.id, cls);
  }
  const sorted = pySorted(new Set(route));
  if (sorted.length > 40) {
    return refuse("registry-overload",
      `route holds ${sorted.length} rules: the whole registry loaded accidentally; narrow the task`);
  }
  if (item.paths.length > 20) {
    findings.push(continuityFinding("path-expansion", `${item.paths.length} paths expand the route: bound the focus envelope`, tag));
  }
  if (["R0", "R1", ""].includes(item.risk) && sorted.length > 0 && sorted.length <= 4) {
    findings.push(continuityFinding("minimal-route",
      `low-risk task routes ${sorted.length} rules: minimal route confirmed`, tag, "minor"));
  }
  return { route: sorted, classes, findings };
}

// --- Frozen contract: tools/standards_receipt.py (Stage 53) ---
const RECEIPT_VERDICTS = ["ISSUED", "QUIZ", "REFUSE"];
const RECEIPT_RULE_VERDICTS = Object.freeze({
  "wrong-ack": "REFUSE", "missing-critical": "REFUSE", "stale-spec": "REFUSE", "stale-path": "REFUSE",
  "stale-phase": "REFUSE", "stale-standard": "REFUSE", "r0-no-quiz": "ISSUED", "r3-required": "QUIZ",
  "adapter-omitted": "REFUSE", "own-receipt": "REFUSE", "lower-trust": "REFUSE", "clean-receipt": "ISSUED",
});
const RECEIPT_RULES = Object.keys(RECEIPT_RULE_VERDICTS);
const RECEIPT_SAT_TRIGGERS = ["new-provider", "high-risk", "privileged-scope", "authority-change"];
const RECEIPT_LOWER_TRUST_RE = /(skip (the |this )?(quiz|sat|receipt|check)|weaken [^\n]*receipt|self-?certify|lower-?trust [^\n]*approv|ignore [^\n]*standards?)/u;

// Mirrors standards_receipt.receipt_hash: route, acknowledgement and standard hash, bound.
export function receiptHash(route, ack, standardHash) {
  const canonical = pyJsonDumps({ ack: pySorted(ack), route: pySorted(route), standard: pyStrAny(standardHash) },
    { sortKeys: true, separators: [",", ":"] });
  return sha256Hex16(canonical);
}

const normalizeReceiptAttempt = (attempt) => {
  const raw = isMapping(attempt) ? attempt : {};
  const triggers = pyGet(raw, "sat_triggers");
  const item = { slice: pyStrAny(pyGet(raw, "slice", "")) };
  for (const key of ["routed", "critical", "acknowledged", "paths", "routed_paths"]) item[key] = pyScalarStrs(pyGet(raw, key));
  for (const key of ["risk", "ack_text", "route_text", "spec_hash", "routed_spec", "phase", "routed_phase",
    "standard_hash", "routed_standard", "instruction"]) item[key] = pyOrStrAny(raw, key);
  item.sat_triggers = Array.isArray(triggers) ? [...triggers] : [];
  item.sat_passed = pyBool(pyGet(raw, "sat_passed", false));
  item.adapter_present = pyBool(pyGet(raw, "adapter_present", true));
  item.adapter_required = pyBool(pyGet(raw, "adapter_required", false));
  item.self_issued = pyBool(pyGet(raw, "self_issued", false));
  return item;
};

// Mirrors standards_receipt.issue: one attempt to ISSUED / QUIZ / REFUSE, first hit decides.
export function issueReceipt(attempt) {
  const item = normalizeReceiptAttempt(attempt);
  const tag = pyStrip(item.slice) ? pySlice(item.slice, 200) : (item.routed.length > 0 ? pySlice(item.routed[0], 200) : "(receipt)");
  const decide = (rule, finding, { digest = "", severity = "major" } = {}) => ({
    verdict: RECEIPT_RULE_VERDICTS[rule], rule, digest, findings: [continuityFinding(rule, finding, tag, severity)],
  });
  const drifted = (routed, current) => item[routed] && item[current] && item[routed] !== item[current];
  if (drifted("route_text", "ack_text")) {
    return decide("wrong-ack", "acknowledgement diverges from the routed rule text: acknowledge exactly", { severity: "blocker" });
  }
  const missing = item.critical.find((rule) => !item.acknowledged.includes(rule));
  if (missing !== undefined) {
    return decide("missing-critical",
      `routed critical rule ${pyRepr(missing)} absent from the receipt: acknowledge every critical rule`, { severity: "blocker" });
  }
  if (drifted("routed_spec", "spec_hash")) return decide("stale-spec", "Spec changed since routing: re-route before issuing");
  if (item.routed_paths.length > 0 && !sameList(pySorted(item.paths), pySorted(item.routed_paths))) {
    return decide("stale-path", "touched paths changed since routing: re-route before issuing");
  }
  if (drifted("routed_phase", "phase")) return decide("stale-phase", "phase changed since routing: re-route before issuing");
  if (drifted("routed_standard", "standard_hash")) {
    return decide("stale-standard", "standard hash moved since routing: re-route before issuing");
  }
  if (RECEIPT_LOWER_TRUST_RE.test(pyFoldAscii(item.instruction))) {
    return decide("lower-trust", "lower-trust instruction to skip or weaken the receipt: refuse", { severity: "blocker" });
  }
  if (item.adapter_required && !item.adapter_present) {
    return decide("adapter-omitted", "required adapter capability omitted: attach it before issuing", { severity: "blocker" });
  }
  if (item.self_issued) {
    return decide("own-receipt",
      "subagent self-issued receipt is not independent proof: obtain independent acknowledgement", { severity: "blocker" });
  }
  const digest = receiptHash(item.routed, item.acknowledged, item.standard_hash);
  const triggered = ["R2", "R3"].includes(item.risk) || item.sat_triggers.some((t) => RECEIPT_SAT_TRIGGERS.includes(t));
  if (["R0", "R1", ""].includes(item.risk) && !triggered) {
    return decide("r0-no-quiz", "R0/R1 receipt issued without a quiz: receipt plus capability/tests suffice",
      { digest, severity: "minor" });
  }
  if (triggered && !item.sat_passed) {
    return decide("r3-required",
      "structured SAT required (new provider, R2/R3, privileged scope, or authority change): pass SAT before issuing",
      { severity: "blocker" });
  }
  return decide("clean-receipt", "complete routed acknowledgement: receipt issued with route/receipt/SAT hashes",
    { digest, severity: "minor" });
}

// --- Frozen contract: tools/capability_compiler.py (Stage 54a) ---
const CAPABILITY_CLASSES = ["read", "write", "execute", "network", "secrets", "effects"];
const CAPABILITY_VERDICTS = ["ALLOW", "DENY", "ESCALATE"];
const CAPABILITY_RULE_VERDICTS = Object.freeze({
  "foreign-read": "DENY", "foreign-write": "DENY", "frozen-mold": "DENY", "direct-main": "DENY",
  "secret-mount": "DENY", "arbitrary-egress": "DENY", "mcp-research-write": "DENY", "no-sandbox": "ESCALATE",
  "owner-escalation": "ALLOW", "focused-edit": "ALLOW", "test-command": "ALLOW",
});
const CAPABILITY_RULES = Object.keys(CAPABILITY_RULE_VERDICTS);
const FROZEN_MOLD_MARKERS = ["Canonical/corpus/", "Canonical/schemas/", "Canonical/capabilities.json"];

const slashed = (text) => text.replaceAll("\\", "/");
const lstripSlashes = (text) => text.replace(/^\/+/, "");
// Mirrors capability_compiler._under_any: the path equals a root or sits beneath it.
const underAnyRoot = (target, roots) => {
  const text = lstripSlashes(pyStrip(slashed(target)));
  return roots.some((root) => {
    const guard = lstripSlashes(pyStrip(slashed(root)));
    return guard !== "" && (text === guard || text.startsWith(`${guard.replace(/\/+$/, "")}/`));
  });
};

const normalizeCapabilityAction = (action) => {
  const raw = isMapping(action) ? action : {};
  const item = { kind: pyStrAny(pyGet(raw, "kind", "")) };
  for (const key of ["target", "command", "endpoint", "phase", "handle"]) item[key] = pyOrStrAny(raw, key);
  for (const key of ["direct_main", "raw_secret", "sandbox", "wrapper", "owner_approved", "test_command", "mcp_write"]) {
    item[key] = pyBool(pyGet(raw, key, false));
  }
  for (const key of ["read_roots", "write_roots", "exec_allow", "net_allow"]) item[key] = pyScalarStrs(pyGet(raw, key));
  return item;
};

// Mirrors capability_compiler.check: one requested action to ALLOW / DENY / ESCALATE.
export function checkCapability(action) {
  const item = normalizeCapabilityAction(action);
  const tag = scalarExcerpt(item, ["target", "command", "endpoint"], "(capability)");
  const decide = (rule, finding, severity = "major") => ({
    verdict: CAPABILITY_RULE_VERDICTS[rule], rule, findings: [continuityFinding(rule, finding, tag, severity)],
  });
  const allow = { verdict: "ALLOW", rule: "focused-edit", findings: [] };
  switch (item.kind) {
    case "read":
      return underAnyRoot(item.target, item.read_roots) ? allow
        : decide("foreign-read", `read of ${pyRepr(item.target)} outside read roots: DENY`, "blocker");
    case "write":
      if (FROZEN_MOLD_MARKERS.some((marker) => lstripSlashes(slashed(item.target)).startsWith(marker))) {
        return decide("frozen-mold", `write to frozen Mold ${pyRepr(item.target)}: DENY, regenerate via the owning tool`, "blocker");
      }
      if (item.direct_main) return decide("direct-main", "direct-to-main mutation: DENY, land via PR only", "blocker");
      if (!underAnyRoot(item.target, item.write_roots)) {
        return decide("foreign-write", `write to ${pyRepr(item.target)} outside write roots: DENY`, "blocker");
      }
      if (item.phase === "research" && item.mcp_write) {
        return decide("mcp-research-write", "MCP write during research: DENY, research is read-only");
      }
      return decide("focused-edit", "focused edit inside write roots: ALLOW", "minor");
    case "secret":
      return item.raw_secret || !item.handle
        ? decide("secret-mount", "raw secret where a handle belongs: DENY, mount the scoped handle", "blocker") : allow;
    case "egress":
      return !underAnyRoot(item.endpoint, item.net_allow) && !item.net_allow.includes(item.endpoint)
        ? decide("arbitrary-egress", `egress to ${pyRepr(item.endpoint)} outside the allowlist: DENY`, "blocker") : allow;
    case "execute":
      if (item.test_command && item.exec_allow.includes(item.command)) {
        return decide("test-command", "allowlisted test command: ALLOW", "minor");
      }
      if (item.owner_approved) return decide("owner-escalation", "owner-approved escalation: ALLOW with the approval recorded", "minor");
      if (!item.sandbox && !item.wrapper) return decide("no-sandbox", "provider without sandbox nor wrapper: ESCALATE dry-run/report");
      if (!item.exec_allow.includes(item.command)) {
        return decide("arbitrary-egress", `command ${pyRepr(item.command)} outside the execute allowlist: DENY`);
      }
      return allow;
    default:
      return decide("foreign-read", `unknown action kind ${pyRepr(item.kind)}: DENY by default`, "blocker");
  }
}

// Mirrors capability_compiler.compile: one role/phase/task profile to its bounds.
export function compileCapabilities(profile) {
  const role = pyOrStrAny(isMapping(profile) ? profile : {}, "role") || "builder";
  return {
    read_roots: ["tools/", "tests/", "Canonical/corpus/"],
    write_roots: role === "builder" ? ["tools/", "tests/"] : ["evidence/"],
    exec_allow: ["python tools/standardctl.py verify", "python -m unittest"],
    net_allow: ["api.github.com"],
    secret_handles: ["scoped-secret-handle"],
    mode: "dry-run/report with sharp-edge enforcement",
  };
}

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
  quality: {
    DIMENSIONS: QUALITY_DIMENSIONS,
    SEVERITIES: QUALITY_SEVERITIES,
    FINDING_FIELDS: QUALITY_FINDING_FIELDS,
  },
  context_rotation: {
    SEQUENCE: ROTATION_SEQUENCE,
    VERDICTS: ROTATION_VERDICTS,
    SEVERITIES: ["blocker", "major", "minor"],
    FINDING_FIELDS: ["id", "rule", "finding", "severity", "excerpt"],
    RULES: ROTATION_RULES,
    RULE_VERDICTS: ROTATION_RULE_VERDICTS,
  },
  capsule: {
    VERSION: CAPSULE_VERSION,
    BUDGET_BYTES_MIN: CAPSULE_BYTES_MIN,
    BUDGET_BYTES_MAX: CAPSULE_BYTES_MAX,
    CAPSULE_FIELDS,
  },
  mcp_profile: {
    SIBLING_CONTRACT_VERSION: "1.0.0",
    SERVER_FIELDS: MCP_SERVER_FIELDS,
    TRANSPORTS: MCP_TRANSPORTS,
    KINDS: MCP_KINDS,
    PHASES: MCP_PHASES,
    TRANSPORT_KEYS: MCP_TRANSPORT_KEYS,
    EGRESS_ALLOWLIST: MCP_EGRESS_ALLOWLIST,
    SECRET_MARKERS: MCP_SECRET_MARKERS,
    ADVISORY_LIMITS: MCP_ADVISORY_LIMITS,
  },
  extensions_registry: {
    RESERVED_KEYS: REGISTRY_RESERVED_KEYS,
    REGISTRY_REQUIRED,
  },
  profile_compiler: {
    CONTRACT_VERSION: "1.0.0",
    DESCRIPTOR_FIELDS,
    PROCESS_PLUS_DOMAIN_BUDGET,
  },
  standards_route: {
    CLASSES: ROUTE_CLASSES,
    SEVERITIES: ["blocker", "major", "minor"],
    FINDING_FIELDS: ["id", "rule", "finding", "severity", "excerpt"],
    RULES: ROUTE_RULES,
    ROUTE_MIN,
    ROUTE_MAX,
    INDEX: ROUTE_INDEX,
  },
  standards_receipt: {
    VERDICTS: RECEIPT_VERDICTS,
    SEVERITIES: ["blocker", "major", "minor"],
    FINDING_FIELDS: ["id", "rule", "finding", "severity", "excerpt"],
    RULES: RECEIPT_RULES,
    RULE_VERDICTS: RECEIPT_RULE_VERDICTS,
    SAT_TRIGGERS: RECEIPT_SAT_TRIGGERS,
  },
  capability_compiler: {
    CLASSES: CAPABILITY_CLASSES,
    VERDICTS: CAPABILITY_VERDICTS,
    SEVERITIES: ["blocker", "major", "minor"],
    FINDING_FIELDS: ["id", "rule", "finding", "severity", "excerpt"],
    RULES: CAPABILITY_RULES,
    RULE_VERDICTS: CAPABILITY_RULE_VERDICTS,
    FROZEN_MOLD_MARKERS,
  },
};

export function provenance() {
  return "tools/repo_map.py + tools/ownership_map.py + tools/context_budget.py + tools/handoff_acceptance.py + tools/thinness.py + tools/ready.py + tools/disposition.py + tools/verification_mold.py + tools/mold_qualification.py + tools/verification_portfolio.py + tools/quality_eval.py + tools/context_rotation.py + tools/capsule.py + tools/mcp_profile.py + tools/extensions_registry.py + tools/profile_compiler.py + tools/standards_route.py + tools/standards_receipt.py + tools/capability_compiler.py @9e50c9c3518e5bed2ba93e194cb157a78ee0278d";
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
  // Continuity plane: rotation, capsule, handoff acceptance. S5 (#423)
  // characterizes the four upstream modules against golden Python output and
  // a cold-resume canary; goal/scratch state is the capsule contract, kept
  // local by hyperbolic-core's gitignored scratch roots.
  "continuity:work-state": { mechanism: "AGENTS.md", gap: null },
  "continuity:goal-scratch": { mechanism: "docs/ops/stage63-continuity.test.mjs", gap: null },
  "continuity:handoff-acceptance": { mechanism: "docs/ops/stage63-continuity.test.mjs", gap: null },
  "continuity:context-budget": { mechanism: "docs/ops/stage63-continuity.test.mjs", gap: null },
  "continuity:rotation-decision": { mechanism: "docs/ops/stage63-continuity.test.mjs", gap: null },
  // Molds plane (slice S3, #421): the v5 Verification Mold family —
  // critique (Stage 29), qualification (Stage 31), portfolio router
  // (Stage 32), and the mold substrates 59b/61b already bind.
  "molds:critique-rules": { mechanism: "docs/ops/stage63-molds.test.mjs", gap: null },
  "molds:qualification-rules": { mechanism: "docs/ops/stage63-molds.test.mjs", gap: null },
  "molds:portfolio-router": { mechanism: "docs/ops/stage63-molds.test.mjs", gap: null },
  "molds:release-substrate": { mechanism: "docs/ops/stage61b-release-proofbed-lib.mjs", gap: null },
  "molds:proof-invalidation": { mechanism: null, gap: 428 },
  // Extension plane (slice S6, #424): the profile contracts are characterized
  // against golden Python output and bound to hyperbolic-core's live surface
  // (LifeOS read-only stdio MCP server, project.yaml, tracked tree); the
  // capability layer itself is provisioned machine-globally at session start.
  "extensions:mcp-zero-standing": { mechanism: "docs/ops/stage63-profiles.test.mjs", gap: null },
  "extensions:mcp-activation-gate": { mechanism: "docs/ops/stage63-profiles.test.mjs", gap: null },
  "extensions:registry-consistency": { mechanism: "docs/ops/stage63-profiles.test.mjs", gap: null },
  "extensions:profile-selection": { mechanism: "docs/ops/stage63-profiles.test.mjs", gap: null },
  "extensions:provisioning": { mechanism: ".claude/hooks/session-start.sh", gap: null },
  // Standards/capability boundary plane (slice S7, #425): route, receipt and
  // capability contracts characterized against golden Python output and the
  // frozen upstream corpora; AGENTS.md's agent prohibitions are the live
  // boundary each sharp-edge DENY binds to.
  "standards:route-index": { mechanism: "docs/ops/stage63-standards.test.mjs", gap: null },
  "standards:receipt-binding": { mechanism: "docs/ops/stage63-standards.test.mjs", gap: null },
  "capability:sharp-edge-bounds": { mechanism: "docs/ops/stage63-standards.test.mjs", gap: null },
  "capability:agent-boundaries": { mechanism: "AGENTS.md", gap: null },
  // Implementation quality plane (slice S4, #422): offline advisory
  // characterization only; no PR Gate or production action consumes it.
  "quality:correctness-gate": { mechanism: "docs/ops/stage63-quality.test.mjs", gap: null },
  "quality:conformance-and-parsimony": { mechanism: "docs/ops/stage63-quality.test.mjs", gap: null },
  "quality:deterministic-ranking": { mechanism: "docs/ops/stage63-quality.test.mjs", gap: null },
  "quality:independent-agreement": { mechanism: "docs/ops/stage63-quality.test.mjs", gap: null },
};

export function gapsOf() {
  return Object.keys(ADOPTION).filter((k) => ADOPTION[k].mechanism === null);
}

export function mappedOf() {
  return Object.keys(ADOPTION).filter((k) => ADOPTION[k].mechanism !== null);
}
