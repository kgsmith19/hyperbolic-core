// Structural assertions over .github/workflows/ops-restore-drill.yml (issue
// #168). Each test names the failure it catches. The first REAL drill
// against a real Storage Box happens once the owner has provisioned one --
// these tests verify the pipeline's shape, not a live restore.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/ops-restore-drill.yml"), "utf8");

test("the drill job is gated behind the same restic flag as the two backup pipelines", () => {
  // There is nothing to drill until restic backups are actually live.
  assert.match(workflow, /\n {4}needs: flags\n {4}if: needs\.flags\.outputs\.restic_backup_enabled == 'true'\n/);
});

test("the drill job runs in its own environment, so its OIDC subject is a narrow environment, not ref:refs/heads/main (#455)", () => {
  // Without an environment the subject is ref:refs/heads/main, which the
  // platform-restic identity rightly refuses; widening that identity to every
  // main-branch job would hand restic credentials to any workflow on main.
  assert.match(workflow, /\n {4}environment: ops-restore-drill-production\n/);
});

test("the cron is monthly, distinct from every nightly cron already scheduled", () => {
  assert.match(workflow, /cron: "15 10 1 \* \*"/);
  for (const taken of ['"52 9', '"41 8', '"17 9', '"17 8']) {
    assert.ok(!workflow.includes(taken), `collides with existing cron ${taken}`);
  }
});

