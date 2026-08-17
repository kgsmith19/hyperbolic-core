// Structural assertions over .github/workflows/platform-smoke.yml and its
// wiring into both deploy workflows (issue #143, gap G-1). Each test names
// the failure it catches.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const smoke = readFileSync(path.join(root, ".github/workflows/platform-smoke.yml"), "utf8");
const deploy = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
const lifeosDeploy = readFileSync(path.join(root, ".github/workflows/lifeos-deploy.yml"), "utf8");

test("smoke is callable, dispatchable, production-gated, and read-only by design", () => {
  const onBlock = smoke.slice(smoke.indexOf("\non:"), smoke.indexOf("\npermissions:"));
  assert.match(onBlock, /workflow_call:/);
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /push:|schedule:|pull_request/);
  assert.match(smoke, /if: vars\.DEPLOY_ENABLED == 'true'/);
  // Read-only: probes only -- no ssh, no scp, no mutation of the box.
  assert.doesNotMatch(smoke, /\bssh\b|\bscp\b/);
  assert.doesNotMatch(smoke, /\$\{\{ secrets\./);
  assert.doesNotMatch(smoke, /SSH_KEY|id_ed25519/);
});

test("the probe map covers every mounted unit through the shared origin", () => {
  // One probe per serve mount (runbook route table). Losing one silently
  // un-verifies that unit on every future deploy.
  for (const probePath of ["/healthz", '"/"', "/api/healthz", "/api/brain/health", "/life/", "/life/api/healthz"]) {
    assert.ok(smoke.includes(probePath), `missing probe: ${probePath}`);
  }
  // A red probe must fail the run, not just annotate the summary.
  assert.match(smoke, /failures=\$\(\(failures \+ 1\)\)/);
  assert.match(smoke, /exit 1/);
  assert.match(smoke, />> "\$GITHUB_STEP_SUMMARY"/);
});

test("LifeOS probes are gated on the cutover switch, not skipped forever", () => {
  // Pre-cutover the /life/ routes serve the standalone layout this repo
  // must not assert about; post-cutover the probes MUST run. The gate is
  // the LIFEOS_DEPLOY_ENABLED variable, checked at runtime.
  assert.match(smoke, /LIFEOS_LIVE: \$\{\{ vars\.LIFEOS_DEPLOY_ENABLED \}\}/);
  assert.match(smoke, /skipped \(pre-cutover\)/);
});

test("both deploy workflows call smoke after their deploy jobs, red-on-red", () => {
  for (const [wf, name, anySuccess] of [
    [deploy, "deploy.yml", /needs\.deploy-shell\.result == 'success' \|\|/],
    [lifeosDeploy, "lifeos-deploy.yml", /needs\.deploy-backend\.result == 'success' \|\|/],
  ]) {
    const smokeJob = wf.slice(wf.indexOf("  smoke:"));
    assert.ok(smokeJob.length > 10, `${name}: no smoke job`);
    assert.match(smokeJob, /uses: \.\/\.github\/workflows\/platform-smoke\.yml/);
    // always() + any-deploy-succeeded: a sibling unit's failure must not
    // skip the verdict for the units that DID deploy.
    assert.match(smokeJob, /always\(\)/);
    assert.match(smokeJob, anySuccess);
  }
});
