// m4-03-feat-po-injection-rpc (05-d-prompt-organizer.md section 3, PO-4):
// real-Postgres proof of the starter-prompt seed migration
// (20260813160000_prompt_seed_starters.sql / _down.sql), applying the real,
// committed migration files from disk verbatim. Mirrors the
// detection/skip mechanics and harness technique get-prompt.test.mjs (this
// same issue) and apps/toolbelt/apps/idea-intake/tests/intake-guards.test.mjs
// (m3-05) already established -- see get-prompt.test.mjs's header comment
// for the full rationale (live Supabase does not have this migration
// applied yet, confirmed live; a bare local PostgreSQL 16 lacks Supabase's
// managed platform, stubbed here the same way).
//
// PO-4's own verification query (05-d section 3: "group count of active
// prompts by namespace prefix, minimum 1 per category") is asserted
// directly against the 8 categories in the section 3 table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asAuthenticated,
  createPostgresHarness,
  supabaseHarnessSql,
} from "../../../tests/postgres-harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "supabase", "migrations");
const PO_MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

const PLATFORM_BOOTSTRAP_UP = join(ROOT_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");

// Schema prerequisites only; get_prompt (20260813120000) itself is not
// needed to prove the seed migration's own properties, but is included so
// tests can optionally exercise get_prompt against real seeded bodies too
// (below).
const PO_MIGRATIONS_IN_ORDER = [
  "20260807020000_prompt_create_prompt.sql",
  "20260807041000_prompt_versions_and_unique_title.sql",
  "20260807051000_prompt_create_tag.sql",
  "20260807070000_prompt_create_usage.sql",
  "20260808000000_prompt_add_is_active.sql",
  "20260808100000_prompt_create_configuration.sql",
  "20260808130000_prompt_create_render_function.sql",
  "20260812180000_prompt_owner_pin.sql",
  "20260812200000_prompt_observed_query_indexes.sql",
  "20260813120000_prompt_create_get_prompt_function.sql",
  "20260813151000_prompt_scope_title_uniqueness.sql",
];
const SEED_UP = join(PO_MIGRATIONS_DIR, "20260813160000_prompt_seed_starters.sql");
const SEED_DOWN = join(PO_MIGRATIONS_DIR, "20260813160000_prompt_seed_starters_down.sql");
const PRIOR_SEED_UP = join(PO_MIGRATIONS_DIR, "20260813130000_prompt_seed_starters.sql");
const PRIOR_SEED_DOWN = join(PO_MIGRATIONS_DIR, "20260813130000_prompt_seed_starters_down.sql");

const OWNER_UUID = "9a50a35a-8a1e-4f0c-8495-7f26777982d8";

// The 8 05-d section 3 taxonomy categories, exactly as their table lists
// them (namespace prefix column), plus the two extra rows this migration
// also seeds: 05-h-idea-intake.md section 5's literal
// `idea-intake/optimize-v1` consumer contract (a distinct row from the
// `intake/optimize` category's own taxonomy example, `intake/optimize/idea`
// -- see the seed migration's own header comment for why both exist).
const CATEGORY_PREFIXES = [
  "brain/",
  "coding/system",
  "coding/review",
  "planning/spec",
  "intake/optimize",
  "lifeos/chat",
  "research/",
  "ops/runbooks",
];
const SEEDED_TITLES = [
  "brain/task-contract",
  "coding/system/kernel-run",
  "coding/review/simplification",
  "planning/spec/issue-outcome",
  "intake/optimize/idea",
  "lifeos/chat/system",
  "research/deep-dive",
  "ops/runbooks/deploy-verify",
  "idea-intake/optimize-v1",
];

const HARNESS_SQL = supabaseHarnessSql([OWNER_UUID]);

const OWNER_BOOTSTRAP_SQL = `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`;

const PG = createPostgresHarness("m4_03_seed_test");
const { psql, psqlOk, applyMigrationWithRetry } = PG;
const SKIP_REASON = PG.skipReason;

// See get-prompt.test.mjs for the "tuple concurrently updated" rationale
// (20260807020000's unscoped `alter role authenticator set pgrst.db_schemas`).
function buildBaseSchema(db) {
  psqlOk(db, HARNESS_SQL);
  psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
  psqlOk(db, OWNER_BOOTSTRAP_SQL);
  for (const name of PO_MIGRATIONS_IN_ORDER) {
    const sql = readFileSync(join(PO_MIGRATIONS_DIR, name), "utf8");
    if (name === "20260807020000_prompt_create_prompt.sql") applyMigrationWithRetry(db, sql);
    else psqlOk(db, sql);
  }
}

// Same prefix as buildBaseSchema, but stops BEFORE 20260813151000 (the last
// entry) so a caller can splice 20260813130000_prompt_seed_starters.sql in
// at its real chronological position -- 130000 < 151000 by timestamp, so
// real deployment always applies 130000 before 151000 rescopes the unique
// index. buildBaseSchema itself cannot be reused for this: it already
// includes 151000, and applying 130000 afterward (out of real order) fails
// outright, since 130000's own `on conflict (lower(title))` targets the
// unscoped index 151000 has by then already dropped.
const PRE_151000 = PO_MIGRATIONS_IN_ORDER.slice(0, -1);
const SCOPE_TITLE_UNIQUENESS = PO_MIGRATIONS_IN_ORDER.at(-1);

function buildSchemaThroughRealMigrationOrder(db) {
  psqlOk(db, HARNESS_SQL);
  psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
  psqlOk(db, OWNER_BOOTSTRAP_SQL);
  for (const name of PRE_151000) {
    const sql = readFileSync(join(PO_MIGRATIONS_DIR, name), "utf8");
    if (name === "20260807020000_prompt_create_prompt.sql") applyMigrationWithRetry(db, sql);
    else psqlOk(db, sql);
  }
  psqlOk(db, readFileSync(PRIOR_SEED_UP, "utf8"));
  psqlOk(db, readFileSync(join(PO_MIGRATIONS_DIR, SCOPE_TITLE_UNIQUENESS), "utf8"));
}

function withDb(fn) {
  return PG.withDatabase(fn);
}

test("real Postgres: the seed migration inserts one active prompt per each of the 8 taxonomy categories (PO-4)", { skip: SKIP_REASON }, () => {
  withDb((db) => {
    buildBaseSchema(db);
    psqlOk(db, readFileSync(SEED_UP, "utf8"));

    // PO-4's own verification query shape: count of active prompts grouped
    // by namespace prefix, each category >= 1.
    const rows = psqlOk(
      db,
      asAuthenticated(
        OWNER_UUID,
        `select cat.prefix || '|' || count(p.title)
         from (values ${CATEGORY_PREFIXES.map((p) => `('${p}')`).join(",")}) as cat(prefix)
         left join prompt.prompt p on p.title like cat.prefix || '%' and p.is_active
         group by cat.prefix
         order by cat.prefix;`,
      ),
    )
      .trim()
      .split("\n")
      .map((line) => {
        const [prefix, count] = line.split("|");
        return [prefix, Number(count)];
      });

    assert.equal(rows.length, CATEGORY_PREFIXES.length);
    for (const [prefix, count] of rows) {
      assert.ok(count >= 1, `category "${prefix}" has ${count} active seeded prompts, expected >= 1`);
    }
  });
});

test("real Postgres: the seed includes the exact idea-intake/optimize-v1 title 05-h section 5 hardcodes", { skip: SKIP_REASON }, () => {
  withDb((db) => {
    buildBaseSchema(db);
    psqlOk(db, readFileSync(SEED_UP, "utf8"));

    const found = psqlOk(
      db,
      asAuthenticated(OWNER_UUID, "select count(*) from prompt.prompt where title = 'idea-intake/optimize-v1' and is_active;"),
    ).trim();

    assert.equal(found, "1");
  });
});

test("real Postgres: get_prompt renders the real seeded idea-intake/optimize-v1 body with 05-h's exact variable set", { skip: SKIP_REASON }, () => {
  withDb((db) => {
    buildBaseSchema(db);
    psqlOk(db, readFileSync(SEED_UP, "utf8"));

    const values = JSON.stringify({
      TITLE: "Faster onboarding",
      PROBLEM: "New devs take 2 days to get a working env",
      OUTCOME: "Env ready in under 1 hour",
      NOTES: "n/a",
      TARGET_REPO: "kgsmith19/hyperbolic-core",
    }).replace(/'/g, "''");

    const out = JSON.parse(
      psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          `select prompt.get_prompt('idea-intake/optimize-v1', null, null, '${values}'::jsonb, null);`,
        ),
      ).trim(),
    );

    assert.ok(!/\{\{[A-Z_]+\}\}/.test(out.text), "no unresolved {{VAR}} token may remain: " + out.text);
    assert.match(out.text, /Faster onboarding/);
    assert.match(out.text, /kgsmith19\/hyperbolic-core/);
    assert.equal(out.version_no, 1);
  });
});

