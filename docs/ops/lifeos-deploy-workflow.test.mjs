// Structural assertions over .github/workflows/lifeos-deploy.yml -- the
// root-authored LifeOS deploy (issue #138). Same rationale as
// deploy-workflow.test.mjs: the properties below are the workflow's safety
// contract, and a quiet edit that drops one should fail a gate, not be
// discovered live. Each test names the failure it exists to catch.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/lifeos-deploy.yml"), "utf8");

const backendJob = workflow.slice(
  workflow.indexOf("  deploy-backend:"),
  workflow.indexOf("  deploy-ui:"),
);
const uiJob = workflow.slice(workflow.indexOf("  deploy-ui:"));

test("both deploy jobs carry BOTH production gates and the main-ref guard", () => {
  // The double gate is the two-writers race breaker: LIFEOS_DEPLOY_ENABLED
  // stays unset until the standalone repo's pipeline is switched off, so this
  // workflow is provably inert until the ordered cutover. Losing either gate
  // on either job reopens the race (or deploys from a disabled repo).
  for (const job of [backendJob, uiJob]) {
    assert.match(job, /vars\.DEPLOY_ENABLED == 'true'/);
    assert.match(job, /vars\.LIFEOS_DEPLOY_ENABLED == 'true'/);
    assert.match(job, /github\.ref == 'refs\/heads\/main'/);
  }
});

test("no registry anywhere: no login action, no image push, no ghcr reference", () => {
  // The Workflow Safety Invariant exists because the standalone ci.yml's
  // build-backend job would publish a ghcr image on every push if it ran here.
  // This workflow is built to make that hazard structurally impossible: the
  // image is built in-job and shipped over SSH, so there is nothing to leak.
  assert.doesNotMatch(workflow, /docker\/login-action/);
  assert.doesNotMatch(workflow, /docker\/build-push-action/);
  assert.doesNotMatch(workflow, /push:\s*true/);
  assert.doesNotMatch(workflow, /ghcr\.io/);
});

test("no SSH key material: keyless Tailscale SSH only (ADR 008)", () => {
  assert.doesNotMatch(workflow, /id_ed25519/);
  assert.doesNotMatch(workflow, /SSH_KEY/);
  assert.doesNotMatch(workflow, /webfactory\/ssh-agent/);
  // Reachability still requires the tailnet join in both deploy jobs.
  const joins = workflow.match(/tailscale\/github-action@/g) ?? [];
  assert.equal(joins.length, 2);
});

test("no GitHub Actions secrets at all -- Infisical OIDC is the only secret source", () => {
  assert.doesNotMatch(workflow, /secrets\./);
  const paths = workflow.match(/secret-path: "\/platform\/lifeos-deploy\/"/g) ?? [];
  assert.equal(paths.length, 2);
});

test("every checkout refuses to persist credentials", () => {
  const checkouts = workflow.match(/actions\/checkout@/g) ?? [];
  const persists = workflow.match(/persist-credentials: false/g) ?? [];
  assert.equal(checkouts.length, 4);
  assert.equal(persists.length, checkouts.length);
});

test("backend renders the one-origin root path and applies migrations before shipping", () => {
  // LIFEOS_ROOT_PATH=/life/api is what makes the backend routable behind the
  // full-path-forwarding /life/api/ serve mount; without it every proxied
  // request 404s. Migrations must land before the new container expects them.
  assert.match(backendJob, /LIFEOS_ROOT_PATH=\/life\/api/);
  const migrateAt = backendJob.indexOf("supabase db push");
  const shipAt = backendJob.indexOf("docker save");
  assert.ok(migrateAt > -1 && shipAt > -1 && migrateAt < shipAt);
});

test("UI is a versioned-dir release: stage, activate, verify, roll back, prune -- in that order", () => {
  // This ordering is the whole improvement over the standalone pipeline's
  // destructive rm -rf swap: a failed verify repoints `current` at the
  // previous release instead of leaving a half-deployed tree.
  const stage = uiJob.indexOf("Deploy · Stage the release");
  const activate = uiJob.indexOf("Deploy · Activate the release");
  const verify = uiJob.indexOf("Verify · Live bundle serves the built assets");
  const rollback = uiJob.indexOf("Recover · Roll back an unhealthy release");
  const prune = uiJob.indexOf("Prune · Retire old releases");
  assert.ok(stage > -1 && activate > stage && verify > activate && rollback > verify && prune > rollback);
  assert.match(uiJob, /if: failure\(\) && steps\.activate\.outputs\.previous != ''/);
  // Same-origin API base baked into the bundle.
  assert.match(uiJob, /VITE_API_URL: \/life\/api/);
});

test("the two deploy jobs use distinct, non-cancelling production concurrency groups", () => {
  assert.match(backendJob, /group: deploy-lifeos-backend-production/);
  assert.match(uiJob, /group: deploy-lifeos-ui-production/);
  const cancels = workflow.match(/cancel-in-progress: false/g) ?? [];
  assert.equal(cancels.length, 2);
});

test("the pinned Supabase CLI version is asserted before any database contact", () => {
  const pin = backendJob.indexOf('test "$(supabase --version)" = "2.114.0"');
  const push = backendJob.indexOf("supabase db push");
  assert.ok(pin > -1 && push > -1 && pin < push);
});

