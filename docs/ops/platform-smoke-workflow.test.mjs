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
  // Read-only: probes only -- no scp, no mutation of the box. ssh alone is
  // no longer forbidden outright (issue #185's broker probe uses it, since
  // the broker has no Serve mount -- see the dedicated test below for what
  // stays true about that one exception), but every other read-only-over-
  // HTTPS invariant is unchanged: no key material, no secrets beyond the
  // tailnet OAuth client already used to join.
  assert.doesNotMatch(smoke, /\bscp\b/);
  assert.doesNotMatch(smoke, /\$\{\{ secrets\./);
  assert.doesNotMatch(smoke, /SSH_KEY|id_ed25519/);
});

test("the smoke job declares shell-deploy-production so its OIDC subject matches the trusted shell-deploy identity", () => {
  // deploy.yml's deploy-shell job declares this same environment, so the
  // shell-deploy Infisical identity is trusted against the environment-
  // scoped subject (...:environment:shell-deploy-production), not the
  // no-environment ref:refs/heads/main fallback. Without this, the smoke
  // job's own Infisical pull 403s with "OIDC subject not allowed" even
  // though it authenticates as the same identity (confirmed live: run
  // 32930336092's "Post-deploy smoke" job).
  const smokeJob = smoke.slice(smoke.indexOf("  smoke:"), smoke.indexOf("    steps:"));
  assert.match(smokeJob, /environment: shell-deploy-production/);
});

test("the broker probe is the ONLY ssh usage, keyless, and strictly read-only (curl, never a mutating command)", () => {
  // issue #185: the broker is deliberately loopback-only with no Serve
  // mount (its callers are other containers, not external clients), so it
  // cannot be reached through the shared-origin probe() every other unit
  // uses. probe_ssh() is the one, disclosed exception to this file's
  // otherwise-total "no ssh" design -- scoped narrowly enough that a
  // regression widening it (a second ssh call, or a mutating command
  // riding along) fails this test, not just the eyeball review that added
  // it.
  const sshInvocations = smoke.match(/\bssh\b/g) ?? [];
  assert.equal(sshInvocations.length, 1, "exactly one ssh invocation in the whole file");
  const probeSshFn = smoke.slice(smoke.indexOf("probe_ssh() {"), smoke.indexOf("\n          }\n", smoke.indexOf("probe_ssh() {")));
  // Positive match on the ENTIRE remote command string, not a blocklist:
  // a blocklist (forbidding "docker compose", "rm ", etc.) misses anything
  // not named -- confirmed by mutation testing during independent review,
  // where appending `&& docker restart broker` to the same one-line curl
  // still passed a blocklist-shaped assertion. Requiring the whole quoted
  // remote command to be exactly one curl invocation and nothing else (no
  // `&&`, `;`, `|`, backticks, or `$()`) closes that gap structurally.
  const remoteCommandMatch = /ssh "\$\{ssh_options\[@\]\}" "deploy@\$DEPLOY_HOST" "([^"]*)"/.exec(smoke);
  assert.ok(remoteCommandMatch, "must find the ssh invocation's quoted remote command");
  const remoteCommand = remoteCommandMatch[1];
  assert.match(remoteCommand, /^curl --fail --silent --show-error --max-time 15 '\$url'$/);
  assert.match(smoke, /probe_ssh "Broker" "http:\/\/127\.0\.0\.1:8300\/healthz"/);
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

test("the broker probe is gated behind BROKER_DEPLOY_ENABLED, not run unconditionally (issue #185)", () => {
  // The broker has never been deployed until the owner provisions Infisical
  // /platform/broker/ and confirms it live -- unlike Shell/Handler A/Brain,
  // which have been continuously live since earlier milestones and are
  // correctly probed unconditionally. An UNGATED broker probe would turn
  // every future deploy of every OTHER unit red indefinitely (an
  // independent adversarial review of this file's first draft caught
  // exactly this).
  assert.match(smoke, /BROKER_LIVE: \$\{\{ vars\.BROKER_DEPLOY_ENABLED \}\}/);
  assert.match(smoke, /if \[\[ "\$\{BROKER_LIVE:-\}" == "true" \]\]/);
  assert.match(smoke, /probe_ssh "Broker" "http:\/\/127\.0\.0\.1:8300\/healthz"/);
  assert.match(smoke, /skipped \(not yet deployed\)/);
});