test("real Postgres: re-applying the seed migration is idempotent (0 new rows, no error, ON CONFLICT DO NOTHING)", { skip: SKIP_REASON }, () => {
  withDb((db) => {
    buildBaseSchema(db);
    psqlOk(db, readFileSync(SEED_UP, "utf8"));
    const countBefore = psqlOk(db, asAuthenticated(OWNER_UUID, "select count(*) from prompt.prompt;")).trim();

    psqlOk(db, readFileSync(SEED_UP, "utf8"));

    const countAfter = psqlOk(db, asAuthenticated(OWNER_UUID, "select count(*) from prompt.prompt;")).trim();
    assert.equal(countAfter, countBefore, "re-running the seed migration must not add or duplicate rows");
  });
});

test(
  "real Postgres: a pre-existing title collision survives both seed and rollback untouched",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      buildBaseSchema(db);
      // A "personal" prompt is created BEFORE the seed migration ever
      // runs, under a title the seed also wants to use.
      psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          "insert into prompt.prompt (title, body) values ('ops/runbooks/deploy-verify', 'MY PERSONAL PRE-EXISTING BODY, NOT THE SEED TEXT');",
        ),
      );

      psqlOk(db, readFileSync(SEED_UP, "utf8"));

      const row = psqlOk(
        db,
        asAuthenticated(OWNER_UUID, "select body from prompt.prompt where lower(title) = lower('ops/runbooks/deploy-verify');"),
      ).trim();
      assert.equal(row, "MY PERSONAL PRE-EXISTING BODY, NOT THE SEED TEXT");

      const dupCount = psqlOk(
        db,
        asAuthenticated(OWNER_UUID, "select count(*) from prompt.prompt where lower(title) = lower('ops/runbooks/deploy-verify');"),
      ).trim();
      assert.equal(dupCount, "1", "the conflicting seed row must be skipped, not inserted alongside the personal one");

      psqlOk(db, readFileSync(SEED_DOWN, "utf8"));
      const afterRollback = psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          "select body from prompt.prompt where lower(title) = lower('ops/runbooks/deploy-verify');",
        ),
      ).trim();
      assert.equal(afterRollback, "MY PERSONAL PRE-EXISTING BODY, NOT THE SEED TEXT");
    });
  },
);

