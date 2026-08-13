// Independent security review, Finding 33 (re-verified against current
// HEAD): real-Postgres proof that core.purge_old_events() no longer
// double-counts core.event_monthly_agg under concurrent invocation, and a
// real-Postgres reproduction of the original bug's exact mechanism before
// the fix.
//
// Two different kinds of proof, deliberately:
//
//   1. RED: a fully deterministic reproduction of the OLD function's exact
//      two-statement shape, with the two statements from two "calls"
//      manually interleaved in the worst-case order (both aggregate steps
//      before either delete step). This is not a timing-dependent
//      simulation of concurrency -- it is the literal SQL the old function
//      body issues, run in the one specific interleaving that two
//      genuinely concurrent, real invocations under READ COMMITTED can
//      produce (and the only interleaving that actually triggers the bug).
//      Deterministic and non-flaky by construction: no sleeps, no timing
//      windows, no dependence on OS scheduling.
//
//   2. GREEN: a genuine two-session concurrency proof against the real
//      fixed function, using a third session's held `SELECT ... FOR
//      UPDATE` to force two concurrent `select core.purge_old_events();`
//      calls to actually block on the same rows (confirmed via
//      pg_stat_activity.wait_event_type = 'Lock' before releasing), so
//      this is real engine-verified concurrent contention, not merely
//      "ran two processes at about the same time and hoped." Verified
//      interactively in this session's own sandbox: the lock-acquired and
//      both-blocked signals were observed before the release, and the
//      technique was validated on a throwaway table first.
//
// Same harness/skip mechanics as
// apps/toolbelt/tests/purge_old_events_revoke_public.test.mjs, including
// the identical pg_cron caveat and fix (this sandbox's local Postgres has
// no pg_cron control file installed, so
// 20260808120000_core_event_retention.sql's trailing `create extension
// pg_cron; select cron.schedule(...);` block is sliced off before applying
// -- this suite needs only that file's core.event_monthly_agg table and
// core.purge_old_events() function, neither pg_cron-related).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

const CORE_CREATE_SCHEMA_UP = join(MIGRATIONS_DIR, "20260806190000_core_create_schema.sql");
const CORE_EVENT_RETENTION_UP = join(MIGRATIONS_DIR, "20260808120000_core_event_retention.sql");
const FIX_UP = join(MIGRATIONS_DIR, "20260814070000_core_event_retention_atomic.sql");
const FIX_DOWN = join(MIGRATIONS_DIR, "20260814070000_core_event_retention_atomic_down.sql");

const CRON_SPLIT_MARKER = "create extension pg_cron;";

function coreEventRetentionWithoutCron() {
  const full = readFileSync(CORE_EVENT_RETENTION_UP, "utf8");
  const idx = full.indexOf(CRON_SPLIT_MARKER);
  assert.ok(idx > 0, "expected to find the pg_cron marker in the real retention migration");
  return full.slice(0, idx);
}

