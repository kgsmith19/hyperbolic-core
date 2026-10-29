// The cloud ops surface stays removed (#503; owner decision 2026-10-29: the
// platform is local-only). Each assertion names a path #503 deleted, so a
// revert or a re-add of any of them fails here, not silently in production.

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const REMOVED_WORKFLOWS = [
  "auto-merge-deploy-reconcile.yml", "canary-observe.yml", "deploy.yml", "lifeos-backup.yml",
  "lifeos-deploy.yml", "lifeos-ops.yml", "ops-broker-canary.yml", "ops-broker-soak-report.yml",
  "ops-edge.yml", "ops-restore-drill.yml", "ops-serve-apply.yml", "ops-storagebox-authorize-key.yml",
  "platform-backup.yml", "platform-contract.yml", "platform-migrations.yml", "platform-smoke.yml",
  "read-flags.yml", "shell-idp-down.yml",
];

test("no cloud-ops workflow is back in .github/workflows", () => {
  const present = REMOVED_WORKFLOWS.filter((name) => existsSync(path.join(root, ".github/workflows", name)));
  assert.deepEqual(present, []);
});

test("ops/flags.json and the VPS/restic/Tailscale/edge tooling are gone", () => {
  for (const relative of [
    "ops/flags.json", "docs/ops/read-flags.mjs", "docs/ops/restic-setup.sh", "docs/ops/bootstrap-vps.sh",
    "docs/ops/tailscale-serve-apply.sh", "docs/ops/edge-origin", "docs/ops/composed-origin", "docs/ops/canary",
  ]) {
    assert.ok(!existsSync(path.join(root, relative)), `${relative} must stay removed`);
  }
});

test("no app carries a nested .github directory (GitHub never runs one)", () => {
  const nested = readdirSync(path.join(root, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, "apps", entry.name, ".github")))
    .map((entry) => `apps/${entry.name}/.github`);
  assert.deepEqual(nested, []);
});