test("the public-edge probe is independently gated behind CLOUDFLARE_EDGE_ENABLED (issue #170)", () => {
  const publicStep = smoke.slice(smoke.indexOf("- name: Smoke · Public edge"));
  assert.match(publicStep, /if: \(success\(\) \|\| failure\(\)\) && vars\.CLOUDFLARE_EDGE_ENABLED == 'true'/);
});

test("the public-edge probe still runs even if the private-probe step above it failed -- not an implicit success()-AND (verification finding, issue #170)", () => {
  // A plausible wrong implementation: a bare `if: vars.CLOUDFLARE_EDGE_ENABLED == 'true'`
  // is implicitly ANDed with success() by GitHub Actions, so a failure in the private
  // probe step above silently skips this one -- exactly the run where the public edge
  // might ALSO be broken and nothing would report it. success()||failure(), not always()
  // (which would also fire on a cancelled run), is what actually decouples the two.
  const publicStep = smoke.slice(smoke.indexOf("- name: Smoke · Public edge"));
  assert.match(publicStep, /if: \(success\(\) \|\| failure\(\)\)/);
  assert.doesNotMatch(publicStep, /if: always\(\)/);
});

test("the public-edge probe runs with set -euo pipefail, so a curl transport failure can't fall through to the range check with a garbage status", () => {
  const publicStep = smoke.slice(smoke.indexOf("- name: Smoke · Public edge"));
  assert.match(publicStep, /set -euo pipefail/);
});

test("the private probes carry no CLOUDFLARE_EDGE_ENABLED gate of their own -- additive, not intertwined", () => {
  const privateStep = smoke.slice(
    smoke.indexOf("- name: Smoke · Probe every live unit"),
    smoke.indexOf("- name: Smoke · Public edge"),
  );
  assert.ok(privateStep.length > 10);
  assert.doesNotMatch(privateStep, /CLOUDFLARE_EDGE_ENABLED/);
});

test("the public-edge probe requires CLOUDFLARE_PUBLIC_HOSTNAME and fails loudly if it's missing", () => {
  const publicStep = smoke.slice(smoke.indexOf("- name: Smoke · Public edge"));
  assert.match(publicStep, /CLOUDFLARE_PUBLIC_HOSTNAME: \$\{\{ vars\.CLOUDFLARE_PUBLIC_HOSTNAME \}\}/);
  assert.match(publicStep, /if \[\[ -z "\$\{CLOUDFLARE_PUBLIC_HOSTNAME:-\}" \]\]; then/);
});

test("the public-edge probe rejects both 2xx (unauthenticated app access) and 5xx (broken edge), only accepts 3xx", () => {
  // A plausible wrong implementation: using `curl --fail`, which only
  // flags >=400 and would treat a 200 (Access is not actually in front of
  // the app) as a passing probe -- the one thing this check exists to
  // catch. Assert the real status-code range check is present instead.
  const publicStep = smoke.slice(smoke.indexOf("- name: Smoke · Public edge"));
  assert.doesNotMatch(publicStep, /curl --fail/);
  assert.match(publicStep, /-o \/dev\/null -w '%\{http_code\}'/);
  assert.match(publicStep, /status < 300 \|\| status >= 400/);
});

test("the public-edge probe never follows the redirect -- it asserts the redirect happened, not what Access's login page contains", () => {
  // Line-based, skipping comments: the step's own header comment
  // legitimately explains *why* -L isn't used, which would otherwise
  // false-positive a substring check run against the whole step text.
  const publicStep = smoke.slice(smoke.indexOf("- name: Smoke · Public edge"));
  const nonCommentLines = publicStep
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(nonCommentLines, /\bcurl\b[^\n]* -L\b/);
  assert.doesNotMatch(nonCommentLines, /--location/);
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
