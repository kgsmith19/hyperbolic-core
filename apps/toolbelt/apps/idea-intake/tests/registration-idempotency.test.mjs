// m3-05: real-Postgres proof of the registration migration's idempotency,
// scoped to Idea Intake specifically (apps/toolbelt/tests/registry-migrations-idempotency.test.mjs
// already proves this same property for m3-02's own two registrations --
// prompt-organizer, network-checker -- via a hardcoded REGISTRATIONS list
// that predates this tool; this file is the same proof for idea-intake,
// not a modification of that existing, out-of-scope file). Mirrors its
// detection/skip mechanics: skips cleanly, reported SKIPPED via node:test's
// own mechanism, when no local Postgres is reachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "supabase", "migrations");

const EXTENSION_UP = join(ROOT_MIGRATIONS_DIR, "20260812230000_core_app_registry_extension.sql");
const REGISTER_UP = join(ROOT_MIGRATIONS_DIR, "20260813002605_register_idea-intake.sql");
const REGISTER_DOWN = join(ROOT_MIGRATIONS_DIR, "20260813002605_register_idea-intake_down.sql");

// Minimal, faithful reproduction of the pre-registration state this
// migration assumes: core.app's shape copied verbatim from
// 20260806190000_core_create_schema.sql lines 12-19, same posture
// apps/toolbelt/tests/registry-migrations-idempotency.test.mjs's own
// PRE_STATE_SQL takes (core.run and its siblings reference auth.users, a
// Supabase-only extension schema a vanilla local Postgres lacks; none of
// these migrations touch core.run, so it is intentionally not reproduced).
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
  : "no local Postgres reachable (tried direct `psql` and `sudo -n -u postgres psql`); see the m3-05 " +
    "implementation report for the interactive proof run where a local engine was available";

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
  return `m3_05_register_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

test(
  "real Postgres: re-applying the idea-intake registration migration is a true no-op (row count AND row content unchanged, except registered_at's intentional re-stamp)",
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
  "real Postgres: the down migration never deletes the idea-intake row, only resets it to pre-registration defaults",
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
        "select status, kind, coalesce(route,'<null>'), version, coalesce(manifest_hash,'<null>') from core.app where id = 'idea-intake';",
      ).trim();
      assert.equal(row, "idea|ui|<null>|0.0.0|<null>");
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);
