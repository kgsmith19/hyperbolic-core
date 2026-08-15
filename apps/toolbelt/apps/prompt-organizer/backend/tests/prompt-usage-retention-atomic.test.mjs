// Independent security review, Finding 33 (re-verified against current
// HEAD), part B: real-Postgres proof that prompt.purge_old_usage() no
// longer double-counts prompt.usage_monthly_agg under concurrent
// invocation, mirroring
// apps/toolbelt/tests/core-event-retention-atomic.test.mjs's two proof
// styles exactly (see that file's header comment for the full rationale):
//
//   1. RED: a deterministic reproduction of the OLD two-statement shape,
//      with both "calls'" aggregate steps interleaved before either's
//      delete step -- the one interleaving that actually triggers the bug,
//      and the only one two genuinely concurrent invocations under READ
//      COMMITTED can produce.
//
//   2. GREEN: a genuine two-session concurrency proof against the real
//      fixed function, using a third session's held `SELECT ... FOR
//      UPDATE` to force two concurrent `select prompt.purge_old_usage();`
//      calls to actually block on the same rows (confirmed via
//      pg_stat_activity.wait_event_type = 'Lock' before releasing).
//
// Same harness/skip mechanics and same pg_cron caveat/fix as
// apps/toolbelt/apps/prompt-organizer/backend/tests/purge_old_usage_revoke_public.test.mjs.
import { test } from "node:test";
import {
  createPostgresHarness,
  psqlAsync,
  psqlSpawnSpec,
  supabaseHarnessSql,
  waitFor,
} from "../../../../tests/postgres-harness.mjs";
import { applyRetentionSchema, makeWithRetentionDb, poMigration } from "./prompt-db.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FIX_UP = poMigration("20260814080000_prompt_usage_retention_atomic.sql");
const FIX_DOWN = poMigration("20260814080000_prompt_usage_retention_atomic_down.sql");

const PG = createPostgresHarness("f33_prompt_retention");
const { psql, psqlOk, freshDatabaseName: freshDbName, withDatabase } = PG;
const SKIP_REASON = PG.skipReason;
const psqlAllowError = psql;

const HARNESS_SQL = supabaseHarnessSql([]);

const OWNER_UUID = "11111111-1111-1111-1111-111111111111";
const PROMPT_ID = "66666666-6666-6666-6666-666666666666";
const FIXTURE_SQL = `
insert into auth.users (id) values ('${OWNER_UUID}');
insert into prompt.prompt (id, user_id, title, body) values ('${PROMPT_ID}', '${OWNER_UUID}', 'f33 fixture prompt', 'fixture body');
`;

// A fixed, far-past date so every seeded row is unconditionally older than
// the function's 365-day cutoff and lands in the same monthly bucket.
const OLD_MONTH = "2020-01-01";
function insertOldUsageSql(n, label) {
  const values = Array.from(
    { length: n },
    (_, i) => `('${PROMPT_ID}', 1, '${OWNER_UUID}', timestamptz '2020-01-0${1 + i} 00:00:00')`,
  ).join(",\n    ");
  return `insert into prompt.usage (prompt_id, version_no, user_id, created_at) values\n    ${values};`;
}

const withDb = makeWithRetentionDb(PG, {
  harnessSql: HARNESS_SQL,
  fixtureSql: FIXTURE_SQL,
  fixUp: FIX_UP,
});

