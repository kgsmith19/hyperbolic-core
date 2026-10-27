// Stage 63 S10 (#428): release/runtime contract ports.
//
// Three upstream Standard modules, pinned to agent-engineering-standard @
// 516fdb2 (the post-series commit that standard.lock moves to):
//   tools/release_mold.py        Stage 61a: evaluate one release package to
//                                PROMOTE / HOLD / REFUSE (the 14 rules the 61b
//                                proofbed binding names, now with their logic)
//   tools/proof_invalidation.py  Stage 33: freeze a Mold and invalidate any
//                                proof recorded against drifted content
//   tools/edition_packaging.py   T10: the Full/Lite release VERIFY checks
//
// Pure functions: plain JSON data in, verdicts out. Python semantics come from
// stage63-adoption-lib.mjs (str/bool/repr/strip/slice/iterate), never from the
// JS built-ins; the golden (stage63-release-golden.json) is the oracle.
// tools/standardctl.py's edition UX (--edition, --set harness.*, doctor --live)
// is not ported: hyperbolic-core has no edition or harness surface for it to
// drive (disclosed in docs/ops/stage63-release.test.mjs).

import { pythonSemantics } from "./stage63-adoption-lib.mjs";

const {
  str: pyStr, strAny: pyStrAny, truthy: pyBool, get: pyGet, slice: pySlice, strip: pyStrip,
  repr: pyRepr, isScalar: isPyScalar, scalarStrs: pyScalarStrs, orStrAny: pyOrStrAny,
  typeName: pyTypeName, iterate: pyIterate, compareCodePoints: pyCompareCodePoints,
} = pythonSemantics;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKey = (mapping, key) => Object.prototype.hasOwnProperty.call(mapping, key);
const sortedKeys = (values) => [...values].sort(pyCompareCodePoints);
// A Python exception the port raises: the golden records its type name.
const pyError = (name, message) => {
  const error = new Error(message);
  error.name = name;
  return error;
};
// int(value) for JSON plain data: bool is an int, a float truncates, a str
// parses as a decimal literal, anything else raises TypeError.
const pyIntOf = (value) => {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    if (!/^[ \t\n\r\f\v]*[+-]?[0-9]+[ \t\n\r\f\v]*$/u.test(value)) {
      throw pyError("ValueError", `invalid literal for int() with base 10: ${pyRepr(value)}`);
    }
    return Number.parseInt(value, 10);
  }
  throw pyError("TypeError", `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`);
};
// Python's `re` `$` also matches before one trailing newline; `\d` is Unicode.
const releaseIdRe = /^release-mold\.[a-z-]+\.\p{Nd}{2}(?=\n?$)/u;
const invalidationIdRe = /^proof-inv\.[a-z-]+\.\p{Nd}{2}(?=\n?$)/u;

// --- release_mold (Stage 61a) ----------------------------------------------------

export const RELEASE_VERDICTS = Object.freeze(["PROMOTE", "HOLD", "REFUSE"]);
export const RELEASE_CLAIMS = Object.freeze([
  "integrated-behavior", "deployment-proof", "rollback-proof", "restore-proof",
  "provenance-proof", "runtime-proof", "canary-proof",
]);
export const RELEASE_SEVERITIES = Object.freeze(["blocker", "major", "minor"]);
export const RELEASE_FINDING_FIELDS = Object.freeze(["id", "rule", "finding", "severity", "excerpt"]);
export const RELEASE_RULES = Object.freeze([
  "open-issues", "stale-artifact", "broken-integration", "failed-rollback", "unusable-backup",
  "missing-attestation", "invariant-breach", "missing-telemetry", "partial-green",
  "expired-evidence", "restore-rpo", "mold-unqualified", "canary-missing", "clean-promote",
]);
export const RELEASE_RULE_VERDICTS = Object.freeze({
  "open-issues": "REFUSE", "stale-artifact": "REFUSE", "broken-integration": "REFUSE",
  "failed-rollback": "REFUSE", "unusable-backup": "REFUSE", "missing-attestation": "REFUSE",
  "invariant-breach": "REFUSE", "missing-telemetry": "REFUSE", "partial-green": "REFUSE",
  "expired-evidence": "REFUSE", "restore-rpo": "PROMOTE", "mold-unqualified": "HOLD",
  "canary-missing": "HOLD", "clean-promote": "PROMOTE",
});

