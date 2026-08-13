// Real red/green tests for docs/ops/prune-dist-dirs.sh
// (docs/planning/issues/m2-07-chore-ci-deploy-shell.md's own instruction:
// externalize and test anything with real branching logic, e.g. the
// prune-to-3 logic, since off-by-one errors there are exactly the kind of
// bug worth a real unit test).
//
// This runs the actual bash script against a real temporary directory tree
// (mkdtemp, real files, real mtimes via utimesSync, a real symlink) and
// asserts on the real directory listing afterward -- not a re-implementation
// of the script's logic in JS that could drift from what actually ships.
// What this file CANNOT prove (honest limitation, same category as
// tailscale-serve-apply.test.mjs): that scp'ing this script to the real
// deploy host and running it there over ssh behaves identically -- that
// requires the live host .github/workflows/deploy.yml's deploy-shell job
// targets, which does not exist in this sandbox. What IS proven here is the
// script's actual deletion logic, byte-for-byte the same file the workflow
// ships, exercised against a real filesystem.
//
// Run with: node --test docs/ops/prune-dist-dirs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, readdirSync, rmSync, utimesSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "prune-dist-dirs.sh");

/** Creates <base>/dist-<label> for each label, oldest first, each mtime
 * strictly increasing by 10 seconds so `ls -dt` ordering can never be
 * ambiguous on any filesystem's mtime granularity. */
function makeDistDirs(base, labelsOldestFirst) {
  const start = Date.now() / 1000 - labelsOldestFirst.length * 10;
  labelsOldestFirst.forEach((label, i) => {
    const dir = path.join(base, `dist-${label}`);
    mkdirSync(dir);
    const t = start + i * 10;
    utimesSync(dir, t, t);
  });
}

function distDirsRemaining(base) {
  return readdirSync(base)
    .filter((name) => name.startsWith("dist-"))
    .sort();
}

function run(base, keep) {
  const args = keep === undefined ? [base] : [base, String(keep)];
  return execFileSync("bash", [scriptPath, ...args], { encoding: "utf8" });
}

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prune-dist-dirs-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("keeps exactly the newest 3 by default, prunes the rest, when current points at the newest", () => {
  withTempDir((dir) => {
    makeDistDirs(dir, ["a", "b", "c", "d", "e"]); // a oldest ... e newest
    symlinkSync("dist-e", path.join(dir, "current"));
    run(dir);
    assert.deepEqual(distDirsRemaining(dir), ["dist-c", "dist-d", "dist-e"]);
  });
});

test("off-by-one boundary: exactly keep+1 dirs prunes exactly 1 (the single oldest), not 0 or 2", () => {
  withTempDir((dir) => {
    makeDistDirs(dir, ["a", "b", "c", "d"]); // 4 dirs, keep=3
    symlinkSync("dist-d", path.join(dir, "current"));
    run(dir, 3);
    assert.deepEqual(distDirsRemaining(dir), ["dist-b", "dist-c", "dist-d"]);
  });
});

test("off-by-one boundary: exactly keep dirs prunes nothing", () => {
  withTempDir((dir) => {
    makeDistDirs(dir, ["a", "b", "c"]); // exactly 3, keep=3
    symlinkSync("dist-c", path.join(dir, "current"));
    run(dir, 3);
    assert.deepEqual(distDirsRemaining(dir), ["dist-a", "dist-b", "dist-c"]);
  });
});

test("fewer than keep-count dirs: nothing pruned", () => {
  withTempDir((dir) => {
    makeDistDirs(dir, ["a", "b"]);
    symlinkSync("dist-b", path.join(dir, "current"));
    const output = run(dir, 3);
    assert.deepEqual(distDirsRemaining(dir), ["dist-a", "dist-b"]);
    assert.match(output, /nothing to prune/);
  });
});

test("rollback survival: current points at a dir OUTSIDE the newest-3 window and is protected from pruning", () => {
  // Simulates docs/planning/10-cicd-deployment.md section 8.2: an operator
  // manually rolled `current` back to dist-a (the oldest) without a
  // rebuild. This script must not delete the directory the rollback
  // depends on, even though it is not among the newest 3 by mtime.
  withTempDir((dir) => {
    makeDistDirs(dir, ["a", "b", "c", "d", "e"]); // a oldest ... e newest
    symlinkSync("dist-a", path.join(dir, "current"));
    run(dir, 3);
    // Newest 3 (c, d, e) plus the protected rollback target (a) survive;
    // only b (neither newest-3 nor the rollback target) is pruned.
    assert.deepEqual(distDirsRemaining(dir), ["dist-a", "dist-c", "dist-d", "dist-e"]);
  });
});

test("no current symlink present: prunes by mtime alone with no error", () => {
  withTempDir((dir) => {
    makeDistDirs(dir, ["a", "b", "c", "d", "e"]);
    run(dir, 3);
    assert.deepEqual(distDirsRemaining(dir), ["dist-c", "dist-d", "dist-e"]);
  });
});

test("never deletes the current symlink itself", () => {
  withTempDir((dir) => {
    makeDistDirs(dir, ["a", "b", "c", "d"]);
    symlinkSync("dist-d", path.join(dir, "current"));
    run(dir, 3);
    assert.ok(existsSync(path.join(dir, "current")), "current symlink must survive pruning");
  });
});

test("keep-count of 0 prunes everything except a protected current target", () => {
  withTempDir((dir) => {
    makeDistDirs(dir, ["a", "b"]);
    symlinkSync("dist-a", path.join(dir, "current"));
    run(dir, 0);
    assert.deepEqual(distDirsRemaining(dir), ["dist-a"]);
  });
});

test("rejects a non-numeric keep-count instead of silently misbehaving", () => {
  withTempDir((dir) => {
    makeDistDirs(dir, ["a"]);
    assert.throws(() => run(dir, "not-a-number"));
  });
});

test("rejects a missing base directory instead of silently no-op'ing", () => {
  assert.throws(() => run("/definitely/does/not/exist-" + Date.now()));
});

test("newline-bearing dist names cannot make pruning delete an unrelated directory", () => {
  withTempDir((dir) => {
    mkdirSync(path.join(dir, "unrelated"));
    mkdirSync(path.join(dir, "dist-adversarial\nunrelated"));
    run(dir, 0);
    assert.ok(existsSync(path.join(dir, "unrelated")));
    assert.ok(!existsSync(path.join(dir, "dist-adversarial\nunrelated")));
  });
});

test("refuses the filesystem root before enumerating prune targets", () => {
  const result = spawnSync("bash", [scriptPath, "/"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to prune the filesystem root/);
});
