// m3-05: real-Postgres proof that intake.idea's three independent
// immutability layers (docs/planning/05-h-idea-intake.md section 3: guard
// triggers 3.1, column-scoped grants 3.2, RLS 1.2) are database properties,
// not app discipline -- run against an actual PostgreSQL engine, applying
// the real, committed migration files from disk verbatim, never a
// reimplementation of their logic. Mirrors the detection/skip mechanics
// apps/toolbelt/tests/registry-migrations-idempotency.test.mjs (m3-02)
// already established: this suite detects a usable local `psql` and skips
// itself cleanly -- via node:test's own skip mechanism, reported as
// SKIPPED, never silently omitted and never falsely green -- when no local
// Postgres engine is reachable.
//
// A bare local PostgreSQL has none of Supabase's managed platform (no
// GoTrue `auth` schema, no `anon`/`authenticated`/`service_role`/
// `authenticator` roles, no PostgREST). HARNESS_SQL below stubs exactly
// those pieces, session-settable per docs/planning/issues/m3-05's own
// suggested "standard technique": a plain SQL STABLE auth.uid() reads a
// session GUC (app.test_uid) instead of GoTrue's JWT claim. This stub is
// local-only test scaffolding, never a committed migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = join(__dirname, "..");
const ROOT_MIGRATIONS_DIR = join(TOOL_DIR, "..", "..", "supabase", "migrations");
const INTAKE_MIGRATIONS_DIR = join(TOOL_DIR, "supabase", "migrations");

const PLATFORM_BOOTSTRAP_UP = join(ROOT_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");
const INTAKE_UP = join(INTAKE_MIGRATIONS_DIR, "20260813002605_intake_create_schema.sql");
const INTAKE_DOWN = join(INTAKE_MIGRATIONS_DIR, "20260813002605_intake_create_schema_down.sql");

const OWNER_UUID = "11111111-1111-1111-1111-111111111111";
const STRANGER_UUID = "22222222-2222-2222-2222-222222222222";

const HARNESS_SQL = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('app.test_uid', true), '')::uuid $$;

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

const OWNER_BOOTSTRAP_SQL = `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`;

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
    "this suite proves real trigger/grant/RLS behavior against an actual engine and has nothing honest to " +
    "assert without one -- see the m3-05 implementation report for the interactive proof run where a local " +
    "engine was available";