// _make_finding: the release default severity is "major".
const releaseFinding = (rule, message, excerpt, severity = "major") => ({
  id: `${rule}-1`, rule, finding: message, severity, excerpt: pySlice(excerpt, 200),
});

export function releaseFindingRepairs(finding) {
  if (!isObject(finding)) return [`finding must be a mapping of plain data, not ${pyTypeName(finding)}`];
  const repairs = [];
  for (const key of RELEASE_FINDING_FIELDS) {
    if (!hasKey(finding, key)) repairs.push(`finding is missing required key ${pyRepr(key)}`);
  }
  if (hasKey(finding, "rule") && !RELEASE_RULES.includes(finding.rule)) {
    repairs.push(`finding rule ${pyRepr(finding.rule)} is not a frozen Stage 61a release rule`);
  }
  if (hasKey(finding, "severity") && !RELEASE_SEVERITIES.includes(finding.severity)) {
    repairs.push(`finding severity ${pyRepr(finding.severity)} must be blocker|major|minor`);
  }
  return repairs;
}

// _normalize_package: total defaults, so partial input never crashes (but a
// value int() rejects still raises, as it does upstream).
const normalizeRelease = (value) => {
  const pkg = isObject(value) ? value : {};
  const claims = pyGet(pkg, "claims", null);
  const invariants = pyGet(pkg, "canary_invariants", null);
  const blockers = pyGet(pkg, "open_blockers", null);
  const flag = (key, fallback) => pyBool(pyGet(pkg, key, fallback));
  return {
    release: pyStrAny(pyGet(pkg, "release", "")),
    open_blockers: pyBool(blockers) ? pyIntOf(blockers) : 0,
    artifact_fresh: flag("artifact_fresh", true),
    integration_green: flag("integration_green", true),
    rollback_ok: flag("rollback_ok", true),
    backup_restorable: flag("backup_restorable", true),
    attested: flag("attested", true),
    invariants_held: flag("invariants_held", true),
    telemetry_present: flag("telemetry_present", true),
    partial_green: flag("partial_green", false),
    evidence_fresh: flag("evidence_fresh", true),
    restore_rpo_ok: flag("restore_rpo_ok", false),
    restore_rto_ok: flag("restore_rto_ok", false),
    mold_built: flag("mold_built", false),
    mold_attacked: flag("mold_attacked", false),
    mold_qualified: flag("mold_qualified", false),
    canary_declared: flag("canary_declared", false),
    canary_exposure: pyOrStrAny(pkg, "canary_exposure"),
    canary_window: pyOrStrAny(pkg, "canary_window"),
    canary_invariants: Array.isArray(invariants) ? [...invariants] : [],
    claims: Array.isArray(claims) ? pyScalarStrs(claims) : [],
  };
};

// _excerpt: the release name, else "(release)".
const releaseTag = (item) => (pyStrip(item.release) ? pySlice(item.release, 200) : "(release)");

const decide = (rule, message, tag, severity = "major") => ({
  verdict: RELEASE_RULE_VERDICTS[rule],
  rule,
  findings: [releaseFinding(rule, message, tag, severity)],
});

