// node --test docs/ops/stage63-review.test.mjs (run from the repo root)
//
// S8 RED characterization (Issue #426): v5 review semantics from
// agent-engineering-standard @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d —
// tools/independent_review.py (Stage 59a: the frozen 15-rule review and
// remediation contract) and tools/spec_critic.py (Stage 28: the fresh Spec
// critic and its ready gate).
//
// The oracle is stage63-review-golden.json, computed by the upstream Python at
// the pinned commit. It also embeds both frozen upstream corpora with their
// upstream results and the Python Unicode tables (str.lower, re's \w and \d)
// the ports must reproduce. The live half binds the contract to
// hyperbolic-core's own review lane (packages/review, adopted in Stage 59b):
// the 59a/59b deltas are pinned in both directions, never silently
// equalized, and the lane's dialogue behavior is not touched by this slice.
//
// Runtime basis: the .ts imports run natively under Node's type-stripping
// (Node >= 22.18; CI pins 22.19.0), exactly as stage59b-review-adoption does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADOPTION, FROZEN, GAP_SLICES, cleanReviewRequest, critiqueSpec, provenance, pythonSemantics,
  remediateRound, reviewDecision, reviewFingerprint, specGatesReady, validateCritiqueFinding,
  validateReviewFinding,
} from "./stage63-adoption-lib.mjs";
import { ADOPTION as ADOPTION_59B, FROZEN_RULES } from "./stage59b-review-adoption-lib.mjs";
import { MALFORMED_SUMMARY_PREFIX, validateVerdict } from "../../packages/review/src/validate.ts";
import { resolveConfig } from "../../packages/review/src/config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n?/g, "\n");
const golden = JSON.parse(readFileSync(path.join(here, "stage63-review-golden.json"), "utf8"));

// --- Frozen contract shape ---------------------------------------------------

test("S8 · independent_review contract is frozen: verdicts, outcomes, rules, injection pattern", () => {
  const review = FROZEN.independent_review;
  assert.deepEqual([...review.VERDICTS], ["PASS", "BLOCK", "INCONCLUSIVE", "INFRASTRUCTURE_FAIL", "POLICY_FAIL"]);
  assert.deepEqual([...review.REMEDIATION], ["FIXED", "DISPUTE", "RECHECK", "REFUSE"]);
  assert.deepEqual([...review.BLOCKING_SEVERITIES], ["blocker", "major"]);
  assert.equal(review.RULES.length, 15);
  const { constants } = golden.review;
  for (const key of ["VERDICTS", "REMEDIATION", "SEVERITIES", "FINDING_FIELDS", "BLOCKING_SEVERITIES", "RULES",
    "INJECTION_PATTERN"]) {
    assert.deepEqual(review[key], constants[key], `independent_review.${key} drifted from upstream`);
  }
  assert.equal(constants.INJECTION_FLAGS, 2 | 32, "upstream compiles the pattern IGNORECASE | UNICODE");
});

test("S8 · spec_critic contract is frozen: risks, rules, classes, word lists, defaults", () => {
  const critic = FROZEN.spec_critic;
  assert.deepEqual([...critic.RISKS], ["R0", "R1", "R2", "R3"]);
  assert.deepEqual([...critic.RULES], [
    "ambiguous_owner", "contradictory_examples", "untestable_adjective", "missing_timeout",
    "hidden_migration_order", "overconstrained_implementation", "giant_spec",
  ]);
  assert.equal(critic.CLASSES.length, 8);
  for (const key of Object.keys(golden.critic.constants)) {
    assert.deepEqual(critic[key], golden.critic.constants[key], `spec_critic.${key} drifted from upstream`);
  }
  assert.deepEqual(Object.keys(critic).sort(), Object.keys(golden.critic.constants).sort());
});

test("S8 · the 59a rule set hyperbolic-core adopted in 59b is still the v5 contract", () => {
  assert.deepEqual(FROZEN_RULES, [...FROZEN.independent_review.RULES],
    "stage59b-review-adoption-lib's FROZEN_RULES must stay byte-identical to the v5 RULES tuple");
});

