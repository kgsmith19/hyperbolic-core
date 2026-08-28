// Structural assertions that every job actually mutating the production box
// or its data (issue #190) carries its own GitHub deployment environment --
// the native, per-job approval/protection point independent of this repo's
// own var gates -- while read-only or non-box-mutating jobs stay excluded.
// Extends the one precedent already live in this repo
// (platform-migrations.yml's `migrate` job, environment:
// platform-migrations-production) to every other prod-touching job rather
// than leaving it a one-off. Each test names the failure it exists to catch.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readWorkflow(file) {
  return readFileSync(path.join(root, ".github/workflows", file), "utf8");
}

function jobBlock(workflow, jobKey, nextJobKey) {
  const start = workflow.indexOf(`\n  ${jobKey}:`);
  assert.ok(start > -1, `job "${jobKey}" not found`);
  const end = nextJobKey
    ? workflow.indexOf(`\n  ${nextJobKey}:`, start + 1)
    : workflow.length;
  assert.ok(
    nextJobKey ? end > start : true,
    `job "${nextJobKey}" not found (used as end marker)`,
  );
  return workflow.slice(start, end === -1 ? undefined : end);
}

// --- deploy.yml ---

const deploy = readWorkflow("deploy.yml");

test("deploy.yml: every deploy job carries its own correctly-named production environment", () => {
  assert.match(
    jobBlock(deploy, "deploy-shell", "build-llm-handler"),
    /environment: shell-deploy-production/,
  );
  assert.match(
    jobBlock(deploy, "deploy-llm-handler", "build-brain"),
    /environment: llm-handler-deploy-production/,
  );
  assert.match(
    jobBlock(deploy, "deploy-brain", "smoke"),
    /environment: brain-deploy-production/,
  );
});

test("deploy.yml: migrate-platform picks up platform-migrations-production through the reusable workflow it calls, not a second declaration on the caller job", () => {
  // platform-migrations.yml's own `migrate` job already declares
  // `environment: platform-migrations-production` -- that is what actually
  // takes effect for a workflow_call. A second environment: on the calling
  // job here would be redundant, not additive.
  const migrateCaller = jobBlock(deploy, "migrate-platform", "build-shell");
  assert.doesNotMatch(migrateCaller, /environment:/);
  assert.match(
    migrateCaller,
    /uses: \.\/\.github\/workflows\/platform-migrations\.yml/,
  );
});

test("deploy.yml: smoke and tag-release are read-only or non-box-mutating and get no environment", () => {
  // smoke only probes; tag-release only calls the GitHub Git Data API to
  // create a tag -- neither touches the deployed box or its data.
  assert.doesNotMatch(jobBlock(deploy, "smoke", "tag-release"), /environment:/);
  assert.doesNotMatch(jobBlock(deploy, "tag-release"), /environment:/);
});

// --- lifeos-deploy.yml ---

const lifeosDeploy = readWorkflow("lifeos-deploy.yml");

test("lifeos-deploy.yml: both deploy jobs carry their own correctly-named production environment", () => {
  assert.match(
    jobBlock(lifeosDeploy, "deploy-backend", "deploy-ui"),
    /environment: lifeos-backend-deploy-production/,
  );
  assert.match(
    jobBlock(lifeosDeploy, "deploy-ui"),
    /environment: lifeos-ui-deploy-production/,
  );
});

// --- platform-backup.yml / lifeos-backup.yml ---

const platformBackup = readWorkflow("platform-backup.yml");
const lifeosBackup = readWorkflow("lifeos-backup.yml");

test("platform-backup.yml and lifeos-backup.yml: the bundle job carries its own production environment", () => {
  assert.match(
    jobBlock(platformBackup, "bundle"),
    /environment: platform-backup-production/,
  );
  assert.match(
    jobBlock(lifeosBackup, "bundle"),
    /environment: lifeos-backup-production/,
  );
});

// --- ops-serve-apply.yml / ops-edge.yml ---

const opsServeApply = readWorkflow("ops-serve-apply.yml");
const opsEdge = readWorkflow("ops-edge.yml");

function workflowConcurrency(workflow) {
  const match = workflow.match(
    /^concurrency:\n  group: (?<group>[^\n]+)\n  cancel-in-progress: (?<cancelInProgress>[^\n]+)\n  queue: (?<queue>[^\n]+)$/m,
  );
  assert.ok(match?.groups, "workflow-level concurrency block not found");
  return match.groups;
}

