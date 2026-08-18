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

function runValidator(agentRolesYaml) {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-policy-validate-"));
  const scriptFile = path.join(dir, "validate.py");
  writeFileSync(scriptFile, extractValidatorScript());
  writeFileSync(path.join(dir, "agent-roles.yaml"), agentRolesYaml);
  try {
    const stdout = execFileSync("python3", [scriptFile], { cwd: dir, encoding: "utf8" });
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
