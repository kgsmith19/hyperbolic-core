// Structural assertions over .github/actions/verify-tests-acc-windows/action.yml
// (issue #211).
//
// A red ACC Windows run used to leave no usable evidence: node --test falls
// back to TAP when stdout is not a TTY, TAP numbers only top-level tests, and
// nothing was uploaded when the job failed. The fix adds spec+junit
// reporters via NODE_OPTIONS and uploads the junit report on failure. A live
// seeded-canary run against the real Windows lane (linked on PR #236) proved
// this end to end once, but that proof was necessarily ephemeral -- the seed
// was reverted, because a nested subtest left permanently failing in the
// real ACC suite would make `ACC Windows` red forever, which is a worse
// defect than the one this Issue fixes. A permanent proof has to live
// somewhere that can fail on its own without ever failing the real suite:
// this file spawns an ISOLATED `node --test` process, elsewhere in the
// filesystem, against a throwaway fixture, using the exact reporter types
// action.yml configures -- so a future edit that quietly breaks the
// reporter wiring, or the pairing between the reporter's destination and
// the artifact upload path, fails HERE, every run, without ever touching
// the real ACC test suite.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const actionPath = path.join(root, ".github/actions/verify-tests-acc-windows/action.yml");
const action = readFileSync(actionPath, "utf8");

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

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

test("action.yml's own reporter types, run for real against a failing nested subtest, name it on stdout and in the junit file", () => {
  // Reads the reporter TYPES out of action.yml (not the destinations -- the
  // destination-pairing test above already owns that) so this test fails if
  // a future edit swaps spec/junit for something else, same as it would
  // fail on a real drift today.
  const nodeOptionsMatch = /NODE_OPTIONS:\s*>-\s*\n((?:\s+.+\n)+)/.exec(action);
  assert.ok(nodeOptionsMatch, "expected a NODE_OPTIONS block before the native test step");
  const reporterTypes = [...nodeOptionsMatch[1].matchAll(/--test-reporter=(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(
    reporterTypes,
    ["spec", "junit"],
    "expected exactly spec (stdout visibility) then junit (evidence artifact) -- this proof only covers those two",
  );

  const dir = mkdtempSync(path.join(tmpdir(), "acc-windows-reporter-proof-"));
  tmpDirs.push(dir);
  const fixturePath = path.join(dir, "fixture.test.mjs");
  const junitPath = path.join(dir, "report.xml");
  const failingName = "nested subtest that must be named in evidence";
  writeFileSync(
    fixturePath,
    [
      'import { test } from "node:test";',
      'import assert from "node:assert";',
      'test("outer", async (t) => {',
      `  await t.test(${JSON.stringify(failingName)}, () => {`,
      "    assert.strictEqual(1, 2);",
      "  });",
      "});",
      "",
    ].join("\n"),
  );

  // NODE_TEST_CONTEXT is how node --test marks the child process it spawns
  // for THIS FILE. Left in the environment, the fixture run below inherits
  // it and node --test treats that as a *recursive* run() call and silently
  // skips it (0 tests, exit 0) -- a real Node behavior this test would
  // otherwise fail on for a reason that has nothing to do with action.yml.
  const { NODE_TEST_CONTEXT: _unused, ...childEnv } = process.env;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=junit",
      `--test-reporter-destination=${junitPath}`,
      fixturePath,
    ],
    { encoding: "utf8", env: childEnv },
  );

  assert.notEqual(result.status, 0, "the fixture's seeded failure must make the run exit non-zero");
  assert.ok(
    result.stdout.includes(failingName),
    `the spec reporter must name the failing nested subtest on stdout; got:\n${result.stdout}`,
  );

  assert.ok(existsSync(junitPath), "the junit reporter must write its report file even though the run failed");
  const junitContents = readFileSync(junitPath, "utf8");
  assert.ok(
    junitContents.includes(failingName),
    `the junit report must name the failing nested subtest; got:\n${junitContents}`,
  );
});