function assertOriginServeConcurrency(serveSource, edgeSource) {
  const serveConcurrency = workflowConcurrency(serveSource);
  const edgeConcurrency = workflowConcurrency(edgeSource);
  assert.equal(edgeConcurrency.group, "ops-origin-serve-production");
  assert.equal(
    serveConcurrency.group,
    "${{ inputs.origin_parent_run_id != '' && format('ops-origin-serve-child-{0}', inputs.origin_parent_run_id) || 'ops-origin-serve-production' }}",
  );
  assert.equal(serveConcurrency.cancelInProgress, "false");
  assert.equal(edgeConcurrency.cancelInProgress, "false");
  assert.equal(serveConcurrency.queue, "max");
  assert.equal(edgeConcurrency.queue, "max");
}

test("ops-serve-apply.yml and ops-edge.yml: both SSH-into-and-mutate-the-box jobs carry their own production environment", () => {
  assert.match(
    jobBlock(opsServeApply, "apply"),
    /environment: ops-serve-apply-production/,
  );
  assert.match(jobBlock(opsEdge, "deploy"), /environment: ops-edge-production/);
});

test("ops-serve-apply.yml and ops-edge.yml queue every direct mutation while a nested Serve child avoids parent-lock deadlock", () => {
  assertOriginServeConcurrency(opsServeApply, opsEdge);

  const mutants = [
    [opsServeApply.replace("  queue: max", "  queue: single"), opsEdge],
    [opsServeApply, opsEdge.replace("  queue: max", "  queue: single")],
    [
      opsServeApply.replace(
        "${{ inputs.origin_parent_run_id != '' && format('ops-origin-serve-child-{0}', inputs.origin_parent_run_id) || 'ops-origin-serve-production' }}",
        "ops-origin-serve-production",
      ),
      opsEdge,
    ],
  ];
  for (const [serveMutant, edgeMutant] of mutants) {
    assert.throws(() => assertOriginServeConcurrency(serveMutant, edgeMutant));
  }
});

// --- ops-restore-drill.yml: explicitly excluded ---

test("ops-restore-drill.yml never touches the deployed box (runs entirely against a throwaway Postgres in the runner) and gets no environment", () => {
  const opsRestoreDrill = readWorkflow("ops-restore-drill.yml");
  assert.doesNotMatch(opsRestoreDrill, /environment:/);
});

// --- existing dark-gate discipline unchanged ---

test("adding an environment: does not remove any existing vars.*_ENABLED gate -- environments are additive defense in depth, not a replacement", () => {
  assert.match(
    jobBlock(deploy, "deploy-shell", "build-llm-handler"),
    /vars\.DEPLOY_ENABLED == 'true'/,
  );
  assert.match(
    jobBlock(deploy, "deploy-llm-handler", "build-brain"),
    /vars\.DEPLOY_ENABLED == 'true'/,
  );
  assert.match(
    jobBlock(deploy, "deploy-brain", "smoke"),
    /vars\.DEPLOY_ENABLED == 'true'/,
  );
  assert.match(
    jobBlock(lifeosDeploy, "deploy-backend", "deploy-ui"),
    /vars\.LIFEOS_DEPLOY_ENABLED == 'true'/,
  );
  assert.match(
    jobBlock(lifeosDeploy, "deploy-ui"),
    /vars\.LIFEOS_DEPLOY_ENABLED == 'true'/,
  );
  assert.match(
    jobBlock(platformBackup, "bundle"),
    /vars\.PLATFORM_BACKUP_ENABLED == 'true'/,
  );
  assert.match(
    jobBlock(lifeosBackup, "bundle"),
    /vars\.LIFEOS_BACKUP_ENABLED == 'true'/,
  );
  assert.match(
    jobBlock(opsServeApply, "apply"),
    /vars\.DEPLOY_ENABLED == 'true'/,
  );
  const originDeploy = jobBlock(opsEdge, "deploy");
  assert.match(originDeploy, /vars\.DEPLOY_ENABLED == 'true'/);
  assert.match(originDeploy, /vars\.PRIVATE_ORIGIN_GATEWAY_ENABLED == 'true'/);
  assert.match(originDeploy, /if: vars\.CLOUDFLARE_EDGE_ENABLED == 'true'/);
});
