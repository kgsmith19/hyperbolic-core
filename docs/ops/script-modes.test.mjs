// Every tracked shell script is executable in the git index (hyperbolic-core#475).
// Workflows and hooks run scripts by path. A 100644 script makes the step exit 126,
// which kept Platform Deploy red from 2026-09-28. The index, not the working tree, is what
// a fresh CI checkout gets, so that is what this test reads.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * [mode, path] for every tracked *.sh, read from the index. In a git pathspec, `*` also
 * matches `/`, so "*.sh" lists scripts in every directory (docs/ops/stamp-canary.sh
 * included); the test below pins that.
 */
function trackedScripts() {
  const out = execFileSync("git", ["ls-files", "-s", "--", "*.sh"], { cwd: root, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      return [meta.split(" ")[0], file];
    });
}

test("the repository tracks shell scripts, so an empty listing cannot pass vacuously", () => {
  assert.ok(trackedScripts().length > 0);
});

test("the listing reaches subdirectories: a nested script is listed, and executable", () => {
  // Oracle change (#503): the canary scripts this pinned were removed with the
  // cloud pipeline; the Claude session-start hook is the nested script now.
  const modes = new Map(trackedScripts().map(([mode, file]) => [file, mode]));
  assert.equal(modes.get(".claude/hooks/session-start.sh"), "100755");
});

test("every tracked *.sh is mode 100755 in the git index", () => {
  const notExecutable = trackedScripts()
    .filter(([mode]) => mode !== "100755")
    .map(([mode, file]) => `${mode} ${file}`);
  assert.deepEqual(notExecutable, [], "run: git update-index --chmod=+x <file>");
});
