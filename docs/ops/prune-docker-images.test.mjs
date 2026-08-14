// Real red/green tests for docs/ops/prune-docker-images.sh, mirroring
// prune-dist-dirs.test.mjs's own justification (m2-07's instruction:
// externalize and test anything with real branching logic -- an
// off-by-one here either deletes a rollback target or leaks disk
// forever, same two failure modes as the Shell unit's own prune script).
//
// No real Docker daemon is available in this sandbox (or reachable at
// all from a test), so this exercises the actual shipped script against a
// STUBBED `docker` command placed first on PATH -- a small fixture script
// backed by a plain-text state file (one "CreatedAt\tRepository:Tag" line
// per image), supporting exactly the two subcommands
// prune-docker-images.sh calls: `image ls --format ... <repo>` (reads the
// state file) and `rmi -- <ref>` (deletes the matching line). This proves
// the real deletion/keep-set logic byte-for-byte the same file the
// workflow ships; it cannot prove the real `docker` CLI's own output
// format never drifts, the same honest limitation
// tailscale-serve-apply.test.mjs and prune-dist-dirs.test.mjs both name
// for their own external tools.
//
// Run with: node --test docs/ops/prune-docker-images.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "prune-docker-images.sh");

const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_DOCKER_STATE:?}"
if [[ "\$1" == "image" && "\$2" == "ls" ]]; then
  repo="\${*: -1}"
  grep -F "\$repo" "\$state" || true
  exit 0
fi
if [[ "\$1" == "rmi" ]]; then
  ref="\$3"
  tmp="\$(mktemp)"
  awk -F'\\t' -v ref="\$ref" '\$2 != ref' "\$state" > "\$tmp"
  mv "\$tmp" "\$state"
  exit 0
fi
echo "fake docker: unhandled invocation: \$*" >&2
exit 1
`;

/** `refs` newest-first, e.g. ["repo:sha-c", "repo:sha-b", "repo:sha-a"].
 * Timestamps are synthesized strictly decreasing so lexicographic sort in
 * the script under test is unambiguous, exactly like the real `docker
 * image ls --format '{{.CreatedAt}}'` string. */
function stateLines(refs) {
  return refs
    .map((ref, i) => {
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - i));
      return `${t.toISOString()}\t${ref}`;
    })
    .join("\n");
}

function withFixture(refsNewestFirst, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prune-docker-images-test-"));
  try {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);
    const dockerPath = path.join(binDir, "docker");
    writeFileSync(dockerPath, FAKE_DOCKER);
    chmodSync(dockerPath, 0o755);
    const statePath = path.join(dir, "state.tsv");
    writeFileSync(statePath, stateLines(refsNewestFirst) + (refsNewestFirst.length ? "\n" : ""));
    fn({ dir, binDir, statePath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run({ binDir, statePath }, args) {
  return execFileSync("bash", [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_STATE: statePath },
  });
}

function remaining(statePath) {
  return readFileSync(statePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]);
}

const REPO = "ghcr.io/kgsmith19/hyperbolic-core/brain";

test("keeps the newest 3 by default, prunes the rest, when protect-ref is already the newest", () => {
  withFixture([`${REPO}:sha-e`, `${REPO}:sha-d`, `${REPO}:sha-c`, `${REPO}:sha-b`, `${REPO}:sha-a`], (fx) => {
    run(fx, [REPO, `${REPO}:sha-e`]);
    assert.deepEqual(remaining(fx.statePath), [`${REPO}:sha-e`, `${REPO}:sha-d`, `${REPO}:sha-c`]);
  });
});

test("off-by-one boundary: exactly keep+1 images prunes exactly 1 (the single oldest)", () => {
  withFixture([`${REPO}:sha-d`, `${REPO}:sha-c`, `${REPO}:sha-b`, `${REPO}:sha-a`], (fx) => {
    run(fx, [REPO, `${REPO}:sha-d`, "3"]);
    assert.deepEqual(remaining(fx.statePath), [`${REPO}:sha-d`, `${REPO}:sha-c`, `${REPO}:sha-b`]);
  });
});

test("off-by-one boundary: exactly keep images prunes nothing", () => {
  withFixture([`${REPO}:sha-c`, `${REPO}:sha-b`, `${REPO}:sha-a`], (fx) => {
    const output = run(fx, [REPO, `${REPO}:sha-c`, "3"]);
    assert.deepEqual(remaining(fx.statePath), [`${REPO}:sha-c`, `${REPO}:sha-b`, `${REPO}:sha-a`]);
    assert.match(output, /nothing to prune/);
  });
});

test("rollback survival: protect-ref outside the newest-3 window is kept, and only the truly-oldest excess is pruned", () => {
  // Mirrors 10-cicd-deployment.md section 8.3: an operator repointed
  // BRAIN_IMAGE to an older sha tag in .env; this script must not delete
  // the image that rollback depends on even though a fresh deploy has
  // since produced 3 newer ones.
  withFixture([`${REPO}:sha-e`, `${REPO}:sha-d`, `${REPO}:sha-c`, `${REPO}:sha-b`, `${REPO}:sha-a`], (fx) => {
    run(fx, [REPO, `${REPO}:sha-a`, "3"]);
    // Newest 3 (e, d, c) plus the protected rollback target (a) survive;
    // only b is pruned.
    assert.deepEqual(remaining(fx.statePath).sort(), [`${REPO}:sha-a`, `${REPO}:sha-c`, `${REPO}:sha-d`, `${REPO}:sha-e`].sort());
  });
});

test("never touches a different repo's images, even with an overlapping name prefix", () => {
  const otherRepo = `${REPO}-other`;
  withFixture([`${REPO}:sha-b`, `${REPO}:sha-a`, `${otherRepo}:sha-z`], (fx) => {
    run(fx, [REPO, `${REPO}:sha-b`, "1"]);
    const left = remaining(fx.statePath);
    assert.ok(left.includes(`${otherRepo}:sha-z`), "a different repository's image must survive");
    assert.ok(!left.includes(`${REPO}:sha-a`), "the pruned unit's own excess image must be gone");
  });
});

test("never touches a non-sha tag of the same repo (e.g. :main)", () => {
  withFixture([`${REPO}:sha-b`, `${REPO}:sha-a`, `${REPO}:main`], (fx) => {
    run(fx, [REPO, `${REPO}:sha-b`, "0"]);
    assert.ok(remaining(fx.statePath).includes(`${REPO}:main`), ":main must never be pruned");
  });
});

test("fewer than keep-count images: nothing pruned", () => {
  withFixture([`${REPO}:sha-b`, `${REPO}:sha-a`], (fx) => {
    const output = run(fx, [REPO, `${REPO}:sha-b`, "3"]);
    assert.deepEqual(remaining(fx.statePath), [`${REPO}:sha-b`, `${REPO}:sha-a`]);
    assert.match(output, /nothing to prune/);
  });
});

test("keep-count of 0 prunes everything except the protected ref", () => {
  withFixture([`${REPO}:sha-b`, `${REPO}:sha-a`], (fx) => {
    run(fx, [REPO, `${REPO}:sha-a`, "0"]);
    assert.deepEqual(remaining(fx.statePath), [`${REPO}:sha-a`]);
  });
});

test("rejects a non-numeric keep-count instead of silently misbehaving", () => {
  withFixture([`${REPO}:sha-a`], (fx) => {
    assert.throws(() => run(fx, [REPO, `${REPO}:sha-a`, "not-a-number"]));
  });
});

test("rejects a missing image-repo argument", () => {
  const result = spawnSync("bash", [scriptPath]);
  assert.notEqual(result.status, 0);
});
