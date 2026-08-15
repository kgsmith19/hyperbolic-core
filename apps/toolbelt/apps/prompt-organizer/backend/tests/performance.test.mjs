import { test } from "node:test";
import { createPostgresHarness } from "../../../../tests/postgres-harness.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../../frontend/render.mjs";
import { searchPrompts } from "../../frontend/search.mjs";

// Rendering a maximum-size prompt must stay below this p95 budget.
const BUDGET_MS = 100;
// Searching a 1,000-prompt library must stay below this p95 budget.
const SEARCH_BUDGET_MS = 300;
// PO-2 (05-d-prompt-organizer.md section 4): rpc/get_prompt, warm client,
// network included, p95 budget.
const GET_PROMPT_BUDGET_MS = 150;

// p95 over warm iterations. Warm-up matters: the first call pays JIT cost.
// Iterating matters too -- a single shot is what produced the 34.7ms figure
// this slice had to retract (SPEC-0007 section 2).
function p95(fn, iterations = 20) {
  for (let i = 0; i < 5; i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const started = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(iterations * 0.95)];
}

// A body at FR-001's 100,000-character ceiling that looks like a real prompt:
// variables to substitute and well-formed sections to resolve.
function realisticBody() {
  const unit = "prose {{VAR}} here. <!--OPTIONAL:s-->opt<!--/OPTIONAL:s--> tail. ";
  return unit.repeat(Math.ceil(100000 / unit.length)).slice(0, 100000);
}

// The pathological body: nothing but opening fences, no closer anywhere. This
// is the worst case for a parser that hunts forward for a matching closer, and
// it is a body FR-001's CHECK constraint permits (99,994 <= 100,000).
function pathologicalBody() {
  return "<!--OPTIONAL:a-->".repeat(5882);
}

// T-U-024 -> AC-001 -> NFR-002. The ordinary case: a full-size realistic body
// must render well inside the budget.
test("renders_a_realistic_maximum_size_body_within_budget__T_U_024__AC_001", () => {
  const body = realisticBody();
  assert.equal(body.length, 100000, "given: FR-001's ceiling exactly");

  const measured = p95(() => render(body, { VAR: "x" }, ["s"]));

  assert.ok(
    measured < BUDGET_MS,
    `NFR-002: p95 ${measured.toFixed(1)}ms must be under ${BUDGET_MS}ms`,
  );
});

// T-U-025 -> AC-002, PROP-001 -> NFR-002. The defect. SL-003's pair-regex
// expands `[\s\S]*?` to the end of the string once per opening fence, so this
// body costs O(n^2) and measures ~210ms -- over budget on input the schema
// accepts. Output must also be unchanged, since none of these fences pair.
test("renders_a_pathological_fence_body_within_budget__T_U_025__AC_002", () => {
  const body = pathologicalBody();
  assert.ok(body.length <= 100000, "given: within FR-001's CHECK constraint");

  const result = render(body, {}, []);
  assert.equal(result.ok, true);
  assert.equal(result.text, body, "no fence pairs, so nothing is removed");

  const measured = p95(() => render(body, {}, []));

  assert.ok(
    measured < BUDGET_MS,
    `NFR-002: p95 ${measured.toFixed(1)}ms must be under ${BUDGET_MS}ms`,
  );
});

