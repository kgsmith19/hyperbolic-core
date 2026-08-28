// Real red/green tests for the "Policy · Confirm agent-roles.yaml is valid
// and dev/review providers differ" step in
// .github/actions/verify-repo-policy/action.yml.
//
// This extracts the step's actual embedded Python (the `python3 <<'PYEOF'`
// heredoc body), writes it to a real file, and executes it with a real
// `agent-roles.yaml` in a real temporary working directory -- not a
// reimplementation of the validation logic in JS that could silently drift
// from what CI actually runs. Same philosophy as the sibling
// prune-dist-dirs.test.mjs and tag-release.test.mjs: exercise the shipped
// script itself.
//
// What this CANNOT prove: that the surrounding `run: |` block's
// `set -euo pipefail` and heredoc quoting inside the real YAML actually
// invoke this exact script unmodified in CI -- a structural check below
// (the step exists with this exact name and its `run:` contains this exact
// heredoc marker) covers that half.
//
// Run with: node --test docs/ops/repo-policy-workflow.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const actionPath = path.join(root, ".github/actions/verify-repo-policy/action.yml");
const action = readFileSync(actionPath, "utf8");

const STEP_NAME = "Policy · Confirm agent-roles.yaml is valid and dev/review providers differ";
const HEREDOC_START = "python3 <<'PYEOF'";
const HEREDOC_END = "\n        PYEOF";

function extractValidatorScript() {
  const stepIndex = action.indexOf(`name: ${STEP_NAME}`);
  assert.ok(stepIndex >= 0, `verify-repo-policy/action.yml: step "${STEP_NAME}" not found`);
  const afterStep = action.slice(stepIndex);
  const startIndex = afterStep.indexOf(HEREDOC_START);
  assert.ok(startIndex >= 0, `step "${STEP_NAME}": no python3 heredoc found`);
  const bodyStart = startIndex + HEREDOC_START.length + 1;
  const endIndex = afterStep.indexOf(HEREDOC_END, bodyStart);
  assert.ok(endIndex >= 0, `step "${STEP_NAME}": heredoc has no closing PYEOF`);
  const body = afterStep.slice(bodyStart, endIndex);
  const lines = body.split("\n");
  const indented = lines.filter((line) => line.trim().length > 0);
  const commonIndent = Math.min(...indented.map((line) => line.match(/^ */)[0].length));
  return lines.map((line) => line.slice(commonIndent)).join("\n");
}

