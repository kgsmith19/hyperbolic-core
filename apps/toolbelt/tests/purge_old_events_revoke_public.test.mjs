// PR #8 security review, Finding 2 (P1, merge-blocking), part A: real-Postgres
// proof that core.purge_old_events() -- a destructive, unconditional bulk
// DELETE over core.event -- can no longer be invoked by an anonymous
// PostgREST caller (PUBLIC/anon EXECUTE, never revoked despite
// 20260812160000_core_idea_owner_pin.sql's own "cron-only from here on"
// comment only having revoked `authenticated`).
//
// Same harness/skip mechanics as
// apps/toolbelt/tests/log_run_owner_null_guard.test.mjs and
// apps/toolbelt/tests/registry-migrations-idempotency.test.mjs. Same
// pg_cron caveat and fix, for the identical reason: this sandbox's local
// Postgres has no pg_cron control file installed (confirmed: `select 1
// from pg_available_extensions where name='pg_cron'` returns zero rows),
// so 20260808120000_core_event_retention.sql's trailing `create extension
// pg_cron; select cron.schedule(...);` block cannot run locally. This suite
// needs only that file's core.event_monthly_agg table and
// core.purge_old_events() function -- neither pg_cron-related -- so it
// applies the real file's exact text with only that trailing block sliced
// off (found by locating the literal string, never hand-retyped).
//
// The "legitimate path still works" proof is the pg_cron job's own
// identity, not a live pg_cron run: pg_cron runs a scheduled job as the
// role that called cron.schedule() -- the migration-applying connection
// (this project's superuser/service connection), never a PostgREST API
// role. Revoking PUBLIC/anon/authenticated does not touch that role's
// access (superusers bypass ACL checks entirely), so this suite asserts
// the function is still callable by the same unprivileged-role-agnostic
// connection the real cron job runs as -- a direct call with no `SET
// ROLE`, exactly matching apps/toolbelt/tests/owner-repin.test.mjs's own
// documented posture that pg_cron's live end-to-end schedule is a
// manual/CI-operator verification, not something this REST/psql-only
// harness fakes.
import { test } from "node:test";
import {
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
const CORE_EVENT_RETENTION_UP = join(MIGRATIONS_DIR, "20260808120000_core_event_retention.sql");
const CORE_IDEA_OWNER_PIN_UP = join(MIGRATIONS_DIR, "20260812160000_core_idea_owner_pin.sql");
const FIX_UP = join(MIGRATIONS_DIR, "20260814020000_core_purge_old_events_revoke_public.sql");
const FIX_DOWN = join(MIGRATIONS_DIR, "20260814020000_core_purge_old_events_revoke_public_down.sql");

const CRON_SPLIT_MARKER = "create extension pg_cron;";

const coreEventRetentionWithoutCron = () => migrationBeforeMarker(CORE_EVENT_RETENTION_UP, CRON_SPLIT_MARKER);

const { psql, psqlOk, withDatabase, skipReason: SKIP_REASON } = createPostgresHarness("f2a_purge_events");
const psqlAllowError = psql;

const HARNESS_SQL = supabaseHarnessSql([]);

const RUN_ID = "33333333-3333-3333-3333-333333333333";
const FIXTURE_SQL = `
insert into core.app (id, name, schema_name) values ('purge-guard-test-app', 'Test App', 'test');
insert into core.run (id, app_id, kind) values ('${RUN_ID}', 'purge-guard-test-app', 'job');
`;

function insertOldEventSql(name) {
  return `insert into core.event (run_id, at, kind, name) values ('${RUN_ID}', now() - interval '100 days', 'tool_call', '${name}');`;
}

function asAnon(sqlText) {
  return `set role anon;\n${sqlText}`;
}

function withDb(applyFix, fn) {
  return withDatabase((db) => {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, readFileSync(CORE_CREATE_SCHEMA_UP, "utf8"));
    psqlOk(db, readFileSync(IDEA_CREATE_SCHEMA_UP, "utf8"));
    psqlOk(db, readFileSync(RLS_BASELINE_UP, "utf8"));
    psqlOk(db, coreEventRetentionWithoutCron());
    psqlOk(db, readFileSync(CORE_IDEA_OWNER_PIN_UP, "utf8"));
    if (applyFix) psqlOk(db, readFileSync(FIX_UP, "utf8"));
    psqlOk(db, FIXTURE_SQL);
    return fn(db);
  });
}

test(
  "real Postgres RED: before the fix, an anonymous caller invokes purge_old_events and it really deletes a stale core.event row (Finding 2a reproduction)",
  { skip: SKIP_REASON },
  () => {
    withDb(false, (db) => {
      psqlOk(db, insertOldEventSql("red-old-event"));
      const before = psqlOk(db, "select count(*) from core.event;").trim();
      assert.equal(before, "1");

      const purged = psqlOk(db, asAnon("select core.purge_old_events();")).trim();
      assert.equal(purged, "1", "expected the anon-invoked purge to report exactly one deleted row");

      const after = psqlOk(db, "select count(*) from core.event;").trim();
      assert.equal(after, "0", "the stale event row must really be gone -- proving this is a real destructive call, not a no-op");

      const agg = psqlOk(db, "select event_count from core.event_monthly_agg;").trim();
      assert.equal(agg, "1", "the purge's own monthly-aggregate bookkeeping must still have run");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, an anonymous caller can no longer call purge_old_events at all, and the stale row survives",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      psqlOk(db, insertOldEventSql("green-old-event"));

      const result = psqlAllowError(db, asAnon("select core.purge_old_events();"));
      assert.notEqual(result.status, 0, "expected the anon call to fail after the fix");
      assert.match(result.stderr, /permission denied for function purge_old_events/);

      const after = psqlOk(db, "select count(*) from core.event;").trim();
      assert.equal(after, "1", "the stale event row must survive an anon caller who can no longer reach the purge RPC");
    });
  },
);

test(
  "real Postgres GREEN: the legitimate path still works -- the migration-applying/superuser connection pg_cron's job actually runs as can still call purge_old_events and it still purges for real",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      psqlOk(db, insertOldEventSql("legit-old-event"));

      // No `set role`: this is the same class of connection pg_cron's
      // scheduled job runs its command as (the role that called
      // cron.schedule at migration-apply time), which superuser ACL bypass
      // makes unaffected by this migration's REVOKE.
      const purged = psqlOk(db, "select core.purge_old_events();").trim();
      assert.equal(purged, "1");

      const after = psqlOk(db, "select count(*) from core.event;").trim();
      assert.equal(after, "0");
    });
  },
);