// T-U-026 -> AC-003, AC-005, PROP-007, PROP-008 -> NFR-002. A wall-clock
// threshold alone would pass on fast hardware even if the parser were still
// quadratic, so this pins the growth curve instead: quadrupling the input must
// not multiply the time by ~16. The tolerance is deliberately loose -- this
// exists to catch an algorithmic regression, not to police constant factors.
// AC-005 rides along: interleaved sections must stay non-overlapping.
test("section_parsing_grows_at_most_linearly__T_U_026__AC_003", () => {
  // Sizes are deliberately far above FR-001's 100,000-char storage bound.
  // This test measures the shape of the growth curve, not a storable body --
  // the absolute NFR-002 budget is pinned by T-U-024/025 at in-bounds sizes.
  // Below ~1ms the linear parser is faster than the timer is precise, and the
  // ratio degenerates into noise (measured: a 4x-larger input timing *faster*).
  const time = (fences) => {
    const body = "<!--OPTIONAL:a-->".repeat(fences);
    return p95(() => render(body, {}, []), 10);
  };

  const base = time(15000);
  const quadruple = time(60000);

  assert.ok(
    base > 0.5,
    `base measurement ${base.toFixed(3)}ms is at the timer's noise floor, so ` +
      `the ratio below would be meaningless -- raise the fence counts`,
  );

  const growth = quadruple / base;
  assert.ok(
    growth < 8,
    `PROP-008: 4x the input grew time ${growth.toFixed(1)}x; linear is ~4x, ` +
      `quadratic is ~16x, so anything at or above 8x means the parser backtracks`,
  );

  // AC-005: interleaved pairs. The old regex applied the first complete pair
  // and left the overlapping one literal; the rewrite must agree, and must
  // never emit corrupt text.
  const interleaved = "<!--OPTIONAL:a-->A<!--OPTIONAL:b-->B<!--/OPTIONAL:a-->C<!--/OPTIONAL:b-->";
  const kept = render(interleaved, {}, ["a"]);
  assert.equal(kept.ok, true);
  assert.equal(kept.text, "A<!--OPTIONAL:b-->BC<!--/OPTIONAL:b-->");

  const dropped = render(interleaved, {}, []);
  assert.equal(dropped.ok, true);
  assert.equal(dropped.text, "C<!--/OPTIONAL:b-->");
});

// Search runs client-side over the already-fetched list, not a database
// query, so this is a JS benchmark rather than a seeded-database timing.
test("searches_1000_prompts_within_budget__T_U_029", () => {
  const prompts = [];
  for (let i = 0; i < 1000; i++) {
    prompts.push({
      title: `Prompt ${i}`,
      body: i % 7 === 0 ? "contains spec somewhere in the body" : "ordinary prose here",
      tags: i % 5 === 0 ? ["spec"] : [],
    });
  }

  const measured = p95(() => searchPrompts(prompts, "spec"));

  assert.ok(
    measured < SEARCH_BUDGET_MS,
    `NFR-001: p95 ${measured.toFixed(1)}ms must be under ${SEARCH_BUDGET_MS}ms at 1,000 prompts`,
  );
});

// m4-03-feat-po-injection-rpc, PO-2: p95 over 50 rpc/get_prompt calls under
// 150ms. The issue's own verification command names this exact budget
// against rpc/get_prompt (05-d-prompt-organizer.md section 4's table:
// "warm client, network included").
//
// What this section CAN and CANNOT prove, stated plainly: get_prompt does
// not exist on the live Supabase project yet (confirmed live while
// implementing this issue: POST rest/v1/rpc/get_prompt with the public
// anon key returns PGRST202, "Could not find the function
// prompt.get_prompt(p_name) in the schema cache" -- platform-migrations.yml
// has not deployed this migration pair). There is therefore no reachable
// target yet for the literal PO-2 measurement (PostgREST HTTP round trip,
// auth, network). What IS reachable and genuinely measured here is
// get_prompt's own execution latency against a real PostgreSQL 16 engine,
// on a warm session (planner/JIT warmed by 5 untimed iterations first,
// matching this file's own p95() convention above) -- the RPC body's real
// cost, with the HTTP/PostgREST/network layer this budget nominally
// includes necessarily absent until deployment. This is a narrower, honest
// proxy for PO-2, not a claim of having measured the full path; the gap is
// closed and this section can be extended to the live target as soon as
// platform-migrations.yml has actually applied the migration.
//
// Detection/skip mechanics match get-prompt.test.mjs and seed.test.mjs
// (this same issue): skip cleanly, via node:test's own mechanism, when no
// local Postgres is reachable, rather than fabricate a number.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const PO_MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");
const PLATFORM_BOOTSTRAP_UP = join(ROOT_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");
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
];

const PERF_OWNER_UUID = "9a50a35a-8a1e-4f0c-8495-7f26777982d8";

const PERF_HARNESS_SQL = `
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

insert into auth.users (id) values ('${PERF_OWNER_UUID}');
`;


const { psql, psqlOk, applyMigrationWithRetry, freshDatabaseName: freshDbName, available: perfAvailable } =
  createPostgresHarness("m4_03_perf_test", { timeout: 30000 });

