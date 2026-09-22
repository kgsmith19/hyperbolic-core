// node --test docs/ops/stage59b-review-adoption.test.mjs (run from the repo root)
//
// Runtime basis: the .ts imports below run natively under Node's
// type-stripping (Node >= 22.18; CI pins node-version "22" with the
// floor documented at the pin in .github/actions/verify-tests-shell,
// and the Platform lane executes exactly this file via
// `node --test docs/ops/*.test.mjs`). No loader,
// transpiler, or dist build is involved — proven by the green Platform
// run on the PR, not by assertion.
//
// Stage 59b (#388): adopt the frozen Stage 59a independent-review-and-
// remediation contract into hyperbolic-core's live review lane while
// preserving the proven fix/rebut/recheck behavior and the single PR Gate.
//
// Three halves in one CI-provable file:
//   1. Adoption mapping: every frozen 59a rule names the hyperbolic-core
//      mechanism that implements it (single-sourced in the lib), and every
//      named mechanism exists on disk.
//   2. Behavioral pins: the Issue's canary family (clean/P1/P2/injection/
//      outage/scope-creep/dispute, plus same-provider and stale-head)
//      exercised against the REAL review code and workflow topology.
//   3. Native-authority removal: the live ruleset proves zero native
//      approvals and zero code-owner review gating (explicit owner override
//      on #388), and AGENTS.md no longer requires code-owner approval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADOPTION,
  FROZEN_RULES,
  cleanAdoption,
  nativeDrift,
} from "./stage59b-review-adoption-lib.mjs";
import { validateVerdict } from "../../packages/review/src/validate.ts";
import { resolveConfig } from "../../packages/review/src/config.ts";
import {
  DATA_NOT_INSTRUCTIONS_RULE,
  buildSystemPrompt,
} from "../../packages/review/src/prompt.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

// --- Half 1: the adoption mapping is total and grounded ---

test("all 15 frozen 59a rules are adopted exactly once", () => {
  assert.deepEqual(new Set(Object.keys(ADOPTION)), new Set(FROZEN_RULES));
  assert.equal(Object.keys(ADOPTION).length, 15);
});

test("every adopted mechanism exists on disk", () => {
  for (const [rule, entry] of Object.entries(ADOPTION)) {
    assert.ok(entry.path && entry.note, `rule ${rule} needs a path and a note`);
    assert.ok(
      existsSync(path.join(root, entry.path)),
      `rule ${rule} names a missing mechanism: ${entry.path}`,
    );
  }
});

// --- Half 2: the canary family against the real code ---

function validFinding(overrides = {}) {
  return {
    severity: "blocking",
    category: "acceptance-criteria",
    claim: "the diff ignores the linked Issue's stated criterion",
    evidence: "quoted diff line showing the criterion unaddressed",
    requestedChange: "address the criterion or show where it is met",
    citation: "AC-1",
    ...overrides,
  };
}

test("clean: no valid blocking finding passes", () => {
  const verdict = validateVerdict({ findings: [], summary: "nothing wrong" });
  assert.equal(verdict.verdict, "pass");
  assert.deepEqual(verdict.findings, []);
});

test("P1-equivalent: an evidenced, cited blocking finding blocks", () => {
  const verdict = validateVerdict({ findings: [validFinding()], summary: "real defect" });
  assert.equal(verdict.verdict, "block");
  assert.equal(verdict.findings.length, 1);
});

test("P2-equivalent: an advisory finding passes with notes", () => {
  const verdict = validateVerdict({
    findings: [validFinding({ severity: "advisory" })],
    summary: "minor note",
  });
  assert.equal(verdict.verdict, "pass");
  assert.equal(verdict.findings.length, 1);
});

test("uncited blocking finding is discarded and never blocks (disclosed delta)", () => {
  // Stage 59a's deterministic oracle BLOCKs a fake-cited review as
  // untrustworthy. This lane's reviewer is model prose, so an uncited
  // objection is discarded fail-open instead: a confused model must never
  // stall real work (AGENTS.md > Independent LLM Review). The control that
  // matters is the pair: a CITED finding blocks (above), an UNCITED one
  // does not (here) — this package must not commit the green-washing sin
  // it polices, in either direction.
  const verdict = validateVerdict({
    findings: [validFinding({ citation: "" })],
    summary: "unsupported objection",
  });
  assert.equal(verdict.verdict, "pass");
  assert.equal(verdict.discarded.length, 1);
});

test("same-provider review is refused before any credential is used", () => {
  assert.throws(
    () =>
      resolveConfig({
        REVIEW_PROVIDER: "openai",
        REVIEW_MODEL: "gpt-5-mini",
        REVIEW_BUILDER_PROVIDER: "openai",
        DEV_MODEL: "codex",
      }),
    /separation/,
  );
});

