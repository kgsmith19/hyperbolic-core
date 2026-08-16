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