// Minimal auth stub: core.run.user_id references auth.users(id) and
// defaults to auth.uid(), so both must exist for core.run's CREATE TABLE
// to compile, even though every fixture insert below supplies user_id
// explicitly (null) and never actually invokes the default.
const HARNESS_SQL = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select null::uuid $$;
`;

const RUN_ID = "55555555-5555-5555-5555-555555555555";
const FIXTURE_SQL = `
insert into core.app (id, name, schema_name) values ('f33-test-app', 'Test App', 'test');
insert into core.run (id, app_id, kind, user_id) values ('${RUN_ID}', 'f33-test-app', 'job', null);
`;

// A fixed, far-past date (never affected by "when is this test actually
// run") so every seeded row is unconditionally older than the function's
// 90-day cutoff, and all seeded rows land in the same core.event_monthly_agg
// month bucket.
const OLD_MONTH = "2020-01-01";
function insertOldEventsSql(n, label) {
  const values = Array.from(
    { length: n },
    (_, i) => `('${RUN_ID}', timestamptz '2020-01-0${1 + i} 00:00:00', 'tool_call', '${label}-${i}')`,
  ).join(",\n    ");
  return `insert into core.event (run_id, at, kind, name) values\n    ${values};`;
}

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
  : "no local Postgres reachable (tried direct `psql` and `sudo -n -u postgres psql`); " +
    "this suite proves real concurrent behavior against an actual engine and has nothing honest to assert without one";

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

// Async (non-blocking) psql invocation: needed for the real two-session
// concurrency proof below, since spawnSync would serialize what must run
// in parallel.
function psqlAsync(dbName, sqlText) {
  return new Promise((resolve) => {
    const child = spawn(RUNNER.cmd, [...RUNNER.args, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-tA", "-q"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(sqlText);
    child.stdin.end();
  });
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function freshDbName() {
  return `f33_core_retention_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDb(applyFix, fn) {
  const db = freshDbName();
  psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
  try {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(CORE_CREATE_SCHEMA_UP, "utf8"));
    psqlOk(db, coreEventRetentionWithoutCron());
    if (applyFix) psqlOk(db, readFileSync(FIX_UP, "utf8"));
    psqlOk(db, FIXTURE_SQL);
    return fn(db);
  } finally {
    psqlOk("postgres", `drop database if exists ${db};`);
  }
}

test(
  "real Postgres RED: the OLD two-statement shape, with both calls' aggregate step interleaved before either's delete step, permanently double-counts event_monthly_agg (Finding 33 reproduction)",
  { skip: SKIP_REASON },
  () => {
    withDb(false, (db) => {
      psqlOk(db, insertOldEventsSql(3, "red"));

      // The OLD function body's own two statements, issued twice each, in
      // the exact worst-case order two genuinely concurrent invocations
      // under READ COMMITTED can produce: both aggregate-selects observe
      // the same still-live rows before either delete removes them.
      const aggregateStmt = `
        insert into core.event_monthly_agg (month, event_count)
        select date_trunc('month', at)::date, count(*)
        from core.event
        where at < now() - interval '90 days'
        group by 1
        on conflict (month) do update
          set event_count = core.event_monthly_agg.event_count + excluded.event_count;
      `;
      const deleteStmt = `delete from core.event where at < now() - interval '90 days';`;

      psqlOk(db, aggregateStmt); // "call 1" statement 1
      psqlOk(db, aggregateStmt); // "call 2" statement 1 -- same live rows, not yet deleted
      psqlOk(db, deleteStmt); // "call 1" statement 2
      psqlOk(db, deleteStmt); // "call 2" statement 2 -- rows already gone, no-op

      const remaining = psqlOk(db, "select count(*) from core.event;").trim();
      assert.equal(remaining, "0", "all 3 rows must really be deleted exactly once");

      const total = psqlOk(
        db,
        `select event_count from core.event_monthly_agg where month = date '${OLD_MONTH}';`,
      ).trim();
      assert.equal(total, "6", "double-counted: 3 real rows counted twice (once per interleaved aggregate step) = 6");
    });
  },
);

test(
  "real Postgres GREEN (sanity): the FIXED function called twice back-to-back never double-counts",
  { skip: SKIP_REASON },
  () => {
    withDb(true, (db) => {
      psqlOk(db, insertOldEventsSql(3, "green-sanity"));

      const firstPurged = psqlOk(db, "select core.purge_old_events();").trim();
      assert.equal(firstPurged, "3");
      const secondPurged = psqlOk(db, "select core.purge_old_events();").trim();
      assert.equal(secondPurged, "0", "the second call has nothing left to purge");

      const total = psqlOk(
        db,
        `select event_count from core.event_monthly_agg where month = date '${OLD_MONTH}';`,
      ).trim();
      assert.equal(total, "3", "must equal the true row count, not double-counted");
    });
  },
);