// -q (quiet): suppresses psql's own command-completion announcements
// ("SET", "INSERT 0 1", "CREATE TABLE", ...) that it otherwise prints for
// every executed statement in a script, even under -tA (which only
// suppresses SELECT result headers/footers, not those announcements) --
// needed here because several helpers below combine a session-setup
// statement with the actual query-of-interest in one invocation (a fresh
// psql process per call has no session to carry SET ROLE/set_config
// across separate calls, so they must be combined).
function psql(dbName, sqlText) {
  return spawnSync(RUNNER.cmd, [...RUNNER.args, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-tA", "-q"], {
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

// Applies a migration file with a bounded retry on Postgres's transient
// "tuple concurrently updated" error -- reproduced via repeated real runs
// once this file started running alongside
// tests/migrate-forgepad-e2e.test.mjs (m3-08), which applies this same
// migration in its own scratch databases. The cause: this migration's
// `alter role authenticator set pgrst.db_schemas = ...` (like the identical
// pattern in 20260812150000_test_create_fence.sql and Prompt Organizer's
// own schema-exposure migration) is unscoped (no `IN DATABASE`), so it
// writes one role-wide row in the shared pg_db_role_setting catalog --
// every scratch database applying it contends on that same row. Wrapping
// the script in one explicit transaction makes a retry safe and idempotent
// (Postgres DDL is transactional, so a failure rolls back every earlier
// statement in the same script too; the retry starts from a clean slate
// rather than re-running non-idempotent `create schema`/`create table`
// against partially-applied state). Test-harness fix only -- the real
// Supabase project only ever applies this migration once.
function applyMigrationWithRetry(dbName, sqlText, attempts = 5) {
  const wrapped = `begin;\n${sqlText}\ncommit;\n`;
  let lastResult;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastResult = psql(dbName, wrapped);
    if (lastResult.status === 0) return lastResult.stdout;
    if (!/tuple concurrently updated/.test(lastResult.stderr || "")) break;
  }
  assert.equal(lastResult.status, 0, `psql failed against ${dbName}: ${lastResult.stderr || lastResult.stdout}`);
  return lastResult.stdout;
}

// Runs sqlText as the `authenticated` role with auth.uid() pinned to uuid
// for the duration of this one psql invocation (mirrors what PostgREST does
// per-request: switch role, carry the JWT-derived uid). set_config is
// invoked via a DO block (PERFORM, not SELECT) so it contributes no row of
// its own to the output -- a bare top-level `select set_config(...)` would
// print its return value as real tuple output ahead of sqlText's, even
// under -q, since that line is genuine query data, not an announcement.
function asAuthenticated(uuid, sqlText) {
  return `set role authenticated;\ndo $$ begin perform set_config('app.test_uid', '${uuid}', false); end $$;\n${sqlText}`;
}

function freshDbName() {
  return `m3_05_intake_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// Applies the harness stub plus the two real, committed migrations
// (platform bootstrap, then the intake schema) to a fresh scratch database,
// then hands the db name to fn. Always drops the db afterward.
function withMigratedDb(fn) {
  const db = freshDbName();
  psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
  try {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, OWNER_BOOTSTRAP_SQL);
    applyMigrationWithRetry(db, readFileSync(INTAKE_UP, "utf8"));
    return fn(db);
  } finally {
    psqlOk("postgres", `drop database if exists ${db};`);
  }
}

test(
  "real Postgres: draft -> idea -> submitted_to_github succeeds, all three github fields set atomically (II-1a allowed pair)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const id = psqlOk(
        db,
        asAuthenticated(OWNER_UUID, "insert into intake.idea (title) values ('allowed path') returning id;"),
      ).trim();

      psqlOk(
        db,
        asAuthenticated(OWNER_UUID, `update intake.idea set target_repo = 'kgsmith19/scratch', status = 'idea' where id = '${id}';`),
      );

      psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          `update intake.idea set status = 'submitted_to_github', github_issue_number = 7, ` +
            `github_issue_url = 'https://github.com/kgsmith19/scratch/issues/7', submitted_at = now() where id = '${id}';`,
        ),
      );

      const row = psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          `select status, github_issue_number, (github_issue_url is not null), (submitted_at is not null) ` +
            `from intake.idea where id = '${id}';`,
        ),
      ).trim();
      assert.equal(row, "submitted_to_github|7|t|t");
    });
  },
);

test(
  "real Postgres: all three forbidden UPDATE transitions raise (II-1a); the other two allowed transitions never do",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const draftId = psqlOk(
        db,
        asAuthenticated(OWNER_UUID, "insert into intake.idea (title) values ('draft fixture') returning id;"),
      ).trim();

      const ideaId = psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          "insert into intake.idea (title, target_repo) values ('idea fixture', 'kgsmith19/scratch') returning id;",
        ),
      ).trim();
      psqlOk(db, asAuthenticated(OWNER_UUID, `update intake.idea set status = 'idea' where id = '${ideaId}';`));

      const submittedId = psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          "insert into intake.idea (title, target_repo) values ('submitted fixture', 'kgsmith19/scratch') returning id;",
        ),
      ).trim();
      psqlOk(db, asAuthenticated(OWNER_UUID, `update intake.idea set status = 'idea' where id = '${submittedId}';`));
      psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          `update intake.idea set status = 'submitted_to_github', github_issue_number = 1, ` +
            `github_issue_url = 'https://x/1', submitted_at = now() where id = '${submittedId}';`,
        ),
      );

      // draft -> submitted_to_github (skip): rule 2, illegal transition.
      let r = psql(db, asAuthenticated(OWNER_UUID, `update intake.idea set status = 'submitted_to_github' where id = '${draftId}';`));
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /II-1: illegal transition draft -> submitted_to_github/);

      // idea -> draft (demote): rule 2, illegal transition.
      r = psql(db, asAuthenticated(OWNER_UUID, `update intake.idea set status = 'draft' where id = '${ideaId}';`));
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /II-1: illegal transition idea -> draft/);

      // submitted_to_github -> idea (reopen): rule 1, immutability, fires
      // before rule 2 ever evaluates the transition.
      r = psql(db, asAuthenticated(OWNER_UUID, `update intake.idea set status = 'idea' where id = '${submittedId}';`));
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /II-3: submitted ideas are immutable/);
    });
  },
);

test(
  "real Postgres: a submitted row rejects both UPDATE and DELETE (II-3a DB layer)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const id = psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          "insert into intake.idea (title, target_repo) values ('submitted fixture', 'kgsmith19/scratch') returning id;",
        ),
      ).trim();
      psqlOk(db, asAuthenticated(OWNER_UUID, `update intake.idea set status = 'idea' where id = '${id}';`));
      psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          `update intake.idea set status = 'submitted_to_github', github_issue_number = 2, ` +
            `github_issue_url = 'https://x/2', submitted_at = now() where id = '${id}';`,
        ),
      );

      const upd = psql(db, asAuthenticated(OWNER_UUID, `update intake.idea set title = 'x' where id = '${id}';`));
      assert.notEqual(upd.status, 0);
      assert.match(upd.stderr, /II-3: submitted ideas are immutable/);

      const del = psql(db, asAuthenticated(OWNER_UUID, `delete from intake.idea where id = '${id}';`));
      assert.notEqual(del.status, 0);
      assert.match(del.stderr, /II-3: submitted ideas cannot be deleted/);

      const stillThere = psqlOk(db, `select count(*) from intake.idea where id = '${id}';`).trim();
      assert.equal(stillThere, "1", "the row must still exist after both rejected writes");
    });
  },
);

test(
  "real Postgres: INSERT with status='idea' is rejected by the column grant, and INDEPENDENTLY by the insert-guard trigger in a service context (II-1b, two distinct layers)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      // Layer 1 (grant): `authenticated` never has `status` in its INSERT
      // column grant (section 3.2), so PostgreSQL itself refuses the
      // statement before any trigger runs.
      const grantDenied = psql(db, asAuthenticated(OWNER_UUID, "insert into intake.idea (title, status) values ('x', 'idea');"));
      assert.notEqual(grantDenied.status, 0);
      assert.match(grantDenied.stderr, /permission denied for table idea/);

      // Control: the same role/grant set CAN insert when `status` is
      // simply omitted -- isolates the failure above to the status column,
      // not some unrelated RLS/role misconfiguration.
      const controlOk = psqlOk(db, asAuthenticated(OWNER_UUID, "insert into intake.idea (title) values ('layer1 control') returning status;")).trim();
      assert.equal(controlOk, "draft");

      // Layer 2 (trigger): connected as the table owner (no SET ROLE at
      // all -- this psql session is the migration-applying superuser),
      // which bypasses grants AND RLS entirely, simulating "what if
      // PostgREST's grants were somehow bypassed". The BEFORE INSERT
      // trigger still fires unconditionally and independently rejects a
      // non-draft birth.
      const triggerDenied = psql(
        db,
        "insert into intake.idea (title, status, target_repo, user_id) values ('service ctx', 'idea', 'kgsmith19/scratch', '" +
          OWNER_UUID +
          "');",
      );
      assert.notEqual(triggerDenied.status, 0);
      assert.match(triggerDenied.stderr, /II-1: ideas are born draft/);
      assert.doesNotMatch(triggerDenied.stderr, /permission denied/, "the service-context failure must come from the trigger, not a grant check");
    });
  },
);

test(
  "real Postgres: a derivative INSERT referencing a draft (not submitted) parent is rejected by insert-guard rule 2 (II-3c)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const draftParentId = psqlOk(
        db,
        asAuthenticated(OWNER_UUID, "insert into intake.idea (title) values ('draft parent') returning id;"),
      ).trim();

      const submittedParentId = psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          "insert into intake.idea (title, target_repo) values ('submitted parent', 'kgsmith19/scratch') returning id;",
        ),
      ).trim();
      psqlOk(db, asAuthenticated(OWNER_UUID, `update intake.idea set status = 'idea' where id = '${submittedParentId}';`));
      psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          `update intake.idea set status = 'submitted_to_github', github_issue_number = 3, ` +
            `github_issue_url = 'https://x/3', submitted_at = now() where id = '${submittedParentId}';`,
        ),
      );

      // Service context (table owner), the same posture as the previous
      // test's layer-2 proof: bypasses grants/RLS, isolates this assertion
      // to the trigger's own rule 2.
      const badDerivative = psql(
        db,
        `insert into intake.idea (title, parent_idea_id, user_id) values ('bad derivative', '${draftParentId}', '${OWNER_UUID}');`,
      );
      assert.notEqual(badDerivative.status, 0);
      assert.match(badDerivative.stderr, /II-3: derivatives fork submitted ideas only/);

      // Control: the identical statement shape against the SUBMITTED
      // parent succeeds -- rule 2 discriminates on parent status, it is
      // not a blanket rejection of parent_idea_id.
      const goodDerivative = psqlOk(
        db,
        `insert into intake.idea (title, parent_idea_id, user_id) values ('good derivative', '${submittedParentId}', '${OWNER_UUID}') returning status;`,
      ).trim();
      assert.equal(goodDerivative, "draft");
    });
  },
);

test(
  "real Postgres: guard_idea_update rule 3 independently rejects a partial github_issue_number set on a non-submitting update, distinct from the submitted_fields_all_or_none CHECK",
  { skip: SKIP_REASON },
  () => {
    // Mutation-testing finding: the CHECK constraint only requires "not all
    // three github fields non-null" when status != submitted_to_github, so
    // it does NOT by itself reject setting github_issue_number alone (url
    // and submitted_at left null) on an idea->idea update. Only trigger
    // rule 3 catches this specific partial-field case. Proven by disabling
    // rule 3 in isolation (a copy of the migration with only that clause
    // removed) and showing the CHECK alone lets the partial set through.
    withMigratedDb((db) => {
      const id = psqlOk(
        db,
        asAuthenticated(OWNER_UUID, "insert into intake.idea (title, target_repo) values ('t1', 'kgsmith19/scratch') returning id;"),
      ).trim();
      psqlOk(db, asAuthenticated(OWNER_UUID, `update intake.idea set status = 'idea' where id = '${id}';`));

      const r = psql(db, asAuthenticated(OWNER_UUID, `update intake.idea set github_issue_number = 999 where id = '${id}';`));
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /II-1: github fields may be set only by the submit transition/);
    });
  },
);

test(
  "real Postgres: submitted_fields_all_or_none CHECK independently rejects an idea->submitted_to_github update that sets github_issue_number but leaves github_issue_url/submitted_at null, distinct from trigger rule 3",
  { skip: SKIP_REASON },
  () => {
    // Mutation-testing finding: trigger rule 3 only fires when
    // new.status <> 'submitted_to_github', so it does NOT fire during the
    // legitimate submit transition itself -- an update that sets status to
    // submitted_to_github with only github_issue_number populated (url and
    // submitted_at left null) passes every trigger rule and is caught only
    // by the CHECK constraint.
    withMigratedDb((db) => {
      const id = psqlOk(
        db,
        asAuthenticated(OWNER_UUID, "insert into intake.idea (title, target_repo) values ('t1', 'kgsmith19/scratch') returning id;"),
      ).trim();
      psqlOk(db, asAuthenticated(OWNER_UUID, `update intake.idea set status = 'idea' where id = '${id}';`));

      const r = psql(
        db,
        asAuthenticated(OWNER_UUID, `update intake.idea set status = 'submitted_to_github', github_issue_number = 5 where id = '${id}';`),
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /submitted_fields_all_or_none/);
    });
  },
);

test(
  "real Postgres: RLS owner-pin's user_id check independently hides a service-context row whose user_id does not match the caller, even though auth.uid() equals platform.owner()",
  { skip: SKIP_REASON },
  () => {
    // Mutation-testing finding: Pattern A's policy checks BOTH
    // user_id = platform.owner() AND auth.uid() = platform.owner(). A row
    // can only carry a mismatched user_id via a service-context write
    // (user_id is not in the authenticated INSERT grant, so no PostgREST
    // caller can set it), but if that ever happened -- a bug, a future
    // migration, a bypassed grant -- dropping the user_id half of the
    // check would silently make such a row visible/writable to the real
    // owner's session. Only the row-content check catches that; the
    // caller-identity check alone does not.
    withMigratedDb((db) => {
      psqlOk(db, `insert into intake.idea (title, target_repo, user_id) values ('mismatched', 'kgsmith19/scratch', '${STRANGER_UUID}');`);

      const seenByOwner = psqlOk(
        db,
        asAuthenticated(OWNER_UUID, "select count(*) from intake.idea where title = 'mismatched';"),
      ).trim();
      assert.equal(seenByOwner, "0", "a row whose user_id does not match the caller must stay invisible even to the platform owner");
    });
  },
);

test(
  "real Postgres: RLS owner-pin rejects a non-owner authenticated caller's SELECT and INSERT, even though the column/table grants would otherwise allow them",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into intake.idea (title) values ('owner row');"));

      const strangerSees = psqlOk(db, asAuthenticated(STRANGER_UUID, "select count(*) from intake.idea;")).trim();
      assert.equal(strangerSees, "0", "a non-owner authenticated caller must see zero rows under the owner-pinned policy");

      const strangerInsert = psql(db, asAuthenticated(STRANGER_UUID, "insert into intake.idea (title) values ('stranger row');"));
      assert.notEqual(strangerInsert.status, 0);
      assert.match(strangerInsert.stderr, /row-level security policy/);

      const ownerSees = psqlOk(db, asAuthenticated(OWNER_UUID, "select count(*) from intake.idea;")).trim();
      assert.equal(ownerSees, "1");
    });
  },
);

test(
  "real Postgres: intake.optimization is append-only (select+insert only; no update/delete grant, section 3.2)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const ideaId = psqlOk(db, asAuthenticated(OWNER_UUID, "insert into intake.idea (title) values ('opt target') returning id;")).trim();
      const optId = psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          `insert into intake.optimization (input_idea_id, prompt_name, model) values ('${ideaId}', 'idea-intake/optimize-v1', 'test-model') returning id;`,
        ),
      ).trim();

      const upd = psql(db, asAuthenticated(OWNER_UUID, `update intake.optimization set model = 'x' where id = '${optId}';`));
      assert.notEqual(upd.status, 0);
      assert.match(upd.stderr, /permission denied for table optimization/);

      const del = psql(db, asAuthenticated(OWNER_UUID, `delete from intake.optimization where id = '${optId}';`));
      assert.notEqual(del.status, 0);
      assert.match(del.stderr, /permission denied for table optimization/);
    });
  },
);

test(
  "real Postgres: anon has zero access to the intake schema (no USAGE grant, ADR-03 owner-only surface)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const r = psql(db, "set role anon;\nselect count(*) from intake.idea;");
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /permission denied for schema intake/);
    });
  },
);

test(
  "real Postgres: re-applying the up migration a second time fails cleanly (single transaction, no partial state) rather than silently duplicating or corrupting",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const before = psqlOk(
        db,
        "select (select count(*) from intake.idea) || '|' || (select count(*) from pg_proc where pronamespace = 'intake'::regnamespace);",
      ).trim();

      const reapply = spawnSync(
        RUNNER.cmd,
        [...RUNNER.args, "-d", db, "-v", "ON_ERROR_STOP=1", "-1", "-tA"],
        { encoding: "utf8", input: readFileSync(INTAKE_UP, "utf8"), timeout: 20000 },
      );
      assert.notEqual(reapply.status, 0, "re-applying the up migration verbatim should fail (create table has no IF NOT EXISTS)");
      assert.match(reapply.stderr, /relation "idea" already exists/);

      const after = psqlOk(
        db,
        "select (select count(*) from intake.idea) || '|' || (select count(*) from pg_proc where pronamespace = 'intake'::regnamespace);",
      ).trim();
      assert.equal(after, before, "the failed re-apply must leave zero side effects (single-transaction rollback)");
    });
  },
);

test(
  "real Postgres: the down migration fully reverts the schema and restores pgrst.db_schemas to its prior recorded value",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      applyMigrationWithRetry(db, readFileSync(INTAKE_DOWN, "utf8"));

      const schemaGone = psqlOk(db, "select count(*) from pg_namespace where nspname = 'intake';").trim();
      assert.equal(schemaGone, "0");

      const roleConfig = psqlOk(db, "select coalesce(array_to_string(rolconfig, ','), '') from pg_roles where rolname = 'authenticator';").trim();
      assert.equal(roleConfig, "pgrst.db_schemas=public, core, idea, prompt, test");

      // The pair round-trips: re-applying up on the now-reverted db succeeds cleanly.
      applyMigrationWithRetry(db, readFileSync(INTAKE_UP, "utf8"));
      const rebuilt = psqlOk(db, "select count(*) from intake.idea;").trim();
      assert.equal(rebuilt, "0");
    });
  },
);