// evaluate: first hit decides, in the frozen check order.
export function evaluateRelease(pkg) {
  const item = normalizeRelease(pkg);
  const tag = releaseTag(item);
  const missing = RELEASE_CLAIMS.filter((claim) => !item.claims.includes(claim));
  if (item.open_blockers > 0) {
    return decide("open-issues", `${item.open_blockers} open release-blocking Issues: REFUSE`, tag, "blocker");
  }
  if (!item.artifact_fresh) return decide("stale-artifact", "stale build artifact: REFUSE and rebuild", tag);
  if (!item.integration_green) {
    return decide("broken-integration", "broken integrated behavior: REFUSE", tag, "blocker");
  }
  if (!item.rollback_ok) return decide("failed-rollback", "rollback drill failed: REFUSE", tag, "blocker");
  if (!item.backup_restorable) {
    return decide("unusable-backup", "backup/config/data unrestorable: REFUSE", tag, "blocker");
  }
  if (!item.attested) return decide("missing-attestation", "SBOM/attestation missing: REFUSE", tag);
  if (!item.invariants_held) {
    return decide("invariant-breach", "canary invariant breached: REFUSE and halt", tag, "blocker");
  }
  if (!item.telemetry_present) return decide("missing-telemetry", "canary telemetry missing: REFUSE", tag);
  if (item.partial_green) {
    return decide("partial-green", "partial green treated as release-ready: REFUSE", tag, "blocker");
  }
  if (!item.evidence_fresh) {
    return decide("expired-evidence", "evidence past its window: REFUSE and re-prove", tag);
  }
  if (item.restore_rpo_ok && item.restore_rto_ok && missing.length === 0 && item.evidence_fresh) {
    return decide("restore-rpo",
      `successful restore within RPO/RTO with all ${RELEASE_CLAIMS.length} claims: PROMOTE path`,
      tag, "minor");
  }
  if (!(item.mold_built && item.mold_attacked && item.mold_qualified)) {
    return decide("mold-unqualified", "Release Mold not built/attacked/qualified: HOLD", tag);
  }
  const invariants = pyScalarStrs(item.canary_invariants);
  if (!item.canary_declared || !item.canary_exposure || !item.canary_window
      || !(invariants.length >= 2 && invariants.length <= 5)) {
    return decide("canary-missing",
      "canary not declared (exposure, baseline, window, 2-5 invariants, thresholds): HOLD", tag);
  }
  if (missing.length > 0) return decide("mold-unqualified", `missing release claims ${pyRepr(missing)}: HOLD`, tag);
  return {
    verdict: "PROMOTE",
    rule: "clean-promote",
    findings: [releaseFinding("clean-promote", "all proofs present and fresh: PROMOTE", tag, "minor")],
  };
}

// clean_package: one package that promotes; callers mutate one dimension.
export function cleanReleasePackage() {
  return {
    release: "v5.0", open_blockers: 0, artifact_fresh: true, integration_green: true,
    rollback_ok: true, backup_restorable: true, attested: true, invariants_held: true,
    telemetry_present: true, partial_green: false, evidence_fresh: true, restore_rpo_ok: true,
    restore_rto_ok: true, mold_built: true, mold_attacked: true, mold_qualified: true,
    canary_declared: true, canary_exposure: "1% for 24h", canary_window: "24h",
    canary_invariants: ["error-rate", "latency-p99", "rollback-time"],
    claims: [...RELEASE_CLAIMS],
  };
}

const entriesOf = (corpus) => {
  const entries = isObject(corpus) ? corpus.entries : corpus;
  return Array.isArray(entries) ? entries : [];
};

// validate_release_corpus: [] findings means a valid frozen oracle.
export function validateReleaseCorpus(corpus) {
  if (isObject(corpus)) {
    if (corpus._frozen !== true) {
      return { findings: ['release corpus is not frozen: set "_frozen": true'], entries: [] };
    }
    if (!pyStr(pyGet(corpus, "_provenance", "")).includes("Stage 61a #152")) {
      return { findings: ['release corpus provenance must name "Stage 61a #152"'], entries: [] };
    }
  } else if (!Array.isArray(corpus)) {
    return {
      findings: ["release corpus must be a JSON object with an 'entries' array (or a bare array)"],
      entries: [],
    };
  }
  const entries = entriesOf(corpus);
  const findings = [];
  if (entries.length < 14) {
    findings.push(`release corpus holds ${entries.length} entries, want at least 14`);
  }
  const seen = new Map();
  const covered = new Set();
  entries.forEach((entry, index) => {
    if (!isObject(entry)) {
      findings.push(`entries[${index}] is not a mapping`);
      return;
    }
    const cid = pyStrAny(pyGet(entry, "id", ""));
    if (!releaseIdRe.test(cid)) findings.push(`entry ${pyRepr(cid)}: id is not release-mold.<class>.<nn>`);
    if (seen.has(cid)) {
      findings.push(`duplicate entry id ${cid} (entries ${seen.get(cid)} and ${index})`);
    } else {
      seen.set(cid, index);
    }
    if (!pyStrip(pyStrAny(pyGet(entry, "note", "")))) {
      findings.push(`entry ${cid}: a one-line adjudication note is required`);
    }
    for (const key of ["expected_rule", "expected_verdict"]) {
      if (!hasKey(entry, key)) findings.push(`entry ${cid}: ${key} is required`);
    }
    const rule = pyGet(entry, "expected_rule", null);
    if (!RELEASE_RULES.includes(rule)) {
      findings.push(`entry ${cid}: expected_rule ${pyRepr(rule)} is not a frozen Stage 61a release rule`);
      return;
    }
    covered.add(rule);
    const expectedVerdict = pyGet(entry, "expected_verdict", null);
    if (expectedVerdict !== RELEASE_RULE_VERDICTS[rule]) {
      findings.push(`entry ${cid}: expected_verdict ${pyRepr(expectedVerdict)} != rule verdict ${pyRepr(RELEASE_RULE_VERDICTS[rule])}`);
      return;
    }
    const result = evaluateRelease(pyGet(entry, "package", {}));
    if (result.rule !== rule) {
      findings.push(`entry ${cid}: expected_rule ${pyRepr(rule)} != evaluate ${pyRepr(result.rule)}`);
    }
    if (result.verdict !== expectedVerdict) {
      findings.push(`entry ${cid}: expected_verdict ${pyRepr(expectedVerdict)} != evaluate ${pyRepr(result.verdict)}`);
    }
  });
  for (const rule of RELEASE_RULES) {
    if (!covered.has(rule)) {
      findings.push(`rule ${pyRepr(rule)} has no entries (all 14 release rules are required)`);
    }
  }
  return { findings, entries };
}

