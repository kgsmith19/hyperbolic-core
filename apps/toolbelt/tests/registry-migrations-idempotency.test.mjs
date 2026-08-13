// m3-02: real-Postgres proof of the second and third acceptance criteria --
// registration migrations are idempotent upserts (re-applying leaves row
// counts unchanged) and no migration this issue adds ever deletes a
// core.app row -- run against an actual PostgreSQL engine, not asserted by
// reading the SQL text (registry-manifest-hash.test.mjs already covers the
// static/textual half of that).
//
// This environment has no live Supabase project access, so the real
// core.app table cannot be reached. What CAN be reached, when a local
// Postgres engine is: the exact same SQL files, applied for real. This
// suite detects a usable local `psql` (trying a direct connection, then
// `sudo -n -u postgres psql`, non-interactively so it never hangs a CI
// run) and skips itself cleanly -- via node:test's own skip mechanism, so
// it is reported as SKIPPED, never silently omitted and never falsely
// green -- when neither is reachable.
//
// Where it *is* reachable (confirmed in the sandbox this issue was
// implemented in: a local PostgreSQL 16 cluster, started with
// `service postgresql start`, reached via `sudo -n -u postgres psql`),
// every assertion below runs against a real, disposable scratch database,
// applying the actual committed migration files from disk verbatim (never
// a reimplementation of their logic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestHash } from "../scripts/validate-manifests.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

const EXTENSION_UP = join(MIGRATIONS_DIR, "20260812230000_core_app_registry_extension.sql");
const EXTENSION_DOWN = join(MIGRATIONS_DIR, "20260812230000_core_app_registry_extension_down.sql");
const PO_UP = join(MIGRATIONS_DIR, "20260812240000_register_prompt-organizer.sql");
const PO_DOWN = join(MIGRATIONS_DIR, "20260812240000_register_prompt-organizer_down.sql");
const NC_UP = join(MIGRATIONS_DIR, "20260812250000_register_network-checker.sql");
const NC_DOWN = join(MIGRATIONS_DIR, "20260812250000_register_network-checker_down.sql");
const IDEA_UP = join(MIGRATIONS_DIR, "20260813003000_register_idea-intake.sql");
const IDEA_DOWN = join(MIGRATIONS_DIR, "20260813003000_register_idea-intake_down.sql");
const NC_V1_UP = join(MIGRATIONS_DIR, "20260813173000_register_network-checker-v1.sql");
const NC_V1_DOWN = join(MIGRATIONS_DIR, "20260813173000_register_network-checker-v1_down.sql");
const ROOT_BASE_UP = join(MIGRATIONS_DIR, "20260814110000_register_toolbelt.sql");
const ROOT_BASE_DOWN = join(MIGRATIONS_DIR, "20260814110000_register_toolbelt_down.sql");
const ROOT_UP = join(MIGRATIONS_DIR, "20260814130000_register_toolbelt-v0.1.1.sql");
const ROOT_DOWN = join(MIGRATIONS_DIR, "20260814130000_register_toolbelt-v0.1.1_down.sql");
const PO_V1_UP = join(MIGRATIONS_DIR, "20260814130100_register_prompt-organizer-v0.1.2.sql");
const PO_V1_DOWN = join(MIGRATIONS_DIR, "20260814130100_register_prompt-organizer-v0.1.2_down.sql");
const IDEA_V1_UP = join(MIGRATIONS_DIR, "20260814130200_register_idea-intake-v0.1.1.sql");
const IDEA_V1_DOWN = join(MIGRATIONS_DIR, "20260814130200_register_idea-intake-v0.1.1_down.sql");

const REGISTRATION_UPS = [PO_UP, NC_UP, IDEA_UP, NC_V1_UP, ROOT_BASE_UP, ROOT_UP, PO_V1_UP, IDEA_V1_UP];
const MANIFEST_PATHS = [
  join(__dirname, "..", "tool.json"),
  join(__dirname, "..", "apps", "idea-intake", "tool.json"),
  join(__dirname, "..", "apps", "network-checker", "tool.json"),
  join(__dirname, "..", "apps", "prompt-organizer", "tool.json"),
];

const EXPECTED_HASHES = Object.fromEntries(
  MANIFEST_PATHS.map((path) => {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return [manifest.id, manifestHash(manifest)];
  }),
);

