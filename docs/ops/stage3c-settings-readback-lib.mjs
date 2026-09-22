// docs/ops/stage3c-settings-readback-lib.mjs
//
// Stage 3c (#387): shared predicate + live-API adapter for the
// owner-approved squash-only, exact-head, one-Gate policy.
//
// The offline characterization tests and the live read-back script both
// import this module, so the mapping from a real GitHub ruleset response to
// the approved-policy snapshot is proven in CI by the tests and reused
// verbatim by the script. No network access happens here.

export const APPROVED = {
  mergeMethods: ["squash"],
  requiredContext: "PR Gate",
  requiredApprovals: 0,
  ownerBypassId: 64936641,
  gateName: "PR Gate",
};

// Pure predicate: returns the list of drifted policies for a snapshot.
export function drift(snapshot) {
  const findings = [];
  if (JSON.stringify([...snapshot.mergeMethods].sort()) !== JSON.stringify(APPROVED.mergeMethods))
    findings.push("wrong-merge-mode");
  if (!snapshot.contexts.includes(APPROVED.requiredContext))
    findings.push("stale-required-context");
  if (snapshot.contexts.some((c) => c !== APPROVED.requiredContext && !c.startsWith("PR Gate")))
    findings.push("wrong-required-context");
  if (!snapshot.strict) findings.push("non-strict-protection");
  if (snapshot.approvals !== APPROVED.requiredApprovals) findings.push("native-approval-drift");
  if (snapshot.allowForce || snapshot.allowDelete) findings.push("force-delete-exposure");
  if (!snapshot.bypass.includes(APPROVED.ownerBypassId)) findings.push("missing-owner-bypass");
  if (snapshot.gateName !== APPROVED.gateName) findings.push("gate-renamed");
  return findings;
}

export function clean() {
  return {
    mergeMethods: ["squash"], contexts: ["PR Gate"], strict: true,
    approvals: 0, allowForce: false, allowDelete: false,
    bypass: [64936641], gateName: "PR Gate",
  };
}

// Map the response of GET /repos/{owner}/{repo}/rulesets/{id} into the
// snapshot shape the predicate consumes. Defaults fail closed: an absent
// protective rule reads as exposure, never as protection.
export function snapshotFromRuleset(ruleset) {
  const byType = Object.fromEntries((ruleset.rules ?? []).map((r) => [r.type, r]));
  const pull = byType.pull_request?.parameters ?? {};
  const status = byType.required_status_checks?.parameters ?? {};
  const contexts = (status.required_status_checks ?? []).map((c) => c.context);
  return {
    mergeMethods: pull.allowed_merge_methods ?? [],
    contexts,
    strict: status.strict_required_status_checks_policy === true,
    approvals: pull.required_approving_review_count ?? -1,
    allowForce: !byType.non_fast_forward,
    allowDelete: !byType.deletion,
    bypass: (ruleset.bypass_actors ?? []).map((a) => a.actor_id),
    gateName: contexts.length === 1 ? contexts[0] : "(none)",
  };
}
