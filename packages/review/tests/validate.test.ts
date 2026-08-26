import { test } from "node:test";
import assert from "node:assert/strict";
import { MALFORMED_SUMMARY_PREFIX, validateVerdict } from "../src/validate.ts";

function wellFormedFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "blocking",
    category: "test-quality",
    file: "src/pricing.ts",
    line: 42,
    claim: "applyDiscount is never exercised with a discount above 100%.",
    evidence: "assert.equal(applyDiscount(100, 0.1), 90);",
    requestedChange: "Add a case asserting the clamp at 100% and above.",
    citation: "AGENTS.md > Test quality",
    ...overrides,
  };
}

// Behavior protected: an objection with no quoted evidence cannot count.
// Defect caught: a validator that checks only for the property's presence, or
// accepts an empty string. Either would let "this looks fragile" -- an
// assertion of authority with nothing behind it -- fail a pull request.
test("validateVerdict: a finding with no evidence is discarded, not kept", () => {
  const result = validateVerdict({
    verdict: "block",
    summary: "One objection.",
    findings: [wellFormedFinding({ evidence: "" })],
  });

  assert.equal(result.findings.length, 0);
  assert.equal(result.discarded.length, 1);
  assert.equal(result.discarded[0]?.claim, wellFormedFinding().claim);
});

// Same rule for the other half of the evidence contract. Defect caught:
// validating `evidence` but forgetting `citation`, which would allow a finding
// that quotes real code but invents the rule it supposedly violates -- the
// most persuasive and most dangerous kind of hallucinated objection.
test("validateVerdict: a finding with no citation is discarded, not kept", () => {
  const result = validateVerdict({
    verdict: "block",
    summary: "One objection.",
    findings: [wellFormedFinding({ citation: "   " })],
  });

  assert.equal(result.findings.length, 0);
  assert.equal(result.discarded.length, 1);
});

// Positive control for the two tests above: the validator must not discard
// everything. A validator that rejected all input would satisfy both discard
// tests while making the gate incapable of ever reporting a finding.
test("validateVerdict: a fully-formed finding is kept, with its fields intact", () => {
  const result = validateVerdict({
    verdict: "block",
    summary: "One objection.",
    findings: [wellFormedFinding()],
  });

  assert.equal(result.discarded.length, 0);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding?.severity, "blocking");
  assert.equal(finding?.category, "test-quality");
  assert.equal(finding?.file, "src/pricing.ts");
  assert.equal(finding?.line, 42);
  assert.equal(finding?.evidence, "assert.equal(applyDiscount(100, 0.1), 90);");
  assert.equal(finding?.citation, "AGENTS.md > Test quality");
});

// NEGATIVE CONTROL. Behavior protected: an unsupported blocking finding cannot
// fail a pull request, even when the model insists the verdict is "block".
// Defect caught: trusting the model's own `verdict` field, or counting
// discarded findings toward the block decision. Either would let a model that
// produced nothing checkable stop a merge -- and a gate that can be tripped by
// an empty assertion trains everyone to ignore it.
test("validateVerdict: an uncited blocking finding produces a NON-blocking verdict", () => {
  const result = validateVerdict({
    verdict: "block",
    summary: "I am confident this is wrong.",
    findings: [wellFormedFinding({ severity: "blocking", evidence: "", citation: "" })],
  });

  assert.equal(result.verdict, "pass");
  assert.equal(result.findings.length, 0);
  assert.equal(result.discarded.length, 1);
  assert.match(result.summary, /discarded/);
});

// POSITIVE CONTROL for the gate as a whole. Behavior protected: a valid
// blocking finding really does block. Defect caught: any change that makes the
// gate structurally incapable of failing -- a verdict hardcoded to "pass", a
// severity comparison that never matches, an over-eager discard rule. Without
// this test the four above are all satisfiable by `verdict: "pass"` forever,
// and the suite would be exactly the empty-green this package is built to
// reject.
test("validateVerdict: one valid blocking finding blocks", () => {
  const result = validateVerdict({
    verdict: "pass", // deliberately contradicts the finding: the model is not trusted
    summary: "Looks fine to me.",
    findings: [wellFormedFinding({ severity: "blocking" })],
  });

  assert.equal(result.verdict, "block");
  assert.equal(result.findings.length, 1);
});

