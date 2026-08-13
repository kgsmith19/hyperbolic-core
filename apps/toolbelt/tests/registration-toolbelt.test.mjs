// Independent security review, Finding 43 (re-verified against current
// HEAD): apps/toolbelt/tool.json's own `register` field still read
// "pending-m3-02" and no core.app row existed for id 'toolbelt'. This
// suite is the toolbelt root spine's own registration proof, mirroring
// apps/toolbelt/apps/idea-intake/tests/registration.test.mjs (the static
// TB-1a/TB-1b half) and
// apps/toolbelt/apps/idea-intake/tests/registration-idempotency.test.mjs
// (the real-Postgres upsert/down-migration half) exactly, scoped to the
// root spine's own new registration migration. A new file, not a
// modification of apps/toolbelt/tests/registry-manifest-hash.test.mjs or
// registry-migrations-idempotency.test.mjs (m3-02's own hardcoded
// prompt-organizer/network-checker fixtures) -- same "new file over
// touching an existing, out-of-scope shared fixture list" posture
// idea-intake's own registration tests already established for this repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifestShape, manifestHash } from "../scripts/validate-manifests.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLBELT_ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(TOOLBELT_ROOT, "supabase", "migrations");
const MANIFEST_PATH = join(TOOLBELT_ROOT, "tool.json");
const EXTENSION_UP = join(MIGRATIONS_DIR, "20260812230000_core_app_registry_extension.sql");
const REGISTER_UP = join(MIGRATIONS_DIR, "20260814110000_register_toolbelt.sql");
const REGISTER_DOWN = join(MIGRATIONS_DIR, "20260814110000_register_toolbelt_down.sql");

const HASH_LINE_RE = /^\s*'([0-9a-f]{64})',\s*$/m;

// --- Static, no-live-DB-needed checks --------------------------------

test("tool.json's register field names the real registration migration file, not the scaffold placeholder", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.lifecycle.register, "20260814110000_register_toolbelt.sql");
  assert.notEqual(manifest.lifecycle.register, "pending-m3-02");
});

test("tool.json conforms to tool.schema.json", () => {
  const failures = checkManifestShape([MANIFEST_PATH]);
  assert.deepEqual(failures, []);
});

test("the registration migration's literal manifest_hash equals manifestHash() over the real tool.json on disk", () => {
  const sql = readFileSync(REGISTER_UP, "utf8");
  const match = HASH_LINE_RE.exec(sql);
  assert.ok(match, "expected exactly one bare 64-hex-char single-quoted literal line in the migration");

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(
    match[1],
    manifestHash(manifest),
    "manifest_hash in the registration migration no longer matches tool.json -- regenerate the registration migration",
  );
});

test("the registration migration never deletes a core.app row", () => {
  const sql = readFileSync(REGISTER_UP, "utf8");
  assert.doesNotMatch(sql.toLowerCase(), /delete\s+from\s+core\.app/);
});

test("the registration migration is an upsert keyed on core.app.id, and its ON CONFLICT SET list omits status", () => {
  const sql = readFileSync(REGISTER_UP, "utf8").toLowerCase();
  assert.match(sql, /insert\s+into\s+core\.app/);
  assert.match(sql, /on\s+conflict\s*\(\s*id\s*\)\s+do\s+update\s+set/);
  assert.doesNotMatch(sql, /status\s*=\s*excluded\.status/);
});

test("apps/toolbelt/supabase/migrations/ contains the toolbelt registration migration pair", () => {
  const onDisk = new Set(readdirSync(MIGRATIONS_DIR));
  assert.ok(onDisk.has("20260814110000_register_toolbelt.sql"));
  assert.ok(onDisk.has("20260814110000_register_toolbelt_down.sql"));
});

// --- Real-Postgres proof: upsert idempotency, down-migration safety ---

const PRE_STATE_SQL = `
create schema core;
create table core.app (
  id            text primary key,
  name          text not null,
  schema_name   text not null,
  status        text not null default 'idea'
                check (status in ('idea','building','live','retired')),
  created_at    timestamptz not null default now()
);
`;

