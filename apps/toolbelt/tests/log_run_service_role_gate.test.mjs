// m6-02 prerequisite fix: real-Postgres proof for
// 20260814180000_core_log_run_service_role_gate.sql's two claims.
//
// 1. SECURITY REGRESSION: 20260814170000_core_log_run_cost_fields.sql
//    replaced core.log_run via `drop function` + `create function` (a new
//    signature, four trailing params added) rather than `create or
//    replace`, so Postgres attached its own CREATE-time default ACL
//    (EXECUTE to PUBLIC) and the function body carried none of
//    20260814010000's null-safe owner gate. An authenticated caller who is
//    not the owner could call it and insert core.run/core.cost rows.
//
// 2. VISIBILITY BUG: Brain's own background dispatch calls this RPC with
//    the service-role key, so core.run.user_id's `default auth.uid()`
//    resolves to null for every Brain-mirrored row -- invisible under
//    core.run's owner_rw RLS policy (`user_id = platform.owner()`), even
//    to the real owner's own session.
//
// Same harness/detection/skip mechanics as
// apps/toolbelt/tests/log_run_owner_null_guard.test.mjs (this file's own
// direct precedent) -- a bare local Postgres has none of Supabase's
// managed auth schema/roles, so HARNESS_SQL stubs auth.uid() (a session
// GUC) and auth.role() (literally the ambient `SET ROLE`, the same
// "SET ROLE simulates the caller's JWT role" convention
// idea-intake/tests/mark_submitted_to_github_rpc.test.mjs already
// established for a service_role-gated RPC) -- and applies the real,
// committed migration files from disk verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

const PLATFORM_BOOTSTRAP_UP = join(MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");
const CORE_CREATE_SCHEMA_UP = join(MIGRATIONS_DIR, "20260806190000_core_create_schema.sql");
const IDEA_CREATE_SCHEMA_UP = join(MIGRATIONS_DIR, "20260806190100_idea_create_schema.sql");
const RLS_BASELINE_UP = join(MIGRATIONS_DIR, "20260806190200_rls_baseline.sql");
const CORE_LOG_RUN_RPC_UP = join(MIGRATIONS_DIR, "20260807080000_core_log_run_rpc.sql");
const CORE_EVENT_RETENTION_UP = join(MIGRATIONS_DIR, "20260808120000_core_event_retention.sql");
const CORE_IDEA_OWNER_PIN_UP = join(MIGRATIONS_DIR, "20260812160000_core_idea_owner_pin.sql");
const OWNER_NULL_GUARD_UP = join(MIGRATIONS_DIR, "20260814010000_core_log_run_owner_null_guard.sql");
const COST_FIELDS_UP = join(MIGRATIONS_DIR, "20260814170000_core_log_run_cost_fields.sql");
const FIX_UP = join(MIGRATIONS_DIR, "20260814180000_core_log_run_service_role_gate.sql");

// Same known-suffix-stripped technique log_run_owner_null_guard.test.mjs
// already uses on this exact file, for the exact same reason: this
// sandbox's local Postgres has no pg_cron control file installed.
const CRON_SPLIT_MARKER = "create extension pg_cron;";

function coreEventRetentionWithoutCron() {
  const full = readFileSync(CORE_EVENT_RETENTION_UP, "utf8");
  const idx = full.indexOf(CRON_SPLIT_MARKER);
  assert.ok(idx > 0, "expected to find the pg_cron marker in the real retention migration");
  return full.slice(0, idx);
}

const OWNER_UUID = "11111111-1111-1111-1111-111111111111";
const STRANGER_UUID = "22222222-2222-2222-2222-222222222222";

// auth.role() here is literally the ambient `SET ROLE` -- a fair stand-in
// for what real Supabase's auth.role() resolves to (the JWT's own role
// claim), since this suite's whole simulation convention IS "SET ROLE
// authenticated/service_role/anon before the call" (asRole() below), the
// same substitution mark_submitted_to_github_rpc.test.mjs's asServiceRole()
// already relies on for a service_role-gated RPC.
const HARNESS_SQL = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('app.test_uid', true), '')::uuid $$;
create or replace function auth.role() returns text
language sql stable
as $$ select current_setting('role') $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end
$$;

