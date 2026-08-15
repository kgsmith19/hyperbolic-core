// PR #8 security review, Finding 1 (P1, merge-blocking): real-Postgres proof
// that core.log_run's owner gate no longer fails open when
// platform.owner() is null (bootstrap state, before the one-time operator
// insert into platform.config -- docs/notes/2026-08-12-platform-idp-owner-setup.md)
// AND the caller is anonymous (auth.uid() also null) -- the exact "two
// nulls" condition IS DISTINCT FROM treats as NOT distinct, letting the
// pre-fix guard's `raise exception` branch never fire.
//
// Mirrors the detection/skip mechanics and scratch-database harness already
// established by apps/toolbelt/tests/registry-migrations-idempotency.test.mjs
// (m3-02) and apps/toolbelt/apps/idea-intake/backend/tests/intake-guards.test.mjs
// (m3-05): detects a usable local `psql`, skips itself cleanly via
// node:test's own skip mechanism (reported SKIPPED, never silently omitted
// or falsely green) when no local Postgres engine is reachable, and applies
// the real, committed migration files from disk verbatim wherever a vanilla
// local Postgres can support them.
//
// One file is NOT applied verbatim: 20260808120000_core_event_retention.sql
// ends with `create extension pg_cron;` plus two `cron.schedule(...)`
// calls. This sandbox's local Postgres has no pg_cron control file
// installed (confirmed: `select 1 from pg_available_extensions where
// name='pg_cron'` returns zero rows), so that statement cannot succeed on
// any local engine, in any test in this repo. This suite needs only that
// file's core.event_monthly_agg table + core.purge_old_events() function
// (20260812160000_core_idea_owner_pin.sql revokes/re-grants around
// purge_old_events, so it must exist for that migration to apply) --
// neither is pg_cron-related -- so CORE_EVENT_RETENTION_NO_CRON below is
// the real file's exact text with only the trailing
// `create extension pg_cron; select cron.schedule(...); select
// cron.schedule(...);` block sliced off (found by locating the literal
// string, not hand-retyped), the same "known-suffix-stripped, documented"
// technique registry-migrations-idempotency.test.mjs's own control test
// already uses on a different file for an analogous reason.
import { test } from "node:test";
import {
  asRole,
  createPostgresHarness,
  migrationBeforeMarker,
  supabaseHarnessSql,
} from "./postgres-harness.mjs";
import assert from "node:assert/strict";
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
const FIX_UP = join(MIGRATIONS_DIR, "20260814010000_core_log_run_owner_null_guard.sql");
const FIX_DOWN = join(MIGRATIONS_DIR, "20260814010000_core_log_run_owner_null_guard_down.sql");

const CRON_SPLIT_MARKER = "create extension pg_cron;";

const coreEventRetentionWithoutCron = () => migrationBeforeMarker(CORE_EVENT_RETENTION_UP, CRON_SPLIT_MARKER);

const OWNER_UUID = "11111111-1111-1111-1111-111111111111";
const STRANGER_UUID = "22222222-2222-2222-2222-222222222222";

// Same auth/role stub as intake-guards.test.mjs: a bare local Postgres has
// none of Supabase's managed platform (no GoTrue auth schema, no
// anon/authenticated/service_role/authenticator roles). auth.uid() reads a
// session GUC (app.test_uid) instead of GoTrue's JWT claim -- unset means
// null, exactly like an anonymous PostgREST request.
const { psql, psqlOk, withDatabase, skipReason: SKIP_REASON } = createPostgresHarness("f1_log_run_guard");
const psqlAllowError = psql;

const HARNESS_SQL = supabaseHarnessSql([OWNER_UUID, STRANGER_UUID]);

const APP_FIXTURE_SQL = `insert into core.app (id, name, schema_name) values ('log-run-guard-test-app', 'Test App', 'test');`;


