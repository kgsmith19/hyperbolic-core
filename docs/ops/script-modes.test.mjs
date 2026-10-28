// Every tracked shell script is executable in the git index (hyperbolic-core#475).
// Workflows run scripts by path (deploy.yml, lifeos-deploy.yml: docs/ops/stamp-canary.sh;
// canary-observe.yml: docs/ops/canary-observe.sh). A 100644 script makes the step exit 126,
// which kept Platform Deploy red from 2026-09-28. The index, not the working tree, is what
// a fresh CI checkout gets, so that is what this test reads.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** [mode, path] for every tracked *.sh, read from the index. */
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

test("every tracked *.sh is mode 100755 in the git index", () => {
  const notExecutable = trackedScripts()
    .filter(([mode]) => mode !== "100755")
    .map(([mode, file]) => `${mode} ${file}`);
  assert.deepEqual(notExecutable, [], "run: git update-index --chmod=+x <file>");
});