// Behavior protected: advisory findings are reported without failing the gate.
// Defect caught: treating any finding as blocking, which would make the
// advisory tier meaningless and every nit a merge stopper.
test("validateVerdict: a valid advisory-only finding does not block", () => {
  const result = validateVerdict({
    verdict: "block",
    summary: "A nit.",
    findings: [wellFormedFinding({ severity: "advisory" })],
  });

  assert.equal(result.verdict, "pass");
  assert.equal(result.findings.length, 1);
});

// Behavior protected: an unrecognized severity token fails open to advisory.
// Defect caught: a model emitting "critical" or "BLOCKING" being coerced into
// the one value that fails a pull request. Only the exact contract value blocks.
test("validateVerdict: an unrecognized severity is treated as advisory, not blocking", () => {
  const result = validateVerdict({
    verdict: "block",
    summary: "Severity invented by the model.",
    findings: [wellFormedFinding({ severity: "critical" })],
  });

  assert.equal(result.verdict, "pass");
  assert.equal(result.findings[0]?.severity, "advisory");
});

// Behavior protected: a blocking finding the model marks outOfScope: true does
// not block, but is still reported (never silently dropped).
// Defect caught: forgetting to exclude outOfScope findings from the blocking
// filter, which would make the whole deferred-to-an-Issue path a no-op; or
// dropping the finding from `findings` entirely, which would make the
// dialogue workflow unable to render or file an Issue for it.
test("validateVerdict: a blocking finding marked outOfScope does not block, and is kept", () => {
  const result = validateVerdict({
    verdict: "block",
    summary: "Reviewer and dev agreed this is out of scope.",
    findings: [wellFormedFinding({ severity: "blocking", outOfScope: true })],
  });

  assert.equal(result.verdict, "pass");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.severity, "blocking");
  assert.equal(result.findings[0]?.outOfScope, true);
});

// NEGATIVE CONTROL for the field's trust posture. Behavior protected: only a
// literal boolean `true` can excuse a finding from blocking. Defect caught: a
// looser check (truthy string, any non-undefined value) that a model could
// trip accidentally -- e.g. emitting outOfScope: "false" as a string -- and
// have it wrongly excuse a real blocking finding.
test("validateVerdict: outOfScope is only honored as a literal boolean true", () => {
  for (const value of ["true", "false", 1, 0, null]) {
    const result = validateVerdict({
      verdict: "block",
      summary: "Non-boolean outOfScope must not excuse this finding.",
      findings: [wellFormedFinding({ severity: "blocking", outOfScope: value })],
    });
    assert.equal(result.verdict, "block", `outOfScope: ${JSON.stringify(value)} must not excuse a blocking finding`);
    assert.equal(result.findings[0]?.outOfScope, undefined);
  }
});

// Behavior protected: outOfScope is invisible on a normal finding -- it must
// not appear as `false` by default, keeping the field's absence and its
// explicit-false meaning identical (both "not excused").
// Defect caught: a validator that always sets outOfScope: false, which would
// make a later "was this explicitly considered and rejected?" distinction
// (not needed today, but the field's own doc comment leaves room for it)
// impossible to add without a breaking change.
test("validateVerdict: outOfScope is omitted, not defaulted to false, on an ordinary finding", () => {
  const result = validateVerdict({
    verdict: "block",
    summary: "Ordinary finding, no dialogue involved.",
    findings: [wellFormedFinding({ severity: "blocking" })],
  });

  assert.equal(result.verdict, "block");
  assert.equal("outOfScope" in (result.findings[0] ?? {}), false);
});

// Behavior protected: proposedBlockingIssue is additive data only -- it must
// never change the block/pass verdict by itself, since only the dialogue
// workflow (not this package) may act on `confirmed` by actually filing an
// Issue. Defect caught: a validator that treats a confirmed proposal as
// equivalent to a blocking finding, which would let this field silently
// start failing pull requests the schema's own description says it cannot.
test("validateVerdict: proposedBlockingIssue never affects the verdict by itself, confirmed or not", () => {
  for (const confirmed of [undefined, false, true]) {
    const result = validateVerdict({
      verdict: "pass",
      summary: "Advisory finding with a proposed blocking Issue.",
      findings: [
        wellFormedFinding({
          severity: "advisory",
          proposedBlockingIssue: { title: "Track the broader refactor", body: "Too large for this PR.", confirmed },
        }),
      ],
    });
    assert.equal(result.verdict, "pass");
  }
});

