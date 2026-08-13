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
// apps/toolbelt/apps/idea-intake/tests/intake-guards.test.mjs (m3-05):
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
const FIX_UP = join(INTAKE_MIGRATIONS_DIR, "20260814040000_intake_mark_submitted_to_github_rpc.sql");
const FIX_DOWN = join(INTAKE_MIGRATIONS_DIR, "20260814040000_intake_mark_submitted_to_github_rpc_down.sql");

const OWNER_UUID = "11111111-1111-1111-1111-111111111111";

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

insert into auth.users (id) values ('${OWNER_UUID}');
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
    "this suite proves real trigger/grant behavior against an actual engine and has nothing honest to assert without one";

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

// Same "tuple concurrently updated" retry as intake-guards.test.mjs: this
// migration's `alter role authenticator set pgrst.db_schemas = ...` writes
// one role-wide pg_db_role_setting row shared across every scratch database
// applying it, contended when this suite runs alongside other suites that
// also apply INTAKE_UP.
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

function asAuthenticatedOwner(sqlText) {
  return `set role authenticated;\ndo $$ begin perform set_config('app.test_uid', '${OWNER_UUID}', false); end $$;\n${sqlText}`;
}

function asServiceRole(sqlText) {
  return `set role service_role;\n${sqlText}`;
}

function freshDbName() {
  return `f8_mark_submitted_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDb(applyFix, fn) {
  const db = freshDbName();
  psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
  try {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, OWNER_BOOTSTRAP_SQL);
    applyMigrationWithRetry(db, readFileSync(INTAKE_UP, "utf8"));
    if (applyFix) psqlOk(db, readFileSync(FIX_UP, "utf8"));
    return fn(db);
  } finally {
    psqlOk("postgres", `drop database if exists ${db};`);
  }
}

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