insert into auth.users (id) values ('${OWNER_UUID}'), ('${STRANGER_UUID}');
`;

const APP_FIXTURE_SQL = `insert into core.app (id, name, schema_name) values ('log-run-svc-gate-test-app', 'Test App', 'test');`;

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
  if (tryRunner("sudo", ["-n", "-u", "postgres", "psql"])) return { cmd: "sudo", args: ["-n", "-u", "postgres", "psql"] };
  return null;
}

const RUNNER = detectRunner();
const SKIP_REASON = RUNNER
  ? false
  : "no local Postgres reachable (tried direct `psql` and `sudo -n -u postgres psql`); " +
    "this suite proves real grant/guard behavior against an actual engine and has nothing honest to " +
    "assert without one";

function psql(dbName, sqlText) {
  return spawnSync(RUNNER.cmd, [...RUNNER.args, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-tA", "-q"], {
    encoding: "utf8",
    input: sqlText,
    timeout: 20000,
  });
}

const psqlAllowError = psql;

function psqlOk(dbName, sqlText) {
  const result = psql(dbName, sqlText);
  assert.equal(result.status, 0, `psql failed against ${dbName}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function freshDbName() {
  return `f_log_run_svc_gate_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function asRole(role, uuidOrNull, sqlText) {
  const setUid = uuidOrNull
    ? `do $$ begin perform set_config('app.test_uid', '${uuidOrNull}', false); end $$;\n`
    : "";
  return `set role ${role};\n${setUid}${sqlText}`;
}

const LOG_RUN_8ARG = "select core.log_run('log-run-svc-gate-test-app','job',7,null,10,20,5,0.5);";

// Builds the schema through 20260814170000_core_log_run_cost_fields.sql
// (the regressed state m6-02 found) on a fresh scratch database, then
// optionally applies FIX_UP on top.
function withDb(applyFix, fn) {
  const db = freshDbName();
  psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
  try {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, readFileSync(CORE_CREATE_SCHEMA_UP, "utf8"));
    psqlOk(db, readFileSync(IDEA_CREATE_SCHEMA_UP, "utf8"));
    psqlOk(db, readFileSync(RLS_BASELINE_UP, "utf8"));
    psqlOk(db, readFileSync(CORE_LOG_RUN_RPC_UP, "utf8"));
    psqlOk(db, coreEventRetentionWithoutCron());
    psqlOk(db, readFileSync(CORE_IDEA_OWNER_PIN_UP, "utf8"));
    psqlOk(db, readFileSync(OWNER_NULL_GUARD_UP, "utf8"));
    psqlOk(db, readFileSync(COST_FIELDS_UP, "utf8"));
    if (applyFix) psqlOk(db, readFileSync(FIX_UP, "utf8"));
    psqlOk(db, `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`);
    psqlOk(db, APP_FIXTURE_SQL);
    return fn(db);
  } finally {
    psqlOk("postgres", `drop database if exists ${db};`);
  }
}

test(
  "real Postgres RED: before this fix, an authenticated caller who is NOT the owner can still call the 8-arg log_run and insert rows (the m4-17 cost-fields migration's own regression)",
  { skip: SKIP_REASON },
  () => {
    withDb(false, (db) => {
      const runId = psqlOk(db, asRole("authenticated", STRANGER_UUID, LOG_RUN_8ARG)).trim();
      assert.match(runId, /^[0-9a-f-]{36}$/, "expected the forged call to succeed pre-fix, proving the regression");

      const runCount = psqlOk(db, `select count(*) from core.run where id = '${runId}';`).trim();
      assert.equal(runCount, "1");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, PUBLIC/anon lose EXECUTE on the 8-arg log_run entirely",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const result = psqlAllowError(db, asRole("anon", null, LOG_RUN_8ARG));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /permission denied for function log_run/);
    });
  },
);

test(
  "real Postgres GREEN: after the fix, an authenticated caller who is NOT the owner is rejected (42501 'owner only')",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const result = psqlAllowError(db, asRole("authenticated", STRANGER_UUID, LOG_RUN_8ARG));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /owner only/);

      const runCount = psqlOk(db, `select count(*) from core.run;`).trim();
      assert.equal(runCount, "0", "the rejected call must not have inserted anything");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, the owner's own authenticated call still succeeds, and user_id is the owner (not the null the pre-fix column default produced)",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const runId = psqlOk(db, asRole("authenticated", OWNER_UUID, LOG_RUN_8ARG)).trim();
      assert.match(runId, /^[0-9a-f-]{36}$/);

      const userId = psqlOk(db, `select user_id from core.run where id = '${runId}';`).trim();
      assert.equal(userId, OWNER_UUID);
    });
  },
);

test(
  "real Postgres GREEN: after the fix, service_role can still call log_run (Brain's own core-mirror.ts caller shape) even though it has no owner JWT at all",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const runId = psqlOk(db, asRole("service_role", null, LOG_RUN_8ARG)).trim();
      assert.match(runId, /^[0-9a-f-]{36}$/, "expected the Brain's own service_role call shape to succeed");

      const row = psqlOk(db, `select user_id from core.run where id = '${runId}';`).trim();
      assert.equal(row, OWNER_UUID, "a service_role-inserted run must still carry the owner's user_id, not null");
    });
  },
);

test(
  "real Postgres GREEN: the linked cost row carries the token/usd figures the caller supplied, for both caller shapes",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const runId = psqlOk(db, asRole("service_role", null, LOG_RUN_8ARG)).trim();
      const cost = psqlOk(
        db,
        `select input_tokens, output_tokens, cache_read_tokens, wall_clock_ms, usd from core.cost where run_id = '${runId}';`,
      ).trim();
      assert.equal(cost, "10|20|5|7|0.500000");
    });
  },
);
