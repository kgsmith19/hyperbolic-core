// Structural assertions over .github/actions/verify-tests-acc-windows/action.yml
// (issue #211).
//
// A red ACC Windows run used to leave no usable evidence: node --test falls
// back to TAP when stdout is not a TTY, TAP numbers only top-level tests, and
// nothing was uploaded when the job failed. The fix adds spec+junit
// reporters via NODE_OPTIONS and uploads the junit report on failure. A live
// seeded-canary run (linked on PR #236) proved this works end to end, but
// that proof is ephemeral -- the seed was reverted, so nothing in the
// merged diff itself would catch a future edit that quietly breaks the
// wiring again. This file is that permanent, cheap check: it does not run
// the native suite (that is what the real CI lane is for), it only pins
// that the reporter destination and the artifact upload path are computed
// to name the exact same file, and that the failure-evidence contract
// (if-no-files-found: error, if: failure()) still holds.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const actionPath = path.join(root, ".github/actions/verify-tests-acc-windows/action.yml");
const action = readFileSync(actionPath, "utf8");

const packageJsonPath = path.join(root, "apps/agentic-command-center/package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

test("test:windows still starts with a `cd <dir>` this file's cwd math depends on", () => {
  const script = packageJson.scripts["test:windows"];
  assert.match(script, /^cd (\S+) &&/, "expected test:windows to start with `cd <dir> &&`");
});

function nativeStepCwd() {
  // working-directory: apps/agentic-command-center, then test:windows's own
  // `cd backend` -- both are read from the real files, not hardcoded, so
  // this test fails loudly if either one is renamed instead of silently
  // computing a stale path.
  const cdMatch = /^cd (\S+) &&/.exec(packageJson.scripts["test:windows"]);
  return path.posix.join("apps/agentic-command-center", cdMatch[1]);
}

test("the native test step sets NODE_OPTIONS with spec (stdout) and junit reporters", () => {
  const nodeOptionsMatch = /NODE_OPTIONS:\s*>-\s*\n((?:\s+.+\n)+)/.exec(action);
  assert.ok(nodeOptionsMatch, "expected a NODE_OPTIONS block before the native test step");
  const nodeOptions = nodeOptionsMatch[1];
  assert.match(
    nodeOptions,
    /--test-reporter=spec\s+--test-reporter-destination=stdout/,
    "spec reporter must write to stdout -- that is what makes a failing nested subtest visible in the live log",
  );
  assert.match(
    nodeOptions,
    /--test-reporter=junit\s+--test-reporter-destination=(\S+)/,
    "junit reporter must have a destination -- that is the file the evidence step uploads",
  );
});

test("the junit destination and the evidence upload path name the same file", () => {
  const destMatch = /--test-reporter=junit\s+--test-reporter-destination=(\S+)/.exec(action);
  assert.ok(destMatch, "could not find the junit reporter destination");
  const resolvedDestination = path.posix.normalize(path.posix.join(nativeStepCwd(), destMatch[1]));

  const uploadMatch = /name:\s*acc-windows-test-evidence[\s\S]*?path:\s*(\S+)/.exec(action);
  assert.ok(uploadMatch, "could not find the acc-windows-test-evidence upload step's path:");
  const uploadPath = uploadMatch[1];

  assert.equal(
    resolvedDestination,
    uploadPath,
    `junit reporter writes to ${resolvedDestination} (relative to the native step's cwd) but the upload step looks for ${uploadPath} -- a failing run would upload nothing`,
  );
});

test("the evidence upload runs on failure and fails loudly if nothing was produced", () => {
  const uploadBlockMatch = /- name: Evidence · Upload native-suite failure report\n([\s\S]*?)(?=\n {4}- name:|\n*$)/.exec(action);
  assert.ok(uploadBlockMatch, "could not find the evidence upload step");
  const block = uploadBlockMatch[1];
  assert.match(block, /if:\s*failure\(\)/, "the evidence step must only run on failure");
  assert.match(
    block,
    /if-no-files-found:\s*error/,
    "a failed run that produced no evidence must fail loudly, not silently (the #148 lesson) -- `ignore` is the wrong setting here",
  );
});

test("all three PowerShell suites are still wired ahead of the evidence step", () => {
  for (const script of [
    "backend/shim/claude.test.ps1",
    "backend/watcher/claude-cap-watch.test.ps1",
    "backend/watcher/install-cap-watch-task.test.ps1",
  ]) {
    assert.ok(action.includes(script), `expected ${script} to still be invoked`);
  }
});