test(
  "real Postgres: an inaccessible legacy fixture title cannot squat an owner seed",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      buildBaseSchema(db);
      const foreignId = "9a50a35a-8a1e-4f0c-8495-7f26777982d9";
      psqlOk(db, `insert into auth.users (id) values ('${foreignId}');`);
      psqlOk(
        db,
        `insert into prompt.prompt (user_id, title, body)
         values ('${foreignId}', 'ops/runbooks/deploy-verify', 'FOREIGN FIXTURE BODY');`,
      );

      psqlOk(db, readFileSync(SEED_UP, "utf8"));

      const ownerBody = psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          "select body from prompt.prompt where lower(title) = lower('ops/runbooks/deploy-verify');",
        ),
      ).trim();
      assert.notEqual(ownerBody, "FOREIGN FIXTURE BODY");
      assert.equal(
        psqlOk(db, "select count(*) from prompt.prompt where lower(title) = lower('ops/runbooks/deploy-verify');").trim(),
        "2",
      );

      psqlOk(db, readFileSync(SEED_DOWN, "utf8"));
      assert.equal(
        psqlOk(
          db,
          `select body from prompt.prompt
           where user_id = '${foreignId}' and lower(title) = lower('ops/runbooks/deploy-verify');`,
        ).trim(),
        "FOREIGN FIXTURE BODY",
      );
    });
  },
);

