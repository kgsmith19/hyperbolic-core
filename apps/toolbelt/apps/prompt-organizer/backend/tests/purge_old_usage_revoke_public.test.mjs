// PR #8 security review, Finding 2 (P1, merge-blocking), part B: real-Postgres
// proof that prompt.purge_old_usage() -- a destructive, unconditional bulk
// DELETE over prompt.usage -- can no longer be invoked by an anonymous
// PostgREST caller. 20260812210000_prompt_usage_retention.sql created this
// function with NO grant/revoke statement at all; its own comment ("cron-only
// ... no EXECUTE grant to API roles") does not match Postgres's actual
// default (EXECUTE to PUBLIC at CREATE FUNCTION time), which was never
// revoked.
//
// Same harness/skip mechanics as
// apps/toolbelt/tests/registry-migrations-idempotency.test.mjs and
// apps/toolbelt/apps/idea-intake/backend/tests/intake-guards.test.mjs. Same pg_cron
// caveat as apps/toolbelt/tests/purge_old_events_revoke_public.test.mjs, for
// the identical reason: this sandbox's local Postgres has no pg_cron
// control file installed, so 20260812210000_prompt_usage_retention.sql's
// trailing `select cron.schedule(...)` calls (two of them: the usage purge
// and the unrelated test.scratch purge) cannot run locally. This suite
// needs only that file's prompt.usage_monthly_agg table and
// prompt.purge_old_usage() function -- neither pg_cron-related -- so it
// applies the real file's exact text with only that trailing block sliced
// off (found by locating the literal string, never hand-retyped; no
// `create extension pg_cron` line exists in THIS file, unlike
// core_event_retention.sql, since 20260812210000's own comment notes
// pg_cron is already installed by that earlier migration).
//
// "Legitimate path still works" proof: identical reasoning to
// purge_old_events_revoke_public.test.mjs -- pg_cron runs a scheduled job
// as the role that called cron.schedule() (the migration-applying
// connection), never a PostgREST API role, so this asserts the function
// stays callable by that same unprivileged-role-agnostic connection (no
// `SET ROLE`) after the fix.
import { test } from "node:test";
import {
  createPostgresHarness,
  migrationBeforeMarker,
  supabaseHarnessSql,
} from "../../../../tests/postgres-harness.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(__dirname, "..");
const ROOT_MIGRATIONS_DIR = join(BACKEND_DIR, "..", "..", "..", "supabase", "migrations");
const PO_MIGRATIONS_DIR = join(BACKEND_DIR, "supabase", "migrations");

const PLATFORM_BOOTSTRAP_UP = join(ROOT_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");
const PROMPT_CREATE_PROMPT_UP = join(PO_MIGRATIONS_DIR, "20260807020000_prompt_create_prompt.sql");
const PROMPT_VERSIONS_UP = join(PO_MIGRATIONS_DIR, "20260807041000_prompt_versions_and_unique_title.sql");
const PROMPT_CREATE_USAGE_UP = join(PO_MIGRATIONS_DIR, "20260807070000_prompt_create_usage.sql");
const PROMPT_USAGE_RETENTION_UP = join(PO_MIGRATIONS_DIR, "20260812210000_prompt_usage_retention.sql");
const FIX_UP = join(PO_MIGRATIONS_DIR, "20260814030000_prompt_purge_old_usage_revoke_public.sql");
const FIX_DOWN = join(PO_MIGRATIONS_DIR, "20260814030000_prompt_purge_old_usage_revoke_public_down.sql");

const CRON_SPLIT_MARKER = "select cron.schedule(";

const promptUsageRetentionWithoutCron = () => migrationBeforeMarker(PROMPT_USAGE_RETENTION_UP, CRON_SPLIT_MARKER);

const { psql, psqlOk, withDatabase, skipReason: SKIP_REASON } = createPostgresHarness("f2b_purge_usage");
const psqlAllowError = psql;

const HARNESS_SQL = supabaseHarnessSql([]);

const OWNER_UUID = "11111111-1111-1111-1111-111111111111";
const PROMPT_ID = "44444444-4444-4444-4444-444444444444";
const FIXTURE_SQL = `
insert into auth.users (id) values ('${OWNER_UUID}');
insert into prompt.prompt (id, user_id, title, body) values ('${PROMPT_ID}', '${OWNER_UUID}', 'fixture prompt', 'fixture body');
`;

function insertOldUsageSql() {
  return `insert into prompt.usage (prompt_id, version_no, user_id, created_at) values ('${PROMPT_ID}', 1, '${OWNER_UUID}', now() - interval '400 days');`;
}

function asAnon(sqlText) {
  return `set role anon;\n${sqlText}`;
}

function withDb(applyFix, fn) {
  return withDatabase((db) => {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, readFileSync(PROMPT_CREATE_PROMPT_UP, "utf8"));
    psqlOk(db, readFileSync(PROMPT_VERSIONS_UP, "utf8"));
    psqlOk(db, readFileSync(PROMPT_CREATE_USAGE_UP, "utf8"));
    psqlOk(db, promptUsageRetentionWithoutCron());
    if (applyFix) psqlOk(db, readFileSync(FIX_UP, "utf8"));
    psqlOk(db, FIXTURE_SQL);
    return fn(db);
  });
}

test(
  "real Postgres RED: before the fix, an anonymous caller invokes purge_old_usage and it really deletes a stale prompt.usage row (Finding 2b reproduction)",
  { skip: SKIP_REASON },
  () => {
    withDb(false, (db) => {
      psqlOk(db, insertOldUsageSql());
      const before = psqlOk(db, "select count(*) from prompt.usage;").trim();
      assert.equal(before, "1");

      const purged = psqlOk(db, asAnon("select prompt.purge_old_usage();")).trim();
      assert.equal(purged, "1", "expected the anon-invoked purge to report exactly one deleted row");

      const after = psqlOk(db, "select count(*) from prompt.usage;").trim();
      assert.equal(after, "0", "the stale usage row must really be gone -- proving this is a real destructive call, not a no-op");

      const agg = psqlOk(db, "select copy_count from prompt.usage_monthly_agg;").trim();
      assert.equal(agg, "1", "the purge's own monthly-aggregate bookkeeping must still have run");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, an anonymous caller can no longer call purge_old_usage at all, and the stale row survives",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      psqlOk(db, insertOldUsageSql());

      const result = psqlAllowError(db, asAnon("select prompt.purge_old_usage();"));
      assert.notEqual(result.status, 0, "expected the anon call to fail after the fix");
      assert.match(result.stderr, /permission denied for function purge_old_usage/);

      const after = psqlOk(db, "select count(*) from prompt.usage;").trim();
      assert.equal(after, "1", "the stale usage row must survive an anon caller who can no longer reach the purge RPC");
    });
  },
);

test(
  "real Postgres GREEN: the legitimate path still works -- the migration-applying/superuser connection pg_cron's job actually runs as can still call purge_old_usage and it still purges for real",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      psqlOk(db, insertOldUsageSql());

      const purged = psqlOk(db, "select prompt.purge_old_usage();").trim();
      assert.equal(purged, "1");

      const after = psqlOk(db, "select count(*) from prompt.usage;").trim();
      assert.equal(after, "0");
    });
  },
);
