/**
 * Turns whatever the model actually emitted into a `ReviewVerdict`.
 *
 * The asymmetry here is the point, and it is deliberate:
 *
 * - A model that produces GARBAGE must not block. A confused, truncated, or
 *   schema-violating answer says nothing about the pull request; failing the
 *   gate on it would train everyone to re-run the job until the model has a
 *   good day, which destroys the gate's meaning. So malformed output returns a
 *   non-blocking verdict that says so in `summary`, and never throws.
 * - A model that produces an UNSUPPORTED finding must not block either. A
 *   blocking objection with no quoted evidence or no citation is an assertion
 *   of authority, not a review. Those move to `discarded` where a human can
 *   still read them.
 * - The verdict is recomputed here, never trusted from the model. A model that
 *   says `verdict: "pass"` while listing a fully-evidenced blocking finding is
 *   contradicting itself, and the findings are the checkable half.
 *
 * Infrastructure failures are the opposite case and are NOT handled here --
 * they throw out of review.ts so the gate fails closed. See that file.
 */

import type { Finding, ReviewVerdict, Severity } from "./types.ts";

/** Summary used when the model's answer could not be parsed at all. */
export const MALFORMED_SUMMARY_PREFIX = "Review inconclusive: the model's answer did not match the submit_review schema";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function severityOf(value: unknown): Severity {
  // Anything that is not literally "blocking" is treated as advisory. Failing
  // open on an unrecognized severity is correct: an unknown token must not be
  // promoted into the one value that fails a pull request.
  return value === "blocking" ? "blocking" : "advisory";
}

/**
 * A finding is VALID only with a non-empty `claim`, `evidence`, `citation`, and
 * `requestedChange`. `evidence` and `citation` are the two the standard's
 * "Intent and behavioral claims" section actually turns on; `claim` and
 * `requestedChange` are required because a finding without either is not
 * actionable and cannot be checked.
 */
function toFinding(raw: unknown): { finding: Finding; valid: boolean } | null {
  if (!isRecord(raw)) {
    return null;
  }
  const claim = nonEmptyString(raw.claim);
  const evidence = nonEmptyString(raw.evidence);
  const citation = nonEmptyString(raw.citation);
  const requestedChange = nonEmptyString(raw.requestedChange);

  const finding: Finding = {
    severity: severityOf(raw.severity),
    category: nonEmptyString(raw.category) ?? "unspecified",
    claim: claim ?? "",
    evidence: evidence ?? "",
    requestedChange: requestedChange ?? "",
    citation: citation ?? "",
  };
  const file = optionalString(raw.file);
  if (file !== undefined) {
    finding.file = file;
  }
  const line = optionalLine(raw.line);
  if (line !== undefined) {
    finding.line = line;
  }
  // Only a literal `true` counts. Anything else -- absent, false, a string,
  // a typo -- leaves the finding subject to the ordinary blocking rule, the
  // same fail-safe-toward-blocking posture severityOf() takes on an unknown
  // token: a field this consequential must never be promoted by accident.
  if (raw.outOfScope === true) {
    finding.outOfScope = true;
  }
  // Same fail-safe posture as outOfScope: a malformed or absent proposal
  // (not a record, or missing a non-empty title/body) is simply dropped --
  // it never promotes a finding into something the dialogue workflow would
  // act on. `confirmed` only carries through as `true` when literally `true`,
  // for the same reason severityOf() and the outOfScope check above only
  // ever honor an exact match: a field this consequential (it can eventually
  // cause a real GitHub Issue to be filed) must never be promoted by a typo
  // or an unexpected type.
  if (isRecord(raw.proposedBlockingIssue)) {
    const title = nonEmptyString(raw.proposedBlockingIssue.title);
    const body = nonEmptyString(raw.proposedBlockingIssue.body);
    if (title !== null && body !== null) {
      finding.proposedBlockingIssue = {
        title,
        body,
        ...(raw.proposedBlockingIssue.confirmed === true ? { confirmed: true } : {}),
      };
    }
  }

  // Same fail-safe posture again for suggestedFix (Issue #326): a malformed
  // suggestion (not a record, a missing/empty `file` or `originalLines`, or a
  // non-string `replacement`) is dropped rather than repaired -- the dialogue
  // workflow renders whatever arrives here into a real, line-anchored GitHub
  // suggestion a human can apply with one click, so a field this consequential
  // must never be promoted by a typo or an unexpected type. `replacement`
  // alone may be the empty string: an empty replacement proposes deleting the
  // quoted lines, which GitHub's suggestion UI supports directly.
  if (isRecord(raw.suggestedFix)) {
    const file = nonEmptyString(raw.suggestedFix.file);
    const originalLines = nonEmptyString(raw.suggestedFix.originalLines);
    if (file !== null && originalLines !== null && typeof raw.suggestedFix.replacement === "string") {
      finding.suggestedFix = { file, originalLines, replacement: raw.suggestedFix.replacement };
    }
  }

  // Same fail-safe posture again for deliberation (Issue #325): only an
  // exact-match position token and non-empty reasoning carry through --
  // anything else (an unknown or wrong-case token, whitespace reasoning, not
  // a record) is dropped rather than repaired. Dropping fails OPEN here: on
  // a re-review round validateVerdict treats a blocking finding without a
  // deliberation as resolved by default, so a malformed one can never
  // sustain a block on a technicality, and never fail one into existence.
  if (isRecord(raw.deliberation)) {
    const position = raw.deliberation.position;
    const engagesLatestEvidence = nonEmptyString(raw.deliberation.engagesLatestEvidence);
    if ((position === "agree" || position === "disagree" || position === "other") && engagesLatestEvidence !== null) {
      finding.deliberation = { position, engagesLatestEvidence };
    }
  }

  const valid = claim !== null && evidence !== null && citation !== null && requestedChange !== null;
  return { finding, valid };
}

