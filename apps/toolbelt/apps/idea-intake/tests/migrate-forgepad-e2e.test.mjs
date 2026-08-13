// m3-08: real-Postgres, real-CLI-subprocess proof that migrate-forgepad.mjs
// (docs/planning/05-h-idea-intake.md section 10) does what its field mapping
// table says against an actual PostgreSQL engine running the real, committed
// intake schema migration -- never a reimplementation of the CLI's logic.
// Mirrors the detection/skip mechanics and scratch-database harness
// apps/toolbelt/apps/idea-intake/tests/intake-guards.test.mjs (m3-05) already
// established, extended here to also spawn the CLI itself as a real child
// process (never importing its internals) so this is a genuine end-to-end
// run of exactly the documented invocation:
//
//   node apps/toolbelt/apps/idea-intake/tools/migrate-forgepad.mjs \
//     --acc-root <path> [--dry-run]
//
// This sandbox's only reachable Postgres is local, peer-authenticated as
// the `postgres` OS user (via `sudo -n -u postgres psql`, never a direct
// `psql`) -- so when that is the detected runner, the CLI subprocess itself
// is launched the same way (`sudo -n -u postgres env DATABASE_URL=<db> node
// ...`), which both supplies the peer-auth identity the CLI's own psql calls
// need and exercises the CLI exactly as an operator would run it against a
// real project (service/superuser connection bypassing PostgREST grants).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = join(__dirname, "..");
const ROOT_MIGRATIONS_DIR = join(TOOL_DIR, "..", "..", "supabase", "migrations");
const INTAKE_MIGRATIONS_DIR = join(TOOL_DIR, "supabase", "migrations");
const CLI_PATH = join(TOOL_DIR, "tools", "migrate-forgepad.mjs");

