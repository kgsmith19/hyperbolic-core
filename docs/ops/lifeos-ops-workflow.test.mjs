// Structural assertions over .github/workflows/lifeos-ops.yml -- the root
// port of the standalone LifeOS operator console (issue #140). Each test
// names the failure it catches.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/lifeos-ops.yml"), "utf8");

test("dispatch-only: no push, schedule, or pull_request trigger can reach production", () => {
  const onBlock = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /push:|schedule:|pull_request/);
});

test("the job is gated on the LifeOS cutover switch", () => {
  // Until vars.LIFEOS_DEPLOY_ENABLED flips at cutover, the standalone repo's
  // console owns the box; a dispatch here must be a visible skip.
  assert.match(workflow, /if: vars\.LIFEOS_DEPLOY_ENABLED == 'true'/);
});

test("the task inventory matches the standalone console exactly", () => {
  for (const task of [
    "define-daily-checkin",
    "migrate-durable-erasure",
    "migrate-bill-status",
    "migrate-bill-date-charset",
    "migrate-briefing-composition",
    "migrate-document-ref-anchor",
    "install-scheduled-jobs",
    "run-scheduled-jobs",
  ]) {
    assert.ok(workflow.includes(`- ${task}`), `missing task option: ${task}`);
    assert.ok(workflow.includes(`inputs.task == '${task}'`), `no step guarded on: ${task}`);
  }
});

test("dry_run executes nothing: every credentialed or mutating step is guarded", () => {
  // The dry-run plan step must be the ONLY step that runs when dry_run is
  // set -- including the Infisical pull (a dry run needs no credentials).
  const guards = workflow.match(/if: inputs\.dry_run != true/g) ?? [];
  // Secrets + 2 python setup + 6 migration tasks + join + 2 ssh tasks = 12
  assert.equal(guards.length, 12);
  assert.match(workflow, /if: inputs\.dry_run == true/); // the plan step itself
});

test("no GitHub Actions secrets and no SSH key material -- Infisical OIDC + Tailscale SSH only", () => {
  assert.doesNotMatch(workflow, /\$\{\{ secrets\./);
  assert.doesNotMatch(workflow, /SSH_KEY/);
  assert.doesNotMatch(workflow, /id_ed25519/);
  assert.match(workflow, /secret-path: "\/platform\/lifeos-deploy\/"/);
});

test("the tailnet join is scoped to the two SSH tasks only", () => {
  // Database-only migration tasks must not join the tailnet: least access.
  const joinStep = workflow.slice(
    workflow.indexOf("- name: Network · Join tailnet"),
    workflow.indexOf("tailscale/github-action@"),
  );
  assert.match(joinStep, /inputs\.task == 'install-scheduled-jobs' \|\| inputs\.task == 'run-scheduled-jobs'/);
});

test("the cron wrapper preserves the standalone semantics verbatim where they matter", () => {
  // Sentinel-delimited idempotent crontab edit, 06:15 box-time slot, 1 MiB
  // log rotation, per-job failure isolation, and the exact nightly trio.
  assert.match(workflow, /# >>> lifeos jobs/);
  assert.match(workflow, /# <<< lifeos jobs/);
  assert.match(workflow, /15 6 \* \* \*/);
  assert.match(workflow, /-ge 1048576/);
  assert.match(workflow, /domains\.calendar\.ingest domains\.calendar\.autolink domains\.ops\.briefing/);
  assert.match(workflow, /\|\| status=1/);
});

test("both remote scripts run under strict mode and republish output to the step summary", () => {
  const heredocs = workflow.match(/<<'REMOTE'\n\s+set -euo pipefail/g) ?? [];
  assert.equal(heredocs.length, 2);
  const summaries = workflow.match(/>> "\$GITHUB_STEP_SUMMARY"/g) ?? [];
  assert.ok(summaries.length >= 3); // dry-run plan + both SSH tasks
});

test("checkout does not persist credentials and the concurrency group is its own", () => {
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /group: lifeos-ops-production/);
  assert.match(workflow, /cancel-in-progress: false/);
});