test("S8 · provenance names both review modules at the pinned SHA", () => {
  for (const module of ["independent_review", "spec_critic"]) {
    assert.match(provenance(), new RegExp(`tools/${module}\\.py`));
    assert.match(golden._provenance, new RegExp(`tools/${module}\\.py`));
  }
  assert.match(golden._provenance, /9e50c9c3518e5bed2ba93e194cb157a78ee0278d/);
});

test("S8 · cleanReviewRequest matches upstream clean_request and is a fresh copy", () => {
  assert.deepEqual(cleanReviewRequest(), golden.review.clean_request);
  const first = cleanReviewRequest();
  first.findings.push({});
  first.criteria.push("AC-2");
  assert.deepEqual(cleanReviewRequest(), golden.review.clean_request, "callers mutate one dimension per test");
});

// --- Python Unicode semantics, proven over every code point -------------------

const allCodePoints = function* allCodePoints() {
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code < 0xd800 || code > 0xdfff) yield code;
  }
};
const hex = (code) => code.toString(16).toUpperCase().padStart(4, "0");
// Inclusive [start, end] runs, binary-searched.
const inRuns = (runs, code) => {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (code < runs[mid][0]) high = mid - 1;
    else if (code > runs[mid][1]) low = mid + 1;
    else return true;
  }
  return false;
};
// Only code points Python's Unicode database still leaves unassigned may
// classify differently here (a newer Unicode assigned them); with equal
// versions there is no skew at all.
const assertSkewOnly = (skew, label) => {
  const { unassigned, version } = golden.unicode;
  for (const code of skew) {
    assert.ok(inRuns(unassigned, code),
      `U+${hex(code)}: ${label} diverges from Python beyond Unicode ${version} vs ${process.versions.unicode} skew`);
  }
  if (process.versions.unicode === version) assert.deepEqual(skew, [], label);
};

test("S8 · lower() maps every code point exactly as Python's str.lower()", () => {
  const skew = [];
  for (const code of allCodePoints()) {
    const ch = String.fromCodePoint(code);
    const expected = golden.unicode.lower[hex(code)] ?? ch;
    if (pythonSemantics.lower(ch) !== expected) skew.push(code);
  }
  assertSkewOnly(skew, "lower()");
  for (const [text, lowered] of golden.unicode.lower_strings) {
    assert.equal(pythonSemantics.lower(text), lowered, `final-sigma and multi-char context: ${JSON.stringify(text)}`);
  }
});

test("S8 · the word class is exactly Python's \\w and the digit class exactly Python's \\d", () => {
  const wordSkew = [];
  const digitSkew = [];
  for (const code of allCodePoints()) {
    const ch = String.fromCodePoint(code);
    if (pythonSemantics.isWordChar(ch) !== inRuns(golden.unicode.word, code)) wordSkew.push(code);
    if (pythonSemantics.isDigit(ch) !== inRuns(golden.unicode.digit, code)) digitSkew.push(code);
  }
  assertSkewOnly(wordSkew, "\\w");
  assertSkewOnly(digitSkew, "\\d");
  assert.ok(pythonSemantics.isWordChar("\u00e9") && !/\w/.test("\u00e9"), "Python's \\w is Unicode, a JS \\w is not");
  assert.ok(pythonSemantics.isDigit("\u0663") && !/\d/.test("\u0663"), "Python's \\d is Unicode, a JS \\d is not");
});

// --- Differential characterization against the upstream Python ----------------

const replay = (call, expected) => {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected) && "error" in expected) {
    assert.throws(call, (e) => e.name === expected.error);
    return;
  }
  assert.deepEqual(call(), expected);
};

for (const c of golden.review.review) {
  test(`S8 · reviewDecision matches upstream review: ${c.label}`, () => replay(() => reviewDecision(c.request), c.result));
}

for (const c of golden.review.remediate) {
  test(`S8 · remediateRound matches upstream remediate: ${c.label}`, () => replay(() => remediateRound(c.round), c.result));
}