test(
  "real Postgres RED: the OLD two-statement shape, with both calls' aggregate step interleaved before either's delete step, permanently double-counts usage_monthly_agg (Finding 33 reproduction)",
  { skip: SKIP_REASON },
  () => {
    withDb(false, (db) => {
      psqlOk(db, insertOldUsageSql(3, "red"));

      const aggregateStmt = `
        insert into prompt.usage_monthly_agg (prompt_id, month, copy_count)
        select prompt_id, date_trunc('month', created_at)::date, count(*)
        from prompt.usage
        where created_at < now() - interval '365 days'
        group by 1, 2
        on conflict (prompt_id, month) do update
          set copy_count = prompt.usage_monthly_agg.copy_count + excluded.copy_count;
      `;
      const deleteStmt = `delete from prompt.usage where created_at < now() - interval '365 days';`;

      psqlOk(db, aggregateStmt); // "call 1" statement 1
      psqlOk(db, aggregateStmt); // "call 2" statement 1 -- same live rows, not yet deleted
      psqlOk(db, deleteStmt); // "call 1" statement 2
      psqlOk(db, deleteStmt); // "call 2" statement 2 -- rows already gone, no-op

      const remaining = psqlOk(db, "select count(*) from prompt.usage;").trim();
      assert.equal(remaining, "0", "all 3 rows must really be deleted exactly once");

      const total = psqlOk(
        db,
        `select copy_count from prompt.usage_monthly_agg where prompt_id = '${PROMPT_ID}' and month = date '${OLD_MONTH}';`,
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
      psqlOk(db, insertOldUsageSql(3, "green-sanity"));

      const firstPurged = psqlOk(db, "select prompt.purge_old_usage();").trim();
      assert.equal(firstPurged, "3");
      const secondPurged = psqlOk(db, "select prompt.purge_old_usage();").trim();
      assert.equal(secondPurged, "0", "the second call has nothing left to purge");

      const total = psqlOk(
        db,
        `select copy_count from prompt.usage_monthly_agg where prompt_id = '${PROMPT_ID}' and month = date '${OLD_MONTH}';`,
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
      applyRetentionSchema(psqlOk, db, {
        harnessSql: HARNESS_SQL,
        fixtureSql: FIXTURE_SQL,
        fixUp: FIX_UP,
      });
      psqlOk(db, insertOldUsageSql(5, "green-concurrent"));

      const locker = spawn(...psqlSpawnSpec(db), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let lockerOut = "";
      locker.stdout.on("data", (d) => (lockerOut += d));
      locker.stderr.on("data", (d) => (lockerOut += "[ERR]" + d));
      locker.stdin.write("begin;\nselect * from prompt.usage for update;\nselect 'LOCK_HELD';\n");

      const lockAcquired = await waitFor(() => lockerOut.includes("LOCK_HELD"), 5000);
      assert.ok(lockAcquired, `locker session never confirmed its lock: ${lockerOut}`);

      const callA = psqlAsync(db, "select prompt.purge_old_usage();");
      const callB = psqlAsync(db, "select prompt.purge_old_usage();");

      const bothBlocked = await waitFor(() => {
        const count = psqlOk(
          db,
          "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database();",
        ).trim();
        return Number(count) === 2;
      }, 5000);
      assert.ok(bothBlocked, "expected both concurrent purge calls to be genuinely blocked on the locker's row lock");

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

      const remaining = psqlOk(db, "select count(*) from prompt.usage;").trim();
      assert.equal(remaining, "0", "all 5 rows must be gone exactly once");

      const total = psqlOk(
        db,
        `select copy_count from prompt.usage_monthly_agg where prompt_id = '${PROMPT_ID}' and month = date '${OLD_MONTH}';`,
      ).trim();
      assert.equal(total, "5", "the real concurrent race must not have double-counted the monthly aggregate");
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);

test("the down migration restores the exact original racy two-statement body", () => {
  const downSql = readFileSync(FIX_DOWN, "utf8");
  assert.match(downSql, /insert into prompt\.usage_monthly_agg/);
  assert.match(downSql, /with deleted as \(\s*delete from prompt\.usage/);
  const aggregateBlockEnd = downSql.indexOf("with deleted as");
  const aggregateBlock = downSql.slice(0, aggregateBlockEnd);
  assert.match(aggregateBlock, /from prompt\.usage\s*\n\s*where created_at < now\(\)/);
});

