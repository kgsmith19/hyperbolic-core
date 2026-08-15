// PR #8 security review, Finding 8 (P1, merge-blocking): real-Postgres proof
// that an `authenticated` client can no longer forge a terminal Idea
// submission by directly UPDATEing status + fabricated github_issue_number/
// github_issue_url/submitted_at in one statement, and that the narrow
// intake.mark_submitted_to_github() RPC this migration adds is the only
// remaining path to that transition, still gated by the exact same
// `intake.guard_idea_update` state-machine trigger
// 20260813002605_intake_create_schema.sql already established (II-1 legal
// transitions, II-3 immutability) -- unweakened, since that trigger fires
// for every UPDATE regardless of caller or SECURITY DEFINER context.
//
// Same harness/detection/skip mechanics as
// apps/toolbelt/apps/idea-intake/backend/tests/intake-guards.test.mjs (m3-05):
// stubs GoTrue's auth schema/roles a bare local Postgres lacks, applies the
// real, committed migration files from disk verbatim.
//
// One SQL-authoring note carried over from manual verification while
// writing this suite: `select (fn()).*;` on a plain (non-set-returning)
// function is a documented PostgreSQL executor gotcha -- expanding a
// composite value's columns with `.*` directly off a bare function call can
// re-evaluate that function once per referenced output column, which would
// call this state-mutating RPC multiple times per "one call" test
// assertion. Every call below is written as a bare `select
// intake.mark_submitted_to_github(...);` (the whole composite as a single
// output column, never `.*`-expanded on the call site) specifically to
// avoid that trap; row contents are asserted afterward with a separate,
// plain `select ... from intake.idea where id = ...` query instead.
import { test } from "node:test";
import { asRole, createPostgresHarness } from "../../../../tests/postgres-harness.mjs";
import {
  asAuthenticatedOwner,
  intakeMigration,
  makeWithDb,
} from "./intake-db.mjs";
import assert from "node:assert/strict";


const FIX_UP = intakeMigration("20260814040000_intake_mark_submitted_to_github_rpc.sql");
const FIX_DOWN = intakeMigration("20260814040000_intake_mark_submitted_to_github_rpc_down.sql");


const PG = createPostgresHarness("f8_mark_submitted");
const { psql, psqlOk, applyMigrationWithRetry, withDatabase, skipReason: SKIP_REASON } = PG;
const psqlAllowError = psql;




const asServiceRole = (sqlText) => asRole("service_role", null, sqlText);

const withDb = makeWithDb(PG, FIX_UP);

// Promotes a fresh draft idea to 'idea' (as the owner) and returns its id --
// the shared starting point every test below forges/submits from.
function insertPromotedIdea(db, title) {
  const id = psqlOk(
    db,
    asAuthenticatedOwner(`insert into intake.idea (title, target_repo) values ('${title}', 'kgsmith19/scratch') returning id;`),
  ).trim();
  psqlOk(db, asAuthenticatedOwner(`update intake.idea set status = 'idea' where id = '${id}';`));
  return id;
}

test(
  "real Postgres RED: before the fix, an authenticated client forges a terminal submission in one UPDATE -- fabricated issue number/url/timestamp, no server ever created the GitHub Issue (Finding 8 reproduction)",
  { skip: SKIP_REASON },
  () => {
    withDb(false, (db) => {
      const id = insertPromotedIdea(db, "forge target");

      psqlOk(
        db,
        asAuthenticatedOwner(
          `update intake.idea set status = 'submitted_to_github', github_issue_number = 99999, ` +
            `github_issue_url = 'https://github.com/attacker/fake/issues/99999', submitted_at = now() where id = '${id}';`,
        ),
      );

      const row = psqlOk(
        db,
        `select status, github_issue_number, github_issue_url from intake.idea where id = '${id}';`,
      ).trim();
      assert.equal(
        row,
        "submitted_to_github|99999|https://github.com/attacker/fake/issues/99999",
        "the client's single UPDATE must have frozen the row around fabricated GitHub metadata",
      );
    });
  },
);

test(
  "real Postgres GREEN: after the fix, the same forged UPDATE is rejected by the column grant, and the row is untouched (not partially applied)",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const id = insertPromotedIdea(db, "forge target, fixed");

      const result = psqlAllowError(
        db,
        asAuthenticatedOwner(
          `update intake.idea set status = 'submitted_to_github', github_issue_number = 99999, ` +
            `github_issue_url = 'https://github.com/attacker/fake/issues/99999', submitted_at = now() where id = '${id}';`,
        ),
      );
      assert.notEqual(result.status, 0, "expected the forged UPDATE to fail after the fix");
      assert.match(result.stderr, /permission denied for table idea/);

      const row = psqlOk(
        db,
        `select status, github_issue_number, (github_issue_url is null), (submitted_at is null) from intake.idea where id = '${id}';`,
      ).trim();
      assert.equal(row, "idea||t|t", "the row must be completely untouched -- Postgres rejects the whole statement, not just the ungranted columns");
    });
  },
);

test(
  "real Postgres GREEN: after the fix, the client cannot even reach the new RPC directly (no EXECUTE grant for authenticated)",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const id = insertPromotedIdea(db, "rpc denied for client");
      const result = psqlAllowError(
        db,
        asAuthenticatedOwner(`select intake.mark_submitted_to_github('${id}', 1, 'https://github.com/kgsmith19/scratch/issues/1');`),
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /permission denied for function mark_submitted_to_github/);
    });
  },
);

test(
  "real Postgres GREEN: the legitimate path still works -- service_role can call mark_submitted_to_github and it performs the real, correct transition",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const id = insertPromotedIdea(db, "legit submission");

      psqlOk(db, asServiceRole(`select intake.mark_submitted_to_github('${id}', 42, 'https://github.com/kgsmith19/scratch/issues/42');`));

      const row = psqlOk(
        db,
        `select status, github_issue_number, github_issue_url, (submitted_at is not null) from intake.idea where id = '${id}';`,
      ).trim();
      assert.equal(row, "submitted_to_github|42|https://github.com/kgsmith19/scratch/issues/42|t");
    });
  },
);

test(
  "real Postgres GREEN: the RPC does not weaken II-3 -- calling it again on an already-submitted idea still raises the immutability guard",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const id = insertPromotedIdea(db, "immutability still enforced");
      psqlOk(db, asServiceRole(`select intake.mark_submitted_to_github('${id}', 42, 'https://x/42');`));

      const result = psqlAllowError(db, asServiceRole(`select intake.mark_submitted_to_github('${id}', 43, 'https://x/43');`));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /II-3: submitted ideas are immutable/);

      const row = psqlOk(db, `select github_issue_number from intake.idea where id = '${id}';`).trim();
      assert.equal(row, "42", "the second call must not have overwritten the first real submission's issue number");
    });
  },
);

test(
  "real Postgres GREEN: the RPC does not weaken II-1 -- calling it against a still-draft idea still raises the illegal-transition guard",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      const draftId = psqlOk(db, asAuthenticatedOwner("insert into intake.idea (title) values ('still a draft') returning id;")).trim();

      const result = psqlAllowError(db, asServiceRole(`select intake.mark_submitted_to_github('${draftId}', 44, 'https://x/44');`));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /II-1: illegal transition draft -> submitted_to_github/);
    });
  },
);
