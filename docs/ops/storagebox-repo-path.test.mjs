// Restic repositories on the Hetzner Storage Box live under /home/ (hyperbolic-core#481, #483).
// Hetzner: "Only the directory /home/ is writable on the Storage Box" (docs.hetzner.com, Access
// with SSH/rsync/BorgBackup). /platform failed restic init with `MkdirAll /platform/snapshots:
// sftp: "Failure" (SSH_FX_FAILURE)` (runs 40656590619, 40656594741). A relative "platform" did too:
// the SFTP session starts at /, so it resolved to /platform (runs 40660417960, 40660420934).

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

test("every Storage Box repository is /home/<name> (only /home/ is writable)", () => {
  for (const [file, repo] of storageBoxRepos()) {
    assert.match(repo, /^\/home\/[a-z][a-z0-9-]*$/, `${file}: repository ${repo} must be /home/<name>`);
  }
});

test("each repo's backup and drill use the same repository name", () => {
  const byFile = new Map();
  for (const [file, repo] of storageBoxRepos()) {
    if (!byFile.has(file)) byFile.set(file, new Set());
    byFile.get(file).add(repo);
  }
  assert.deepEqual([...byFile.get("platform-backup.yml")], ["/home/platform"]);
  assert.deepEqual([...byFile.get("lifeos-backup.yml")], ["/home/lifeos"]);
  assert.deepEqual([...byFile.get("ops-restore-drill.yml")].sort(), ["/home/lifeos", "/home/platform"]);
});