for (const c of golden.review.fingerprint) {
  test(`S8 · reviewFingerprint matches upstream fingerprint: ${c.label}`, () => {
    replay(() => reviewFingerprint(c.citations, c.verdict, c.head), c.digest);
  });
}

for (const c of golden.review.validate) {
  test(`S8 · validateReviewFinding matches upstream validate_finding: ${c.label}`, () => {
    replay(() => validateReviewFinding(c.finding), c.repairs);
  });
}

for (const c of golden.critic.critique) {
  test(`S8 · critiqueSpec matches upstream critique: ${c.label}`, () => replay(() => critiqueSpec(c.spec), c.result));
}

for (const c of golden.critic.gates) {
  test(`S8 · specGatesReady matches upstream gates_ready: ${c.label}`, () => replay(() => specGatesReady(c.spec), c.result));
}

for (const c of golden.critic.validate) {
  test(`S8 · validateCritiqueFinding matches upstream validate_finding: ${c.label}`, () => {
    replay(() => validateCritiqueFinding(c.finding), c.repairs);
  });
}

test("S8 · port inputs are never mutated", () => {
  const request = { ...cleanReviewRequest(), findings: [{ finding: "x", severity: "major", citation: "AC-1" }] };
  const snapshot = structuredClone(request);
  reviewDecision(request);
  assert.deepEqual(request, snapshot);
  const spec = golden.critic.critique.find((c) => c.label === "all-rules").spec;
  const specSnapshot = structuredClone(spec);
  critiqueSpec(spec);
  specGatesReady(spec);
  assert.deepEqual(spec, specSnapshot);
});

test("S8 · golden cases exercise every review rule, outcome, verdict and critic rule", () => {
  const rules = new Set([...golden.review.review, ...golden.review.remediate].map((c) => c.result.rule));
  assert.deepEqual([...FROZEN.independent_review.RULES].filter((rule) => !rules.has(rule)), []);
  const verdicts = new Set(golden.review.review.map((c) => c.result.verdict));
  assert.deepEqual([...FROZEN.independent_review.VERDICTS].filter((v) => !verdicts.has(v)), []);
  const outcomes = new Set(golden.review.remediate.map((c) => c.result.outcome));
  assert.deepEqual([...FROZEN.independent_review.REMEDIATION].filter((o) => !outcomes.has(o)), []);
  const criticRules = new Set(golden.critic.critique.flatMap((c) => c.result.findings.map((f) => f.rule)));
  assert.deepEqual([...FROZEN.spec_critic.RULES].filter((rule) => !criticRules.has(rule)), []);
  assert.ok(golden.review.fingerprint.some((c) => c.digest.error === "TypeError"),
    "upstream's one crash (sorted() over incomparable citations) is characterized too");
});

// --- The frozen upstream corpora, replayed through the ports ------------------

test("S8 · every frozen independent-review corpus entry decides as upstream adjudicated", () => {
  const entries = golden.corpus.review;
  assert.ok(entries.length >= 15);
  for (const entry of entries) {
    assert.deepEqual(reviewDecision(entry.request ?? {}), entry.result, entry.id);
    if (entry.remediation !== undefined) {
      const round = remediateRound(entry.remediation);
      assert.deepEqual(round, entry.remediation_result, entry.id);
      assert.deepEqual([round.rule, round.outcome], [entry.expected_rule, entry.expected_outcome], entry.id);
    } else {
      assert.deepEqual([entry.result.rule, entry.result.verdict], [entry.expected_rule, entry.expected_verdict], entry.id);
    }
  }
  assert.deepEqual(new Set(entries.map((e) => e.expected_rule)), new Set(FROZEN.independent_review.RULES),
    "the corpus covers all 15 review rules");
});