function runValidator(agentRolesYaml = null, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-policy-validate-"));
  const scriptFile = path.join(dir, "validate.py");
  writeFileSync(scriptFile, extractValidatorScript());
  if (agentRolesYaml !== null) {
    writeFileSync(path.join(dir, "agent-roles.yaml"), agentRolesYaml);
  }
  try {
    const stdout = execFileSync("python3", [scriptFile], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stderr: error.stderr?.toString() ?? "", status: error.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixture({ devProvider = "anthropic", devModel = "claude-opus-5", reviewProvider = "openai", reviewModel = "gpt-5-mini" } = {}) {
  return `dev:\n  provider: ${devProvider}\n  model: ${devModel}\n\nreview:\n  provider: ${reviewProvider}\n  model: ${reviewModel}\n`;
}

test("verify-repo-policy: the agent-roles.yaml validation step exists with the exact name AGENTS.md and the Issue reference it", () => {
  assert.ok(action.includes(`name: ${STEP_NAME}`));
});

// Issue #289. The behavioral tests below prove the cross-check LOGIC is
// correct when review_provider/review_model are passed in -- they cannot
// prove either caller actually passes them. Structural check for that half:
// both pr-verify.yml's native job and repo-policy.yml's own standalone
// trigger must wire the same live vars into verify-repo-policy, or the
// cross-check silently never runs on either trigger path.
test("both verify-repo-policy call sites wire vars.REVIEW_PROVIDER/REVIEW_MODEL into review_provider/review_model", () => {
  for (const file of ["pr-verify.yml", "repo-policy.yml"]) {
    const workflowPath = path.join(root, ".github/workflows", file);
    const text = readFileSync(workflowPath, "utf8");
    const usesIndex = text.indexOf("uses: ./.github/actions/verify-repo-policy");
    assert.ok(usesIndex >= 0, `${file}: no verify-repo-policy invocation found`);
    const withIndex = text.indexOf("with:", usesIndex);
    const nextStepIndex = text.indexOf("\n      - name:", withIndex);
    const withBlock = text.slice(withIndex, nextStepIndex > 0 ? nextStepIndex : withIndex + 300);
    assert.match(withBlock, /review_provider:\s*\$\{\{\s*vars\.REVIEW_PROVIDER\s*\}\}/, `${file}: review_provider not wired from vars.REVIEW_PROVIDER`);
    assert.match(withBlock, /review_model:\s*\$\{\{\s*vars\.REVIEW_MODEL\s*\}\}/, `${file}: review_model not wired from vars.REVIEW_MODEL`);
  }
});

// POSITIVE CONTROL. Behavior protected: a well-formed, non-colliding file
// passes. Without this, every test below could be satisfied by a validator
// that always exits non-zero.
test("agent-roles.yaml validator: a valid, distinct-provider file passes", () => {
  const result = runValidator(fixture());
  assert.equal(result.ok, true, `expected pass, got failure: ${result.stderr}`);
  assert.match(result.stdout, /dev=anthropic, review=openai/);
});

// NEGATIVE CONTROL -- the exact scenario Issue #239's acceptance criteria
// named explicitly. Behavior protected: the whole point of this step. Defect
// caught: a validator that only checks parseability and never actually
// compares the two providers.
test("agent-roles.yaml validator: dev.provider === review.provider fails closed", () => {
  const result = runValidator(fixture({ reviewProvider: "anthropic" }));
  assert.equal(result.ok, false, "expected the validator to fail on a provider collision");
  assert.match(result.stderr, /dev\.provider and review\.provider are both 'anthropic'/);
});

// Cross-enum negative control. dev and review are role-specific value
// spaces, but both now name COMPANIES identically (Issue #307/#308 dropped
// review's separate "gemini" model-API identifier in favor of the same
// "google" family name dev already uses), so a Google-family collision is
// caught the same simple way as any other same-provider collision.
test("agent-roles.yaml validator: google dev and google review are one provider family", () => {
  const result = runValidator(
    fixture({
      devProvider: "google",
      devModel: "gemini-2.5-pro",
      reviewProvider: "google",
      reviewModel: "gemini-2.5-pro",
    })
  );

  assert.equal(result.ok, false, "expected the validator to fail on a Google-family collision");
  assert.match(result.stderr, /same provider family 'google'/i);
});

// Behavior protected: an invalid provider name fails closed rather than
// silently passing as "not a collision because they're both garbage".
test("agent-roles.yaml validator: an unrecognized provider fails closed", () => {
  const result = runValidator(fixture({ devProvider: "gpt5" }));
  assert.equal(result.ok, false);
  assert.match(result.stderr, /'dev\.provider' is 'gpt5'/);
});

// Behavior protected: a missing model name fails closed, independent of the
// provider fields being fine.
test("agent-roles.yaml validator: an empty model fails closed", () => {
  const result = runValidator(fixture({ reviewModel: "" }));
  assert.equal(result.ok, false);
  assert.match(result.stderr, /'review\.model' is missing or empty/);
});

// Behavior protected: casing differences are canonicalized, matching
// packages/review/src/config.ts's REVIEW_PROVIDER handling, rather than
// causing a spurious failure OR silently evading the collision check.
test("agent-roles.yaml validator: provider casing is canonicalized before comparison", () => {
  const passResult = runValidator(fixture({ devProvider: "Anthropic" }));
  assert.equal(passResult.ok, true, `expected 'Anthropic' to canonicalize and pass: ${passResult.stderr}`);

  const collisionResult = runValidator(fixture({ devProvider: "OpenAI", reviewProvider: "openai" }));
  assert.equal(collisionResult.ok, false, "expected differently-cased duplicates to still collide");
  assert.match(collisionResult.stderr, /are both 'openai'/);
});

// Behavior protected: unparseable YAML fails closed with a clear message,
// not a Python traceback that obscures the actual problem in CI logs.
test("agent-roles.yaml validator: malformed YAML fails closed", () => {
  const result = runValidator("dev: [this is not\n  a valid: mapping");
  assert.equal(result.ok, false);
  assert.match(result.stderr, /could not be read or parsed/);
});

// Behavior protected: dev.provider and review.provider are separate value
// spaces (Issue #252), and dev.provider's own values name COMPANIES,
// consistently with every other value in both enums (Issue #264 -- #253
// originally picked "antigravity", a product/CLI name, which was itself the
// inconsistency). This is the positive control for dev's own space: "google"
// is not a real model API `packages/llm` can dispatch to, so accepting it
// here only makes sense because dev.provider means something different from
// review.provider.
test("agent-roles.yaml validator: dev.provider accepts google, the coding-agent tool's company", () => {
  const result = runValidator(fixture({ devProvider: "google" }));
  assert.equal(result.ok, true, `expected pass, got failure: ${result.stderr}`);
  assert.match(result.stdout, /dev=google, review=openai/);
});

// NEGATIVE CONTROL for the rename itself (Issue #264's own acceptance
// criterion: "dev: antigravity now fails -- the value it currently
// accepts"). Behavior protected: the old product-name value is no longer
// valid now that dev.provider's space names companies. Defect caught: a
// validator edit that adds "google" without actually removing "antigravity",
// silently leaving two ways to name the same harness.
test("agent-roles.yaml validator: dev.provider rejects antigravity -- superseded by the company name google", () => {
  const result = runValidator(fixture({ devProvider: "antigravity" }));
  assert.equal(result.ok, false);
  assert.match(result.stderr, /'dev\.provider' is 'antigravity'/);
  assert.match(result.stderr, /must be one of \['anthropic', 'google', 'openai'\]/);
});

// NEGATIVE CONTROL for the space split. Behavior protected: "gemini" is
// review's real-API identifier, not a valid dev-tool name -- there is no
// "Gemini" coding-agent harness this repo dispatches dev work to. Defect
// caught: a validator that still shares one VALID_PROVIDERS set across both
// roles, which would let this pass and silently keep the old conflation
// Issue #252 exists to remove.
test("agent-roles.yaml validator: dev.provider rejects gemini -- that identifier belongs to review's API space, not dev's tool space", () => {
  const result = runValidator(fixture({ devProvider: "gemini" }));
  assert.equal(result.ok, false);
  assert.match(result.stderr, /'dev\.provider' is 'gemini'/);
  assert.match(result.stderr, /must be one of \['anthropic', 'google', 'openai'\]/);
});

// POSITIVE CONTROL, the mirror image of dev's own "accepts google" test
// above. Behavior protected: review.provider now names the same COMPANY
// space dev.provider does (Issue #307/#308) -- "google" identifies the
// Gemini API here, same value, same meaning as dev's own Antigravity entry.
// Defect caught: a validator edit that added "google" to dev's set but
// forgot review's, silently keeping the two enums out of sync.
test("agent-roles.yaml validator: review.provider accepts google, the real Gemini API's company", () => {
  const result = runValidator(fixture({ reviewProvider: "google" }));
  assert.equal(result.ok, true, `expected pass, got failure: ${result.stderr}`);
  assert.match(result.stdout, /dev=anthropic, review=google/);
});

// NEGATIVE CONTROL for the rename itself, review's mirror of dev's own
// "rejects antigravity" control above. Behavior protected: "gemini" (a
// specific model name, not a provider company) is no longer a valid
// review.provider value now that review.provider's space names companies
// consistently with dev.provider. Defect caught: a validator edit that
// added "google" without actually removing the old "gemini" identifier,
// silently leaving two ways to name the same company.
test("agent-roles.yaml validator: review.provider rejects gemini -- superseded by the company name google", () => {
  const result = runValidator(fixture({ reviewProvider: "gemini" }));
  assert.equal(result.ok, false);
  assert.match(result.stderr, /'review\.provider' is 'gemini'/);
  assert.match(result.stderr, /must be one of \['anthropic', 'google', 'openai'\]/);
});

// ---------------------------------------------------------------------------
// Issue #289: agent-roles.yaml's review.provider/review.model, cross-checked
// against the live vars.REVIEW_PROVIDER/REVIEW_MODEL that actually drive the
// review call (verify-llm-review's real inputs) -- so the new AI Review
// footer, which is sourced from agent-roles.yaml alone, cannot silently
// state a provider/model that drifted from what actually ran.
// ---------------------------------------------------------------------------

// POSITIVE CONTROL. Behavior protected: matching live vars pass, alongside
// the pre-existing checks -- without this, every negative test below could
// be satisfied by a validator that always fails once the env vars are set.
test("agent-roles.yaml validator: matching live REVIEW_PROVIDER/REVIEW_MODEL pass", () => {
  const result = runValidator(fixture(), { LIVE_REVIEW_PROVIDER: "openai", LIVE_REVIEW_MODEL: "gpt-5-mini" });
  assert.equal(result.ok, true, `expected pass, got failure: ${result.stderr}`);
});

// NEGATIVE CONTROL. Behavior protected: the whole point of this check --
// agent-roles.yaml declaring one provider while the live var that actually
// drives the review call says another. Defect caught: a cross-check that
// only compares model, never provider.
test("agent-roles.yaml validator: a mismatched live REVIEW_PROVIDER fails closed", () => {
  const result = runValidator(fixture({ reviewProvider: "openai" }), { LIVE_REVIEW_PROVIDER: "gemini", LIVE_REVIEW_MODEL: "gpt-5-mini" });
  assert.equal(result.ok, false, "expected the validator to fail on a provider mismatch");
  assert.match(result.stderr, /review\.provider \('openai'\) does not match the live vars\.REVIEW_PROVIDER \('gemini'\)/);
});

// NEGATIVE CONTROL, the model half. Defect caught: a cross-check that only
// compares provider, never model -- the exact drift Issue #289's own
// context describes (agent-roles.yaml and the live var disagreeing).
test("agent-roles.yaml validator: a mismatched live REVIEW_MODEL fails closed", () => {
  const result = runValidator(fixture({ reviewModel: "gpt-5-mini" }), { LIVE_REVIEW_PROVIDER: "openai", LIVE_REVIEW_MODEL: "gpt-4o" });
  assert.equal(result.ok, false, "expected the validator to fail on a model mismatch");
  assert.match(result.stderr, /review\.model \('gpt-5-mini'\) does not match the live vars\.REVIEW_MODEL \('gpt-4o'\)/);
});

// Behavior protected: an unprovisioned live var (empty string, e.g. before
// vars.REVIEW_PROVIDER/REVIEW_MODEL are first set) skips this specific
// check rather than failing closed on nothing to compare against -- the
// same tolerance this action's own base_sha input already has. Defect
// caught: a cross-check that treats an empty/unset var as a literal
// mismatch and blocks every PR before the repo variables exist.
test("agent-roles.yaml validator: unset live REVIEW_PROVIDER/REVIEW_MODEL skip the cross-check entirely", () => {
  const result = runValidator(fixture(), { LIVE_REVIEW_PROVIDER: "", LIVE_REVIEW_MODEL: "" });
  assert.equal(result.ok, true, `expected pass (check skipped), got failure: ${result.stderr}`);
});
