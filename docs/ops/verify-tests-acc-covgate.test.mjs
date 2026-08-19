// Real red/green regression test for the "Coverage · Expose the integration
// diff to covgate" step in .github/actions/verify-tests-acc/action.yml
// (Issue #245).
//
// Reproduces the actual failure mode with real git repositories -- no
// GitHub Actions runner needed. The scenario: a pull request branch forks
// from main, then ANOTHER pull request merges into main while this one
// stays open. The next CI run's BASE_SHA (github.event.pull_request.base.sha)
// is main's NEW tip, which was never an ancestor of this branch's own
// history -- and fetch-depth: 0 on `ref: head.sha` only ever unshallows
// THAT ref's own ancestry, never unrelated later commits that landed on
// main through a different PR. `git merge-base` then failed on a missing
// object, not a real "no common ancestor" case.
//
// This extracts the step's actual embedded bash and executes it against
// real git repositories built to reproduce exactly that shape, the same
// "exercise the shipped script itself" philosophy as prune-dist-dirs.test.mjs
// and repo-policy-workflow.test.mjs use for their own embedded scripts.
//
// Run with: node --test docs/ops/verify-tests-acc-covgate.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const actionPath = path.join(root, ".github/actions/verify-tests-acc/action.yml");
const action = readFileSync(actionPath, "utf8");

const STEP_NAME = "Coverage · Expose the integration diff to covgate";
const NEXT_STEP_MARKER = "\n    - name:";

function extractCovgateScript() {
  const stepIndex = action.indexOf(`name: ${STEP_NAME}`);
  assert.ok(stepIndex >= 0, `verify-tests-acc/action.yml: step "${STEP_NAME}" not found`);
  const afterStep = action.slice(stepIndex);
  const runIndex = afterStep.indexOf("run: |");
  assert.ok(runIndex >= 0, `step "${STEP_NAME}": no run: | block found`);
  const bodyStart = runIndex + "run: |".length + 1;
  const rest = afterStep.slice(bodyStart);
  const nextStepIndex = rest.indexOf(NEXT_STEP_MARKER);
  const body = nextStepIndex >= 0 ? rest.slice(0, nextStepIndex) : rest;
  const lines = body.split("\n");
  const indented = lines.filter((line) => line.trim().length > 0);
  const commonIndent = Math.min(...indented.map((line) => line.match(/^ */)[0].length));
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(commonIndent))).join("\n");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

