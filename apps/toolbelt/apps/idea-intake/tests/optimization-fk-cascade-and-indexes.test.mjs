// Independent security review, Finding 36 and Finding 49 (re-verified
// against current HEAD): real-Postgres proof that
// (a) deleting a non-submitted idea with optimization history, an action
//     intake.guard_idea_delete and intake.idea's own grants explicitly
//     permit, no longer fails with a foreign-key violation (Finding 36),
//     and cascade-deletes the now-orphaned intake.optimization rows;
// (b) intake.optimization.input_idea_id/output_idea_id are now backed by a
//     real index each, proven via the catalog and via EXPLAIN showing an
//     index scan is available for the cascade's own lookup (Finding 49);
// (c) II-3 (submitted ideas cannot be deleted) is unaffected -- this fix
//     only changes what happens to OPTIMIZATION rows, never intake.idea's
//     own delete guard.
//
// Same harness/skip mechanics as
// apps/toolbelt/apps/idea-intake/tests/intake-guards.test.mjs (m3-05).
import { test } from "node:test";
import { asRole, createPostgresHarness, supabaseHarnessSql } from "../../../tests/postgres-harness.mjs";
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
const FIX_UP = join(INTAKE_MIGRATIONS_DIR, "20260814100000_intake_optimization_fk_cascade_and_indexes.sql");
const FIX_DOWN = join(INTAKE_MIGRATIONS_DIR, "20260814100000_intake_optimization_fk_cascade_and_indexes_down.sql");

const OWNER_UUID = "11111111-1111-1111-1111-111111111111";

const { psql, psqlOk, applyMigrationWithRetry, withDatabase, skipReason: SKIP_REASON } = createPostgresHarness("f36_f49_optimization");
const psqlAllowError = psql;

const HARNESS_SQL = supabaseHarnessSql([OWNER_UUID]);

const OWNER_BOOTSTRAP_SQL = `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`;

const asAuthenticatedOwner = (sqlText) => asRole("authenticated", OWNER_UUID, sqlText);

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

function insertDraftIdea(db, title) {
  return psqlOk(db, asAuthenticatedOwner(`insert into intake.idea (title) values ('${title}') returning id;`)).trim();
}

function insertOptimization(db, inputIdeaId) {
  return psqlOk(
    db,
    asAuthenticatedOwner(
      `insert into intake.optimization (input_idea_id, prompt_name, model) values ('${inputIdeaId}', 'p1', 'm1') returning id;`,
    ),
  ).trim();
}

test(
  "real Postgres RED: before the fix, deleting a draft idea with optimization history fails with a foreign-key violation, even though the guard trigger permits the delete (Finding 36 reproduction)",
  { skip: SKIP_REASON },
  () => {
    withDb(false, (db) => {
      const ideaId = insertDraftIdea(db, "red draft with history");
      insertOptimization(db, ideaId);

      const result = psqlAllowError(db, asAuthenticatedOwner(`delete from intake.idea where id = '${ideaId}';`));
      assert.notEqual(result.status, 0, "expected the delete to fail before the fix");
      assert.match(result.stderr, /violates foreign key constraint/);

      const stillThere = psqlOk(db, `select count(*) from intake.idea where id = '${ideaId}';`).trim();
      assert.equal(stillThere, "1", "the idea must still exist -- the delete was rejected, not silently dropped");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, deleting a draft idea with optimization history succeeds and cascades the optimization rows",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const ideaId = insertDraftIdea(db, "green draft with history");
      const optId = insertOptimization(db, ideaId);

      psqlOk(db, asAuthenticatedOwner(`delete from intake.idea where id = '${ideaId}';`));

      const ideaGone = psqlOk(db, `select count(*) from intake.idea where id = '${ideaId}';`).trim();
      assert.equal(ideaGone, "0");
      const optGone = psqlOk(db, `select count(*) from intake.optimization where id = '${optId}';`).trim();
      assert.equal(optGone, "0", "the optimization row referencing the deleted idea must be cascade-deleted, not orphaned");
    });
  },
);