// --- proof_invalidation (Stage 33) ------------------------------------------------

export const INVALIDATION_RULES = Object.freeze([
  "mold-payload-changed", "intent-changed", "command-changed", "protected-path-touched",
  "stale-proof-reuse", "stale-review-reuse", "reopen-without-requalification",
]);
export const INVALIDATION_CHANGE_CLASSES = Object.freeze(["editorial", "semantic", "reopen"]);
export const FREEZE_FIELDS = Object.freeze([
  "mold", "frozen_digest", "frozen_head", "frozen_intent_digest", "frozen_commands", "frozen_by",
]);
export const FROZEN_BY = "proof_invalidation.freeze";

// _make_finding: the invalidation default severity is "blocker".
const invalidationFinding = (rule, message, excerpt, severity = "blocker") => ({
  id: `${rule}-1`, rule, finding: message, severity, excerpt: pySlice(excerpt, 200),
});

export function invalidationFindingRepairs(finding) {
  if (!isObject(finding)) return [`finding must be a mapping of plain data, not ${pyTypeName(finding)}`];
  const repairs = [];
  for (const key of ["id", "rule", "finding", "severity", "excerpt"]) {
    if (!hasKey(finding, key)) repairs.push(`finding is missing required key ${pyRepr(key)}`);
  }
  if (hasKey(finding, "rule") && !INVALIDATION_RULES.includes(finding.rule)) {
    repairs.push(`finding rule ${pyRepr(finding.rule)} is not a frozen Stage 33 invalidation rule`);
  }
  if (hasKey(finding, "severity") && !["blocker", "major", "minor"].includes(finding.severity)) {
    repairs.push(`finding severity ${pyRepr(finding.severity)} must be blocker|major|minor`);
  }
  return repairs;
}

const normalizeCommands = (value) => (Array.isArray(value)
  ? value.filter(isObject).map((entry) => ({
    command: pyStrAny(pyGet(entry, "command", "")),
    digest: pyStrAny(pyGet(entry, "digest", "")),
  }))
  : []);

const scalarList = (value) => (Array.isArray(value) ? pyScalarStrs(value) : []);

const normalizeRun = (value) => {
  const run = isObject(value) ? value : {};
  const proof = pyGet(run, "proof", null);
  const prior = pyGet(run, "prior_approval", null);
  const reopen = pyGet(run, "reopen", null);
  const text = (key) => pyStrAny(pyGet(run, key, ""));
  return {
    mold: text("mold"),
    mold_digest: text("mold_digest"),
    frozen_digest: text("frozen_digest"),
    frozen_head: text("frozen_head"),
    head: text("head"),
    intent_digest: text("intent_digest"),
    frozen_intent_digest: text("frozen_intent_digest"),
    commands: normalizeCommands(pyGet(run, "commands", null)),
    frozen_commands: normalizeCommands(pyGet(run, "frozen_commands", null)),
    proof: isObject(proof) ? { ...proof } : {},
    prior_approval: isObject(prior) ? { ...prior } : {},
    reopen: isObject(reopen) ? { ...reopen } : {},
    protected_paths: scalarList(pyGet(run, "protected_paths", null)),
    touched_paths: scalarList(pyGet(run, "touched_paths", null)),
    provider: text("provider"),
  };
};

