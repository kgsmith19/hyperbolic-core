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
 */
export function validateVerdict(raw: unknown): ReviewVerdict {
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

  return { verdict, findings, discarded, summary: summaryParts.join(" ") };
}