function tryRunner(cmd, args) {
  try {
    const result = spawnSync(cmd, [...args, "-d", "postgres", "-tAc", "select 1;"], { encoding: "utf8", timeout: 5000 });
    return result.status === 0 && result.stdout.trim() === "1";
  } catch {
    return false;
  }
}

function detectRunner() {
  if (tryRunner("psql", [])) return { cmd: "psql", args: [] };
  if (tryRunner("sudo", ["-n", "-u", "postgres", "psql"])) return { cmd: "sudo", args: ["-n", "-u", "postgres", "psql"] };
  return null;
}

const RUNNER = detectRunner();
const SKIP_REASON = RUNNER
  ? false
  : "no local Postgres reachable (tried direct `psql` and `sudo -n -u postgres psql`); see the m3-02/m3-05 " +
    "implementation reports for the interactive proof runs where a local engine was available";

function psql(dbName, sqlText) {
  return spawnSync(RUNNER.cmd, [...RUNNER.args, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-tA"], {
    encoding: "utf8",
    input: sqlText,
    timeout: 20000,
  });
}

function psqlOk(dbName, sqlText) {
  const result = psql(dbName, sqlText);
  assert.equal(result.status, 0, `psql failed against ${dbName}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function freshDbName() {
  return `f43_register_toolbelt_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

test(
  "real Postgres: applying the toolbelt registration migration inserts exactly one correctly-shaped row",
  { skip: SKIP_REASON },
  () => {
    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, PRE_STATE_SQL);
      psqlOk(db, readFileSync(EXTENSION_UP, "utf8"));
      psqlOk(db, readFileSync(REGISTER_UP, "utf8"));

      const row = psqlOk(
        db,
        "select id, kind, schema_name, coalesce(route,'<null>'), status, manifest_hash from core.app where id = 'toolbelt';",
      ).trim();
      assert.equal(row, "toolbelt|headless|core|<null>|building|9047af64aa7e5db516e2291f9b0bb4777cf4d9f56c2ad7b3f80749fa9f190828");
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);

test(
  "real Postgres: re-applying the toolbelt registration migration is a true no-op (row count AND row content unchanged, except registered_at's intentional re-stamp)",
  { skip: SKIP_REASON },
  () => {
    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, PRE_STATE_SQL);
      psqlOk(db, readFileSync(EXTENSION_UP, "utf8"));
      psqlOk(db, readFileSync(REGISTER_UP, "utf8"));

      const fingerprintQuery =
        "select id, md5(row(name,schema_name,status,kind,route,version,description,manifest,manifest_hash)::text) from core.app order by id;";
      const before = psqlOk(db, fingerprintQuery);
      const countBefore = psqlOk(db, "select count(*) from core.app;").trim();
      assert.equal(countBefore, "1");

      psqlOk(db, readFileSync(REGISTER_UP, "utf8"));

      const countAfter = psqlOk(db, "select count(*) from core.app;").trim();
      assert.equal(countAfter, countBefore, "row count changed after re-applying the registration migration");

      const after = psqlOk(db, fingerprintQuery);
      assert.equal(after, before, "row content drifted after re-applying the registration migration (not a true no-op upsert)");
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);

test(
  "real Postgres: the down migration never deletes the toolbelt row, only resets it to pre-registration defaults",
  { skip: SKIP_REASON },
  () => {
    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, PRE_STATE_SQL);
      psqlOk(db, readFileSync(EXTENSION_UP, "utf8"));
      psqlOk(db, readFileSync(REGISTER_UP, "utf8"));
      assert.equal(psqlOk(db, "select count(*) from core.app;").trim(), "1");

      psqlOk(db, readFileSync(REGISTER_DOWN, "utf8"));
      assert.equal(psqlOk(db, "select count(*) from core.app;").trim(), "1", "the down migration deleted the row");

      const row = psqlOk(
        db,
        "select status, kind, coalesce(route,'<null>'), version, coalesce(manifest_hash,'<null>') from core.app where id = 'toolbelt';",
      ).trim();
      assert.equal(row, "idea|ui|<null>|0.0.0|<null>");
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);
