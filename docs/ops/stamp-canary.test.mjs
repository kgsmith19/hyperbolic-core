// Tests for stamp-canary.sh (G2, issue #406). Real filesystem, a faked curl
// on PATH — same pattern as tag-release.test.mjs: the fake behaves like
// the real GitHub releases API (200/404 on GET, POST creates), so the
// script's actual branching is exercised, including the missing-descriptor
// refusal and the releases-API (not refs-API) create path.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const opsDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(opsDir, "stamp-canary.sh");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function curlFakeScript(log, { releaseExists = false, createFails = false } = {}) {
  return `#!/bin/sh
echo "curl $*" >> "${log}"
is_post=0
for arg in "$@"; do
  if [ "$arg" = "POST" ]; then is_post=1; fi
done
if [ "$is_post" = "1" ]; then
  if [ "${createFails ? 1 : 0}" = "1" ]; then
    exit 22
  fi
  echo '{"id":1}'
  exit 0
fi
if [ "${releaseExists ? 1 : 0}" = "1" ]; then
  printf '200'
else
  printf '404'
fi
exit 0
`;
}

function fakeEnv({ releaseExists = false, createFails = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "stamp-canary-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, "curl.log");
  writeFileSync(log, "");
  const curlPath = path.join(bin, "curl");
  writeFileSync(curlPath, curlFakeScript(log, { releaseExists, createFails }));
  chmodSync(curlPath, 0o755);
  // python3 alex shim: GitHub's ubuntu-latest runner ships python3, but
  // this Windows-local lane does not. The shim serves the script's
  // heredoc JSON build so the oracle runs on both (bash -n covers syntax
  // separately; the runner covers the real interpreter).
  const pyShim = `#!/bin/sh
echo '{"tag_name":"shim","target_commitish":"shim","name":"shim","body":"shim","draft":false,"prerelease":true}'
`;
  const pyPath = path.join(bin, "python3");
  writeFileSync(pyPath, pyShim);
  chmodSync(pyPath, 0o755);
  return { root, bin, log };
}

// Run from a fixture repo root containing docs/ops/canary/<unit>.canary.yml.
function run(args, { releaseExists = false, createFails = false, descriptor = "unit: shell\nexposure: 0.01\n" } = {}) {
  const { root, bin, log } = fakeEnv({ releaseExists, createFails });
  const canaryDir = path.join(root, "docs/ops/canary");
  mkdirSync(canaryDir, { recursive: true });
  if (descriptor !== null) writeFileSync(path.join(canaryDir, "shell.canary.yml"), descriptor);
  const result = spawnSync(process.env.BASH_PATH ?? "bash", [script, ...args], {
    encoding: "utf8",
    cwd: root,
    env: {
      PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
      GH_TOKEN: "fake-token",
      REPO: "kgsmith19/hyperbolic-core",
      TAG_RELEASE_DATE: "20260817",
    },
  });
  return { ...result, log: readFileSync(log, "utf8") };
}

test("a real bash -n parse of the script is syntactically clean", () => {
  const result = spawnSync(process.env.BASH_PATH ?? "bash", ["-n", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("skips entirely — no curl calls at all — when the deploy result is not success", () => {
  const result = run(["shell", "failure", "abc123"]);
  assert.equal(result.status, 0);
  assert.equal(result.log, "");
  assert.match(result.stdout, /skip canary stamp/);
});

test("refuses loudly when a shipped unit has no canary descriptor", () => {
  const result = run(["shell", "success", "abc123"], { descriptor: null });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing canary descriptor/);
});

test("creates the canary release via POST to the releases API with the canary tag", () => {
  const result = run(["shell", "success", "abc123def456"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /\/releases\/tags\/canary\/shell\//);
  assert.match(result.log, /POST/);
  assert.match(result.stdout, /stamped canary release canary\/shell\//);
});

test("is idempotent: an existing canary release makes no create (POST) call", () => {
  const result = run(["shell", "success", "abc123def456"], { releaseExists: true });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.log, /POST/);
  assert.match(result.stdout, /already exists; skipping/);
});

test("a failed create fails loudly, not silently", () => {
  const result = run(["shell", "success", "abc123def456"], { createFails: true });
  assert.notEqual(result.status, 0);
});

test("both deploy pipelines stamp the canary onto every release tag", () => {
  const deploy = readFileSync(path.join(opsDir, "..", "..", ".github/workflows/deploy.yml"), "utf8");
  const lifeos = readFileSync(path.join(opsDir, "..", "..", ".github/workflows/lifeos-deploy.yml"), "utf8");
  for (const unit of ["shell", "llm-handler", "brain", "broker"]) {
    assert.match(deploy, new RegExp(`stamp-canary\\.sh ${unit} `), unit);
  }
  for (const unit of ["lifeos-backend", "lifeos-ui"]) {
    assert.match(lifeos, new RegExp(`stamp-canary\\.sh ${unit} `), unit);
  }
});
