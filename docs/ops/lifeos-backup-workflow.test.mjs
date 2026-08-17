// Structural assertions over .github/workflows/lifeos-backup.yml -- the
// root-authored LifeOS nightly backup (issue #139), the like-for-like port of
// the standalone repo's backup.yml. Each test names the failure it catches.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/lifeos-backup.yml"), "utf8");

test("the bundle job is gated dark behind LIFEOS_BACKUP_ENABLED", () => {
  // Until the ordered cutover flips this var, the standalone pipeline owns
  // the nightly. Losing the gate double-backs-up and splits ownership.
  assert.match(workflow, /if: vars\.LIFEOS_BACKUP_ENABLED == 'true'/);
});

test("the cron slot collides with no existing scheduled workflow", () => {
  // Existing slots: platform backup 52 9, standalone LifeOS backup 17 8,
  // brain-eval-nightly 17 9 (all UTC). This pipeline takes 41 8.
  assert.match(workflow, /cron: "41 8 \* \* \*"/);
  for (const taken of ['"52 9', '"17 8', '"17 9']) {
    assert.ok(!workflow.includes(taken), `collides with existing cron ${taken}`);
  }
});

test("the age recipient is LifeOS's own variable, never the platform pipeline's", () => {
  // Deliberate key separation: the two backup pipelines must never share a
  // key pair, so a leaked private key unlocks one archive family, not both.
  assert.match(workflow, /\{\{ vars\.LIFEOS_AGE_PUBLIC_KEY \}\}/);
  // Assert on the expression form, not prose: the header comment legitimately
  // NAMES the platform variable to explain the separation.
  assert.doesNotMatch(workflow, /\{\{ vars\.PLATFORM_AGE_PUBLIC_KEY/);
  assert.match(workflow, /age1\*\)/); // recipient-not-identity validation
});

test("no GitHub Actions secrets and no persistent deploy SSH key material -- Infisical OIDC + Tailscale SSH only", () => {
  // Expression form only -- the header prose says "GitHub Actions secrets".
  assert.doesNotMatch(workflow, /\$\{\{ secrets\./);
  // STORAGEBOX_SSH_KEY (issue #167) is a per-run restic transport
  // credential injected from Infisical and never persisted -- a different
  // thing from a long-lived deploy SSH key. Assert on the deploy-key
  // pattern specifically, not the bare substring "SSH_KEY".
  assert.doesNotMatch(workflow, /(?<!STORAGEBOX_)SSH_KEY/);
  assert.doesNotMatch(workflow, /id_ed25519/);
  assert.match(workflow, /secret-path: "\/platform\/lifeos-deploy\/"/);
  assert.match(workflow, /tailscale\/github-action@/);
});

test("both bundle members are verified BEFORE encryption", () => {
  // A bundle that cannot be listed is not a backup; discovering that during
  // a restore is too late. pg_restore --list and tar -tf must both precede
  // the age encryption.
  const restoreList = workflow.indexOf("pg_restore --list");
  const tarList = workflow.indexOf("tar -tf");
  const encrypt = workflow.indexOf("age -r");
  assert.ok(restoreList > -1 && tarList > -1 && encrypt > -1);
  assert.ok(restoreList < encrypt && tarList < encrypt);
  // And the ciphertext header is asserted after encryption.
  assert.match(workflow, /age-encryption\.org/);
});

test("the bundle captures the database AND the document blob volume", () => {
  // The stale claim this Epic already fixed (issue #137) said blobs were
  // excluded; the port must not silently make that claim true.
  assert.match(workflow, /--schema=public/);
  assert.match(workflow, /\/app\/var\/blobs/);
  assert.match(workflow, /SHA256SUMS/);
});

test("the artifact upload fails loudly when the bundle is missing", () => {
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /retention-days: 90/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
});

test("the remote blob stream runs under strict mode with no plaintext archive on the host", () => {
  // The heredoc'd remote script must carry its own set -euo pipefail (same
  // class of bug independent verification caught on lifeos-deploy.yml), and
  // the tar must stream to the runner, never to a file on the box.
  const heredoc = workflow.slice(workflow.indexOf("<<'REMOTE'"), workflow.indexOf("REMOTE", workflow.indexOf("<<'REMOTE'") + 10));
  assert.match(heredoc, /set -euo pipefail/);
  assert.match(workflow, />\s*"\$payload\/lifeos-blobs\.tar"/);
});

/** Text of one `- name: <name>` step block, up to (not including) the next `- name:` at the same indent. */
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

test("the restic credentials and backup steps are gated behind RESTIC_BACKUP_ENABLED, the same var as the platform pipeline", () => {
  // One switch for both pipelines (Issue #167's own acceptance criterion).
  const credentials = stepBlock("- name: Restic · Pull Storage Box credentials from Infisical", [
    "- name: Restic · Back up the dump",
  ]);
  assert.match(credentials, /if: vars\.RESTIC_BACKUP_ENABLED == 'true'/);

  const backup = stepBlock("- name: Restic · Back up the dump and live blobs volume on the box", [
    "- name: Restic · Fail the job",
  ]);
  assert.match(backup, /if: vars\.RESTIC_BACKUP_ENABLED == 'true'/);
});

test("the existing age->artifact path (bundle through publish) carries no RESTIC_BACKUP_ENABLED gate of its own", () => {
  const oldPath = stepBlock("- name: Bundle · Create, verify, and encrypt the recovery bundle", [
    "- name: Restic · Pull Storage Box credentials",
  ]);
  assert.doesNotMatch(oldPath, /if:\s*(\$\{\{\s*)?vars\.RESTIC_BACKUP_ENABLED/);
});

test("restic reads the same Infisical identity/path as the platform pipeline's restic step", () => {
  // Both pipelines back up to the same Storage Box account and share one
  // RESTIC_PASSWORD across repositories by design (docs/ops/restic-setup.sh's
  // own header comment) -- so reusing the identity/path here is intentional,
  // not a copy-paste of the DB-credential mistake ADR-05 warns against
  // (there is no database credential in this step at all).
  assert.match(workflow, /identity-id: \$\{\{ vars\.INFISICAL_PLATFORM_RESTIC_IDENTITY_ID \}\}/);
  assert.match(workflow, /secret-path: "\/platform\/backup\/"/);
});

test("both restic steps carry continue-on-error, and a final gate step re-fails the job after them", () => {
  // Same shape as platform-backup.yml's own fix (issue #176): a restic
  // hiccup must never fail the job directly (which would risk masking the
  // age backup's own already-successful upload), only through the explicit
  // gate step placed after everything else.
  const credentials = stepBlock("- name: Restic · Pull Storage Box credentials from Infisical", [
    "- name: Restic · Back up the dump",
  ]);
  assert.match(credentials, /id: restic-credentials/);
  assert.match(credentials, /continue-on-error: true/);

  const backup = stepBlock("- name: Restic · Back up the dump and live blobs volume on the box", [
    "- name: Restic · Fail the job",
  ]);
  assert.match(backup, /id: restic-backup/);
  assert.match(backup, /continue-on-error: true/);

  const publishIndex = workflow.indexOf("- name: Publish · Upload the encrypted bundle");
  const gateIndex = workflow.indexOf("- name: Restic · Fail the job if the Storage Box backup did not succeed");
  assert.ok(publishIndex > -1 && gateIndex > -1);
  assert.ok(publishIndex < gateIndex, "the gate step must come after the age path's own upload step");

  const gate = stepBlock("- name: Restic · Fail the job if the Storage Box backup did not succeed", []);
  assert.match(gate, /if: vars\.RESTIC_BACKUP_ENABLED == 'true' && \(steps\.restic-credentials\.outcome != 'success' \|\| steps\.restic-backup\.outcome != 'success'\)/);
  assert.match(gate, /exit 1/);
});

test("the dump is handed off through RUNNER_TEMP, not re-dumped a second time, before the age path's own trap deletes $work", () => {
  const dumpCount = (workflow.match(/pg_dump --format=custom/g) ?? []).length;
  assert.equal(dumpCount, 1);
  const copyToRunnerTemp = workflow.indexOf('cp "$payload/lifeos.dump" "$RUNNER_TEMP/lifeos.dump"');
  const encrypt = workflow.indexOf("age -r");
  assert.ok(copyToRunnerTemp > -1 && encrypt > -1);
  assert.ok(copyToRunnerTemp < encrypt);
});

test("restic never receives DATABASE_URL -- only the already-produced dump file travels to the box", () => {
  // The whole point of reusing $RUNNER_TEMP/lifeos.dump (rather than a
  // second on-box pg_dump) is that the database credential never needs to
  // leave the CI runner a second time.
  const backup = stepBlock("- name: Restic · Back up the dump and live blobs volume on the box", [
    "- name: Restic · Fail the job",
  ]);
  assert.doesNotMatch(backup, /DATABASE_URL/);
});

test("the on-box restic script trusts the Storage Box on first connection and reuses restic-setup.sh", () => {
  const backup = stepBlock("- name: Restic · Back up the dump and live blobs volume on the box", [
    "- name: Restic · Fail the job",
  ]);
  assert.match(backup, /\.\/restic-setup\.sh --apply/);
  assert.match(backup, /--repos=lifeos/);
  assert.doesNotMatch(backup, /--repos=platform/);
});

test("remote credentials are cleaned up even if scp or the second ssh session never reaches the heredoc's own trap", () => {
  // Independent verification found: the heredoc's own `trap rm -rf
  // restic-backup-tmp` only exists once that heredoc's ssh session
  // actually starts. If the scp before it fails partway, or that second
  // ssh never connects, the credential files (the SSH key, RESTIC_PASSWORD)
  // are left on the box with nothing to remove them. An outer trap,
  // registered before the first byte is written to $tmp, is the fallback
  // that still attempts a remote cleanup on every exit path -- a no-op if
  // the heredoc already cleaned up, the only defense if it never got the
  // chance to.
  const backup = stepBlock("- name: Restic · Back up the dump and live blobs volume on the box", [
    "- name: Restic · Fail the job",
  ]);
  const cleanupFn = backup.indexOf("cleanup_remote()");
  const outerTrap = backup.indexOf("trap 'cleanup_remote; rm -rf \"$tmp\"' EXIT");
  const firstWrite = backup.indexOf('printf \'%s\\n\' "$STORAGEBOX_SSH_KEY"');
  assert.ok(cleanupFn > -1 && outerTrap > -1 && firstWrite > -1);
  assert.ok(cleanupFn < outerTrap, "cleanup_remote must be defined before the trap registers it");
  assert.ok(outerTrap < firstWrite, "the trap must be registered before any credential file is written");
  assert.match(backup, /rm -rf \\"\$remote_dir\\"/);
});

test("the blob volume is discovered from Docker, never assumed from Compose's naming convention", () => {
  // The named volume Compose actually creates (project-name-prefixed) is
  // not the literal string "lifeos-blobs" from compose.yaml's own
  // `volumes:` key -- a docker run -v lifeos-blobs:... using that bare
  // name would silently create/reference a DIFFERENT, empty volume rather
  // than the one that already has data in it.
  const backup = stepBlock("- name: Restic · Back up the dump and live blobs volume on the box", [
    "- name: Restic · Fail the job",
  ]);
  assert.match(backup, /docker inspect/);
  assert.match(backup, /Destination "\/app\/var\/blobs"/);
  assert.match(backup, /test -n "\$volume_name"/);
  assert.doesNotMatch(backup, /-v lifeos-blobs:/);
});

test("backup and forget run before the snapshot is asserted present, on the lifeos repository", () => {
  const backupCall = workflow.indexOf('restic -r "$repository" backup');
  const forgetCall = workflow.indexOf('restic -r "$repository" forget');
  const snapshotsCall = workflow.indexOf('restic -r "$repository" snapshots');
  assert.ok(backupCall > -1 && forgetCall > -1 && snapshotsCall > -1);
  assert.ok(backupCall < forgetCall);
  assert.ok(forgetCall < snapshotsCall);
  assert.match(workflow, /repository="sftp:hetzner-storagebox:\/lifeos"/);
  assert.match(workflow, /--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune/);
  assert.match(workflow, /snapshots --tag "run-\$\{RUN_ID\}" --json/);
});

test("no secret value is ever echoed -- only error-message prose naming the missing variable", () => {
  const joined = workflow.replace(/\\\n[ \t]*/g, " ");
  assert.doesNotMatch(joined, /echo[^\n]*\$\{?STORAGEBOX_SSH_KEY/);
  assert.doesNotMatch(joined, /echo[^\n]*\$\{?RESTIC_PASSWORD/);
});

test("the restic remote script runs under its own strict mode, distinct heredoc delimiter from the blob-stream heredoc", () => {
  // A shared delimiter name between two heredocs in the same file is a
  // trap waiting to confuse either this test's own extraction or a future
  // hand-edit; RESTIC_REMOTE keeps them unambiguous.
  const start = workflow.indexOf("<<'RESTIC_REMOTE'");
  const end = workflow.indexOf("RESTIC_REMOTE", start + 10);
  assert.ok(start > -1 && end > -1);
  const heredoc = workflow.slice(start, end);
  assert.match(heredoc, /set -euo pipefail/);
});
