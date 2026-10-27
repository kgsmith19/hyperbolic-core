// Structural assertions over .github/workflows/ops-broker-soak-report.yml
// (hyperbolic-core#466). The workflow reads the broker's audit log off the
// production box, so its safety is its SHAPE: dispatch-only, read-only remote
// verbs behind one allowlisted wrapper, the same pinned actions and identity
// deploy.yml already trusts, and no write verb anywhere. Each test names the
// defect it exists to catch.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/ops-broker-soak-report.yml"), "utf8");
const deploy = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");

/** Non-comment lines only, so a comment that mentions a verb cannot trip a rule. */
const code = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** The top-level `on:` block's own keys, read from the first line under `on:`. */
function triggerKeys() {
  const start = workflow.indexOf("\non:\n");
  assert.ok(start > -1, "no top-level on: block");
  const rest = workflow.slice(start + "\non:\n".length);
  const end = rest.search(/\n(?=[A-Za-z_-]+:)/);
  const block = end > -1 ? rest.slice(0, end) : rest;
  return [...block.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]);
}

/** The exact `uses:` reference deploy.yml pins for one action, comment included. */
function deployUses(action) {
  const match = deploy.match(new RegExp(`uses: (${action.replace(/[/.]/g, "\\$&")}@[^\\n]+)`));
  assert.ok(match, `deploy.yml pins no ${action}`);
  return match[1];
}

// --- trigger and identity ---

test("dispatch-only: the sole trigger is workflow_dispatch -- no push, pull_request, schedule, or workflow_run", () => {
  // A scheduled or push-driven run would read production logs with no human
  // asking for it, and a pull_request trigger would hand fork code a
  // production identity.
  assert.deepEqual(triggerKeys(), ["workflow_dispatch"]);
});

test("the dispatch input 'since' is optional and a plain string", () => {
  assert.match(workflow, /\n {2}workflow_dispatch:\n {4}inputs:\n {6}since:\n {8}description: [^\n]+\n {8}required: false\n {8}type: string\n {8}default: ""\n/);
});