test("S8 · every frozen spec-critic corpus entry critiques as upstream adjudicated", () => {
  const entries = golden.corpus.critic;
  assert.ok(entries.length >= 10);
  for (const entry of entries) {
    const result = critiqueSpec(entry.spec);
    assert.deepEqual(result, entry.result, entry.id);
    assert.deepEqual([...new Set(result.findings.map((f) => f.rule))].sort(), [...entry.expected_rules].sort(), entry.id);
    assert.equal(result.scope, entry.expected_scope, entry.id);
  }
  assert.deepEqual(new Set(entries.map((e) => e.id.split(".")[1])), new Set(FROZEN.spec_critic.CLASSES),
    "the corpus covers all 8 critic classes");
});

// --- Characterized upstream defects (tracked upstream in std#293) ------------

test("S8 · upstream defect std#293 is pinned: findings of one rule share one id", () => {
  const two = golden.review.review.find((c) => c.label === "two-blockers-share-an-id");
  const ids = reviewDecision(two.request).findings.map((f) => f.id);
  assert.deepEqual(ids, ["p1-block-1", "p1-block-1"],
    "colliding ids characterized; this pin flips with the lock bump that picks up std#293");
  const ambiguous = critiqueSpec({ ...golden.critic.critique[0].spec,
    statements: ["Tenant rows are isolated.", "The account sees data."] });
  assert.deepEqual(ambiguous.findings.map((f) => f.id), ["ambiguous_owner-1", "ambiguous_owner-2"],
    "the sibling spec_critic numbers its findings");
});

test("S8 · upstream defect std#293 is pinned: migration order words match inside other words", () => {
  const spec = { ...golden.critic.critique[0].spec, migration_steps: ["add column", "backfill"] };
  for (const text of ["The border is red.", "Runs in the afternoon.", "Both emphases hold."]) {
    assert.deepEqual(critiqueSpec({ ...spec, criteria: [text] }).findings, [],
      `${JSON.stringify(text)}: the blocker is suppressed fail-open; flips with the lock bump that picks up std#293`);
  }
  assert.deepEqual(critiqueSpec({ ...spec, criteria: ["A replay returns the receipt."] }).findings.map((f) => f.rule),
    ["hidden_migration_order"], "without a substring hit the blocker fires");
});

// --- hyperbolic-core's live review lane (Stage 59b), deltas pinned both ways ---

const liveFinding = (overrides = {}) => ({
  severity: "blocking", category: "acceptance-criteria", claim: "the diff ignores AC-1",
  evidence: "quoted diff line", requestedChange: "address AC-1", citation: "AC-1", ...overrides,
});
const oracleFinding = (overrides = {}) => ({
  finding: "the diff ignores AC-1", severity: "blocker", citation: "AC-1", excerpt: "quoted diff line", ...overrides,
});
const oracle = (...findings) => reviewDecision({ ...cleanReviewRequest(), findings });
const live = (...findings) => validateVerdict({ findings, summary: "s" });

test("S8 · the live lane agrees with the oracle on clean, P1 and P2", () => {
  assert.deepEqual([oracle().verdict, live().verdict], ["PASS", "pass"]);
  assert.deepEqual([oracle(oracleFinding()).verdict, live(liveFinding()).verdict], ["BLOCK", "block"]);
  assert.deepEqual([oracle(oracleFinding({ severity: "major" })).verdict, live(liveFinding()).verdict], ["BLOCK", "block"],
    "P0 and P1 both block");
  assert.deepEqual([oracle(oracleFinding({ severity: "minor" })).verdict, live(liveFinding({ severity: "advisory" })).verdict],
    ["PASS", "pass"]);
});

test("S8 · disclosed 59b delta: an uncited finding BLOCKs the oracle and is discarded fail-open by the lane", () => {
  const blocked = oracle(oracleFinding({ citation: "" }));
  assert.deepEqual([blocked.verdict, blocked.rule], ["BLOCK", "fake-citation"]);
  const lane = live(liveFinding({ citation: "" }));
  assert.deepEqual([lane.verdict, lane.discarded.length], ["pass", 1]);
  assert.match(ADOPTION_59B["fake-citation"].note, /^DISCLOSED DELTA: /,
    "the delta stays disclosed in the single-sourced 59b mapping");
});

