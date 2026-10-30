// docs/ops/stage61b-release-proofbed-lib.mjs
//
// Stage 61b (#390): the single-sourced mapping from the frozen Stage 61a
// Release Mold contract to hyperbolic-core's live runtime mechanisms, plus
// the honest disclosure of the mechanisms that do not exist yet.
//
// The offline proofbed test imports this module, so the mapping is proven in
// CI by the tests and reused verbatim by any live read-back. No network
// access happens here.
//
// The contract constants below are transcribed byte-stable from
// agent-engineering-standard tools/release_mold.py @ 8b7847d (the merge of
// Stage 61a #266). The Standard is not vendored into this repo, so — exactly
// as stage59b-review-adoption-lib.mjs did for the frozen 59a RULES tuple —
// the constants are transcribed here with this provenance note, and the test
// pins their frozen shape (count, order, verdicts) so a drift is caught.

// Frozen release verdicts (release_mold.py VERDICTS).
export const FROZEN_VERDICTS = ["PROMOTE", "HOLD", "REFUSE"];

// Frozen release claim IDs (release_mold.py CLAIMS).
export const FROZEN_CLAIMS = [
  "integrated-behavior",
  "deployment-proof",
  "rollback-proof",
  "restore-proof",
  "provenance-proof",
  "runtime-proof",
  "canary-proof",
];

// Frozen release rules, in check order — first hit decides (release_mold.py RULES).
export const FROZEN_RULES = [
  "open-issues",
  "stale-artifact",
  "broken-integration",
  "failed-rollback",
  "unusable-backup",
  "missing-attestation",
  "invariant-breach",
  "missing-telemetry",
  "partial-green",
  "expired-evidence",
  "restore-rpo",
  "mold-unqualified",
  "canary-missing",
  "clean-promote",
];

// The verdict each rule carries (release_mold.py RULE_VERDICTS).
export const RULE_VERDICTS = {
  "open-issues": "REFUSE",
  "stale-artifact": "REFUSE",
  "broken-integration": "REFUSE",
  "failed-rollback": "REFUSE",
  "unusable-backup": "REFUSE",
  "missing-attestation": "REFUSE",
  "invariant-breach": "REFUSE",
  "missing-telemetry": "REFUSE",
  "partial-green": "REFUSE",
  "expired-evidence": "REFUSE",
  "restore-rpo": "PROMOTE",
  "mold-unqualified": "HOLD",
  "canary-missing": "HOLD",
  "clean-promote": "PROMOTE",
};

// The gap Issues for mechanisms hyperbolic-core does not have. Any `gap` in
// ADOPTION must be one of these. #405-#408 had closed every gap against the
// cloud deploy pipeline; the owner's local-only decision (2026-10-29) removed
// that pipeline (#503), so its rules are gaps again until the local release
// proof lands (#504, Phase 1d).
export const GAP_ISSUES = ["#504"];