// _path_touched: a touched path is at or under a protected path.
const pathTouched = (touched, protectedPath) => {
  const clean = pyStrip(touched.replaceAll("\\", "/")).replace(/^\/+/u, "");
  const guard = pyStrip(protectedPath.replaceAll("\\", "/")).replace(/^\/+/u, "");
  if (!clean || !guard) return false;
  if (clean === guard) return true;
  return clean.startsWith(`${guard.replace(/\/+$/u, "")}/`);
};

const firstProtectedHit = (run) => run.touched_paths.find(
  (touched) => run.protected_paths.some((guard) => pathTouched(touched, guard))) ?? "";

// Human-readable command deltas; empty means stable.
const commandDrift = (run) => {
  const frozen = new Map();
  for (const { command, digest } of run.frozen_commands) if (command) frozen.set(command, digest);
  const current = new Map();
  for (const { command, digest } of run.commands) if (command) current.set(command, digest);
  const deltas = [];
  for (const command of sortedKeys(frozen.keys())) {
    if (!current.has(command)) deltas.push(`command removed: ${pyRepr(command)}`);
    else if (current.get(command) !== frozen.get(command)) deltas.push(`command changed: ${pyRepr(command)}`);
  }
  for (const command of sortedKeys(current.keys())) {
    if (!frozen.has(command)) deltas.push(`command added: ${pyRepr(command)}`);
  }
  return deltas;
};

const payloadDrifted = (run) => run.frozen_digest !== "" && run.mold_digest !== run.frozen_digest;
const intentDrifted = (run) => run.frozen_intent_digest !== "" && run.intent_digest !== run.frozen_intent_digest;
const reopenReason = (run) => pyStrip(pyStrAny(pyGet(run.reopen, "reason", "")));

// classify_change: editorial | semantic | reopen (frozen precedence).
export function classifyChange(value) {
  const run = normalizeRun(value);
  if (reopenReason(run)) return "reopen";
  if (payloadDrifted(run) || intentDrifted(run) || commandDrift(run).length > 0) return "semantic";
  if (run.touched_paths.some((touched) => run.protected_paths.some((guard) => pathTouched(touched, guard)))) {
    return "semantic";
  }
  if (!run.frozen_digest) return "semantic";
  return "editorial";
}

// freeze: mint one freeze record as plain data (no I/O).
export function freeze(mold, moldDigest, head, intentDigest = "", commands = null, provider = "") {
  return {
    mold: pyStr(mold),
    frozen_digest: pyStrAny(moldDigest),
    frozen_head: pyStrAny(head),
    frozen_intent_digest: pyStrAny(intentDigest),
    frozen_commands: normalizeCommands(commands),
    frozen_by: FROZEN_BY,
    provider: pyStrAny(provider),
  };
}

