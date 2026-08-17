// Structural assertions over .github/workflows/ops-restore-drill.yml (issue
// #168). Each test names the failure it catches. The first REAL drill
// against a real Storage Box happens once the owner has provisioned one --
// these tests verify the pipeline's shape, not a live restore.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/ops-restore-drill.yml"), "utf8");

test("the drill job is gated behind the same RESTIC_BACKUP_ENABLED var as the two backup pipelines", () => {
  // There is nothing to drill until restic backups are actually live.
  assert.match(workflow, /if: vars\.RESTIC_BACKUP_ENABLED == 'true'/);
});

test("the cron is monthly, distinct from every nightly cron already scheduled", () => {
  assert.match(workflow, /cron: "15 10 1 \* \*"/);
  for (const taken of ['"52 9', '"41 8', '"17 9', '"17 8']) {
    assert.ok(!workflow.includes(taken), `collides with existing cron ${taken}`);
  }
});

test("no Tailscale join and no SSH to the VPS -- this drill only talks to the Storage Box", () => {
  // Both restic repositories are reachable directly over SFTP; nothing
  // this workflow does needs to reach the production box at all.
  assert.doesNotMatch(workflow, /tailscale\/github-action@/);
  assert.doesNotMatch(workflow, /\bssh\b.*deploy@/);
  assert.doesNotMatch(workflow, /\bscp\b/);
});

test("restic credentials come from the same Infisical identity/path as both backup pipelines", () => {
  assert.match(workflow, /identity-id: \$\{\{ vars\.INFISICAL_PLATFORM_RESTIC_IDENTITY_ID \}\}/);
  assert.match(workflow, /secret-path: "\/platform\/backup\/"/);
});

test("no GitHub Actions secret and no key material ever echoed", () => {
  assert.doesNotMatch(workflow, /\$\{\{ secrets\./);
  assert.doesNotMatch(workflow, /-----BEGIN/);
  const joined = workflow.replace(/\\\n[ \t]*/g, " ");
  assert.doesNotMatch(joined, /echo[^\n]*\$\{?STORAGEBOX_SSH_KEY/);
  assert.doesNotMatch(joined, /echo[^\n]*\$\{?RESTIC_PASSWORD/);
});

test("restic-setup.sh is reused for install/config, against both repositories", () => {
  assert.match(workflow, /\.\/docs\/ops\/restic-setup\.sh --apply/);
  assert.match(workflow, /--repos=platform,lifeos/);
});

test("a real, pinned Postgres 17 service backs the restore -- matching the dump-producing pipelines' own pin", () => {
  assert.match(workflow, /services:/);
  assert.match(workflow, /postgres:\s*\n\s*image: postgres:17/);
  assert.match(workflow, /--health-cmd pg_isready/);
});

/** Text of one `drill_<label>() { ... }` shell function, brace to brace. */
function drillFunction(label) {
  const fnStart = workflow.indexOf(`drill_${label}() {`);
  const fnEnd = workflow.indexOf("\n          }", fnStart);
  assert.ok(fnStart > -1 && fnEnd > -1, `drill_${label} function not found`);
  return workflow.slice(fnStart, fnEnd);
}

test("each repository's drill runs check, then restore, then the row-count loop, in that order", () => {
  for (const label of ["platform", "lifeos"]) {
    const fn = drillFunction(label);
    const checkCall = fn.indexOf('restic -r "$repository" check --read-data-subset=10%');
    const restoreCall = fn.indexOf('restic -r "$repository" restore');
    const countLoop = fn.indexOf("select count(*) from $t");
    assert.ok(checkCall > -1 && restoreCall > -1 && countLoop > -1, `${label}: missing check/restore/count-loop`);
    assert.ok(checkCall < restoreCall, `${label}: check must run before restore`);
    assert.ok(restoreCall < countLoop, `${label}: restore must run before the row-count loop`);
  }
});

test("the platform drill's table loop matches the manual platform drill in runbook.md, table for table", () => {
  // Consistency: this is the same set the existing (manual) restore drill
  // documented under "Platform project backup and restore" already uses --
  // a different set here would mean the two drills prove different things.
  const fn = drillFunction("platform");
  assert.match(
    fn,
    /for t in platform\.config core\.app core\.run core\.cost prompt\.prompt idea\.idea intake\.idea; do/,
  );
});

test("the lifeos drill's table loop uses the real kernel tables, not a guessed schema", () => {
  // apps/lifeos/backend/supabase/migrations/20260724000000_kernel.sql:
  // entity/type_definition/event/entity_type are the actual public-schema
  // tables every domain record and event passes through -- not a
  // documents/whatever table that does not exist (there is no per-domain
  // table; documents are entity rows, per ADR 015).
  const fn = drillFunction("lifeos");
  assert.match(fn, /for t in entity type_definition event entity_type; do/);
});

test("the lifeos drill asserts the restored blob directory is non-empty, not just present", () => {
  assert.match(workflow, /blob_file_count="\$\(find "\$blobs_dir" -type f \| wc -l\)"/);
  assert.match(workflow, /test "\$blob_file_count" -gt 0/);
});

test("both dump archives are verified with pg_restore --list before any restore is attempted", () => {
  const listCalls = (workflow.match(/pg_restore --list < "\$dump_file" > \/dev\/null/g) ?? []).length;
  assert.equal(listCalls, 2, "expected one pg_restore --list check per repository");
});

test("a failure in one repository's drill does not prevent the other's from running or from being reported", () => {
  // set -euo pipefail is active for the whole step; `drill_platform || { ... }`
  // is what stops a failing platform drill from aborting the script before
  // drill_lifeos ever runs -- and from silently vanishing instead of
  // landing in the summary as a FAIL row.
  const platformCall = workflow.indexOf("drill_platform || {");
  const lifeosCall = workflow.indexOf("drill_lifeos || {");
  assert.ok(platformCall > -1 && lifeosCall > -1);
  assert.ok(platformCall < lifeosCall);
  assert.match(workflow, /overall_status=1/);
  assert.match(workflow, /exit "\$overall_status"/);
});

test("the summary is written to GITHUB_STEP_SUMMARY regardless of pass or fail, and links to runbook.md", () => {
  const summaryWrite = workflow.indexOf('cat "$summary" >> "$GITHUB_STEP_SUMMARY"');
  const exitCall = workflow.indexOf('exit "$overall_status"');
  assert.ok(summaryWrite > -1 && exitCall > -1);
  assert.ok(summaryWrite < exitCall, "the summary must be written before the step can exit non-zero");
  assert.match(workflow, /runbook\.md's restore-drill section/);
});

test("the step runs under strict mode and cleans up its temp directory unconditionally", () => {
  assert.match(workflow, /set -euo pipefail/);
  assert.match(workflow, /trap 'rm -rf "\$tmp"' EXIT/);
});

test("the ops-restore-drill.yml script parses as valid bash", () => {
  // Substitute the two GH expressions the same way GitHub Actions itself
  // would (literal text) before handing the script to bash -n.
  const match = workflow.match(/run: \|\n((?:[ \t]+.*\n?)+)/);
  assert.ok(match, "could not extract the step's run: block");
  const script = match[1]
    .replace(/\$\{\{ vars\.STORAGEBOX_HOST \}\}/g, "u123456.your-storagebox.de")
    .replace(/\$\{\{ vars\.STORAGEBOX_USER \}\}/g, "u123456-sub1");
  assert.doesNotThrow(() => execFileSync("bash", ["-n"], { input: `#!/usr/bin/env bash\n${script}` }));
});