test(
  "real Postgres GREEN: two genuinely concurrent, lock-forced-to-overlap calls to the FIXED function never double-count and never double-delete (Finding 33 fix, real concurrency)",
  { skip: SKIP_REASON },
  async () => {
    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, HARNESS_SQL);
      psqlOk(db, readFileSync(CORE_CREATE_SCHEMA_UP, "utf8"));
      psqlOk(db, coreEventRetentionWithoutCron());
      psqlOk(db, readFileSync(FIX_UP, "utf8"));
      psqlOk(db, FIXTURE_SQL);
      psqlOk(db, insertOldEventsSql(5, "green-concurrent"));

      // Third session: holds an explicit row lock on every row the purge
      // will target, forcing both concurrent purge calls below to
      // genuinely block on real Postgres row-lock contention rather than
      // racing on timing luck.
      const locker = spawn(RUNNER.cmd, [...RUNNER.args, "-d", db, "-v", "ON_ERROR_STOP=1", "-tA", "-q"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let lockerOut = "";
      locker.stdout.on("data", (d) => (lockerOut += d));
      locker.stderr.on("data", (d) => (lockerOut += "[ERR]" + d));
      locker.stdin.write("begin;\nselect * from core.event for update;\nselect 'LOCK_HELD';\n");

      const lockAcquired = await waitFor(() => lockerOut.includes("LOCK_HELD"), 5000);
      assert.ok(lockAcquired, `locker session never confirmed its lock: ${lockerOut}`);

      // Launch two real concurrent purge calls -- both will attempt to
      // DELETE the same locked rows and block.
      const callA = psqlAsync(db, "select core.purge_old_events();");
      const callB = psqlAsync(db, "select core.purge_old_events();");

      const bothBlocked = await waitFor(() => {
        const count = psqlOk(
          db,
          "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database();",
        ).trim();
        return Number(count) === 2;
      }, 5000);
      assert.ok(bothBlocked, "expected both concurrent purge calls to be genuinely blocked on the locker's row lock");

      // Release: both blocked calls now race for the same rows for real.
      locker.stdin.write("commit;\n");
      locker.stdin.end();

      const [resultA, resultB] = await Promise.all([callA, callB]);
      assert.equal(resultA.code, 0, `call A failed: ${resultA.stderr}`);
      assert.equal(resultB.code, 0, `call B failed: ${resultB.stderr}`);

      const purgedA = Number(resultA.stdout.trim());
      const purgedB = Number(resultB.stdout.trim());
      assert.equal(purgedA + purgedB, 5, "every row must be counted as purged by exactly one of the two concurrent calls");
      assert.ok(
        purgedA === 0 || purgedB === 0,
        "whichever call lost the row-lock race must find nothing left (rows cannot be split-then-doubled)",
      );

      const remaining = psqlOk(db, "select count(*) from core.event;").trim();
      assert.equal(remaining, "0", "all 5 rows must be gone exactly once");

      const total = psqlOk(
        db,
        `select event_count from core.event_monthly_agg where month = date '${OLD_MONTH}';`,
      ).trim();
      assert.equal(total, "5", "the real concurrent race must not have double-counted the monthly aggregate");
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);

test("the down migration restores the exact original racy two-statement body", () => {
  const downSql = readFileSync(FIX_DOWN, "utf8");
  assert.match(downSql, /insert into core\.event_monthly_agg/);
  assert.match(downSql, /with deleted as \(\s*delete from core\.event/);
  // The down migration's aggregate statement must NOT read from a `deleted`
  // CTE (that would just be the fixed shape again) -- it must independently
  // scan core.event, matching the original bug precisely.
  const aggregateBlockEnd = downSql.indexOf("with deleted as");
  const aggregateBlock = downSql.slice(0, aggregateBlockEnd);
  assert.match(aggregateBlock, /from core\.event\s*\n\s*where at < now\(\)/);
});