// check_invalidation: findings mean invalidated. A structured reopen suspends
// the drift findings but still refuses stale proof until requalified.
export function checkInvalidation(value) {
  const run = normalizeRun(value);
  const reopened = reopenReason(run) !== "";
  const requalified = pyBool(pyGet(run.reopen, "requalified", false));
  const payloadDrift = payloadDrifted(run);
  const intentDrift = intentDrifted(run);
  const deltas = commandDrift(run);
  const protectedHit = firstProtectedHit(run);
  const mold = run.mold || "(unnamed mold)";
  const findings = [];
  if (!reopened) {
    if (payloadDrift) {
      findings.push(invalidationFinding("mold-payload-changed",
        `Mold payload drifted under a live freeze (frozen ${pySlice(run.frozen_digest, 12)} != current ${pySlice(run.mold_digest, 12)}): freeze a new Mold or file a structured reopen`,
        mold));
    }
    if (intentDrift) {
      findings.push(invalidationFinding("intent-changed",
        `linked intent drifted under a live freeze: the proof evidences frozen intent ${pySlice(run.frozen_intent_digest, 12)}, not current ${pySlice(run.intent_digest, 12)}`,
        mold));
    }
    if (deltas.length > 0) {
      findings.push(invalidationFinding("command-changed",
        `execution drifted under a live freeze (${deltas.join("; ")}): the proof ran under commands that no longer exist`,
        mold));
    }
    if (protectedHit) {
      findings.push(invalidationFinding("protected-path-touched",
        `protected ground moved (touched ${pyRepr(protectedHit)}): no cached authorization survives a protected-path touch`,
        mold));
    }
  }
  const drift = payloadDrift || intentDrift || deltas.length > 0 || protectedHit !== "";
  if (pyBool(run.proof) && drift && !reopened) {
    findings.push(invalidationFinding("stale-proof-reuse",
      `prior proof (verdict ${pyRepr(pyStrAny(pyGet(run.proof, "verdict", "")))}) is bound to frozen content, not to the Mold name: requalify before reusing it`,
      mold));
  }
  if (pyBool(run.prior_approval) && drift && !reopened) {
    findings.push(invalidationFinding("stale-review-reuse",
      `prior ${pyStrAny(pyGet(run.prior_approval, "kind", "review"))} approval is bound to exact frozen content: freeze drift voids it, re-approve after requalification`,
      mold));
  }
  if (reopened && !requalified && (pyBool(run.proof) || pyBool(run.prior_approval))) {
    findings.push(invalidationFinding("reopen-without-requalification",
      `Mold was reopened (${pySlice(pyStrAny(pyGet(run.reopen, "reason", "")), 120)}) but not requalified: reopening suspends invalidation without restoring trust`,
      mold));
  }
  let changeClass = "editorial";
  if (reopened) changeClass = "reopen";
  else if (drift || !run.frozen_digest) changeClass = "semantic";
  return {
    change_class: changeClass,
    findings,
    invalidated: findings.length > 0,
    ok: findings.length === 0 && !findings.some((finding) => finding.severity === "blocker"),
  };
}

// validate_invalidation_corpus: [] findings means a valid frozen oracle.
export function validateInvalidationCorpus(corpus) {
  if (isObject(corpus)) {
    if (corpus._frozen !== true) {
      return { findings: ['invalidation corpus is not frozen: set "_frozen": true'], entries: [] };
    }
    if (!pyStr(pyGet(corpus, "_provenance", "")).includes("Stage 33 #124")) {
      return { findings: ['invalidation corpus provenance must name "Stage 33 #124"'], entries: [] };
    }
  } else if (!Array.isArray(corpus)) {
    return {
      findings: ["invalidation corpus must be a JSON object with an 'entries' array (or a bare array)"],
      entries: [],
    };
  }
  const entries = entriesOf(corpus);
  const findings = [];
  if (entries.length < 11) {
    findings.push(`invalidation corpus holds ${entries.length} entries, want at least 11`);
  }
  const seen = new Map();
  const covered = new Set();
  entries.forEach((entry, index) => {
    if (!isObject(entry)) {
      findings.push(`entries[${index}] is not a mapping`);
      return;
    }
    const cid = pyStrAny(pyGet(entry, "id", ""));
    if (!invalidationIdRe.test(cid)) findings.push(`entry ${pyRepr(cid)}: id is not proof-inv.<class>.<nn>`);
    if (seen.has(cid)) {
      findings.push(`duplicate entry id ${cid} (entries ${seen.get(cid)} and ${index})`);
    } else {
      seen.set(cid, index);
    }
    if (!pyStrip(pyStrAny(pyGet(entry, "note", "")))) {
      findings.push(`entry ${cid}: a one-line adjudication note is required`);
    }
    const expected = pyGet(entry, "expected_rules", null);
    if (!Array.isArray(expected)) {
      findings.push(`entry ${cid}: expected_rules must be a list`);
      return;
    }
    for (const rule of expected) {
      if (!INVALIDATION_RULES.includes(rule)) findings.push(`entry ${cid}: unknown expected rule ${pyRepr(rule)}`);
    }
    for (const rule of expected) if (typeof rule === "string") covered.add(rule);
    for (const key of ["expected_invalidated", "expected_change"]) {
      if (!hasKey(entry, key)) findings.push(`entry ${cid}: ${key} is required`);
    }
    const result = checkInvalidation(pyGet(entry, "run", {}));
    const computed = [...new Set(result.findings.map((finding) => finding.rule))].sort(pyCompareCodePoints);
    const wanted = expected.map(pyStrAny).sort(pyCompareCodePoints);
    if (wanted.length !== computed.length || wanted.some((rule, i) => rule !== computed[i])) {
      findings.push(`entry ${cid}: expected_rules ${pyRepr(wanted)} != check ${pyRepr(computed)}`);
    }
    if (pyBool(pyGet(entry, "expected_invalidated", null)) !== result.invalidated) {
      findings.push(`entry ${cid}: expected_invalidated ${pyRepr(pyGet(entry, "expected_invalidated", null))} != check ${pyRepr(result.invalidated)}`);
    }
    if (pyGet(entry, "expected_change", null) !== result.change_class) {
      findings.push(`entry ${cid}: expected_change ${pyRepr(pyGet(entry, "expected_change", null))} != check ${pyRepr(result.change_class)}`);
    }
  });
  for (const rule of INVALIDATION_RULES) {
    if (!covered.has(rule)) {
      findings.push(`rule ${pyRepr(rule)} has no entries (all 7 invalidation rules are required)`);
    }
  }
  return { findings, entries };
}