// Minimal, faithful reproduction of the pre-m3-02 state these migrations
// assume: core.app's shape copied verbatim from
// 20260806190000_core_create_schema.sql lines 12-19 (core.run and its
// siblings reference auth.users, a Supabase-only extension schema a vanilla
// local Postgres does not have; none of the m3-02 migrations touch
// core.run, so it is intentionally not reproduced here), plus the real
// original prompt-organizer row from
// 20260807040000_register_prompt_organizer.sql.
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

insert into core.app (id, name, schema_name, status)
values ('prompt-organizer', 'Prompt Organizer', 'prompt', 'building');
`;

function tryRunner(cmd, args) {
  try {
    const result = spawnSync(cmd, [...args, "-d", "postgres", "-tAc", "select 1;"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0 && result.stdout.trim() === "1";
  } catch {
    return false;
  }
}

function detectRunner() {
  if (tryRunner("psql", [])) return { cmd: "psql", args: [] };
  // -n: non-interactive. Fails immediately instead of prompting for a
  // password, so a sandbox/CI runner without passwordless sudo never hangs.
  if (tryRunner("sudo", ["-n", "-u", "postgres", "psql"])) return { cmd: "sudo", args: ["-n", "-u", "postgres", "psql"] };
  return null;
}

const RUNNER = detectRunner();
if (process.env.TOOLBELT_REQUIRE_POSTGRES === "1" && !RUNNER) {
  throw new Error("TOOLBELT_REQUIRE_POSTGRES=1 but no local PostgreSQL server is reachable");
}
const SKIP_REASON = RUNNER
  ? false
  : "no local Postgres reachable (tried direct `psql` and `sudo -n -u postgres psql`); " +
    "this suite proves real SQL behavior against an actual engine and has nothing honest to assert without one -- " +
    "see the m3-02 implementation report for the interactive proof run where a local engine was available";

function psql(dbName, sqlText) {
  const result = spawnSync(RUNNER.cmd, [...RUNNER.args, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-tA"], {
    encoding: "utf8",
    input: sqlText,
    timeout: 20000,
  });
  return result; // caller inspects .status/.stdout/.stderr; some tests want the failure case
}

function psqlOk(dbName, sqlText) {
  const result = psql(dbName, sqlText);
  assert.equal(result.status, 0, `psql failed against ${dbName}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function applyFiles(dbName, paths) {
  for (const path of paths) psqlOk(dbName, readFileSync(path, "utf8"));
}