// One hyperbolic-core mechanism per frozen 61a rule. Each entry names EXACTLY
// ONE of:
//   - `path`: a real mechanism on disk that satisfies the rule (the test
//     enforces every listed file exists), or
//   - `gap`:  a #NNN tracking Issue for a mechanism that does not exist yet
//     (the test enforces the mechanism is genuinely absent).
// `note` states the observable behavior (or, for a gap, what is missing and
// where it is tracked). Where the runtime deliberately has no counterpart
// yet, the entry is a gap — never a silent claim of a proof that is not there.
export const ADOPTION = {
  "open-issues": {
    path: ".github/workflows/pr-verify.yml",
    note: "PR Gate fails closed when an Issue the PR closes is still open with an unchecked checklist item (parseLinkedIssues/checklistBlocked, Issue #274): incomplete work cannot merge, let alone release.",
  },
  "stale-artifact": {
    gap: "#504",
    note: "no local release yet binds a promoted artifact to the exact built SHA; the cloud deploy pipeline that proved this was removed by the owner's local-only decision (#503); the local release proof is tracked by #504.",
  },
  "broken-integration": {
    gap: "#504",
    note: "no local post-start smoke verdict exists yet; the cloud deploy pipeline that proved this was removed by the owner's local-only decision (#503); the local release proof is tracked by #504.",
  },
  "failed-rollback": {
    gap: "#504",
    note: "no local release rollback exists yet; the cloud deploy pipeline that proved this was removed by the owner's local-only decision (#503); the local release proof is tracked by #504.",
  },
  "unusable-backup": {
    gap: "#504",
    note: "no local restore drill exists yet; the cloud deploy pipeline that proved this was removed by the owner's local-only decision (#503); the local release proof is tracked by #504.",
  },
  "missing-attestation": {
    gap: "#504",
    note: "no local build manifest is attested yet; the cloud deploy pipeline that proved this was removed by the owner's local-only decision (#503); the local release proof is tracked by #504.",
  },
  "invariant-breach": {
    gap: "#504",
    note: "no local invariant observation exists yet; the cloud deploy pipeline that proved this was removed by the owner's local-only decision (#503); the local release proof is tracked by #504.",
  },
  "missing-telemetry": {
    gap: "#504",
    note: "no local telemetry series exists to fail closed on; the cloud deploy pipeline that proved this was removed by the owner's local-only decision (#503); the local release proof is tracked by #504.",
  },
  "partial-green": {
    path: ".github/workflows/pr-verify.yml",
    note: "PR Gate's verdict comes from its own needs.*.result — anything not exactly success (including skipped/cancelled) fails it — and tag-release requires the run's overall smoke success, not one unit's own deploy success. Partial green never promotes.",
  },
  "expired-evidence": {
    path: ".github/workflows/pr-verify.yml",
    note: "verification evidence binds to the exact head (expectedHeadOid arming, Stage 60b #389; llm-review-recheck re-runs a moved head); a stale verdict is never trusted. Canary-window freshness specifically arrives with #406/#407.",
  },
  "restore-rpo": {
    gap: "#504",
    note: "no local drill measures RPO/RTO yet; the cloud deploy pipeline that proved this was removed by the owner's local-only decision (#503); the local release proof is tracked by #504.",
  },
  "mold-unqualified": {
    path: "docs/ops/stage61b-release-proofbed.test.mjs",
    note: "hyperbolic-core's Release Mold is built/attacked/qualified by this proofbed itself: the frozen 61a contract transcribed with provenance, behavioral pins against the real topology, and targeted-mutation RED sensitivity recorded in the PR.",
  },
  "canary-missing": {
    gap: "#504",
    note: "no local release declares a canary yet; the cloud deploy pipeline that proved this was removed by the owner's local-only decision (#503); the local release proof is tracked by #504.",
  },
  "clean-promote": {
    path: "docs/ops/stage61b-release-proofbed-lib.mjs",
    note: "unreachable while the #504 gaps are open: the first gap in check order (stale-artifact) REFUSEs, so no release can claim clean-promote until the local release proof lands.",
  },
};

// The gap rules mapped to their tracking Issues, in nothing but plain data —
// the honest inventory of what hyperbolic-core cannot prove yet.
export function gapsOf(adoption) {
  const gaps = {};
  for (const [rule, entry] of Object.entries(adoption)) {
    if (entry.gap) gaps[rule] = entry.gap;
  }
  return gaps;
}

// The first rule, in frozen check order, whose hyperbolic-core mechanism is a
// gap. That rule's verdict is the honest current release posture: the Mold
// stops at the first unmet proof, so this is the verdict a real hyperbolic
// release gets today. Returns null only if every rule has a real mechanism.
export function earliestGap(adoption, rules) {
  for (const rule of rules) {
    if (adoption[rule] && adoption[rule].gap) return rule;
  }
  return null;
}