test("activate and rollback run under REMOTE strict mode, not ;-joined one-liners", () => {
  // The independent verification of this issue's first head found exactly this
  // regression: without a remote `set -euo pipefail`, a failed `test ! -e`
  // guard or mv does not stop the remote sequence, and the ssh exit status is
  // the LAST command's -- so a broken symlink flip reports green. The remote
  // scripts must carry their own strict mode, like deploy.yml's proven jobs.
  const remoteStrict = uiJob.match(/"deploy@\$DEPLOY_HOST" "\n\s+set -euo pipefail/g) ?? [];
  assert.equal(remoteStrict.length, 2); // activate + rollback
});

test("the UI build finishes before any secret reaches the job environment", () => {
  // Infisical exports to GITHUB_ENV; npm install lifecycle scripts must never
  // see production credentials. Build (vars-only) must precede the pull.
  const build = uiJob.indexOf("Build · Build the UI");
  const secrets = uiJob.indexOf("Secrets · Pull deploy configuration");
  assert.ok(build > -1 && secrets > -1 && build < secrets);
});

test("prune-script changes redeploy the LifeOS units that ship them", () => {
  assert.match(workflow, /docs\/ops\/prune-dist-dirs\.sh/);
  assert.match(workflow, /docs\/ops\/prune-docker-images\.sh/);
  assert.match(workflow, /prune-docker-images\\\.sh\$/); // backend classify regex
  assert.match(workflow, /prune-dist-dirs\\\.sh\$/); // ui classify regex
});

test("both deploy jobs validate DEPLOY_HOST before first use", () => {
  const validations = workflow.match(/DEPLOY_HOST must be a non-empty DNS name/g) ?? [];
  assert.equal(validations.length, 2);
});

// --- ops-serve-apply.yml (issue #142): the serve route transport ---

const serveApply = readFileSync(path.join(root, ".github/workflows/ops-serve-apply.yml"), "utf8");

test("serve-apply is dispatch-only, production-gated, and ships the checked-in script verbatim", () => {
  const onBlock = serveApply.slice(serveApply.indexOf("\non:"), serveApply.indexOf("\npermissions:"));
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /push:|schedule:|pull_request/);
  assert.match(serveApply, /if: vars\.DEPLOY_ENABLED == 'true'/);
  // Transport-only: the workflow must scp the tested script, never inline a
  // second copy of the route map that could drift from the tested one.
  assert.match(serveApply, /scp .* docs\/ops\/tailscale-serve-apply\.sh/);
  assert.doesNotMatch(serveApply, /--set-path/);
  assert.match(serveApply, /--apply/);
  assert.doesNotMatch(serveApply, /serve reset/);
});

test("serve-apply is keyless, secretless, strict-moded, and publishes before/after status", () => {
  assert.doesNotMatch(serveApply, /\$\{\{ secrets\./);
  assert.doesNotMatch(serveApply, /SSH_KEY|id_ed25519/);
  assert.match(serveApply, /<<'REMOTE'\n\s+set -euo pipefail/);
  assert.match(serveApply, /serve status BEFORE/);
  assert.match(serveApply, /serve status AFTER/);
  assert.match(serveApply, />> "\$GITHUB_STEP_SUMMARY"/);
});

test("tag-release (issue #189): contents: write is scoped to that job alone, nowhere else in the file", () => {
  const writeOccurrences = workflow.match(/contents: write/g) ?? [];
  assert.equal(writeOccurrences.length, 1, "exactly one contents: write in the whole file");
  const tagJob = workflow.slice(workflow.indexOf("  tag-release:"));
  assert.match(tagJob, /contents: write/);
});

test("tag-release only fires once the run's overall smoke verdict succeeded, not merely because a deploy job did", () => {
  const tagJob = workflow.slice(workflow.indexOf("  tag-release:"));
  assert.match(tagJob, /needs\.smoke\.result == 'success'/);
  assert.match(tagJob, /vars\.LIFEOS_DEPLOY_ENABLED == 'true'/);
  assert.doesNotMatch(tagJob, /needs\.deploy-backend\.result == 'success' \|\|/);
});

test("tag-release calls tag-release.sh once per unit, passing that unit's own deploy result and the exact deployed sha", () => {
  const tagJob = workflow.slice(workflow.indexOf("  tag-release:"));
  assert.match(tagJob, /BACKEND_RESULT: \$\{\{ needs\.deploy-backend\.result \}\}/);
  assert.match(tagJob, /UI_RESULT: \$\{\{ needs\.deploy-ui\.result \}\}/);
  assert.match(tagJob, /docs\/ops\/tag-release\.sh lifeos-backend "\$BACKEND_RESULT" "\$SHA"/);
  assert.match(tagJob, /docs\/ops\/tag-release\.sh lifeos-ui "\$UI_RESULT" "\$SHA"/);
  assert.match(tagJob, /SHA: \$\{\{ github\.sha \}\}/);
});

test("tag-release checks out with credentials not persisted, matching every other job in this file", () => {
  const tagJob = workflow.slice(workflow.indexOf("  tag-release:"));
  assert.match(tagJob, /persist-credentials: false/);
});