test("exactly one job, and it runs in the existing production environment that deploy-broker already uses", () => {
  const jobIds = [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(jobIds, ["broker-soak-report"]);
  const environments = workflow.match(/^\s*environment:.*$/gm) ?? [];
  assert.deepEqual(environments.map((line) => line.trim()), ["environment: broker-deploy-production"]);
});

test("permissions are minimal: the top level grants contents read only, the job adds id-token write, nothing else", () => {
  const blocks = [...workflow.matchAll(/^( *)permissions:\n((?:\1 {2}[a-z-]+: [a-z]+\n)+)/gm)].map(
    ([, indent, body]) => ({ indent, pairs: [...body.matchAll(/([a-z-]+): ([a-z]+)/g)].map((m) => `${m[1]}:${m[2]}`) }),
  );
  assert.equal(blocks.length, 2, "expected exactly a top-level and a job-level permissions block");
  const [topLevel, job] = blocks;
  assert.equal(topLevel.indent, "", "first permissions block must be top level");
  assert.deepEqual(topLevel.pairs, ["contents:read"]);
  assert.equal(job.indent, "    ", "second permissions block must be job level");
  assert.deepEqual(job.pairs, ["contents:read", "id-token:write"]);
  assert.doesNotMatch(code, /\b(packages|pull-requests|issues|actions|checks|statuses|deployments|contents): write\b/);
});

test("concurrency serializes the soak read against itself, with no cancel-in-progress", () => {
  assert.match(workflow, /\n {4}concurrency:\n {6}group: ops-broker-soak-report\n {6}cancel-in-progress: false\n/);
});

// --- pinned actions: the same SHAs deploy-broker uses ---

test("every action used is one deploy.yml already pins, at the same full SHA", () => {
  const refs = [...workflow.matchAll(/uses: ([^\s#]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(refs.map((ref) => ref.split("@")[0]))].sort(),
    ["Infisical/secrets-action", "actions/checkout", "actions/upload-artifact", "tailscale/github-action"],
  );
  for (const ref of refs) {
    assert.ok(deploy.includes(`uses: ${ref}`), `${ref} is not pinned in deploy.yml at the same full SHA`);
  }
});

test("the checkout, Infisical, tailscale, and upload-artifact pins are byte-identical to deploy.yml's (and upload-artifact to the repo-wide pin)", () => {
  assert.match(workflow, new RegExp(`uses: ${escape(deployUses("actions/checkout"))}`));
  assert.match(workflow, new RegExp(`uses: ${escape(deployUses("Infisical/secrets-action"))}`));
  assert.match(workflow, new RegExp(`uses: ${escape(deployUses("tailscale/github-action"))}`));
  assert.match(workflow, new RegExp(`uses: ${escape(deployUses("actions/upload-artifact"))}`));
  assert.match(workflow, /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
});

// --- identity, path, and vars: nothing new beyond deploy-broker ---

test("Infisical reads only /platform/broker/ through deploy-broker's own identity variable, never a new one", () => {
  assert.match(workflow, /identity-id: \$\{\{ vars\.INFISICAL_BROKER_DEPLOY_IDENTITY_ID \}\}/);
  assert.match(workflow, /secret-path: "\/platform\/broker\/"/);
  assert.match(workflow, /method: oidc/);
  assert.match(workflow, /env-slug: prod/);
});

test("the only repository variables and secrets consumed are the ones deploy-broker already reads", () => {
  const vars = new Set([...code.matchAll(/vars\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...vars].sort(), ["DEPLOY_HOST", "INFISICAL_BROKER_DEPLOY_IDENTITY_ID", "INFISICAL_PROJECT_SLUG"]);
  assert.doesNotMatch(code, /\$\{\{\s*secrets\./);
});

test("Tailscale joins the tailnet exactly like deploy-broker: tag:ci, pinging DEPLOY_HOST, OAuth from the Infisical env", () => {
  assert.match(workflow, /oauth-client-id: \$\{\{ env\.TS_OAUTH_CLIENT_ID \}\}/);
  assert.match(workflow, /oauth-secret: \$\{\{ env\.TS_OAUTH_SECRET \}\}/);
  assert.match(workflow, /tags: tag:ci/);
  assert.match(workflow, /ping: \$\{\{ vars\.DEPLOY_HOST \}\}/);
});

// --- the read-only ssh allowlist (AC2) ---

/** Every line of executable code that starts an ssh invocation. */
function sshInvocations() {
  return code.split("\n").filter((line) => /(^|[\s;&|(`])ssh\s/.test(line));
}

test("exactly one ssh invocation exists, and it runs only the wrapper's own $remote variable (any other ssh command fails) (c)", () => {
  const invocations = sshInvocations();
  assert.deepEqual(
    invocations.map((line) => line.trim()),
    ['ssh "${ssh_options[@]}" "deploy@$DEPLOY_HOST" "$remote"'],
  );
});

test("no scp, rsync, or second transport: the only way off the runner is the one allowlisted ssh", () => {
  assert.doesNotMatch(code, /\bscp\b/);
  assert.doesNotMatch(code, /\brsync\b/);
  assert.doesNotMatch(code, /\bsftp\b/);
  assert.doesNotMatch(code, /\bnc\b\s/);
});

test("the wrapper's remote command set is exactly the allowlist: docker inspect of StartedAt, and docker logs --timestamps with an optional --since", () => {
  const remotes = [...code.matchAll(/remote="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(remotes.sort(), [
    "docker inspect --format '{{.State.StartedAt}}' $BROKER_CONTAINER",
    "docker logs --timestamps $BROKER_CONTAINER",
    "docker logs --timestamps --since $SINCE $BROKER_CONTAINER",
  ].sort());
});

test("the wrapper names exactly two verbs and refuses everything else", () => {
  const cases = [...code.matchAll(/^\s+([a-z|*-]+)\)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(cases, ["started-at", "audit-log", "*"]);
  assert.match(code, /refusing unlisted broker verb/);
});

test("the broker container is the Compose default name for project 'broker', service 'broker', replica 1, and is never discovered by a further command", () => {
  assert.match(code, /BROKER_CONTAINER=broker-broker-1/);
  assert.doesNotMatch(code, /docker (ps|container|service|network|volume|image)\b/);
});

test("--since is validated against a strict ISO-8601 shape before it is ever interpolated into the remote command", () => {
  const validation = code.indexOf("^[0-9]{4}-[0-9]{2}-[0-9]{2}T");
  const interpolation = code.indexOf("--since $SINCE");
  assert.ok(validation > -1, "no ISO-8601 validation of SINCE");
  assert.ok(interpolation > -1 && validation < interpolation, "validation must precede the interpolation");
});

// --- no write verbs anywhere (AC2) ---

test("no HTTP write verb appears anywhere in the workflow", () => {
  assert.doesNotMatch(code, /\b(POST|PATCH|DELETE|PUT)\b/);
  assert.doesNotMatch(code, /--request\b/);
  assert.doesNotMatch(code, /-X\s/);
});

test("no docker run, exec, compose, restart, stop, rm, or any other mutating docker verb", () => {
  assert.doesNotMatch(code, /\bdocker\s+(run|exec|compose|restart|stop|kill|rm|rmi|start|update|pull|push|load|save|build|cp|create|commit|system|image|container|volume|network|login|logout)\b/);
  assert.doesNotMatch(code, /\bdocker-compose\b/);
});

test("no mutating command on the box at all: no chmod, mkdir, tee, redirected write, or sed -i over remote files", () => {
  assert.doesNotMatch(code, /sed -i/);
  assert.doesNotMatch(code, /\bchmod\b/);
  assert.doesNotMatch(code, /\bmkdir\b/);
  assert.doesNotMatch(code, /\btee\b/);
});

// --- secrets never echoed ---

test("the workflow never echoes an environment value and never writes key material", () => {
  assert.doesNotMatch(code, /echo[^\n]*\$\{?SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(code, /echo[^\n]*\$\{?TS_OAUTH_SECRET/);
  assert.doesNotMatch(workflow, /-----BEGIN/);
});

// --- the report step and the artifact ---

test("the report is written to the step summary and uploaded as a JSON artifact, from the runner's temp directory", () => {
  assert.match(code, /node docs\/ops\/broker-soak-report\.mjs/);
  assert.match(code, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /name: broker-soak-report-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/broker-soak-report\.json/);
  assert.match(workflow, /if-no-files-found: error/);
});

test("the workflow's only ssh-reaching step is the read step, and it runs before the report step", () => {
  const readStep = code.indexOf("ssh \"${ssh_options[@]}\"");
  const reportStep = code.indexOf("node docs/ops/broker-soak-report.mjs");
  assert.ok(readStep > -1 && reportStep > readStep);
});

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