function freshDbName() {
  return `m3_02_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

test(
  "real Postgres: full up-cascade registers all current manifests with the correct, non-default columns",
  { skip: SKIP_REASON },
  () => {
    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, PRE_STATE_SQL);
      psqlOk(db, readFileSync(EXTENSION_UP, "utf8"));
      applyFiles(db, REGISTRATION_UPS);

      const count = psqlOk(db, "select count(*) from core.app;").trim();
      assert.equal(count, "4", "expected exactly 4 core.app rows after registering 4 manifests");

      const rows = psqlOk(
        db,
        "select id, kind, coalesce(route,'<null>'), status, manifest_hash from core.app order by id;",
      ).trim();
      assert.equal(
        rows,
        [
          `idea-intake|ui|/ideas|building|${EXPECTED_HASHES["idea-intake"]}`,
          `network-checker|cli|<null>|building|${EXPECTED_HASHES["network-checker"]}`,
          `prompt-organizer|ui|/prompts|building|${EXPECTED_HASHES["prompt-organizer"]}`,
          `toolbelt|headless|<null>|building|${EXPECTED_HASHES.toolbelt}`,
        ].join("\n"),
      );
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);

test(
  "real Postgres: re-applying all registration migrations is a true no-op (row count AND row content unchanged)",
  { skip: SKIP_REASON },
  () => {
    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, PRE_STATE_SQL);
      psqlOk(db, readFileSync(EXTENSION_UP, "utf8"));
      applyFiles(db, REGISTRATION_UPS);

      const fingerprintQuery =
        "select id, md5(row(name,schema_name,status,kind,route,version,description,manifest,manifest_hash)::text) " +
        "from core.app order by id;";
      const before = psqlOk(db, fingerprintQuery);
      const countBefore = psqlOk(db, "select count(*) from core.app;").trim();

      // Re-apply every registration migration a second time.
      applyFiles(db, REGISTRATION_UPS);

      const countAfter = psqlOk(db, "select count(*) from core.app;").trim();
      assert.equal(countAfter, countBefore, "row count changed after re-applying registration migrations");
      assert.equal(countAfter, "4");

      const after = psqlOk(db, fingerprintQuery);
      assert.equal(after, before, "row content drifted after re-applying registration migrations (not a true no-op upsert)");
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);

test(
  "real Postgres: TB-1b row-count check -- count(status <> 'idea') equals the number of registration migrations",
  { skip: SKIP_REASON },
  () => {
    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, PRE_STATE_SQL);
      psqlOk(db, readFileSync(EXTENSION_UP, "utf8"));
      applyFiles(db, REGISTRATION_UPS);

      const count = psqlOk(db, "select count(*) from core.app where status <> 'idea';").trim();
      assert.equal(count, "4", "docs/planning/05-c-toolbelt.md section 11 TB-1b verification query");
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);

test(
  "real Postgres: the full down-cascade never deletes a row and restores core.app's exact original shape",
  { skip: SKIP_REASON },
  () => {
    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, PRE_STATE_SQL);
      psqlOk(db, readFileSync(EXTENSION_UP, "utf8"));
      applyFiles(db, REGISTRATION_UPS);
      assert.equal(psqlOk(db, "select count(*) from core.app;").trim(), "4");

      // Down-cascade in reverse chronological order.
      psqlOk(db, readFileSync(IDEA_V1_DOWN, "utf8"));
      psqlOk(db, readFileSync(PO_V1_DOWN, "utf8"));
      psqlOk(db, readFileSync(ROOT_DOWN, "utf8"));
      psqlOk(db, readFileSync(ROOT_BASE_DOWN, "utf8"));
      psqlOk(db, readFileSync(NC_V1_DOWN, "utf8"));
      const restoredNc = psqlOk(
        db,
        "select version, manifest_hash from core.app where id = 'network-checker';",
      ).trim();
      assert.equal(
        restoredNc,
        "0.1.0|146e208e509e124d6ca4a74cb0e6f7139acd2fd94c1516078e28c55e5fad2a87",
        "network-checker v1 down did not restore the immediately preceding registration",
      );
      psqlOk(db, readFileSync(IDEA_DOWN, "utf8"));
      assert.equal(
        psqlOk(db, "select count(*) from core.app;").trim(),
        "4",
        "idea-intake's down migration deleted its row",
      );

      psqlOk(db, readFileSync(NC_DOWN, "utf8"));
      assert.equal(
        psqlOk(db, "select count(*) from core.app;").trim(),
        "4",
        "network-checker's down migration deleted its row",
      );

      psqlOk(db, readFileSync(PO_DOWN, "utf8"));
      assert.equal(
        psqlOk(db, "select count(*) from core.app;").trim(),
        "4",
        "prompt-organizer's down migration deleted its row",
      );
      // 20260812210000_register_prompt-organizer_down.sql must not touch
      // kind/route: those belong to the extension migration's backfill.
      const poRow = psqlOk(db, "select kind, route, status from core.app where id = 'prompt-organizer';").trim();
      assert.equal(poRow, "ui|/prompts|building", "prompt-organizer down migration touched kind/route or status, which it must not own");

      psqlOk(db, readFileSync(EXTENSION_DOWN, "utf8"));
      assert.equal(psqlOk(db, "select count(*) from core.app;").trim(), "4", "the extension down migration deleted a row");

      const cols = psqlOk(
        db,
        "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns " +
          "where table_schema = 'core' and table_name = 'app';",
      ).trim();
      assert.equal(cols, "id,name,schema_name,status,created_at", "core.app did not return to its exact original 5-column shape");
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);

test(
  "real Postgres control: a naive INSERT without ON CONFLICT (not the real migration) DOES fail on re-apply, proving this harness has real discriminating power",
  { skip: SKIP_REASON },
  () => {
    // Takes the real network-checker registration text and strips its
    // upsert tail, leaving a bare INSERT -- demonstrating that the
    // "unchanged row count" result above is not vacuous: a migration that
    // regressed to a plain insert (no ON CONFLICT) would be caught here by
    // a real primary-key violation, not silently accepted.
    const realSql = readFileSync(NC_UP, "utf8");
    const conflictIdx = realSql.indexOf("\non conflict");
    assert.ok(conflictIdx > 0, "expected the real migration to contain an ON CONFLICT clause to strip");
    const nakedInsert = realSql.slice(0, conflictIdx) + ";\n";

    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, PRE_STATE_SQL);
      psqlOk(db, readFileSync(EXTENSION_UP, "utf8"));
      psqlOk(db, nakedInsert); // first apply succeeds

      const result = psql(db, nakedInsert); // second apply must fail
      assert.notEqual(result.status, 0, "a bare INSERT with no ON CONFLICT should fail to re-apply, but it succeeded");
      assert.match(result.stderr, /duplicate key value violates unique constraint/);
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);
