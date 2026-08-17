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

test("no GitHub Actions secrets and no SSH key material -- Infisical OIDC + Tailscale SSH only", () => {
  // Expression form only -- the header prose says "GitHub Actions secrets".
  assert.doesNotMatch(workflow, /\$\{\{ secrets\./);
  assert.doesNotMatch(workflow, /SSH_KEY/);
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
