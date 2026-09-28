// Tests for canary-observe.sh (G3, issue #407). Real filesystem, a faked
// curl on PATH plus a python3 alex shim on Windows-local lanes — same
// pattern as stamp-canary.test.mjs. The fake behaves like the real GitHub
// releases API (200/404 on GET), so the script's actual branching is
// exercised: breach → fail (halt), missing stamp → fail closed,
// unshipped unit → skip, unobserved G3-telemetry signals → reported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const opsDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(opsDir, "canary-observe.sh");
const realCanaryDir = path.join(opsDir, "canary");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function curlFakeScript(log, { releaseExists = true } = {}) {
  return `#!/bin/sh
echo "curl $*" >> "${log}"
if [ "${releaseExists ? 1 : 0}" = "1" ]; then
  printf '200'
else
  printf '404'
fi
exit 0
`;
}

function fixture({ releaseExists = true, results = {}, descriptors = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "canary-observe-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, "curl.log");
  writeFileSync(log, "");
  const curlPath = path.join(bin, "curl");
  writeFileSync(curlPath, curlFakeScript(log, { releaseExists }));
  chmodSync(curlPath, 0o755);
  const canaryDir = path.join(root, "docs/ops/canary");
  mkdirSync(canaryDir, { recursive: true });
  const units = ["shell", "llm-handler", "brain", "broker", "lifeos-backend", "lifeos-ui"];
  for (const unit of units) {
    const content = descriptors && descriptors[unit] !== undefined
      ? descriptors[unit]
      : readFileSync(path.join(realCanaryDir, `${unit}.canary.yml`), "utf8");
    if (content !== null) writeFileSync(path.join(canaryDir, `${unit}.canary.yml`), content);
  }
  return { root, bin, log };
}

function run({ releaseExists = true, results = {}, descriptors = null, smoke = "success", sha = "abc123def456" } = {}) {
  const { root, bin, log } = fixture({ releaseExists, results, descriptors });
  const result = spawnSync(process.env.BASH_PATH ?? "bash", [script], {
    encoding: "utf8",
    cwd: root,
    env: {
      PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
      GH_TOKEN: "fake-token",
      REPO: "kgsmith19/hyperbolic-core",
      SHA: sha,
      SMOKE_RESULT: smoke,
      TAG_RELEASE_DATE: "20260817",
      SHELL_RESULT: results.shell ?? "skipped",
      LLM_HANDLER_RESULT: results["llm-handler"] ?? "skipped",
      BRAIN_RESULT: results.brain ?? "skipped",
      BROKER_RESULT: results.broker ?? "skipped",
      BACKEND_RESULT: results["lifeos-backend"] ?? "skipped",
      UI_RESULT: results["lifeos-ui"] ?? "skipped",
    },
  });
  return { ...result, log: readFileSync(log, "utf8") };
}

test("a real bash -n parse of the script is syntactically clean", () => {
  const result = spawnSync(process.env.BASH_PATH ?? "bash", ["-n", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("green smoke + stamped release → PASS with unobserved G3-telemetry signals disclosed", () => {
  const result = run({ results: { shell: "success" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /canary-observe: all shipped units green/);
  assert.match(result.stdout, /unobserved/);
});

test("breach → FAIL: red smoke fails every shipped unit's smoke-anchored invariants (halt)", () => {
  const result = run({ results: { shell: "success", brain: "success" }, smoke: "failure" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invariant-breach for shell\//);
  assert.match(result.stderr, /invariant-breach for brain\//);
  assert.match(result.stderr, /promotion HALTED/);
});

test("missing series → FAIL CLOSED: shipped unit with no canary release", () => {
  const result = run({ results: { shell: "success" }, releaseExists: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-telemetry for shell/);
  assert.match(result.stderr, /FAIL CLOSED/);
});

test("missing declaration → FAIL CLOSED: shipped unit with no descriptor", () => {
  const result = run({ results: { shell: "success" }, descriptors: { shell: null } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canary-missing for shell/);
});

test("unshipped units are skipped, never evaluated", () => {
  const result = run({ results: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip shell/);
  assert.doesNotMatch(result.stderr, /invariant-breach/);
});

test("both deploy pipelines wire the observe job after smoke and tag-release", () => {
  const deploy = readFileSync(path.join(opsDir, "..", "..", ".github/workflows/deploy.yml"), "utf8");
  const lifeos = readFileSync(path.join(opsDir, "..", "..", ".github/workflows/lifeos-deploy.yml"), "utf8");
  assert.match(deploy, /canary-observe:/);
  assert.match(deploy, /needs: \[deploy-shell, deploy-llm-handler, deploy-brain, deploy-broker, smoke, tag-release\]/);
  assert.match(deploy, /uses: \.\/\.(github\/workflows\/canary-observe\.yml)/);
  assert.match(lifeos, /canary-observe:/);
  assert.match(lifeos, /needs: \[deploy-backend, deploy-ui, smoke, tag-release\]/);
});