test("real Postgres: the down migration deletes exactly the 9 seeded titles, nothing else", { skip: SKIP_REASON }, () => {
  withDb((db) => {
    buildBaseSchema(db);
    psqlOk(db, readFileSync(SEED_UP, "utf8"));
    // An unrelated prompt that must survive the down migration untouched.
    psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('my-personal/unrelated-prompt', 'keep me');"));

    const countBefore = psqlOk(db, asAuthenticated(OWNER_UUID, "select count(*) from prompt.prompt;")).trim();
    assert.equal(countBefore, String(SEEDED_TITLES.length + 1));

    psqlOk(db, readFileSync(SEED_DOWN, "utf8"));

    const remaining = psqlOk(db, asAuthenticated(OWNER_UUID, "select title from prompt.prompt order by title;"))
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(remaining, ["my-personal/unrelated-prompt"]);
  });
});

test("real Postgres: the down migration cascades prompt_version cleanly, leaving zero orphans", { skip: SKIP_REASON }, () => {
  withDb((db) => {
    buildBaseSchema(db);
    psqlOk(db, readFileSync(SEED_UP, "utf8"));

    psqlOk(db, readFileSync(SEED_DOWN, "utf8"));

    const orphans = psqlOk(
      db,
      asAuthenticated(
        OWNER_UUID,
        "select count(*) from prompt.prompt_version v where not exists (select 1 from prompt.prompt p where p.id = v.prompt_id);",
      ),
    ).trim();
    assert.equal(orphans, "0");
  });
});

// Deployability regression guard: the seed migration's INSERT runs as
// whatever role executes `supabase db push` in production, which is NOT a
// Postgres superuser (Supabase's managed project does not grant that), and
// which has no PostgREST/JWT session (auth.uid() is null in that context).
// prompt.prompt's owner_rw policy (20260812180000) requires auth.uid() =
// platform.owner(); FORCE ROW LEVEL SECURITY (set at table creation,
// 20260807020000/041000) applies that check to the table's own owner too,
// not just other callers. Proven interactively while implementing this
// issue: inserting as a non-superuser owner role WITHOUT the seed
// migration's `no force / force` wrapper around the statement fails with
// "new row violates row-level security policy for table \"prompt\""; WITH
// the wrapper (as shipped), it succeeds. This test reconstructs that same
// non-superuser-owner condition so a future edit that drops the wrapper
// fails loudly here instead of only at the next real deploy.
// DB review finding (PR #9 follow-up): every test above applies SEED_UP to
// a database that has never seen 20260813130000 -- deliberately, per
// buildBaseSchema's own comment, to isolate this migration's own
// properties. But that isolation hid a real bug: in the ACTUAL deployment
// order (130000 then 160000 against the SAME database, exactly as
// platform-migrations.yml applies them), 130000 already owns every one of
// these 9 titles by the time 160000 runs, so 160000's original
// conflict-driven insert was always a silent 0-row no-op and neither down
// migration ever actually deleted anything. This test is the one this repo
// was missing: it replays the real order end to end, including both down
// migrations in real reverse order, against one database.
test(
  "real Postgres: the real deployment order (130000 then 160000) reconciles onto stable ids, and both down migrations in reverse order fully clean up",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      buildSchemaThroughRealMigrationOrder(db);

      const afterPrior = psqlOk(db, asAuthenticated(OWNER_UUID, "select count(*) from prompt.prompt;")).trim();
      assert.equal(afterPrior, String(SEEDED_TITLES.length), "20260813130000 alone must seed exactly 9 rows");

      psqlOk(db, readFileSync(SEED_UP, "utf8"));

      const rows = psqlOk(
        db,
        asAuthenticated(OWNER_UUID, "select id, title from prompt.prompt order by title;"),
      )
        .trim()
        .split("\n")
        .map((line) => line.split("|"));
      assert.equal(rows.length, SEEDED_TITLES.length, "reconciliation must not create duplicates or lose rows");
      for (const [id] of rows) {
        assert.match(id, /^7a6c6f00-000[1-9]-4000-8000-00000000000[1-9]$/, `row id ${id} must be one of the migration-owned stable ids after reconciliation`);
      }

      // Re-running the reconciled state must stay stable (the exact
      // idempotency property the original bug's fix could not have without
      // silently self-destructing on a second run -- see the migration's
      // own header comment on the CTE-snapshot gotcha this fix avoids).
      psqlOk(db, readFileSync(SEED_UP, "utf8"));
      const afterReapply = psqlOk(db, asAuthenticated(OWNER_UUID, "select count(*) from prompt.prompt;")).trim();
      assert.equal(afterReapply, String(SEEDED_TITLES.length));

      // Real reverse-order rollback: 160000_down, then 130000_down.
      psqlOk(db, readFileSync(SEED_DOWN, "utf8"));
      psqlOk(db, readFileSync(PRIOR_SEED_DOWN, "utf8"));

      const remaining = psqlOk(db, asAuthenticated(OWNER_UUID, "select count(*) from prompt.prompt;")).trim();
      assert.equal(remaining, "0", "both down migrations together must remove every seeded row, not silently leave them live");
    });
  },
);

