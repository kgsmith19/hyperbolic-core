// Shared local-Postgres setup for the Prompt Organizer's migration-level
// suites -- the sibling of apps/idea-intake/backend/tests/intake-db.mjs, and
// deliberately separate from helpers.mjs, which serves the DEPLOYED REST
// tests (login/token/rest) and shares nothing with this concern.
//
// Four suites had byte-identical copies of the migration paths, the cron
// split, and the database-setup closure: contract.test.mjs and
// get-prompt.test.mjs applied the full migration list; retention-atomic and
// purge_old_usage_revoke_public applied the retention subset plus one fix
// under test. What legitimately differs between them -- which owner UUID they
// pin, which fixture rows they seed, which fix migration is the subject --
// stays a parameter; the parts that must not drift live here once.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationBeforeMarker } from "../../../../tests/postgres-harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(__dirname, "..");

export const ROOT_MIGRATIONS_DIR = join(BACKEND_DIR, "..", "..", "..", "supabase", "migrations");
export const PO_MIGRATIONS_DIR = join(BACKEND_DIR, "supabase", "migrations");

// prompt.usage_monthly_agg's owner_rw policy calls platform.owner(), so the
// function must exist for CREATE POLICY itself to compile.
export const PLATFORM_BOOTSTRAP_UP = join(
  ROOT_MIGRATIONS_DIR,
  "20260812140000_platform_owner_bootstrap.sql",
);

export const poMigration = (name) => join(PO_MIGRATIONS_DIR, name);

export const PROMPT_CREATE_PROMPT = "20260807020000_prompt_create_prompt.sql";

/** Every Prompt Organizer migration, in apply order. */
export const PO_MIGRATIONS_IN_ORDER = [
  PROMPT_CREATE_PROMPT,
  "20260807041000_prompt_versions_and_unique_title.sql",
  "20260807051000_prompt_create_tag.sql",
  "20260807070000_prompt_create_usage.sql",
  "20260808000000_prompt_add_is_active.sql",
  "20260808100000_prompt_create_configuration.sql",
  "20260808130000_prompt_create_render_function.sql",
  "20260812180000_prompt_owner_pin.sql",
  "20260812200000_prompt_observed_query_indexes.sql",
  "20260813120000_prompt_create_get_prompt_function.sql",
  "20260813140000_prompt_security_hardening.sql",
  "20260813150000_prompt_create_get_prompt_source_function.sql",
];

/** Just the migrations the two retention suites need, in apply order. */
export const RETENTION_MIGRATIONS_IN_ORDER = [
  PROMPT_CREATE_PROMPT,
  "20260807041000_prompt_versions_and_unique_title.sql",
  "20260807070000_prompt_create_usage.sql",
];

const PROMPT_USAGE_RETENTION_UP = poMigration("20260812210000_prompt_usage_retention.sql");
const CRON_SPLIT_MARKER = "select cron.schedule(";

/**
 * 20260812210000's real text with only its trailing `select cron.schedule(...)`
 * block sliced off -- this sandbox has no pg_cron control file, and these
 * suites need only the table and function that file creates, neither of which
 * is pg_cron-related. Located by the literal marker, never hand-retyped.
 */
export const promptUsageRetentionWithoutCron = () =>
  migrationBeforeMarker(PROMPT_USAGE_RETENTION_UP, CRON_SPLIT_MARKER);

/** Applies every PO migration, for the suites that test the schema as shipped. */
export function makeWithMigratedDb(harness, { harnessSql, ownerBootstrapSql }) {
  const { psqlOk, applyMigrationWithRetry, withDatabase } = harness;
  return function withMigratedDb(fn) {
    return withDatabase((db) => {
      psqlOk(db, harnessSql);
      psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
      psqlOk(db, ownerBootstrapSql);
      for (const name of PO_MIGRATIONS_IN_ORDER) {
        const sql = readFileSync(poMigration(name), "utf8");
        if (name === PROMPT_CREATE_PROMPT) applyMigrationWithRetry(db, sql);
        else psqlOk(db, sql);
      }
      return fn(db);
    });
  };
}

/**
 * Applies the retention subset onto an already-created database, then
 * optionally the one fix migration under test.
 *
 * Exposed as a bare step, not only through makeWithRetentionDb, because the
 * two-session concurrency proof cannot use `withDatabase`: it creates and
 * drops its own database around a held lock, so it needs the schema applied
 * to a handle it owns. Sharing the step keeps that test's stack identical to
 * every other one in its file rather than a copy that can drift.
 */
export function applyRetentionSchema(psqlOk, db, { harnessSql, fixtureSql, fixUp, applyFix = true }) {
  psqlOk(db, harnessSql);
  psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
  for (const name of RETENTION_MIGRATIONS_IN_ORDER) {
    psqlOk(db, readFileSync(poMigration(name), "utf8"));
  }
  psqlOk(db, promptUsageRetentionWithoutCron());
  if (applyFix) psqlOk(db, readFileSync(fixUp, "utf8"));
  psqlOk(db, fixtureSql);
}

/**
 * The common case: a fresh database per test, so a suite can run the same body
 * against the pre-fix schema (RED) and the fixed one (GREEN) without restating
 * the setup twice.
 */
export function makeWithRetentionDb(harness, options) {
  const { psqlOk, withDatabase } = harness;
  return function withDb(applyFix, fn) {
    return withDatabase((db) => {
      applyRetentionSchema(psqlOk, db, { ...options, applyFix });
      return fn(db);
    });
  };
}
