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
const pyRepr = (text) => {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const body = [...text].map((ch) => {
    const code = ch.codePointAt(0);
    if (ch === "\\") return "\\\\";
    if (ch === quote) return `\\${quote}`;
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, "0")}`;
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
const pyJsonDumps = (value, { sortKeys = false, indent = null, ensureAscii = true } = {}, level = 0) => {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyJsonString(value, ensureAscii);
  const options = { sortKeys, indent, ensureAscii };
  const entries = Array.isArray(value)
    ? value.map((item) => pyJsonDumps(item, options, level + 1))
    : (sortKeys ? Object.keys(value).sort() : Object.keys(value))
      .map((key) => `${pyJsonString(key, ensureAscii)}: ${pyJsonDumps(value[key], options, level + 1)}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return open + close;
  if (indent === null) return open + entries.join(", ") + close;
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
};

export function provenance() {
  return "tools/repo_map.py + tools/ownership_map.py + tools/context_budget.py + tools/handoff_acceptance.py + tools/thinness.py + tools/ready.py + tools/disposition.py + tools/verification_mold.py + tools/mold_qualification.py + tools/verification_portfolio.py + tools/quality_eval.py + tools/context_rotation.py + tools/capsule.py @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d";
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