test("restic reaches the box through the VPS (reachable only from Hetzner), and the VPS only relays: no scp, no remote command", () => {
  // Oracle change (#411): run 40628312552 proved the Storage Box has reachable_externally=false,
  // so the drill can no longer reach it directly from a runner. It joins the tailnet exactly as
  // lifeos-backup.yml does, and restic-setup.sh --via relays ssh through the VPS with nc.
  // Authentication still runs from the runner, and the drill still never touches production data.
  const lifeosBackup = readFileSync(path.join(root, ".github/workflows/lifeos-backup.yml"), "utf8");
  const join =
    /uses: tailscale\/github-action@([0-9a-f]{40}) # v[\d.]+\n {8}with:\n {10}oauth-client-id: \$\{\{ env\.TS_OAUTH_CLIENT_ID \}\}\n {10}oauth-secret: \$\{\{ env\.TS_OAUTH_SECRET \}\}\n {10}tags: tag:ci\n {10}ping: \$\{\{ vars\.DEPLOY_HOST \}\}\n/;
  const ours = workflow.match(join);
  assert.ok(ours, "no tailnet join step in the lifeos-backup.yml shape");
  assert.equal(ours[1], lifeosBackup.match(join)[1]);
  assert.match(workflow, /secret-path: "\/platform\/lifeos-deploy\/"/);
  assert.ok(workflow.indexOf('secret-path: "/platform/lifeos-deploy/"') < workflow.search(join), "tailnet client must be read before the join");
  assert.match(workflow, /--via="deploy@\$DEPLOY_HOST"/);
  assert.match(workflow, /DEPLOY_HOST: \$\{\{ vars\.DEPLOY_HOST \}\}/);
  assert.doesNotMatch(workflow, /\bssh\b[^\n]*deploy@/);
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

test("a Supabase-compatible Postgres 17, pinned by digest, backs the restore (#486)", () => {
  // Both dumps reference Supabase objects (auth.uid(), extensions.vector) that plain
  // postgres:17 lacks: run 40663902127 ignored 75 + 6 restore errors there.
  assert.match(workflow, /services:/);
  assert.match(workflow, /postgres:\s*\n\s*image: supabase\/postgres:17\.[0-9.]+@sha256:[0-9a-f]{64}\n/);
  assert.match(workflow, /--health-cmd pg_isready/);
});

test("both dumps restore strictly into the image's own postgres database, as the superuser, with vector enabled first (#486)", () => {
  // A database created from template1 has no auth schema, so the restore targets
  // `postgres` itself; platform uses its own schemas and lifeos uses public.
  assert.doesNotMatch(workflow, /createdb/);
  for (const label of ["platform", "lifeos"]) {
    const fn = drillFunction(label);
    const vector = fn.indexOf("create extension if not exists vector with schema extensions");
    const restore = fn.indexOf("pg_restore -h 127.0.0.1 -U supabase_admin --no-owner --no-privileges --exit-on-error");
    assert.ok(vector > -1 && restore > -1, `${label}: vector extension or strict pg_restore missing`);
    assert.ok(vector < restore, `${label}: vector must exist before the restore`);
    assert.match(fn, /--dbname postgres /);
  }
  // pg_dump --schema=public emits CREATE SCHEMA public, which already exists; only
  // that TOC entry is skipped, so --exit-on-error stays meaningful.
  const lifeos = drillFunction("lifeos");
  assert.match(lifeos, /grep -v ' SCHEMA - public '/);
  assert.match(lifeos, /-L \/tmp\/lifeos\.list/);
  assert.doesNotMatch(drillFunction("platform"), / -L /);
});

test("every verified table must answer an integer count (#486)", () => {
  for (const label of ["platform", "lifeos"]) {
    const fn = drillFunction(label);
    assert.match(fn, /psql -h 127\.0\.0\.1 -U supabase_admin postgres -X -At -v ON_ERROR_STOP=1 -c "select count\(\*\) from \$t"/);
    assert.match(fn, /\[\[ "\$n" =~ \^\[0-9\]\+\$ \]\]/);
  }
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
  // embedding (pgvector) failed to restore in run 40663902127 and went unnoticed (#486).
  assert.match(fn, /for t in entity type_definition event entity_type embedding; do/);
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
  const first = workflow.indexOf("run_drill platform\n");
  const second = workflow.indexOf("run_drill lifeos\n");
  assert.ok(first > -1 && second > -1 && first < second);
  assert.match(workflow, /exit "\$overall_status"/);
  // The fail-open shape (#486): bash ignores set -e inside a function called from ||.
  assert.doesNotMatch(workflow, /drill_(platform|lifeos) \|\|/);
});

/** Text of the run_drill() helper, brace to brace. */
function runDrillHelper() {
  const start = workflow.indexOf("run_drill() {");
  const end = workflow.indexOf("\n          }", start);
  assert.ok(start > -1 && end > -1, "run_drill helper not found");
  return workflow.slice(start, end + "\n          }".length);
}

function runDrillWith(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drill-"));
  const summary = path.join(dir, "summary.md");
  const marker = path.join(dir, "marker");
  writeFileSync(summary, "");
  const script = [
    "set -euo pipefail",
    `summary=${JSON.stringify(summary)}`,
    "overall_status=0",
    `drill_platform() {\n${body.replaceAll("MARKER", JSON.stringify(marker))}\n}`,
    runDrillHelper(),
    "run_drill platform",
    'echo "status=$overall_status"',
  ].join("\n");
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  let reached = false;
  try { readFileSync(marker); reached = true; } catch { reached = false; }
  return { out, summary: readFileSync(summary, "utf8"), reached };
}

test("run_drill: a failing command inside a drill stops that drill and records FAIL (#486)", () => {
  const failing = runDrillWith("  false\n  echo reached > MARKER");
  assert.equal(failing.reached, false, "a command after a failure ran: set -e is not effective inside the drill");
  assert.match(failing.summary, /\| `platform` \| \*\*FAIL\*\*/);
  assert.match(failing.out, /status=1/);

  const passing = runDrillWith("  echo reached > MARKER");
  assert.equal(passing.reached, true);
  assert.equal(passing.summary, "");
  assert.match(passing.out, /status=0/);
});

test("the summary is written to GITHUB_STEP_SUMMARY regardless of pass or fail, and links to runbook.md", () => {
  const summaryWrite = workflow.indexOf('cat "$summary" >> "$GITHUB_STEP_SUMMARY"');
  const exitCall = workflow.indexOf('exit "$overall_status"');
  assert.ok(summaryWrite > -1 && exitCall > -1);
  assert.ok(summaryWrite < exitCall, "the summary must be written before the step can exit non-zero");
  assert.match(workflow, /runbook\.md's restore-drill section/);
});

test("RPO is measured as the latest snapshot's age (now minus snapshot time), per repository", () => {
  // RPO = how much data a restore-from-latest would lose = the age of the
  // most recent backup, derived from the snapshot's own timestamp, never
  // assumed. #408.
  assert.match(workflow, /snapshot_epoch\(\) \{/);
  assert.match(workflow, /date -u -d "\$iso" \+%s/);
  assert.match(workflow, /rpo_seconds="\$\(\( now_epoch - snapshot_epoch_value \)\)"/);
  assert.equal(
    (workflow.match(/rpo_seconds="\$\(\( now_epoch - snapshot_epoch_value \)\)"/g) ?? []).length,
    2,
    "expected one RPO computation per repository",
  );
});

test("RTO is measured as the restore-to-usable wall-clock, per repository", () => {
  // RTO = time to recover to an operational database: bracketed from just
  // before the restic restore to after the row-count verification. #408.
  assert.match(workflow, /restore_start="\$\(date \+%s\)"/);
  assert.match(workflow, /restore_end="\$\(date \+%s\)"/);
  assert.match(workflow, /rto_seconds="\$\(\( restore_end - restore_start \)\)"/);
  assert.equal(
    (workflow.match(/rto_seconds="\$\(\( restore_end - restore_start \)\)"/g) ?? []).length,
    2,
    "expected one RTO computation per repository",
  );
});

test("RTO brackets the actual restore: restore_start precedes the restic restore, restore_end follows it", () => {
  for (const label of ["platform", "lifeos"]) {
    const fn = drillFunction(label);
    const start = fn.indexOf('restore_start="$(date +%s)"');
    const restore = fn.indexOf('restic -r "$repository" restore');
    const end = fn.indexOf('restore_end="$(date +%s)"');
    assert.ok(start > -1 && restore > -1 && end > -1, `${label}: missing RTO brackets`);
    assert.ok(start < restore, `${label}: restore_start must precede restic restore`);
    assert.ok(restore < end, `${label}: restore_end must follow the restore`);
  }
});

test("the summary records measured RPO and RTO columns, one value per repository row", () => {
  assert.match(workflow, /RPO \(s\)/);
  assert.match(workflow, /RTO \(s\)/);
  assert.ok((workflow.match(/\$rpo_seconds/g) ?? []).length >= 2, "each pass row must carry a measured RPO");
  assert.ok((workflow.match(/\$rto_seconds/g) ?? []).length >= 2, "each pass row must carry a measured RTO");
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
