// Restic repositories on the Hetzner Storage Box use relative paths (hyperbolic-core#481).
// Hetzner: "Only the directory /home/ is writable on the Storage Box" and "we therefore
// recommend that you use relative paths" (docs.hetzner.com, Access with SSH/rsync/BorgBackup).
// An absolute repository such as sftp:hetzner-storagebox:/platform makes restic init fail with
// `MkdirAll /platform/snapshots: sftp: "Failure" (SSH_FX_FAILURE)` (runs 40656590619, 40656594741).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowsDir = path.join(root, ".github", "workflows");

/** [workflow file, repository path] for every sftp:hetzner-storagebox: reference. */
function storageBoxRepos() {
  const found = [];
  for (const name of readdirSync(workflowsDir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(path.join(workflowsDir, name), "utf8");
    for (const m of text.matchAll(/sftp:hetzner-storagebox:([^"'\s]*)/g)) found.push([name, m[1]]);
  }
  return found;
}

test("the backup and drill workflows reference Storage Box repositories", () => {
  const files = new Set(storageBoxRepos().map(([file]) => file));
  for (const file of ["platform-backup.yml", "lifeos-backup.yml", "ops-restore-drill.yml"]) {
    assert.ok(files.has(file), `${file} has no sftp:hetzner-storagebox: repository`);
  }
});

test("every Storage Box repository path is relative (only /home/ is writable)", () => {
  for (const [file, repo] of storageBoxRepos()) {
    assert.ok(repo !== "", `${file}: empty repository path`);
    assert.ok(!repo.startsWith("/"), `${file}: repository ${repo} is absolute; use a relative path`);
  }
});

test("each repo's backup and drill use the same repository name", () => {
  const byFile = new Map();
  for (const [file, repo] of storageBoxRepos()) {
    if (!byFile.has(file)) byFile.set(file, new Set());
    byFile.get(file).add(repo);
  }
  assert.deepEqual([...byFile.get("platform-backup.yml")], ["platform"]);
  assert.deepEqual([...byFile.get("lifeos-backup.yml")], ["lifeos"]);
  assert.deepEqual([...byFile.get("ops-restore-drill.yml")].sort(), ["lifeos", "platform"]);
});