test(
  "real Postgres GREEN: cascade also fires through output_idea_id, and deleting one idea does not disturb an unrelated optimization row",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const inputId = insertDraftIdea(db, "green input idea");
      const outputId = insertDraftIdea(db, "green output idea");
      const unrelatedId = insertDraftIdea(db, "green unrelated idea");

      const optId = psqlOk(
        db,
        asAuthenticatedOwner(
          `insert into intake.optimization (input_idea_id, output_idea_id, prompt_name, model) ` +
            `values ('${inputId}', '${outputId}', 'p1', 'm1') returning id;`,
        ),
      ).trim();
      const unrelatedOptId = insertOptimization(db, unrelatedId);

      // Delete only the OUTPUT idea; input_idea_id's own cascade path must
      // fire too.
      psqlOk(db, asAuthenticatedOwner(`delete from intake.idea where id = '${outputId}';`));

      const optGone = psqlOk(db, `select count(*) from intake.optimization where id = '${optId}';`).trim();
      assert.equal(optGone, "0", "deleting the output idea must cascade-delete the optimization row referencing it");

      const unrelatedStillThere = psqlOk(db, `select count(*) from intake.optimization where id = '${unrelatedOptId}';`).trim();
      assert.equal(unrelatedStillThere, "1", "an unrelated optimization row must survive untouched");
    });
  },
);

test(
  "real Postgres GREEN: the fix does not weaken II-3 -- a submitted idea still cannot be deleted, even with no optimization history",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const id = psqlOk(
        db,
        asAuthenticatedOwner(
          "insert into intake.idea (title, target_repo) values ('green submitted', 'kgsmith19/scratch') returning id;",
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

      const result = psqlAllowError(db, asAuthenticatedOwner(`delete from intake.idea where id = '${id}';`));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /II-3: submitted ideas cannot be deleted/);
    });
  },
);

test(
  "real Postgres: intake.optimization carries an index on input_idea_id and on output_idea_id, and the query planner actually uses one for a lookup by input_idea_id (Finding 49)",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const indexNames = psqlOk(
        db,
        "select indexname from pg_indexes where schemaname = 'intake' and tablename = 'optimization' order by indexname;",
      )
        .trim()
        .split("\n");
      assert.ok(indexNames.includes("optimization_input_idea"), `expected an index named optimization_input_idea, got: ${indexNames}`);
      assert.ok(indexNames.includes("optimization_output_idea"), `expected an index named optimization_output_idea, got: ${indexNames}`);

      // Seed a table where the target key is a SMALL, low-selectivity slice
      // of a much larger whole (20 distinct ideas x 50 rows each = 1000
      // rows total, querying for exactly one idea's 50): a lookup matching
      // the ENTIRE table (as a single-idea, all-matching seed would) gives
      // the planner no reason to prefer an index over a seqscan even with
      // the index present, which would make that shape of assertion
      // uninformative either way.
      const targetIdeaId = insertDraftIdea(db, "index-planner target idea");
      const otherIdeaIds = [];
      for (let i = 0; i < 19; i += 1) {
        otherIdeaIds.push(insertDraftIdea(db, `index-planner filler idea ${i}`));
      }
      psqlOk(
        db,
        asAuthenticatedOwner(
          `insert into intake.optimization (input_idea_id, prompt_name, model) ` +
            `select '${targetIdeaId}', 'p', 'm' from generate_series(1, 50);`,
        ),
      );
      for (const otherId of otherIdeaIds) {
        psqlOk(
          db,
          asAuthenticatedOwner(
            `insert into intake.optimization (input_idea_id, prompt_name, model) ` +
              `select '${otherId}', 'p', 'm' from generate_series(1, 50);`,
          ),
        );
      }
      psqlOk(db, "analyze intake.optimization;");

      const plan = psqlOk(
        db,
        `explain select * from intake.optimization where input_idea_id = '${targetIdeaId}';`,
      );
      assert.match(plan, /optimization_input_idea/, `expected the planner to use the new index for a 50/1000-row lookup; got plan:\n${plan}`);
    });
  },
);

test("the down migration restores ON DELETE NO ACTION on both FKs and drops both indexes", () => {
  const downSql = readFileSync(FIX_DOWN, "utf8");
  assert.match(downSql, /foreign key \(input_idea_id\) references intake\.idea\(id\);/);
  assert.match(downSql, /foreign key \(output_idea_id\) references intake\.idea\(id\);/);
  assert.doesNotMatch(downSql, /on delete cascade/i);
  assert.match(downSql, /drop index if exists intake\.optimization_input_idea;/);
  assert.match(downSql, /drop index if exists intake\.optimization_output_idea;/);
});