function commit(cwd, file, message) {
  writeFileSync(path.join(cwd, file), message);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * Builds: origin/main = A -> B -> D (D lands AFTER the fork), and a
 * "checkout" clone that only has A -> B -> C's own ancestry -- exactly what
 * fetch-depth: 0 on `ref: <C's sha>` would produce, never fetching D.
 * Returns { checkoutDir, baseSha (D), mergeBaseSha (B) } and a `cleanup()`.
 */
function buildDriftedScenario({ shallow = false, baseBranch = "main" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "covgate-test-"));
  const originDir = path.join(dir, "origin.git");
  const workDir = path.join(dir, "work");

  git(dir, "init", "--bare", "-b", baseBranch, originDir);
  git(dir, "init", "-b", baseBranch, workDir);
  git(workDir, "remote", "add", "origin", originDir);

  commit(workDir, "a.txt", "A");
  const bSha = commit(workDir, "b.txt", "B"); // the real fork point
  git(workDir, "push", "origin", baseBranch);

  git(workDir, "checkout", "-b", "feature");
  const cSha = commit(workDir, "c.txt", "C"); // this branch's own head
  git(workDir, "push", "origin", "feature");

  git(workDir, "checkout", baseBranch);
  const dSha = commit(workDir, "d.txt", "D"); // a LATER, unrelated PR's merge
  git(workDir, "push", "origin", baseBranch);

  const checkoutDir = path.join(dir, "checkout");
  git(dir, "init", "-b", "detached", checkoutDir);
  git(checkoutDir, "remote", "add", "origin", originDir);
  if (shallow) {
    git(checkoutDir, "fetch", "--depth=1", "origin", cSha);
  } else {
    git(checkoutDir, "fetch", "origin", cSha);
  }
  git(checkoutDir, "checkout", "FETCH_HEAD");

  return {
    checkoutDir,
    baseSha: dSha,
    mergeBaseSha: bSha,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runCovgate(checkoutDir, baseSha, baseRef = "main") {
  const scriptFile = path.join(checkoutDir, "covgate-step.sh");
  writeFileSync(scriptFile, extractCovgateScript());
  return execFileSync("bash", [scriptFile], {
    cwd: checkoutDir,
    encoding: "utf8",
    env: { ...process.env, BASE_SHA: baseSha, BASE_REF: baseRef },
  });
}

// POSITIVE CONTROL / the actual bug (Issue #245). Behavior protected: when
// BASE_SHA is a commit main advanced to AFTER this branch's fork (never
// fetched by the branch's own checkout), the step fetches what it needs and
// still resolves the correct merge base -- rather than crashing on a
// missing object, which is what the pre-fix script did.
test("covgate: BASE_SHA drifted past the fork point is fetched and resolved correctly", () => {
  const scenario = buildDriftedScenario();
  try {
    const output = runCovgate(scenario.checkoutDir, scenario.baseSha);
    // The HEAD assertion below is the real oracle -- it proves the merge
    // base was actually resolved, which a message match alone never could.
    // This one stays a loose substring, diagnostic only, so a harmless
    // wording tweak in the script can't break the test on its own.
    assert.match(output, /not yet fetched/);
    const headAfter = git(scenario.checkoutDir, "rev-parse", "HEAD");
    assert.equal(headAfter, scenario.mergeBaseSha, "HEAD must land on the TRUE merge base (B), not fail or silently no-op");
  } finally {
    scenario.cleanup();
  }
});

// Behavior protected: BASE_REF is actually what gets fetched, not a
// hardcoded "main" -- the direct fix for AI Review's PR #248 round-2
// finding. Uses a base branch deliberately NOT named "main" so a
// regression back to a hardcoded value would fail this test specifically,
// not just happen to still work because the fixture's branch is named main.
test("covgate: a non-main base branch is fetched via BASE_REF, not a hardcoded name", () => {
  const scenario = buildDriftedScenario({ baseBranch: "release" });
  try {
    const output = runCovgate(scenario.checkoutDir, scenario.baseSha, "release");
    assert.match(output, /not yet fetched/);
    const headAfter = git(scenario.checkoutDir, "rev-parse", "HEAD");
    assert.equal(headAfter, scenario.mergeBaseSha, "must resolve correctly against a base branch that isn't main");
  } finally {
    scenario.cleanup();
  }
});

// Behavior protected: the defensive unshallow path actually works, not just
// the already-unshallowed common case above -- this is the direct fix for
// the reviewer's second finding on PR #248 (a shallow clone would otherwise
// leave the fetch below bounded by the existing shallow horizon).
test("covgate: a shallow checkout is unshallowed before fetching the base ref, and still resolves correctly", () => {
  const scenario = buildDriftedScenario({ shallow: true });
  try {
    assert.ok(existsSync(path.join(scenario.checkoutDir, ".git", "shallow")), "test setup must actually produce a shallow repo");
    const output = runCovgate(scenario.checkoutDir, scenario.baseSha);
    assert.match(output, /unshallowing before fetching/);
    const headAfter = git(scenario.checkoutDir, "rev-parse", "HEAD");
    assert.equal(headAfter, scenario.mergeBaseSha);
  } finally {
    scenario.cleanup();
  }
});

// Behavior protected: a BASE_SHA already present locally (the common,
// non-drifted case) never attempts a fetch at all -- proves the cat-file
// guard correctly short-circuits instead of always fetching.
test("covgate: an already-fetched BASE_SHA skips the fetch entirely", () => {
  const scenario = buildDriftedScenario();
  try {
    const output = runCovgate(scenario.checkoutDir, scenario.mergeBaseSha);
    assert.doesNotMatch(output, /not yet fetched/);
    const headAfter = git(scenario.checkoutDir, "rev-parse", "HEAD");
    assert.equal(headAfter, scenario.mergeBaseSha);
  } finally {
    scenario.cleanup();
  }
});

// NEGATIVE CONTROL / fail-open guarantee. Behavior protected: a genuinely
// unreachable BASE_SHA (bad data, not just drift) must never crash the job
// -- it falls back to "leave HEAD alone," the same safe posture the
// empty-BASE_SHA branch already had before this fix.
test("covgate: a BASE_SHA that cannot be fetched at all falls back safely instead of failing", () => {
  const scenario = buildDriftedScenario();
  const bogusSha = "f".repeat(40);
  try {
    const cSha = git(scenario.checkoutDir, "rev-parse", "HEAD");
    const output = runCovgate(scenario.checkoutDir, bogusSha);
    assert.match(output, /leaving HEAD alone/);
    const headAfter = git(scenario.checkoutDir, "rev-parse", "HEAD");
    assert.equal(headAfter, cSha, "HEAD must be untouched when the fix cannot resolve a base at all");
  } finally {
    scenario.cleanup();
  }
});