// --- edition_packaging (T10) ------------------------------------------------------

// Full runs everything; lite runs the safety net only (EDITION_LITE_OFF mirrors
// standardctl's frozen lite-off set).
export const EDITION_LITE_OFF = Object.freeze(["llm_review_strict", "extensions_catalog"]);
export const EDITION_LITE_REQUIRED = Object.freeze([
  "check_template_pairs", "check_harness_edition", "check_gate_aggregator", "check_gate_noop_stages",
]);
export const EDITION_LITE_FORBIDDEN = Object.freeze([
  "check_review_always_comments", "check_no_native_review_gating", "check_capability_registry",
]);

const nameSet = (value) => new Set(Array.isArray(value) ? value : []);

export function checkFullCompleteness(running, known) {
  const runningSet = nameSet(running);
  const knownList = Array.isArray(known) ? known : [];
  return knownList.filter((name) => !runningSet.has(name)).map((name) => (
    `full drops capability ${pyRepr(name)}: full packages everything, no silently dropped capability`));
}

export function checkLiteSafetyNet(running) {
  const runningSet = nameSet(running);
  const violations = [];
  for (const name of EDITION_LITE_REQUIRED) {
    if (!runningSet.has(name)) violations.push(`lite misses safety-net check ${pyRepr(name)}`);
  }
  for (const name of EDITION_LITE_FORBIDDEN) {
    if (runningSet.has(name)) {
      violations.push(`lite runs deep-evidence check ${pyRepr(name)}: R2/R3 extras do not run under lite`);
    }
  }
  return violations;
}

export function checkLiteOmitsReview(render) {
  if (!isObject(render)) return ["lite render must be a mapping"];
  const violations = [];
  for (const key of ["needs", "expected_jobs"]) {
    const value = pyGet(render, key, null);
    for (const job of pyIterate(pyBool(value) ? value : [])) {
      if (pyStrAny(job).includes("llm_review")) {
        violations.push(`lite render keeps ${pyRepr(job)} in ${key}: delete, never stub`);
      }
    }
  }
  const stubs = pyGet(render, "stubs", null);
  for (const stub of pyIterate(pyBool(stubs) ? stubs : [])) {
    violations.push(`lite render stubs ${pyRepr(stub)}: delete, never stub`);
  }
  return violations;
}

export function checkExplicitDeferral(deferrals) {
  if (!Array.isArray(deferrals)) return ["deferrals must be a list"];
  const violations = [];
  for (const item of deferrals) {
    if (!isObject(item)) {
      violations.push(`deferral must be a mapping: ${pyRepr(item)}`);
      continue;
    }
    if (!pyBool(pyGet(item, "capability", null))) violations.push("deferral names no capability");
    if (!pyBool(pyGet(item, "owner_approved", null))) {
      violations.push(`deferral of ${pyRepr(pyGet(item, "capability", "?"))} lacks owner approval: quiet omissions forbidden`);
    }
  }
  return violations;
}

