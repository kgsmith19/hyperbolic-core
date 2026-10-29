// Flags-as-code (hyperbolic-core#455). Operational on/off flags live in
// ops/flags.json, flipped by a reviewed PR, instead of repo variables that need
// a settings write. A key present in the file wins; a key absent falls back to
// the matching repo variable, so adopting the file changes nothing until a PR
// sets a key. Each test names the failure it catches.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const loadResolver = async () => (await import(pathToFileURL(path.join(root, "docs/ops/read-flags.mjs")).href)).resolveFlags;

test("a key present in the file wins over its repo variable, in both directions", async () => {
  const resolveFlags = await loadResolver();
  const fromFileTrue = resolveFlags('{"restic_backup_enabled": true}', { FALLBACK_RESTIC_BACKUP_ENABLED: "" });
  assert.equal(fromFileTrue.restic_backup_enabled, "true");
  const fromFileFalse = resolveFlags('{"restic_backup_enabled": false}', { FALLBACK_RESTIC_BACKUP_ENABLED: "true" });
  assert.equal(fromFileFalse.restic_backup_enabled, "false", "a file false must override a variable true");
});

test("a key absent from the file falls back to its repo variable, and only literal 'true' enables", async () => {
  const resolveFlags = await loadResolver();
  const flags = resolveFlags("{}", {
    FALLBACK_PLATFORM_BACKUP_ENABLED: "true",
    FALLBACK_LIFEOS_BACKUP_ENABLED: "TRUE",
    FALLBACK_RESTIC_BACKUP_ENABLED: undefined,
  });
  assert.equal(flags.platform_backup_enabled, "true");
  assert.equal(flags.lifeos_backup_enabled, "false", "only the literal 'true' enables, as the old `== 'true'` gates did");
  assert.equal(flags.restic_backup_enabled, "false");
});

test("every known flag is always output, so a caller's `needs.flags.outputs.X` is never empty", async () => {
  const resolveFlags = await loadResolver();
  assert.deepEqual(Object.keys(resolveFlags("{}", {})).sort(), [
    "cloud_ops_enabled",
    "lifeos_backup_enabled",
    "platform_backup_enabled",
    "restic_backup_enabled",
  ]);
});

test("a malformed flags file fails loudly instead of silently turning a backup off", async () => {
  const resolveFlags = await loadResolver();
  assert.throws(() => resolveFlags("{not json", {}), /not valid JSON/);
  assert.throws(() => resolveFlags("[]", {}), /must be a JSON object/);
  assert.throws(() => resolveFlags('{"restic_backup_enabled": "true"}', {}), /must be true or false/);
  assert.throws(() => resolveFlags('{"restic_backup_enabld": true}', {}), /unknown flag/);
});

test("ops/flags.json is committed, valid, and holds every cloud workflow off (#499)", async () => {
  const resolveFlags = await loadResolver();
  const flags = resolveFlags(read("ops/flags.json"), {});
  // Oracle change (#499): #464 turned restic on; the owner's 2026-10-29 decision
  // (local-only platform) supersedes it, so both keys are off by reviewed PR.
  assert.equal(flags.cloud_ops_enabled, "false", "cloud ops are frozen by owner decision (#499)");
  assert.equal(flags.restic_backup_enabled, "false", "restic is off with the rest of the cloud (#499)");
});

const readReusable = () => read(".github/workflows/read-flags.yml");

test("read-flags.yml is a reusable workflow only, so it adds no PR check row and runs no trigger of its own", () => {
  const reusable = readReusable();
  const onBlock = reusable.slice(reusable.indexOf("\non:"), reusable.indexOf("\npermissions:"));
  assert.match(onBlock, /\n {2}workflow_call:/);
  assert.doesNotMatch(onBlock, /pull_request|schedule|push|workflow_dispatch/);
});

test("read-flags.yml outputs every known flag and reads repo variables only as the fallback", () => {
  const reusable = readReusable();
  for (const flag of ["restic_backup_enabled", "platform_backup_enabled", "lifeos_backup_enabled"]) {
    assert.match(reusable, new RegExp(`${flag}:\\n\\s+description: [^\\n]+\\n\\s+value: \\$\\{\\{ jobs\\.read\\.outputs\\.${flag} \\}\\}`));
    const variable = flag.toUpperCase();
    assert.match(reusable, new RegExp(`FALLBACK_${variable}: \\$\\{\\{ vars\\.${variable} \\}\\}`));
  }
});

test("read-flags.yml holds read-only contents permission and pins its checkout to a full SHA", () => {
  const reusable = readReusable();
  assert.match(reusable, /\npermissions:\n {2}contents: read\n/);
  assert.doesNotMatch(reusable, /: write/);
  assert.match(reusable, /actions\/checkout@[0-9a-f]{40} # v/);
  assert.match(reusable, /persist-credentials: false/);
});

const callers = {
  ".github/workflows/platform-backup.yml": ["platform_backup_enabled", "restic_backup_enabled"],
  ".github/workflows/lifeos-backup.yml": ["lifeos_backup_enabled", "restic_backup_enabled"],
  ".github/workflows/ops-restore-drill.yml": ["restic_backup_enabled"],
};

test("every backup and drill workflow reads its flags from read-flags.yml, never straight from repo variables", () => {
  for (const [file, flags] of Object.entries(callers)) {
    const text = read(file);
    assert.match(text, /\n {2}flags:\n {4}uses: \.\/\.github\/workflows\/read-flags\.yml\n/, `${file} must call read-flags.yml`);
    for (const flag of flags) {
      assert.match(text, new RegExp(`needs\\.flags\\.outputs\\.${flag} == 'true'`), `${file} must gate on ${flag}`);
      assert.doesNotMatch(text, new RegExp(`vars\\.${flag.toUpperCase()}`), `${file} must not read vars.${flag.toUpperCase()} directly`);
    }
  }
});