test(
  "real Postgres: the seed migration succeeds when run as a non-superuser table owner with no JWT session (production-realistic)",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      // Build the schema normally (as the postgres superuser, exactly like
      // every other case here) -- this test targets the seed migration's
      // own DML specifically, not 20260807020000's unrelated
      // `alter role authenticator set pgrst.db_schemas` line (setting an
      // undefined placeholder GUC via ALTER ROLE is itself a superuser-only
      // operation in vanilla Postgres, independent of table ownership or
      // RLS -- replaying that one statement under a deliberately weakened
      // role is a dead end unrelated to what this test is proving).
      buildBaseSchema(db);

      // Re-own just the two tables the seed migration writes to, to a
      // fresh non-superuser, non-BYPASSRLS role -- the production-realistic
      // condition (Supabase's managed project does not run migrations as
      // an actual Postgres superuser). No login, no JWT session, so
      // auth.uid() is null for this role exactly as it is for whatever
      // role runs `supabase db push` for real.
      const ownerRole = `po_seed_owner_${process.pid}_${Date.now()}`;
      psqlOk(db, `create role ${ownerRole} nologin;`);
      psqlOk(db, `grant usage on schema prompt to ${ownerRole};`);
      psqlOk(db, `grant usage on schema platform to ${ownerRole};`);
      psqlOk(db, `alter table prompt.prompt owner to ${ownerRole};`);
      psqlOk(db, `alter table prompt.prompt_version owner to ${ownerRole};`);
      // platform.owner() is security definer with EXECUTE granted only to
      // anon/authenticated/service_role (20260812140000); the seed
      // migration calls it (wrapped in a scalar subquery), so its runner
      // needs the same explicit grant a real deploy role would need.
      psqlOk(db, `grant execute on function platform.owner() to ${ownerRole};`);

      const relOwner = psqlOk(
        db,
        "select relowner::regrole::text from pg_class where relname = 'prompt' and relnamespace = 'prompt'::regnamespace;",
      ).trim();
      assert.equal(relOwner, ownerRole, "sanity check: prompt.prompt must be owned by the non-superuser role, not postgres");

      // The real assertion: applying the real, unmodified seed migration
      // file as this non-superuser owner, with no auth.uid() set at all,
      // must succeed -- this is exactly the condition that failed with
      // "new row violates row-level security policy for table \"prompt\""
      // when probed interactively without the migration's own
      // `no force / force` wrapper around the insert.
      const result = psql(db, `set role ${ownerRole};\n` + readFileSync(SEED_UP, "utf8"));
      assert.equal(result.status, 0, `seed migration failed as a non-superuser table owner: ${result.stderr}`);

      const count = psqlOk(db, asAuthenticated(OWNER_UUID, "select count(*) from prompt.prompt;")).trim();
      assert.equal(count, String(SEEDED_TITLES.length));
    });
  },
);
