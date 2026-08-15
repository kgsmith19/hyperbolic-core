// Independent security review, Finding 35 (re-verified against current
// HEAD): real-Postgres proof that intake.idea's `source` column can now be
// edited before submission (it was insertable but never updatable --
// 20260813002605_intake_create_schema.sql's UPDATE grant omitted it, unlike
// every sibling free-text column), and that II-3 immutability is
// unaffected: the fix is purely additive to the grant, not a change to the
// guard trigger.
//
// Same harness/skip mechanics as
// apps/toolbelt/apps/idea-intake/tests/mark_submitted_to_github_rpc.test.mjs
// (m3-05 lineage): stubs GoTrue's auth schema/roles a bare local Postgres
// lacks, applies the real, committed migration files from disk verbatim.
import { test } from "node:test";
import { createPostgresHarness, supabaseHarnessSql } from "../../../tests/postgres-harness.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = join(__dirname, "..");
const ROOT_MIGRATIONS_DIR = join(TOOL_DIR, "..", "..", "supabase", "migrations");
const INTAKE_MIGRATIONS_DIR = join(TOOL_DIR, "supabase", "migrations");

const PLATFORM_BOOTSTRAP_UP = join(ROOT_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");
const INTAKE_UP = join(INTAKE_MIGRATIONS_DIR, "20260813002605_intake_create_schema.sql");
const FIX_UP = join(INTAKE_MIGRATIONS_DIR, "20260814090000_intake_idea_source_update_grant.sql");
const FIX_DOWN = join(INTAKE_MIGRATIONS_DIR, "20260814090000_intake_idea_source_update_grant_down.sql");

const OWNER_UUID = "11111111-1111-1111-1111-111111111111";

const { psql, psqlOk, applyMigrationWithRetry, withDatabase, skipReason: SKIP_REASON } = createPostgresHarness("f35_source_grant");
const psqlAllowError = psql;

const HARNESS_SQL = supabaseHarnessSql([OWNER_UUID]);

const OWNER_BOOTSTRAP_SQL = `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`;

function asAuthenticatedOwner(sqlText) {
  return `set role authenticated;\ndo $$ begin perform set_config('app.test_uid', '${OWNER_UUID}', false); end $$;\n${sqlText}`;
}

function withDb(applyFix, fn) {
  return withDatabase((db) => {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, OWNER_BOOTSTRAP_SQL);
    applyMigrationWithRetry(db, readFileSync(INTAKE_UP, "utf8"));
    if (applyFix) psqlOk(db, readFileSync(FIX_UP, "utf8"));
    return fn(db);
  });
}

function insertDraftIdea(db, title, source) {
  return psqlOk(
    db,
    asAuthenticatedOwner(`insert into intake.idea (title, source) values ('${title}', '${source}') returning id;`),
  ).trim();
}

test(
  "real Postgres RED: before the fix, an authenticated owner cannot update source on their own draft idea (Finding 35 reproduction)",
  { skip: SKIP_REASON },
  () => {
    withDb(false, (db) => {
      const id = insertDraftIdea(db, "red source", "original source");

      const result = psqlAllowError(db, asAuthenticatedOwner(`update intake.idea set source = 'corrected source' where id = '${id}';`));
      assert.notEqual(result.status, 0, "expected the source update to fail before the fix");
      assert.match(result.stderr, /permission denied for table idea/);

      const row = psqlOk(db, `select source from intake.idea where id = '${id}';`).trim();
      assert.equal(row, "original source", "source must be unchanged");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, the owner can update source on their own draft idea",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const id = insertDraftIdea(db, "green source draft", "original source");

      psqlOk(db, asAuthenticatedOwner(`update intake.idea set source = 'corrected source' where id = '${id}';`));

      const row = psqlOk(db, `select source from intake.idea where id = '${id}';`).trim();
      assert.equal(row, "corrected source");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, the owner can still update source while the idea is in the 'idea' state (pre-submission)",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const id = psqlOk(
        db,
        asAuthenticatedOwner(
          "insert into intake.idea (title, source, target_repo) values ('green source idea-state', 'original', 'kgsmith19/scratch') returning id;",
        ),
      ).trim();
      psqlOk(db, asAuthenticatedOwner(`update intake.idea set status = 'idea' where id = '${id}';`));

      psqlOk(db, asAuthenticatedOwner(`update intake.idea set source = 'corrected in idea state' where id = '${id}';`));

      const row = psqlOk(db, `select source, status from intake.idea where id = '${id}';`).trim();
      assert.equal(row, "corrected in idea state|idea");
    });
  },
);

test(
  "real Postgres GREEN: the fix does not weaken II-3 -- source still cannot be edited once submitted",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const id = psqlOk(
        db,
        asAuthenticatedOwner(
          "insert into intake.idea (title, source, target_repo) values ('green source submitted', 'original', 'kgsmith19/scratch') returning id;",
        ),
      ).trim();
      psqlOk(db, asAuthenticatedOwner(`update intake.idea set status = 'idea' where id = '${id}';`));
      psqlOk(
        db,
        asAuthenticatedOwner(
          `update intake.idea set status = 'submitted_to_github', github_issue_number = 1, ` +
            `github_issue_url = 'https://x/1', submitted_at = now() where id = '${id}';`,
        ),
      );

      const result = psqlAllowError(db, asAuthenticatedOwner(`update intake.idea set source = 'trying to edit after submit' where id = '${id}';`));
      assert.notEqual(result.status, 0, "expected the post-submission source edit to still fail");
      assert.match(result.stderr, /II-3: submitted ideas are immutable/);

      const row = psqlOk(db, `select source from intake.idea where id = '${id}';`).trim();
      assert.equal(row, "original", "source must remain whatever it was at submission time");
    });
  },
);

test("the down migration reverses exactly the up migration's grant", () => {
  const upSql = readFileSync(FIX_UP, "utf8");
  const downSql = readFileSync(FIX_DOWN, "utf8");
  assert.match(upSql, /grant update \(source\) on intake\.idea to authenticated;/);
  assert.match(downSql, /revoke update \(source\) on intake\.idea from authenticated;/);
});
