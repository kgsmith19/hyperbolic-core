// The Idea Intake suites' shared database scaffolding: where the real,
// committed migrations live, the owner fixture every suite seeds, and the
// per-suite `withDb` that applies a baseline schema plus the ONE migration
// that suite exists to prove.
//
// Not named *.test.mjs on purpose -- the gate runs `node --test
// "tests/*.test.mjs"`, so this is a module the suites import, never a suite.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { asRole, supabaseHarnessSql } from "../../../../tests/postgres-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(HERE, "..");
const ROOT_MIGRATIONS_DIR = join(BACKEND_DIR, "..", "..", "..", "supabase", "migrations");

export const INTAKE_MIGRATIONS_DIR = join(BACKEND_DIR, "supabase", "migrations");

/** A migration file in this app's own directory, by filename. */
export const intakeMigration = (name) => join(INTAKE_MIGRATIONS_DIR, name);

export const PLATFORM_BOOTSTRAP_UP = join(ROOT_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");
export const INTAKE_UP = intakeMigration("20260813002605_intake_create_schema.sql");

export const OWNER_UUID = "11111111-1111-1111-1111-111111111111";
export const HARNESS_SQL = supabaseHarnessSql([OWNER_UUID]);

/** intake's RLS resolves the owner through platform.config, so the row must
 *  exist before any policy is exercised. */
export const OWNER_BOOTSTRAP_SQL = `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`;

/** The owner, as a plain authenticated session with no JWT claims -- see
 *  asRole in the shared harness for why the narrow form is the right one. */
export const asAuthenticatedOwner = (sqlText) => asRole("authenticated", OWNER_UUID, sqlText);

/**
 * Build a suite's `withDb(applyFix, fn)`.
 *
 * Every suite stands up the same baseline -- auth stubs, platform bootstrap,
 * the owner row, then intake's create-schema migration -- and differs only in
 * `fixUp`, the single migration it is there to prove. Passing that path in is
 * what keeps this shared: the three call sites previously had a byte-identical
 * withDb whose meaning differed entirely, because each closed over its own
 * FIX_UP constant. Textually the same function, three different tests.
 *
 * `harness` is the object createPostgresHarness() returns; each suite makes
 * its own so its scratch databases carry its own name prefix.
 */
export function makeWithDb(harness, fixUp) {
  const { psqlOk, applyMigrationWithRetry, withDatabase } = harness;
  return function withDb(applyFix, fn) {
    return withDatabase((db) => {
      psqlOk(db, HARNESS_SQL);
      psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
      psqlOk(db, OWNER_BOOTSTRAP_SQL);
      applyMigrationWithRetry(db, readFileSync(INTAKE_UP, "utf8"));
      if (applyFix) psqlOk(db, readFileSync(fixUp, "utf8"));
      return fn(db);
    });
  };
}