test("S8 · malformed input never blocks, in the oracle or the lane", () => {
  const inconclusive = reviewDecision({ ...cleanReviewRequest(), malformed: true });
  assert.deepEqual([inconclusive.verdict, inconclusive.rule], ["INCONCLUSIVE", "malformed-input"]);
  const lane = validateVerdict("not a submit_review payload");
  assert.equal(lane.verdict, "pass");
  assert.ok(lane.summary.startsWith(MALFORMED_SUMMARY_PREFIX), "the lane flags it as inconclusive, not clean");
});

test("S8 · same-provider is refused by both the oracle and the lane's config", () => {
  const refused = reviewDecision({ ...cleanReviewRequest(), reviewer_family: "anthropic" });
  assert.deepEqual([refused.verdict, refused.rule], ["POLICY_FAIL", "same-provider"]);
  assert.throws(() => resolveConfig({
    REVIEW_PROVIDER: "openai", REVIEW_MODEL: "gpt-5-mini", REVIEW_BUILDER_PROVIDER: "openai", DEV_MODEL: "codex",
  }), /separation/);
});

test("S8 · the owner override names the repository owner the lane's bypass belongs to", () => {
  const fixed = remediateRound({ owner: "kgsmith19", owner_explicit: true, criterion: "AC-1" });
  assert.deepEqual([fixed.outcome, fixed.rule], ["FIXED", "owner-override"]);
  assert.match(read("AGENTS.md"), /kgsmith19/, "AGENTS.md names the owner whose explicit override the oracle honors");
  assert.equal(ADOPTION_59B["owner-override"].path, ".github/workflows/pr-verify.yml");
});

const walk = (dir) => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(rel) : [rel];
});

test("S8 · characterization only: the live review lane does not consume the S8 ports", () => {
  const consumers = [...walk("packages/review"), ...walk(".github/workflows"), ...walk(".github/actions")]
    .filter((rel) => !rel.includes("node_modules") && /stage63-adoption-lib|stage63-review/.test(read(rel)));
  assert.deepEqual(consumers, [], "S8 adds no AI Review dialogue-behavior change: no lane file imports the ports");
});

// --- hyperbolic-core's live risk tiers ----------------------------------------

test("S8 · AGENTS.md's risk tiers are the critic's RISKS, and R0/R1 work is compact", () => {
  const tiers = [...read("AGENTS.md").matchAll(/^\| \*\*(R\d)\*\* \| ([^|]+) \|$/gm)].map(([, tier, meaning]) => [tier, meaning.trim()]);
  assert.deepEqual(tiers.map(([tier]) => tier), [...FROZEN.spec_critic.RISKS], "AGENTS.md declares exactly R0..R3");
  const vague = { statements: ["Each tenant sees data fast."], criteria: [] };
  for (const [tier, meaning] of tiers) {
    const assured = critiqueSpec({ ...vague, risk: tier, assured: true });
    const compact = tier === "R0" || tier === "R1";
    assert.equal(assured.scope, compact ? "compact" : "assured", `${tier} (${meaning})`);
    assert.equal(specGatesReady({ ...vague, risk: tier, assured: true })[0], compact, `${tier} ready gate`);
    assert.equal(critiqueSpec({ ...vague, risk: tier, assured: false }).status, "skipped", `${tier} unassured`);
  }
});

test("S8 · review rows are grounded", () => {
  const rows = Object.keys(ADOPTION).filter((key) => key.startsWith("review:"));
  assert.deepEqual(rows.sort(), [
    "review:live-lane-deltas", "review:remediation-contract", "review:spec-critic", "review:verdict-contract",
  ], "S8 contributes exactly four review rows");
  assert.deepEqual(ADOPTION["review:live-lane-deltas"], { mechanism: "docs/ops/stage59b-review-adoption-lib.mjs", gap: null });
  for (const key of rows) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null, `${key} must be mechanism XOR gap`);
    if (entry.mechanism !== null) assert.ok(existsSync(path.join(root, entry.mechanism)), `${key}: ${entry.mechanism}`);
    else assert.ok(GAP_SLICES.includes(entry.gap));
  }
});