export function checkVerifyReceipt(receipt) {
  if (!isObject(receipt)) return ["verify receipt must be a mapping"];
  const violations = [];
  for (const edition of ["full", "lite"]) {
    const leg = pyGet(receipt, edition, null);
    if (!isObject(leg)) {
      violations.push(`verify receipt missing ${pyRepr(edition)} leg`);
      continue;
    }
    if (pyGet(leg, "result", null) !== "pass") violations.push(`verify receipt ${pyRepr(edition)} leg is not green`);
    if (!pyBool(pyGet(leg, "head", null))) violations.push(`verify receipt ${pyRepr(edition)} leg names no head`);
  }
  const full = pyBool(pyGet(receipt, "full", null)) ? receipt.full : {};
  const lite = pyBool(pyGet(receipt, "lite", null)) ? receipt.lite : {};
  if (isObject(full) && isObject(lite) && pyBool(pyGet(full, "head", null))
      && pyBool(pyGet(lite, "head", null)) && pyGet(full, "head", null) !== pyGet(lite, "head", null)) {
    violations.push(`verify receipt head mismatch: full ${pyRepr(pyGet(full, "head", null))} != lite ${pyRepr(pyGet(lite, "head", null))}`);
  }
  if (pyGet(receipt, "gate", null) !== "pass") {
    violations.push("verify receipt needs the PR Gate green on the same SHA");
  }
  if (pyBool(pyGet(receipt, "head", null)) && isObject(full) && pyBool(pyGet(full, "head", null))
      && pyGet(receipt, "head", null) !== pyGet(full, "head", null)) {
    violations.push(`verify receipt head ${pyRepr(pyGet(receipt, "head", null))} != full-leg head ${pyRepr(pyGet(full, "head", null))}`);
  }
  return violations;
}

// A stale SHA is refused: tested != head by str() comparison, both named.
export function checkStaleShaRefusal(tested, head) {
  if (pyStrAny(tested) !== pyStrAny(head)) {
    return [`stale SHA refused: tested ${pyRepr(tested)} != head ${pyRepr(head)}`];
  }
  return [];
}

const EDITION_TARGETS = Object.freeze(["full", "lite", "review", "deferral", "receipt", "stale"]);

// The validator's dispatch: one entry's violations for its target surface.
export function editionViolations(target, record, known) {
  if (target === "full") return checkFullCompleteness(record, known === undefined ? [] : known);
  if (target === "lite") return checkLiteSafetyNet(record);
  if (target === "review") return checkLiteOmitsReview(record);
  if (target === "deferral") return checkExplicitDeferral(record);
  if (target === "receipt") return checkVerifyReceipt(record);
  return checkStaleShaRefusal((pyBool(record) ? record : {}).tested, (pyBool(record) ? record : {}).head);
}

export function validateEditionCorpus(corpus) {
  if (!isObject(corpus)) return { findings: ["edition corpus must be a mapping"], entries: [] };
  if (corpus._frozen !== true) {
    return { findings: ['edition corpus is not frozen: set "_frozen": true'], entries: [] };
  }
  const entries = pyGet(corpus, "entries", null);
  if (!Array.isArray(entries)) return { findings: ["edition corpus entries must be a list"], entries: [] };
  const findings = [];
  for (const entry of entries) {
    if (!isObject(entry)) {
      findings.push(`corpus entry is not a mapping: ${pyRepr(entry)}`);
      continue;
    }
    const entryId = pyStrAny(pyGet(entry, "id", "?"));
    const target = pyGet(entry, "target", null);
    const expected = pyGet(entry, "expected_violation_fragment", "");
    if (!EDITION_TARGETS.includes(target)) {
      findings.push(`entry ${entryId} has unknown target ${pyRepr(target)}`);
      continue;
    }
    const violations = editionViolations(target, pyGet(entry, "record", null), pyGet(entry, "known", []));
    if (pyBool(expected)) {
      if (!violations.some((violation) => violation.includes(expected))) {
        findings.push(`entry ${entryId}: expected fragment ${pyRepr(expected)} not reproduced (got ${pyRepr(violations)})`);
      }
    } else if (violations.length > 0) {
      findings.push(`entry ${entryId}: expected clean, got ${pyRepr(violations)}`);
    }
  }
  return { findings, entries };
}