// Behavior protected: a well-formed proposal survives with its title, body,
// and confirmed flag intact -- the dialogue workflow needs all three to
// decide whether to file the Issue and what to file.
// Defect caught: dropping the field entirely, or losing `confirmed` (which
// would make a real dev-side affirmation invisible to the caller).
test("validateVerdict: a well-formed proposedBlockingIssue is kept intact, including confirmed", () => {
  const result = validateVerdict({
    verdict: "pass",
    summary: "One proposal, confirmed on this round.",
    findings: [
      wellFormedFinding({
        severity: "advisory",
        proposedBlockingIssue: { title: "Track it", body: "Real, but not this PR.", confirmed: true },
      }),
    ],
  });

  assert.deepEqual(result.findings[0]?.proposedBlockingIssue, {
    title: "Track it",
    body: "Real, but not this PR.",
    confirmed: true,
  });
});

// Behavior protected: an unconfirmed proposal is kept without a `confirmed`
// key at all -- absence and explicit-false must read the same way `outOfScope`
// already does, so a later "was this explicitly considered?" distinction stays
// possible without a breaking change.
test("validateVerdict: proposedBlockingIssue.confirmed is omitted, not defaulted to false", () => {
  const result = validateVerdict({
    verdict: "pass",
    summary: "One proposal, not yet confirmed.",
    findings: [
      wellFormedFinding({
        severity: "advisory",
        proposedBlockingIssue: { title: "Track it", body: "Real, but not this PR." },
      }),
    ],
  });

  assert.equal(result.findings[0]?.proposedBlockingIssue?.title, "Track it");
  assert.equal("confirmed" in (result.findings[0]?.proposedBlockingIssue ?? {}), false);
});

// NEGATIVE CONTROL: a malformed proposal (missing title/body, or not an
// object at all) must be dropped silently, exactly like a malformed
// outOfScope value -- never promoted into something the dialogue workflow
// would act on, and never a reason to discard the whole finding.
test("validateVerdict: a malformed proposedBlockingIssue is dropped, and the finding is still kept", () => {
  for (const malformed of [
    { title: "", body: "Real, but not this PR." },
    { title: "Track it", body: "" },
    { title: "Track it" },
    "not an object",
    42,
    null,
  ]) {
    const result = validateVerdict({
      verdict: "pass",
      summary: "Malformed proposal must not survive.",
      findings: [wellFormedFinding({ severity: "advisory", proposedBlockingIssue: malformed })],
    });
    assert.equal(result.findings.length, 1, `finding itself must survive a malformed proposal: ${JSON.stringify(malformed)}`);
    assert.equal(
      "proposedBlockingIssue" in (result.findings[0] ?? {}),
      false,
      `malformed proposal must not survive: ${JSON.stringify(malformed)}`
    );
  }
});

// NEGATIVE CONTROL for confirmed's trust posture, mirroring outOfScope's own:
// only a literal boolean `true` counts.
test("validateVerdict: proposedBlockingIssue.confirmed is only honored as a literal boolean true", () => {
  for (const value of ["true", 1, 0, null]) {
    const result = validateVerdict({
      verdict: "pass",
      summary: "Non-boolean confirmed must not carry through.",
      findings: [
        wellFormedFinding({
          severity: "advisory",
          proposedBlockingIssue: { title: "Track it", body: "Real, but not this PR.", confirmed: value },
        }),
      ],
    });
    assert.equal(
      "confirmed" in (result.findings[0]?.proposedBlockingIssue ?? {}),
      false,
      `confirmed: ${JSON.stringify(value)} must not carry through`
    );
  }
});

// Behavior protected: unparseable model output never throws and never blocks.
// Defect caught: letting a JSON/shape error escape, which would be caught by
// the CLI's infrastructure handler and reported as exit 2 -- turning "the model
// had a bad day" into "the gate is broken", the failure mode most likely to
// get the whole check disabled.
test("validateVerdict: malformed tool input returns a flagged, non-blocking verdict", () => {
  for (const malformed of [null, "not an object", 42, [], { verdict: "block" }, { findings: "nope" }]) {
    const result = validateVerdict(malformed);
    assert.equal(result.verdict, "pass", `malformed input ${JSON.stringify(malformed)} must not block`);
    assert.equal(result.findings.length, 0);
    assert.ok(
      result.summary.startsWith(MALFORMED_SUMMARY_PREFIX),
      `malformed input ${JSON.stringify(malformed)} must be flagged in the summary, got: ${result.summary}`
    );
  }
});