const PLATFORM_BOOTSTRAP_UP = join(ROOT_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");
const INTAKE_UP = join(INTAKE_MIGRATIONS_DIR, "20260813002605_intake_create_schema.sql");
const INTAKE_SUBMISSION_RPC_UP = join(
  INTAKE_MIGRATIONS_DIR,
  "20260814040000_intake_mark_submitted_to_github_rpc.sql",
);
const INTAKE_SOURCE_DEDUP_UP = join(
  INTAKE_MIGRATIONS_DIR,
  "20260814050000_intake_forgepad_source_dedup.sql",
);
const INTAKE_SOURCE_UPDATE_GRANT_UP = join(
  INTAKE_MIGRATIONS_DIR,
  "20260814090000_intake_idea_source_update_grant.sql",
);
const INTAKE_OPTIMIZATION_CASCADE_UP = join(
  INTAKE_MIGRATIONS_DIR,
  "20260814100000_intake_optimization_fk_cascade_and_indexes.sql",
);
const INTAKE_HARDENING_UP = join(
  INTAKE_MIGRATIONS_DIR,
  "20260814120000_intake_submission_metadata_integrity.sql",
);
const INTAKE_IDEMPOTENCY_UP = join(
  INTAKE_MIGRATIONS_DIR,
  "20260814120100_intake_forgepad_idempotency_key.sql",
);

const OWNER_UUID = "11111111-1111-1111-1111-111111111111";

// Same harness stub as intake-guards.test.mjs: a bare local PostgreSQL has
// none of Supabase's managed platform (no GoTrue auth schema, no API
// roles). This migration tool does not touch auth.uid() or the API roles at
// all (it connects as a service/superuser role, bypassing PostgREST
// entirely) but the schema migration itself still references auth.users via
// intake.idea's user_id foreign key, so that piece of the stub is required
// here too.
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
    const result = spawnSync(cmd, [...args, "-d", "postgres", "-tAc", "select 1;"], { encoding: "utf8", timeout: 5000 });
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
if (process.env.TOOLBELT_REQUIRE_POSTGRES === "1" && !RUNNER) {
  throw new Error("TOOLBELT_REQUIRE_POSTGRES=1 but no local PostgreSQL server is reachable");
}
const SKIP_REASON = RUNNER
  ? false
  : "no local Postgres reachable (tried direct `psql` and `sudo -n -u postgres psql`); this suite proves the real " +
    "migrate-forgepad.mjs CLI end-to-end against an actual engine and has nothing honest to assert without one -- " +
    "see the m3-08 implementation report for the interactive proof run where a local engine was available";

// GitHub-hosted checkouts can live beneath an owner-only runner directory.
// When peer auth requires the postgres OS user, Node then reports the real
// CLI as MODULE_NOT_FOUND because that user cannot traverse the checkout's
// parent path. Stage an exact byte-copy under /tmp (already the convention
// for this suite's cross-user fixtures), and keep direct-runner execution on
// the committed path. The subprocess still executes the real CLI source.
let SUBPROCESS_CLI_PATH = CLI_PATH;
let stagedCliDir;
if (RUNNER?.cmd === "sudo") {
  stagedCliDir = mkdtempSync(join(os.tmpdir(), "m3-08-forgepad-cli-"));
  chmodSync(stagedCliDir, 0o755);
  SUBPROCESS_CLI_PATH = join(stagedCliDir, "migrate-forgepad.mjs");
  copyFileSync(CLI_PATH, SUBPROCESS_CLI_PATH);
  chmodSync(SUBPROCESS_CLI_PATH, 0o644);
  after(() => rmSync(stagedCliDir, { recursive: true, force: true }));
}

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
// "tuple concurrently updated" error -- a real race this review found (not
// hypothetical: reproduced via repeated real runs), caused by
// 20260813002605_intake_create_schema.sql's `alter role authenticator set
// pgrst.db_schemas = ...`, which -- like the same pattern in
// 20260812150000_test_create_fence.sql and
// apps/prompt-organizer/supabase/migrations/20260807020000_prompt_create_prompt.sql
// -- is unscoped (no `IN DATABASE`), so it writes one role-wide row in the
// shared pg_db_role_setting catalog. Every scratch database in this test
// suite applies the identical statement, so two concurrent test files (this
// one and intake-guards.test.mjs both call withMigratedDb) can race to
// UPDATE that same catalog row and one loses with this exact error.
// Wrapping the whole migration in one explicit transaction makes a retry
// safe and idempotent -- Postgres DDL is transactional, so a failure here
// rolls back every earlier statement in the same script too, and the retry
// starts from a clean slate rather than re-running `create schema`/`create
// table` (neither idempotent) against partially-applied state. This is a
// test-harness fix only; the real Supabase project only ever applies this
// migration once, so the race never manifests there.
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

function freshDbName() {
  return `m3_08_forgepad_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withMigratedDb(fn) {
  const db = freshDbName();
  psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
  try {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, OWNER_BOOTSTRAP_SQL);
    applyMigrationWithRetry(db, readFileSync(INTAKE_UP, "utf8"));
    applyMigrationWithRetry(db, readFileSync(INTAKE_SUBMISSION_RPC_UP, "utf8"));
    applyMigrationWithRetry(db, readFileSync(INTAKE_SOURCE_DEDUP_UP, "utf8"));
    applyMigrationWithRetry(db, readFileSync(INTAKE_SOURCE_UPDATE_GRANT_UP, "utf8"));
    applyMigrationWithRetry(db, readFileSync(INTAKE_OPTIMIZATION_CASCADE_UP, "utf8"));
    applyMigrationWithRetry(db, readFileSync(INTAKE_HARDENING_UP, "utf8"));
    applyMigrationWithRetry(db, readFileSync(INTAKE_IDEMPOTENCY_UP, "utf8"));
    return fn(db);
  } finally {
    psqlOk("postgres", `drop database if exists ${db};`);
  }
}

// Recursively opens permissions so the `postgres` OS user (a different
// principal from whichever user created these fixture files, e.g. the CLI
// subprocess run via `sudo -n -u postgres node ...`) can traverse and read
// them -- fs.mkdtempSync defaults to 0700, which the postgres user cannot
// enter at all.
function chmodOpenRecursive(p) {
  const st = statSync(p);
  chmodSync(p, st.isDirectory() ? 0o755 : 0o644);
  if (st.isDirectory()) {
    for (const entry of readdirSync(p)) chmodOpenRecursive(join(p, entry));
  }
}

// Runs the real CLI as a real child process -- never imports its internals
// -- exactly per the documented invocation, prefixed with the same runner
// (direct or `sudo -n -u postgres`) the scratch database itself was reached
// through, so the CLI's own psql calls land on the identical peer-auth
// identity.
function runCli(dbName, args) {
  if (RUNNER.cmd === "sudo") {
    return spawnSync("sudo", ["-n", "-u", "postgres", "env", `DATABASE_URL=${dbName}`, "node", SUBPROCESS_CLI_PATH, ...args], {
      encoding: "utf8",
      timeout: 20000,
    });
  }
  return spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, DATABASE_URL: dbName },
  });
}

function writeFixture(ideasDir, idea) {
  writeFileSync(join(ideasDir, `${idea.id}.json`), JSON.stringify(idea, null, 2) + "\n");
}

function makeFixtureRoot() {
  const accRoot = mkdtempSync(join(os.tmpdir(), "m3-08-forgepad-fixtures-"));
  const ideasDir = join(accRoot, "forgepad", "ideas");
  mkdirSync(ideasDir, { recursive: true });
  return { accRoot, ideasDir };
}

// One fixture per forgepad state (05-h section 10's full mapping table),
// the "handful of realistic fixtures" this issue's testing bar asks for.
function fullFixtureSet() {
  return [
    {
      id: "f-a0000001",
      title: "Draft idea",
      problem: "A problem worth writing down",
      outcome: "Some outcome",
      confidence: "low",
      notes: "still forming",
      state: "draft",
      target: "",
      source: "",
      created: "2026-01-01T10:00:00.000Z",
      updated: "2026-01-02T10:00:00.000Z",
      githubIssue: null,
    },
    {
      id: "f-a0000002",
      title: "Definite idea with a real repo",
      problem: "Ready to build",
      outcome: "Ships",
      confidence: "high",
      notes: "go",
      state: "definite",
      target: "kgsmith19/scratch",
      source: "brainstorm session",
      created: "2026-01-03T10:00:00.000Z",
      updated: "2026-01-04T10:00:00.000Z",
      githubIssue: null,
    },
    {
      id: "f-a0000003",
      title: "Definite idea missing a repo",
      problem: "Ready in spirit, not in target",
      outcome: "Ships eventually",
      confidence: "medium",
      notes: "pick a repo later",
      state: "definite",
      target: "",
      source: "",
      created: "2026-01-05T10:00:00.000Z",
      updated: "2026-01-06T10:00:00.000Z",
      githubIssue: null,
    },
    {
      id: "f-a0000004",
      title: "Research needed idea",
      problem: "Unclear if feasible",
      outcome: "TBD",
      confidence: "low",
      notes: "check feasibility first",
      state: "research-needed",
      target: "",
      source: "",
      created: "2026-01-07T10:00:00.000Z",
      updated: "2026-01-08T10:00:00.000Z",
      githubIssue: null,
    },
    {
      id: "f-a0000005",
      title: "Rejected idea",
      problem: "Not worth it",
      outcome: "n/a",
      confidence: "low",
      notes: "declined",
      state: "rejected",
      target: "",
      source: "",
      created: "2026-01-09T10:00:00.000Z",
      updated: "2026-01-10T10:00:00.000Z",
      githubIssue: null,
    },
  ];
}

test(
  "real Postgres + real CLI subprocess: every state maps per the section 10 table, ACC-4b's row-count equation holds, and a second run inserts zero rows (idempotent)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const { accRoot, ideasDir } = makeFixtureRoot();
      try {
        for (const idea of fullFixtureSet()) writeFixture(ideasDir, idea);
        chmodOpenRecursive(accRoot);

        // --- first run: real inserts -------------------------------------
        const first = runCli(db, ["--acc-root", accRoot]);
        assert.equal(first.status, 0, `first run failed: ${first.stderr}\n${first.stdout}`);
        assert.match(first.stdout, /draft\s+: 1/);
        assert.match(first.stdout, /definite -> idea\s+: 1/);
        assert.match(first.stdout, /definite -> draft \[needs repo\]\s+: 1/);
        assert.match(first.stdout, /research-needed -> draft\s+: 1/);
        assert.match(first.stdout, /rejected \(not migrated\)\s+: 1/);
        assert.match(first.stdout, /rejected ids.*f-a0000005/);
        assert.match(first.stdout, /inserted 4, already migrated \(skipped\) 0, rejected \(not migrated\) 1/);

        // ACC-4b: intake row count carrying the forgepad provenance ref
        // equals source file count (5) minus rejected (1) = 4.
        const rowCount = psqlOk(db, "select count(*) from intake.idea where source like 'forgepad:%';").trim();
        assert.equal(rowCount, "4");

        // --- exact per-row mapping assertions -----------------------------

        const draftRow = psqlOk(
          db,
          "select status, coalesce(target_repo,'<null>'), notes, confidence, title, " +
            "(created_at = '2026-01-01T10:00:00.000Z'::timestamptz), " +
            "(updated_at = '2026-01-02T10:00:00.000Z'::timestamptz) " +
            "from intake.idea where source = 'forgepad:f-a0000001';",
        ).trim();
        assert.equal(draftRow, "draft|<null>|still forming|low|Draft idea|t|t");

        const definiteIdeaRow = psqlOk(
          db,
          "select status, target_repo, notes, confidence, " +
            "(created_at = '2026-01-03T10:00:00.000Z'::timestamptz) " +
            "from intake.idea where source = 'forgepad:f-a0000002; brainstorm session';",
        ).trim();
        assert.equal(definiteIdeaRow, "idea|kgsmith19/scratch|go|high|t");
        // The importer opts a BYPASSRLS session into the migration-only
        // timestamp-preservation seam. Ordinary API updates still receive
        // now(), but this one-shot promotion preserves legacy provenance.
        const definiteUpdatedAtIsOriginal = psqlOk(
          db,
          "select (updated_at = '2026-01-04T10:00:00.000Z'::timestamptz) from intake.idea where source = 'forgepad:f-a0000002; brainstorm session';",
        ).trim();
        assert.equal(definiteUpdatedAtIsOriginal, "t", "the migration must preserve the original Forgepad updated timestamp");

        const needsRepoRow = psqlOk(
          db,
          "select status, coalesce(target_repo,'<null>'), notes, " +
            "(updated_at = '2026-01-06T10:00:00.000Z'::timestamptz) " +
            "from intake.idea where source = 'forgepad:f-a0000003';",
        ).trim();
        assert.equal(needsRepoRow, "draft|<null>|[needs repo] pick a repo later|t");

        const researchRow = psqlOk(
          db,
          "select status, notes, (updated_at = '2026-01-08T10:00:00.000Z'::timestamptz) from intake.idea where source = 'forgepad:f-a0000004';",
        ).trim();
        assert.equal(researchRow, "draft|[research needed] check feasibility first|t");

        const rejectedCount = psqlOk(db, "select count(*) from intake.idea where source like '%f-a0000005%';").trim();
        assert.equal(rejectedCount, "0", "the rejected idea must never appear in intake.idea under any source variant");

        // user_id must be the platform owner so the migrated rows are
        // actually visible to the real owner under the RLS owner-pin.
        const ownerMatches = psqlOk(
          db,
          `select count(*) from intake.idea where source like 'forgepad:%' and user_id = '${OWNER_UUID}';`,
        ).trim();
        assert.equal(ownerMatches, "4");

        // --- second run: idempotent, zero inserts -------------------------
        const second = runCli(db, ["--acc-root", accRoot]);
        assert.equal(second.status, 0, `second run failed: ${second.stderr}\n${second.stdout}`);
        assert.match(second.stdout, /inserted 0, already migrated \(skipped\) 4, rejected \(not migrated\) 1/);

        const rowCountAfterSecond = psqlOk(db, "select count(*) from intake.idea where source like 'forgepad:%';").trim();
        assert.equal(rowCountAfterSecond, "4", "a second invocation must insert zero additional rows");
      } finally {
        rmSync(accRoot, { recursive: true, force: true });
      }
    });
  },
);

test(
  "real Postgres + real CLI subprocess: --dry-run prints counts but opens no database connection and writes nothing",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const { accRoot, ideasDir } = makeFixtureRoot();
      try {
        for (const idea of fullFixtureSet()) writeFixture(ideasDir, idea);
        chmodOpenRecursive(accRoot);

        // Deliberately does NOT pass DATABASE_URL at all -- proves --dry-run
        // truly makes no connection attempt (a real attempt with no env var
        // set would fail loudly instead of succeeding quietly).
        const result = spawnSync("node", [CLI_PATH, "--acc-root", accRoot, "--dry-run"], { encoding: "utf8", timeout: 20000 });
        assert.equal(result.status, 0, `dry-run failed: ${result.stderr}\n${result.stdout}`);
        assert.match(result.stdout, /dry run — no database connection made, no rows inserted/);

        const rowCount = psqlOk(db, "select count(*) from intake.idea;").trim();
        assert.equal(rowCount, "0", "a dry run must never write to the database, even one that is live and reachable");
      } finally {
        rmSync(accRoot, { recursive: true, force: true });
      }
    });
  },
);

test(
  "real Postgres + real CLI subprocess: one unparseable file fails the whole run non-zero with zero DB writes, even though sibling files are valid",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const { accRoot, ideasDir } = makeFixtureRoot();
      try {
        // Two good files plus one corrupt one.
        writeFixture(ideasDir, fullFixtureSet()[0]);
        writeFixture(ideasDir, fullFixtureSet()[1]);
        writeFileSync(join(ideasDir, "f-baaaaaad.json"), "{ not valid json at all");
        chmodOpenRecursive(accRoot);

        const result = runCli(db, ["--acc-root", accRoot]);
        assert.notEqual(result.status, 0, "a run with any unparseable file must exit non-zero");
        assert.match(result.stdout + result.stderr, /f-baaaaaad\.json/);
        assert.match(result.stdout + result.stderr, /invalid JSON/);

        const rowCount = psqlOk(db, "select count(*) from intake.idea;").trim();
        assert.equal(rowCount, "0", "no rows may be inserted when any file in the batch is bad -- validate all, then act, no partial silence");
      } finally {
        rmSync(accRoot, { recursive: true, force: true });
      }
    });
  },
);

test(
  "real Postgres + real CLI subprocess: an acc-root with no forgepad/ideas directory fails closed with zero writes",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const accRoot = mkdtempSync(join(os.tmpdir(), "m3-08-forgepad-empty-"));
      try {
        chmodOpenRecursive(accRoot);
        const result = runCli(db, ["--acc-root", accRoot]);
        assert.notEqual(result.status, 0, "a mistyped or incomplete ACC root must not certify a zero migration");
        assert.match(result.stderr, /ideas directory does not exist/);

        const rowCount = psqlOk(db, "select count(*) from intake.idea;").trim();
        assert.equal(rowCount, "0");
      } finally {
        rmSync(accRoot, { recursive: true, force: true });
      }
    });
  },
);