function malformed(reason: string): ReviewVerdict {
  return {
    verdict: "pass",
    findings: [],
    discarded: [],
    summary: `${MALFORMED_SUMMARY_PREFIX} (${reason}). Nothing was blocked on this basis -- a model that cannot answer has not found a defect. Re-run, or review by hand.`,
  };
}

/**
 * Validate the model's `submit_review` tool input into a `ReviewVerdict`.
 *
 * Blocking rule: the result blocks if and only if at least one VALID finding
 * has `severity === "blocking"`. Discarded findings never block.
 *
 * `priorDialogue` (Issue #325) says whether this run is a re-review round --
 * the PR conversation the reviewer was shown was non-empty. The caller
 * (review.ts) derives it from the same context the model itself saw, so the
 * validator and the prompt's own SCOPE LOCK round test can never disagree
 * about which round this is.
 */
export function validateVerdict(raw: unknown, options: { priorDialogue?: boolean } = {}): ReviewVerdict {
  if (!isRecord(raw)) {
    return malformed("tool input was not an object");
  }
  if (!Array.isArray(raw.findings)) {
    return malformed("`findings` was missing or not an array");
  }

  const findings: Finding[] = [];
  const discarded: Finding[] = [];
  for (const entry of raw.findings) {
    const parsed = toFinding(entry);
    if (parsed === null) {
      continue;
    }
    (parsed.valid ? findings : discarded).push(parsed.finding);
  }

  // Resolution-by-citation (Issue #325). On a re-review round, a continued
  // block must engage the dev side's latest evidence with new
  // citation-grounded reasoning -- the `deliberation` field the prompt and
  // schema require there. A blocking finding without one resolves by
  // default: demoted to advisory (the same fail-open direction severityOf()
  // takes on an unknown token -- never promoted into the one value that
  // fails a pull request) and marked `resolvedByDefault` so the dialogue
  // workflow can say why it no longer blocks. This is the mechanical half of
  // Issue #281's default-to-resolve posture: a reviewer re-asserting its
  // originally-suggested fix without engaging the dev's alternate has not
  // grounded a continued block, and a malformed answer must fail open, never
  // stall a pull request. An outOfScope finding is skipped -- it is already
  // excused by an agreed deferral, and demoting it would corrupt the
  // deferred-Issue path's view of it. First-round behavior is untouched:
  // without prior dialogue there is nothing yet to engage, and blocking
  // findings block exactly as before.
  let resolvedByDefaultCount = 0;
  if (options.priorDialogue === true) {
    for (const finding of findings) {
      if (finding.severity === "blocking" && finding.outOfScope !== true && finding.deliberation === undefined) {
        finding.severity = "advisory";
        finding.resolvedByDefault = true;
        resolvedByDefaultCount += 1;
      }
    }
  }

  // outOfScope excuses a finding from the block decision without touching its
  // severity or dropping it from `findings` -- see the field's doc comment in
  // types.ts. It is reachable only through the dialogue deliberation this
  // package's caller drives; validate.ts just has to honor it once set.
  const blocking = findings.filter((finding) => finding.severity === "blocking" && finding.outOfScope !== true);
  const verdict: ReviewVerdict["verdict"] = blocking.length > 0 ? "block" : "pass";

  const modelSummary = nonEmptyString(raw.summary);
  const summaryParts: string[] = [];
  if (modelSummary !== null) {
    summaryParts.push(modelSummary);
  } else {
    summaryParts.push("The model returned no summary.");
  }
  if (discarded.length > 0) {
    summaryParts.push(
      `${discarded.length} finding(s) were discarded for missing evidence, citation, claim, or requested change, and did not affect the verdict.`
    );
  }
  if (resolvedByDefaultCount > 0) {
    summaryParts.push(
      `${resolvedByDefaultCount} blocking finding(s) were resolved by default: on a re-review round, a continued block must carry a deliberation engaging the dev side's latest evidence with new citation-grounded reasoning, and these carried none. They are reported as advisory.`
    );
  }

  return { verdict, findings, discarded, summary: summaryParts.join(" ") };
}
