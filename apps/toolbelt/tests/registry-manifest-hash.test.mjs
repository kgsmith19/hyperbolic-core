// m3-02: proves the registry's first acceptance criterion (TB-1b parity)
// without a live database connection. docs/planning/05-c-toolbelt.md section
// 4.2: "manifest_hash is the sha256 of the canonicalized tool.json; CI
// recomputes it and fails on mismatch, so the registry can never silently
// lag the manifest." This suite is that recomputation, run statically:
//
//   1. read the real, committed registration migration .sql file
//   2. extract the literal manifest_hash string it writes into core.app
//   3. read the real, committed tool.json it is registering
//   4. compute manifestHash() over that manifest using the SAME
//      canonicalJSON/manifestHash functions scripts/validate-manifests.mjs
//      exports (imported here, never reimplemented -- a second, independent
//      hashing implementation could drift from the real one and validate
//      nothing)
//   5. assert the two are equal
//
// This is a genuine proof of the exact failure mode TB-1b exists to catch:
// if the manifest changes after the migration was written and someone
// forgets to regenerate the registration, this test goes red. It cannot
// prove the value actually reached a live core.app.manifest_hash column
// (no live Supabase access in this environment -- see the m3-02
// implementation report for what remains genuinely unverified).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestHash } from "../scripts/validate-manifests.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLBELT_ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(TOOLBELT_ROOT, "supabase", "migrations");

const REGISTRATIONS = [
  {
    toolId: "prompt-organizer",
    manifestPath: join(TOOLBELT_ROOT, "apps", "prompt-organizer", "tool.json"),
    migrationPath: join(MIGRATIONS_DIR, "20260812240000_register_prompt-organizer.sql"),
  },
  {
    toolId: "network-checker",
    manifestPath: join(TOOLBELT_ROOT, "apps", "network-checker", "tool.json"),
    migrationPath: join(MIGRATIONS_DIR, "20260812250000_register_network-checker.sql"),
  },
];

// The hash is written on its own line as a bare single-quoted 64-hex-char
// literal (see either registration migration: `'<64 hex chars>',` sitting
// alone between the manifest jsonb literal and `now()`). Anchoring on
// "the whole trimmed line is exactly this" avoids ever matching a
// substring inside the much longer minified-JSON manifest literal on the
// preceding line, which itself contains no bare 64-char hex run.
const HASH_LINE_RE = /^\s*'([0-9a-f]{64})',\s*$/m;

function extractLiteralHash(sql) {
  const match = HASH_LINE_RE.exec(sql);
  assert.ok(match, "expected exactly one bare 64-hex-char single-quoted literal line in the migration");
  return match[1];
}

for (const { toolId, manifestPath, migrationPath } of REGISTRATIONS) {
  test(`${toolId}: registration migration's literal manifest_hash equals manifestHash() over the real tool.json on disk`, () => {
    const sql = readFileSync(migrationPath, "utf8");
    const literalHash = extractLiteralHash(sql);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const recomputed = manifestHash(manifest);

    assert.equal(
      literalHash,
      recomputed,
      `${migrationPath} writes manifest_hash=${literalHash} but manifestHash(${manifestPath}) is ${recomputed} -- ` +
        "the manifest changed after the migration was written (or vice versa); regenerate the registration migration",
    );
  });

  test(`${toolId}: registration migration's literal manifest_hash is a real sha256 hex digest (64 lowercase hex chars)`, () => {
    const sql = readFileSync(migrationPath, "utf8");
    assert.match(extractLiteralHash(sql), /^[0-9a-f]{64}$/);
  });
}

// --- Static SQL-shape invariants: no live DB needed, always run --------
//
// These do not prove runtime behavior (see registry-migrations-idempotency
// for the real-Postgres proof, which self-skips when no engine is
// reachable), but they are real, unconditional, mechanically-checked
// guarantees over every migration file this issue adds.

import { readdirSync } from "node:fs";

const M3_02_MIGRATION_BASENAMES = [
  "20260812230000_core_app_registry_extension.sql",
  "20260812230000_core_app_registry_extension_down.sql",
  "20260812240000_register_prompt-organizer.sql",
  "20260812240000_register_prompt-organizer_down.sql",
  "20260812250000_register_network-checker.sql",
  "20260812250000_register_network-checker_down.sql",
];

test("none of the m3-02 migrations (up or down) ever delete a core.app row", () => {
  for (const name of M3_02_MIGRATION_BASENAMES) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    assert.doesNotMatch(
      sql.toLowerCase(),
      /delete\s+from\s+core\.app/,
      `${name} must never delete a core.app row (m3-02 acceptance criteria; retirement is a status update, never a delete)`,
    );
  }
});

test("every registration migration is an upsert keyed on core.app.id (insert ... on conflict (id) do update)", () => {
  for (const { migrationPath } of REGISTRATIONS) {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    assert.match(sql, /insert\s+into\s+core\.app/);
    assert.match(sql, /on\s+conflict\s*\(\s*id\s*\)\s+do\s+update\s+set/);
  }
});

test("every registration migration's ON CONFLICT SET list omits status (docs/planning/05-c-toolbelt.md section 4.2's exact column list)", () => {
  for (const { migrationPath } of REGISTRATIONS) {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    // The literal excluded.* assignment list section 4.2 gives is: name,
    // schema_name, kind, route, version, description, manifest,
    // manifest_hash, registered_at -- status is not among them, so a
    // conflicting registration re-run never clobbers a status a separate,
    // dedicated status-transition migration set.
    assert.doesNotMatch(sql, /status\s*=\s*excluded\.status/);
  }
});

test("apps/toolbelt/supabase/migrations/ contains exactly one registration migration pair per REGISTRATIONS entry", () => {
  const onDisk = new Set(readdirSync(MIGRATIONS_DIR));
  for (const { migrationPath } of REGISTRATIONS) {
    const base = migrationPath.slice(migrationPath.lastIndexOf("/") + 1);
    assert.ok(onDisk.has(base), `${base} missing from ${MIGRATIONS_DIR}`);
    const downBase = base.replace(/\.sql$/, "_down.sql");
    assert.ok(onDisk.has(downBase), `${downBase} missing from ${MIGRATIONS_DIR}`);
  }
});