// ---------------------------------------------------------------------------
// suggestedFix (Issue #326) -- an optional, concrete replacement the dialogue
// workflow renders as a GitHub-native suggestion block. Additive data only,
// mirroring proposedBlockingIssue's fail-safe posture: malformed input is
// dropped, never repaired, and the field never touches the verdict.
// ---------------------------------------------------------------------------

// Behavior protected: a well-formed suggestion survives validation intact --
// the dialogue workflow anchors on `originalLines` and posts `replacement`
// verbatim, so any silent mutation here would corrupt an applyable fix.
test("validateVerdict: a well-formed suggestedFix is kept intact on the finding", () => {
  const result = validateVerdict({
    verdict: "pass",
    summary: "One mechanical fix.",
    findings: [
      wellFormedFinding({
        severity: "advisory",
        suggestedFix: {
          file: "src/pricing.ts",
          originalLines: "if (discount > 100) {",
          replacement: "if (discount >= 100) {",
        },
      }),
    ],
  });

  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]?.suggestedFix, {
    file: "src/pricing.ts",
    originalLines: "if (discount > 100) {",
    replacement: "if (discount >= 100) {",
  });
});

// Behavior protected: an empty replacement is a DELETION, which GitHub's
// suggestion UI supports directly -- it must not be dropped as malformed.
// Defect caught: validating replacement with the same non-empty rule as
// file/originalLines, which would silently forbid deletion suggestions.
test("validateVerdict: a suggestedFix with an empty replacement is kept -- an empty replacement proposes a deletion", () => {
  const result = validateVerdict({
    verdict: "pass",
    summary: "Delete a dead line.",
    findings: [
      wellFormedFinding({
        severity: "advisory",
        suggestedFix: { file: "src/pricing.ts", originalLines: "const unused = 1;", replacement: "" },
      }),
    ],
  });

  assert.equal(result.findings[0]?.suggestedFix?.replacement, "");
});

// Fail-safe posture, same as proposedBlockingIssue: a malformed suggestion is
// dropped while the finding itself is kept. Defect caught: a validator that
// discards the whole finding over its optional field, or one that carries a
// malformed suggestion through to the workflow that renders it into an
// applyable review comment.
test("validateVerdict: a malformed suggestedFix is dropped, and the finding is still kept", () => {
  const malformedSuggestions = [
    "use >= instead", // not a record
    { originalLines: "x", replacement: "y" }, // no file
    { file: "", originalLines: "x", replacement: "y" }, // empty file
    { file: "a.ts", originalLines: "   ", replacement: "y" }, // blank anchor
    { file: "a.ts", originalLines: "x" }, // replacement missing entirely
    { file: "a.ts", originalLines: "x", replacement: 42 }, // wrong type
  ];

  for (const malformed of malformedSuggestions) {
    const result = validateVerdict({
      verdict: "pass",
      summary: "One finding with a broken suggestion.",
      findings: [wellFormedFinding({ severity: "advisory", suggestedFix: malformed })],
    });

    assert.equal(result.findings.length, 1, `finding must survive suggestedFix=${JSON.stringify(malformed)}`);
    assert.equal(
      "suggestedFix" in (result.findings[0] ?? {}),
      false,
      `malformed suggestedFix must be dropped: ${JSON.stringify(malformed)}`
    );
  }
});

// NEGATIVE CONTROL. Behavior protected: suggestedFix is rendering data only.
// Defect caught: any wiring that lets a suggestion's presence or absence leak
// into the blocking decision in either direction.
test("validateVerdict: suggestedFix never affects the verdict", () => {
  const suggestion = { file: "a.ts", originalLines: "x", replacement: "y" };

  const advisory = validateVerdict({
    verdict: "block",
    summary: "Advisory with a fix.",
    findings: [wellFormedFinding({ severity: "advisory", suggestedFix: suggestion })],
  });
  assert.equal(advisory.verdict, "pass");

  const blocking = validateVerdict({
    verdict: "pass",
    summary: "Blocking with a fix.",
    findings: [wellFormedFinding({ severity: "blocking", suggestedFix: suggestion })],
  });
  assert.equal(blocking.verdict, "block");
});