const PERF_SKIP_REASON = perfAvailable
  ? false
  : "no local Postgres reachable (tried direct `psql` and `sudo -n -u postgres psql`); get_prompt is not deployed " +
    "on the live Supabase project yet (confirmed live: rpc/get_prompt returns PGRST202), so this suite has " +
    "nothing honest to measure against either target without a reachable engine";

test(
  "real Postgres: rpc/get_prompt p95 over 50 warm calls stays under the PO-2 150ms budget (engine-level; see comment above for the network-layer gap)",
  { skip: PERF_SKIP_REASON },
  () => {
    const db = freshDbName();
    psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
    try {
      psqlOk(db, PERF_HARNESS_SQL);
      psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
      psqlOk(db, `insert into platform.config (owner_uuid) values ('${PERF_OWNER_UUID}');`);
      for (const name of PO_MIGRATIONS_IN_ORDER) {
        const sql = readFileSync(join(PO_MIGRATIONS_DIR, name), "utf8");
        if (name === "20260807020000_prompt_create_prompt.sql") applyMigrationWithRetry(db, sql);
        else psqlOk(db, sql);
      }

      // A realistic-sized prompt (variables + an optional section), not a
      // trivial one-token body, so the measured cost reflects the same
      // section-then-variable resolution work a real injection call does.
      psqlOk(
        db,
        `set role authenticated;
         do $$ begin perform set_config('app.test_uid', '${PERF_OWNER_UUID}', false); end $$;
         insert into prompt.prompt (title, body) values (
           'perf/get-prompt-fixture',
           'Head {{A}}. <!--OPTIONAL:s-->Section {{B}} {{C}}.<!--/OPTIONAL:s--> Tail {{D}} {{E}}.'
         );
         insert into prompt.configuration (prompt_id, name, values, sections)
         select id, 'perf', '{"A":"1","B":"2","C":"3","D":"4","E":"5"}'::jsonb, '{s}'::text[]
         from prompt.prompt where title = 'perf/get-prompt-fixture';`,
      );

      const samplesRaw = psqlOk(
        db,
        `set role authenticated;
         do $$ begin perform set_config('app.test_uid', '${PERF_OWNER_UUID}', false); end $$;
         create temp table perf_samples (ms double precision);
         do $$
         declare
           t0 timestamptz;
           t1 timestamptz;
           i int;
         begin
           -- Warmup: JIT/plan caching, matching this file's own p95()
           -- convention (5 untimed calls before any timed sample).
           for i in 1..5 loop
             perform prompt.get_prompt('perf/get-prompt-fixture', null, 'perf', null, null);
           end loop;
           for i in 1..50 loop
             t0 := clock_timestamp();
             perform prompt.get_prompt('perf/get-prompt-fixture', null, 'perf', null, null);
             t1 := clock_timestamp();
             insert into perf_samples (ms) values (extract(epoch from (t1 - t0)) * 1000);
           end loop;
         end
         $$;
         select ms from perf_samples order by ms;`,
      );

      const samples = samplesRaw
        .trim()
        .split("\n")
        .map(Number)
        .filter((n) => Number.isFinite(n));
      assert.equal(samples.length, 50, `expected 50 timed samples, got ${samples.length}`);

      const p95Index = Math.floor(samples.length * 0.95);
      const measured = samples[Math.min(p95Index, samples.length - 1)];
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const max = samples[samples.length - 1];

      // Same "[perf] ..." console.log convention as apps/shell/frontend/e2e/tools.spec.ts's
      // perf tests, so a CI log always shows the real measured numbers even
      // when the assertion passes comfortably.
      console.log(
        `[perf] rpc/get_prompt over 50 warm calls (engine-level): mean=${mean.toFixed(2)}ms p95=${measured.toFixed(2)}ms max=${max.toFixed(2)}ms`,
      );

      assert.ok(
        measured < GET_PROMPT_BUDGET_MS,
        `PO-2 (engine-level proxy): p95 ${measured.toFixed(2)}ms must be under ${GET_PROMPT_BUDGET_MS}ms ` +
          `(all 50 samples: ${samples.map((n) => n.toFixed(2)).join(", ")})`,
      );
    } finally {
      psqlOk("postgres", `drop database if exists ${db};`);
    }
  },
);