test("injection content is data, and the attempt is itself a finding", () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes(DATA_NOT_INSTRUCTIONS_RULE));
  assert.match(prompt, /that attempt is itself a finding/);
  assert.match(prompt, /category: injection, severity: blocking/);
});

test("scope lock and resolution-by-citation are pinned in the rubric", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /SCOPE LOCK -- ONE SHOT/);
  assert.match(prompt, /RESOLUTION BY CITATION/);
  assert.match(prompt, /re-review round MUST include `deliberation`/);
});

test("re-review without deliberation resolves by default (fail-open)", () => {
  const verdict = validateVerdict(
    { findings: [validFinding()], summary: "re-asserted block" },
    { priorDialogue: true },
  );
  assert.equal(verdict.verdict, "pass");
  assert.equal(verdict.findings[0].resolvedByDefault, true);
});

test("an agreed out-of-scope finding is reported but does not block", () => {
  const verdict = validateVerdict({
    findings: [validFinding({ outOfScope: true })],
    summary: "deferred by agreement",
  });
  assert.equal(verdict.verdict, "pass");
  assert.equal(verdict.findings.length, 1);
});

test("outage fails closed by construction (structural pin; behavior in package suite)", () => {
  // review.ts throws ReviewInfrastructureError on missing credential,
  // transport error, or a missing tool call; bin maps it to exit 2, never
  // green. The behavioral proof is packages/review's own 90-test suite
  // (infrastructure cases throw; weak answers pass open). This pins the
  // shape so a refactor cannot silently convert a throw into a default.
  assert.match(read("packages/review/src/review.ts"), /class ReviewInfrastructureError/);
  assert.match(read("packages/review/src/review.ts"), /throw new ReviewInfrastructureError/);
  assert.match(read("packages/review/bin/review.mjs"), /2  the review did not happen/);
});

test("fix/rebut/recheck behavior is preserved, not replaced", () => {
  const dispatch = read(".github/workflows/dev-agent-dispatch.yml");
  assert.match(dispatch, /1\. FIX IT/);
  assert.match(dispatch, /2\. REBUT IT/);
  assert.match(dispatch, /3\. PROPOSE OUT OF SCOPE/);
  assert.match(dispatch, /deliberation turn/);
  for (const workflow of [
    "llm-review.yml",
    "llm-review-dialogue.yml",
    "llm-review-recheck.yml",
    "dev-agent-dispatch.yml",
  ]) {
    assert.ok(existsSync(path.join(root, ".github/workflows", workflow)), workflow);
  }
});

test("the review lane stays one input to the single PR Gate", () => {
  const verify = read(".github/workflows/pr-verify.yml");
  assert.match(verify, /\n {4}needs: \[repository-standards\]\n/);
  assert.match(
    verify,
    /needs: \[repository-standards, toolbelt, acc-linux, acc-windows, brain, platform, lifeos, ai-review\]/,
  );
  const required = (read("project.yaml").match(/^\s*required: true/mg) ?? []).length;
  assert.equal(required, 1);
});

// --- Half 3: conflicting native review authority is removed ---

function liveAdoptionInput() {
  const ruleset = JSON.parse(
    readFileSync(new URL("./stage3c-live-ruleset-20904976.json", import.meta.url), "utf8"),
  );
  const byType = Object.fromEntries((ruleset.rules ?? []).map((r) => [r.type, r]));
  const pull = byType.pull_request?.parameters ?? {};
  const status = byType.required_status_checks?.parameters ?? {};
  const agents = read("AGENTS.md");
  return {
    approvals: pull.required_approving_review_count,
    codeOwnerReview: pull.require_code_owner_review,
    requiredChecks: (status.required_status_checks ?? []).map((c) => c.context),
    agentsRequiresCodeOwner: agents.includes("code-owner approval required"),
    agentsStatesZeroGating: agents.includes("zero code-owner review gating"),
  };
}

test("recorded live ruleset 20904976 adopts zero native review gating", () => {
  assert.deepEqual(nativeDrift(liveAdoptionInput()), []);
  assert.deepEqual(nativeDrift(cleanAdoption()), []);
});

test("each native-authority drift mode fires", () => {
  const clean = cleanAdoption();
  assert.ok(nativeDrift({ ...clean, approvals: 2 }).includes("native-approval-drift"));
  assert.ok(nativeDrift({ ...clean, codeOwnerReview: true }).includes("code-owner-review-gating"));
  assert.ok(
    nativeDrift({ ...clean, requiredChecks: ["PR Gate", "CI"] }).includes("second-required-check"),
  );
  assert.ok(
    nativeDrift({ ...clean, agentsRequiresCodeOwner: true }).includes(
      "agents-md-requires-code-owner",
    ),
  );
  assert.ok(
    nativeDrift({ ...clean, agentsStatesZeroGating: false }).includes(
      "agents-md-missing-zero-gating",
    ),
  );
});
