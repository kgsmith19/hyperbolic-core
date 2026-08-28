// Structural assertions over .github/workflows/platform-smoke.yml and its
// wiring into both deploy workflows (issue #143, gap G-1). Each test names
// the failure it catches.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const smoke = readFileSync(path.join(root, ".github/workflows/platform-smoke.yml"), "utf8");
const deploy = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
const lifeosDeploy = readFileSync(path.join(root, ".github/workflows/lifeos-deploy.yml"), "utf8");
const platformGate = readFileSync(path.join(root, ".github/actions/verify-tests-shell/action.yml"), "utf8");

function probeExpectation(label, requestPath) {
  const prefix = `probe "${label}" "${requestPath}" '`;
  const line = smoke
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `missing ${label} probe for ${requestPath}`);
  assert.ok(line.endsWith("'"), `${label} probe marker must be single-quoted`);
  const marker = line.slice(prefix.length, -1);
  return new RegExp(marker);
}

function smokeBashFunction(name) {
  const opening = `          ${name}() {`;
  const start = smoke.indexOf(opening);
  assert.notEqual(start, -1, `missing ${name}() in the private smoke step`);
  const closing = "\n          }";
  const end = smoke.indexOf(closing, start);
  assert.notEqual(end, -1, `missing closing brace for ${name}()`);
  return smoke
    .slice(start, end + closing.length)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

function smokeFailureGate() {
  const opening = '          if [[ "$failures" -gt 0 ]]; then';
  const closing = '          echo "All probes green."';
  const start = smoke.indexOf(opening);
  assert.notEqual(start, -1, "missing the private smoke failure gate");
  const end = smoke.indexOf(closing, start);
  assert.notEqual(end, -1, "missing the private smoke success verdict");
  return smoke
    .slice(start, end + closing.length)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

function smokeTempLifecycle() {
  const opening = '          smoke_tmp="$(mktemp -d)"';
  const closing = "          trap 'exit 143' TERM";
  const start = smoke.indexOf(opening);
  assert.notEqual(start, -1, "missing the private smoke temp directory");
  const end = smoke.indexOf(closing, start);
  assert.notEqual(end, -1, "missing the private smoke signal traps");
  return smoke
    .slice(start, end + closing.length)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

function runSmokeTempLifecycle(exitStatement) {
  const lifecycle = smokeTempLifecycle();
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
${lifecycle}
printf 'temp_dir=%s\n' "$smoke_tmp"
${exitStatement}`,
    ],
    { encoding: "utf8" },
  );
  const match = /^temp_dir=(.+)$/m.exec(result.stdout);
  assert.ok(match, `smoke lifecycle did not expose its temp directory: ${result.stderr}`);
  const survived = existsSync(match[1]);
  rmSync(match[1], { force: true, recursive: true });
  return { result, survived };
}

function runJsonHealthProbe(contentType, body, httpStatus = "200") {
  const tempLifecycle = smokeTempLifecycle();
  const validator = smokeBashFunction("is_json_health");
  const probe = smokeBashFunction("probe_json_health");
  const failureGate = smokeFailureGate();
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
curl() {
  local output_file="" write_out=""
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "--output" ]]; then
      output_file="$2"
      shift 2
    elif [[ "$1" == "--write-out" ]]; then
      write_out="$2"
      shift 2
    else
      shift
    fi
  done
  [[ -n "$output_file" ]]
  printf '%s' "$FAKE_BODY" >"$output_file"
  case "$write_out" in
    '%{content_type}')
      printf '%s' "$FAKE_CONTENT_TYPE"
      ;;
    '%{http_code} %{content_type}')
      printf '%s %s' "$FAKE_HTTP_STATUS" "$FAKE_CONTENT_TYPE"
      ;;
    *)
      printf 'unsupported curl write-out format: %s\n' "$write_out" >&2
      return 64
      ;;
  esac
}
${tempLifecycle}
${validator}
${probe}
origin="https://fixture.invalid"
failures=0
results=()
probe_json_health "fixture API" "/api/healthz"
printf 'failures=%s\n' "$failures"
printf 'result=%s\n' "\${results[*]}"
${failureGate}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_BODY: body,
        FAKE_CONTENT_TYPE: contentType,
        FAKE_HTTP_STATUS: httpStatus,
      },
    },
  );
}

test("smoke is callable, dispatchable, production-gated, and read-only by design", () => {
  const onBlock = smoke.slice(smoke.indexOf("\non:"), smoke.indexOf("\npermissions:"));
  assert.match(onBlock, /workflow_call:/);
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /push:|schedule:|pull_request/);
  assert.match(smoke, /if: vars\.DEPLOY_ENABLED == 'true'/);
  // Read-only: probes only -- no scp, no mutation of the box. ssh alone is
  // no longer forbidden outright (issue #185's broker probe uses it, since
  // the broker has no nginx route -- see the dedicated test below for what
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

test("the probe map covers every nginx-routed unit through the shared origin", () => {
  // One probe per nginx route family. Losing one silently
  // un-verifies that unit on every future deploy.
  for (const probePath of ["/healthz", '"/"', "/api/healthz", "/api/brain/health", "/life/", "/life/api/healthz"]) {
    assert.ok(smoke.includes(probePath), `missing probe: ${probePath}`);
  }
  // A red probe must fail the run, not just annotate the summary.
  assert.match(smoke, /failures=\$\(\(failures \+ 1\)\)/);
  assert.match(smoke, /exit 1/);
  assert.match(smoke, />> "\$GITHUB_STEP_SUMMARY"/);
});

test("live smoke rejects regressions on representative browser-history routes", () => {
  // Index routes are insufficient evidence for a browser-history SPA: a
  // filesystem origin can serve / and /life/ while returning a server 404
  // for every real deep link. These exact probes are the release boundary
  // for both bundles, and each checks the bundle's generated asset marker so
  // an unrelated proxy/error page cannot satisfy the probe.
  assert.ok(smoke.includes(`probe "Shell login deep link" "/login" 'src="/assets/[A-Za-z0-9_.-]+\\.js"'`));
  assert.ok(smoke.includes(`probe "Shell settings deep link" "/settings" 'src="/assets/[A-Za-z0-9_.-]+\\.js"'`));
  assert.ok(smoke.includes(`probe "LifeOS capture deep link" "/life/capture" '/life/assets/[A-Za-z0-9_.-]+\\.js'`));
});

test("Shell document markers reject a LifeOS bundle document", () => {
  const representativeShellHtml =
    '<!doctype html><script type="module" src="/assets/index-Ckkf20am.js"></script>';
  const representativeLifeHtml =
    '<!doctype html><script type="module" src="/life/assets/index-DQFi84m1.js"></script>';

  for (const [label, requestPath] of [
    ["Shell index", "/"],
    ["Shell login deep link", "/login"],
    ["Shell settings deep link", "/settings"],
  ]) {
    const marker = probeExpectation(label, requestPath);
    assert.match(
      representativeShellHtml,
      marker,
      `${label} must accept Shell HTML`,
    );
    assert.doesNotMatch(
      representativeLifeHtml,
      marker,
      `${label} must not accept LifeOS HTML`,
    );
  }

  const lifeMarker = probeExpectation(
    "LifeOS capture deep link",
    "/life/capture",
  );
  assert.match(representativeLifeHtml, lifeMarker);
  assert.doesNotMatch(representativeShellHtml, lifeMarker);
});

test("API health probes use the JSON-health contract instead of an empty generic matcher", () => {
  for (const [label, requestPath] of [
    ["Handler A", "/api/healthz"],
    ["Brain", "/api/brain/health"],
    ["LifeOS API", "/life/api/healthz"],
  ]) {
    assert.ok(
      smoke.includes(`probe_json_health "${label}" "${requestPath}"`),
      `${label} must require a JSON health response`,
    );
    assert.ok(
      !smoke.includes(`probe "${label}" "${requestPath}" ''`),
      `${label} must not use the empty matcher that accepts any 2xx body`,
    );
  }
});

test("JSON health response files are owned by the trapped smoke temp directory", () => {
  const probe = smokeBashFunction("probe_json_health");
  assert.match(probe, /body_file="\$smoke_tmp\/[^"]+"/);
  assert.match(probe, /error_file="\$smoke_tmp\/[^"]+"/);
  assert.doesNotMatch(
    probe,
    /\bmktemp\b/,
    "probe-local temp files can escape cleanup if the function is interrupted",
  );
});

test("the smoke temp directory is removed after an ordinary successful exit", () => {
  const { result, survived } = runSmokeTempLifecycle("true");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(survived, false);
});

test("the smoke temp directory is removed after a set -e early failure", () => {
  const { result, survived } = runSmokeTempLifecycle("false");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(survived, false);
});

for (const [signal, expectedStatus] of [
  ["HUP", 129],
  ["INT", 130],
  ["TERM", 143],
]) {
  test(`the smoke temp directory is removed after ${signal}`, () => {
    const { result, survived } = runSmokeTempLifecycle(`kill -${signal} $$`);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(survived, false);
  });
}

test("the API health validator accepts a JSON object carrying the known ok status", () => {
  const result = runJsonHealthProbe(
    "application/json; charset=utf-8",
    '{"status":"ok","stateStoreWritable":true}',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /failures=0/);
  assert.match(result.stdout, /result=.*✅/);
  assert.match(result.stdout, /All probes green\./);
});

test("the API health validator rejects a JSON response whose health status is not ok", () => {
  const result = runJsonHealthProbe(
    "application/json",
    '{"status":"degraded"}',
  );
  assert.equal(result.status, 1, "the workflow's final failure gate must exit red");
  assert.match(result.stdout, /failures=1/);
  assert.match(result.stdout, /invalid JSON health response/);
  assert.match(result.stderr, /Platform smoke failed: 1 probe\(s\) red/);
});

test("API health NEGATIVE CONTROL: valid ok JSON with text/html fails the workflow", () => {
  const result = runJsonHealthProbe("text/html; charset=utf-8", '{"status":"ok"}');
  assert.equal(result.status, 1, "a non-JSON media type must reach the red exit gate");
  assert.match(result.stdout, /failures=1/);
  assert.match(result.stdout, /invalid JSON health response/);
  assert.match(result.stderr, /Platform smoke failed: 1 probe\(s\) red/);
});

test("API health NEGATIVE CONTROL: SPA HTML mislabeled as JSON fails the workflow", () => {
  const html =
    '<!doctype html><title>hyperbolic-core</title><script>window.fixture={"status":"ok"}</script>';
  const result = runJsonHealthProbe("application/json", html);
  assert.equal(result.status, 1, "an invalid JSON body must reach the red exit gate");
  assert.match(result.stdout, /failures=1/);
  assert.match(result.stdout, /invalid JSON health response/);
  assert.match(result.stderr, /Platform smoke failed: 1 probe\(s\) red/);
});

test("API health NEGATIVE CONTROL: a 302 carrying valid ok JSON fails the workflow", () => {
  const result = runJsonHealthProbe(
    "application/json",
    '{"status":"ok"}',
    "302",
  );
  assert.equal(result.status, 1, "health endpoints must return exact HTTP 200");
  assert.match(result.stdout, /failures=1/);
  assert.match(result.stderr, /expected HTTP 200; got 302/);
  assert.match(result.stderr, /Platform smoke failed: 1 probe\(s\) red/);
});

test("LifeOS probes are gated on the cutover switch, not skipped forever", () => {
  // Pre-cutover the /life/ routes serve the standalone layout this repo
  // must not assert about; post-cutover the probes MUST run. The gate is
  // the LIFEOS_DEPLOY_ENABLED variable, checked at runtime.
  assert.match(smoke, /LIFEOS_LIVE: \$\{\{ vars\.LIFEOS_DEPLOY_ENABLED \}\}/);
  assert.match(smoke, /skipped \(pre-cutover\)/);
});

test("the unrouted broker probe is gated behind BROKER_DEPLOY_ENABLED, not run unconditionally (issue #185)", () => {
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

test("the Platform gate runs the composed production-origin browser suite", () => {
  assert.match(platformGate, /working-directory: apps\/lifeos\/frontend\s+run: npm ci/);
  const composedStep = platformGate.slice(
    platformGate.indexOf("- name: E2E · Run composed production-origin routing suite"),
    platformGate.indexOf("- name: Build · Production build"),
  );
  assert.match(
    composedStep,
    /npx playwright test --config docs\/ops\/composed-origin\/playwright\.config\.ts/,
  );
  assert.doesNotMatch(
    composedStep,
    /continue-on-error|\|\| true/,
    "the composed routing suite must fail the Platform lane when an assertion is red",
  );
  assert.match(platformGate, /docs\/ops\/composed-origin\/playwright-report\//);
  assert.match(platformGate, /docs\/ops\/composed-origin\/test-results\//);
});
