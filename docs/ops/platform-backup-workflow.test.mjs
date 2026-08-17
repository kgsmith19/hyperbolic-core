// Structural assertions over .github/workflows/platform-backup.yml -- the
// restic-primary addition (issue #166). Each test names the failure it
// catches.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/platform-backup.yml"), "utf8");

/** Text of one `- name: <name>` step block, up to (not including) the next `- name:`/`- uses:` at the same indent. */
function stepBlock(afterMarker, nextMarkers) {
  const start = workflow.indexOf(afterMarker);
  assert.ok(start > -1, `step not found: ${afterMarker}`);
  let end = workflow.length;
  for (const marker of nextMarkers) {
    const index = workflow.indexOf(marker, start + afterMarker.length);
    if (index > -1 && index < end) end = index;
  }
  return workflow.slice(start, end);
}

test("the restic credentials and backup steps are gated behind RESTIC_BACKUP_ENABLED", () => {
  const credentials = stepBlock("- name: Storage Box restic credentials", [
    "- name: Back up the platform dump",
  ]);
  assert.match(credentials, /if: vars\.RESTIC_BACKUP_ENABLED == 'true'/);

  const backup = stepBlock("- name: Back up the platform dump to the Hetzner Storage Box (restic)", [
    "- name: Record the run id",
  ]);
  assert.match(backup, /if: vars\.RESTIC_BACKUP_ENABLED == 'true'/);
});

test("the existing age->artifact path carries no RESTIC_BACKUP_ENABLED gate of its own", () => {
  // The old path must be provably unaffected by the new var's state either
  // way -- a gate leaking onto it here would make it stop running the
  // moment the owner turns restic on, which is not what "primary + free
  // secondary" means. Match the expression form only: the handoff comment
  // in this same block legitimately NAMES the variable to explain why the
  // copy is unconditional.
  const oldPath = stepBlock("- name: Validate backup configuration", [
    "- name: Storage Box restic credentials",
  ]);
  assert.doesNotMatch(oldPath, /if:\s*vars\.RESTIC_BACKUP_ENABLED/);
});

test("restic reads a distinct Infisical identity and path from the SUPABASE_DB_URL step", () => {
  // ADR-05: a compromised restic credential must not also unlock the
  // database, and vice versa -- so this cannot reuse
  // INFISICAL_PLATFORM_BACKUP_IDENTITY_ID or the /toolbelt/ path.
  assert.match(workflow, /identity-id: \$\{\{ vars\.INFISICAL_PLATFORM_RESTIC_IDENTITY_ID \}\}/);
  assert.match(workflow, /secret-path: "\/platform\/backup\/"/);
  const dbUrlIdentityCount = (workflow.match(/INFISICAL_PLATFORM_BACKUP_IDENTITY_ID/g) ?? []).length;
  assert.equal(dbUrlIdentityCount, 1, "the DB identity var must appear exactly once, never reused for restic");
});

test("no GitHub Actions secret and no key material hardcoded -- Infisical OIDC only", () => {
  assert.doesNotMatch(workflow, /\$\{\{ secrets\./);
  assert.doesNotMatch(workflow, /-----BEGIN/);
  assert.match(workflow, /STORAGEBOX_SSH_KEY/);
  // The key is written to an mktemp'd file, never a fixed path checked in
  // or logged.
  assert.match(workflow, /key_file=\$\(mktemp\)/);
  // Match actual shell expansion of the secret value, not the validation
  // step's error message, which legitimately names the variable in prose
  // ("...were not supplied by Infisical") without ever printing its value.
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{?STORAGEBOX_SSH_KEY/);
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{?RESTIC_PASSWORD/);
});

test("the dump is handed off through RUNNER_TEMP, not re-dumped a second time", () => {
  // A second pg_dump would risk a different snapshot than the one the age
  // path just encrypted, and doubles the load on the platform database for
  // no reason. Match the actual invocation, not the pre-existing comment
  // that mentions pg_dump's version-skew error message in prose.
  const dumpCount = (workflow.match(/pg_dump --format=custom/g) ?? []).length;
  assert.equal(dumpCount, 1);
  assert.match(workflow, /cp "\$payload\/platform\.dump" "\$RUNNER_TEMP\/platform\.dump"/);
  assert.match(workflow, /if \[ ! -s "\$RUNNER_TEMP\/platform\.dump" \]/);
});

test("the handoff happens before the age path's own trap deletes $work", () => {
  const copyToRunnerTemp = workflow.indexOf('cp "$payload/platform.dump" "$RUNNER_TEMP/platform.dump"');
  const encrypt = workflow.indexOf("age -r");
  assert.ok(copyToRunnerTemp > -1 && encrypt > -1);
  assert.ok(copyToRunnerTemp < encrypt);
});

test("restic reuses docs/ops/restic-setup.sh rather than reimplementing install/config", () => {
  assert.match(workflow, /\.\/docs\/ops\/restic-setup\.sh --apply/);
  assert.match(workflow, /--repos=platform/);
  // Never lifeos -- this is the platform pipeline only (E3 is the LifeOS one).
  assert.doesNotMatch(workflow, /--repos=platform,lifeos/);
  assert.doesNotMatch(workflow, /--repos=lifeos/);
});

test("retention matches the Issue's exact policy: 7 daily / 4 weekly / 6 monthly, pruned", () => {
  assert.match(workflow, /--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune/);
});

test("backup and forget run before the snapshot is asserted present", () => {
  const backupCall = workflow.indexOf("restic -r \"$repository\" backup");
  const forgetCall = workflow.indexOf("restic -r \"$repository\" forget");
  const snapshotsCall = workflow.indexOf("restic -r \"$repository\" snapshots");
  assert.ok(backupCall > -1 && forgetCall > -1 && snapshotsCall > -1);
  assert.ok(backupCall < forgetCall);
  assert.ok(forgetCall < snapshotsCall);
  assert.match(workflow, /snapshots --tag "run-\$\{GITHUB_RUN_ID\}" --json/);
});

test("every restic step still runs under strict mode", () => {
  const backup = stepBlock("- name: Back up the platform dump to the Hetzner Storage Box (restic)", [
    "- name: Record the run id",
  ]);
  assert.match(backup, /set -euo pipefail/);
});
