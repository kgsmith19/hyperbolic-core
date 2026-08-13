import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, TEST_USER_A } from "./helpers.mjs";

// m1-08-feat-db-rls-owner-repin: after 20260812160000_core_idea_owner_pin.sql
// and 20260812180000_prompt_owner_pin.sql apply, a fixture-user token must
// get zero rows on every select and a 4xx on every write, across core,
// idea, and prompt (docs/planning/06-supabase-schema.md section 5.5). These
// assertions target tables that already carry seed/fixture-reachable rows
// under the OLD authenticated_all/auth.uid() policies, so a pass here is
// evidence of the new policy, not an empty table.
//
// Not executed against live data in this session: these migrations have not
// been applied to the live platform project (no live schema-write access
// here), and this session's Supabase network access is restricted to the
// read-only log-query tool. Ready to run once platform-migrations.yml has
// applied them, per apps/toolbelt/docs/notes/2026-08-12-platform-idp-owner-setup.md.

test("fixture_token_gets_zero_rows_and_4xx_on_core_app", async () => {
  const token = await login(TEST_USER_A);
  const read = await rest("core", "app?select=id&limit=5", { token });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, []);

  const write = await rest("core", "app", {
    token,
    method: "POST",
    body: { id: "owner-repin-fixture-probe", name: "should be rejected", schema_name: "test" },
  });
  assert.ok(write.status >= 400 && write.status < 500, `expected 4xx, got ${write.status}`);
});

test("fixture_token_gets_zero_rows_and_4xx_on_idea_idea", async () => {
  const token = await login(TEST_USER_A);
  const read = await rest("idea", "idea?select=id&limit=5", { token });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, []);

  const write = await rest("idea", "idea", {
    token,
    method: "POST",
    body: { id: "owner-repin-fixture-probe", name: "should be rejected", category: "test", one_liner: "x" },
  });
  assert.ok(write.status >= 400 && write.status < 500, `expected 4xx, got ${write.status}`);
});

test("fixture_token_gets_zero_rows_and_4xx_on_prompt_prompt", async () => {
  const token = await login(TEST_USER_A);
  const read = await rest("prompt", "prompt?select=id&limit=5", { token });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, []);

  const write = await rest("prompt", "prompt", {
    token,
    method: "POST",
    body: { title: "owner-repin-fixture-probe", body: "should be rejected" },
  });
  assert.ok(write.status >= 400 && write.status < 500, `expected 4xx, got ${write.status}`);
});

// core.log_run is security definer, so RLS alone does not constrain it; the
// migration adds an explicit owner gate raising errcode 42501. PostgREST
// surfaces a raised exception as a 4xx with the Postgres error code echoed
// in the response body, not as a 200.
test("fixture_token_cannot_call_log_run_rpc", async () => {
  const token = await login(TEST_USER_A);
  const { status, json } = await rest("core", "rpc/log_run", {
    token,
    method: "POST",
    body: { p_app_id: "prompt-organizer", p_kind: "job", p_wall_clock_ms: 1 },
  });
  assert.ok(status >= 400, `expected an error status, got ${status}`);
  assert.match(JSON.stringify(json), /42501|owner only/);
});

// core.purge_old_events loses its "authenticated" EXECUTE grant in the same
// migration (cron-only from here on). PostgREST maps a call with no
// privilege to call the function as a 404 (the RPC route does not resolve
// for a role with no EXECUTE), not a 200.
test("api_roles_cannot_call_purge_old_events_rpc", async () => {
  const token = await login(TEST_USER_A);
  const { status } = await rest("core", "rpc/purge_old_events", { token, method: "POST", body: {} });
  assert.notEqual(status, 200, `expected the RPC to be unreachable for API roles, got ${status}`);
});

// Not expressible through this suite's REST-only harness (no DATABASE_URL in
// this environment, only the public anon key): the InitPlan-vs-SubPlan
// assertion from docs/planning/06-supabase-schema.md section 5.6 requires a
// direct psql connection --
//   psql "$SUPABASE_DB_URL" -c "explain (format json) select * from prompt.prompt;"
// -- and checking the plan JSON contains "InitPlan", not "SubPlan", for the
// platform.owner()/auth.uid() lookups. This is the exact verification
// command m1-08's issue file specifies; it is a manual/CI-operator step
// (docs/planning/issues/m1-08-feat-db-rls-owner-repin.md), not something
// this test file fakes by asserting a REST-observable proxy for it.