// Builds the schema up through 20260812160000_core_idea_owner_pin.sql
// (the pre-Finding-1-fix state -- the buggy IS DISTINCT FROM guard, PUBLIC
// EXECUTE never revoked) on a fresh scratch database. Optionally applies
// FIX_UP on top when `applyFix` is true.
function withDb(applyFix, fn) {
  return withDatabase((db) => {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, readFileSync(CORE_CREATE_SCHEMA_UP, "utf8"));
    psqlOk(db, readFileSync(IDEA_CREATE_SCHEMA_UP, "utf8"));
    psqlOk(db, readFileSync(RLS_BASELINE_UP, "utf8"));
    psqlOk(db, readFileSync(CORE_LOG_RUN_RPC_UP, "utf8"));
    psqlOk(db, coreEventRetentionWithoutCron());
    psqlOk(db, readFileSync(CORE_IDEA_OWNER_PIN_UP, "utf8"));
    if (applyFix) psqlOk(db, readFileSync(FIX_UP, "utf8"));
    psqlOk(db, APP_FIXTURE_SQL);
    return fn(db);
  });
}

test(
  "real Postgres RED: before the fix, an anonymous caller reaches log_run and inserts core.run/core.cost while no owner is configured (Finding 1 reproduction)",
  { skip: SKIP_REASON },
  () => {
    withDb(false, (db) => {
      const runId = psqlOk(db, asRole("anon", null, "select core.log_run('log-run-guard-test-app','job',1);")).trim();
      assert.match(runId, /^[0-9a-f-]{36}$/, "expected log_run to return a real run id, proving the insert succeeded");

      const runCount = psqlOk(db, `select count(*) from core.run where id = '${runId}';`).trim();
      assert.equal(runCount, "1", "core.run row must exist -- the vulnerability is a real insert, not just a non-error return");

      const costCount = psqlOk(db, `select count(*) from core.cost where run_id = '${runId}';`).trim();
      assert.equal(costCount, "1");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, PUBLIC/anon lose EXECUTE entirely",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const result = psqlAllowError(db, asRole("anon", null, "select core.log_run('log-run-guard-test-app','job',1);"));
      assert.notEqual(result.status, 0, "expected the anon call to fail after the fix");
      assert.match(result.stderr, /permission denied for function log_run/);
    });
  },
);

test(
  "real Postgres GREEN: after the fix, an authenticated caller is still rejected (42501 'owner only') while no owner is configured -- the NULL-safe guard itself, independent of the grant revoke",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const result = psqlAllowError(db, asRole("authenticated", null, "select core.log_run('log-run-guard-test-app','job',1);"));
      assert.notEqual(result.status, 0, "expected the call to fail: no owner configured yet");
      assert.match(result.stderr, /owner only/);

      const runCount = psqlOk(db, `select count(*) from core.run;`).trim();
      assert.equal(runCount, "0", "no row should have been inserted");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, an authenticated caller who is NOT the owner is still rejected once an owner IS configured (regression check: the fix must not loosen the non-null case)",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      psqlOk(db, `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`);
      const result = psqlAllowError(
        db,
        asRole("authenticated", STRANGER_UUID, "select core.log_run('log-run-guard-test-app','job',1);"),
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /owner only/);
    });
  },
);

test(
  "real Postgres GREEN: the legitimate path still works -- once the owner is configured, the owner's own authenticated call succeeds and produces linked core.run/core.cost rows",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      psqlOk(db, `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`);
      const runId = psqlOk(
        db,
        asRole("authenticated", OWNER_UUID, "select core.log_run('log-run-guard-test-app','job',42);"),
      ).trim();
      assert.match(runId, /^[0-9a-f-]{36}$/);

      const row = psqlOk(db, `select status, (ended_at is not null) from core.run where id = '${runId}';`).trim();
      assert.equal(row, "ok|t");

      const cost = psqlOk(db, `select wall_clock_ms from core.cost where run_id = '${runId}';`).trim();
      assert.equal(cost, "42");
    });
  },
);
