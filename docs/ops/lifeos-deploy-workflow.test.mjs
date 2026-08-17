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
  assert.equal(checkouts.length, 3);
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
