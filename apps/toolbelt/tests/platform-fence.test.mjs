import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, TEST_USER_A } from "./helpers.mjs";

// m1-06-feat-db-platform-bootstrap: platform.config/platform.owner() must
// exist but never be reachable through PostgREST -- the platform schema is
// deliberately not in pgrst.db_schemas (docs/planning/06-supabase-schema.md
// section 2.2). An Accept-Profile: platform request must error, never return
// rows, regardless of caller.
test("platform_config_is_not_exposed_via_postgrest", async () => {
  const { status, json } = await rest("platform", "config?select=*");
  assert.notEqual(status, 200, `expected the platform schema to be unreachable, got ${status} ${JSON.stringify(json)}`);
});

// m1-06 acceptance: an authenticated fixture token can write test.scratch
// (the fence). This is what a later RLS-denial test uses as its liveness
// proof: the SAME token that succeeds here must get zero rows / 4xx on
// core/idea/prompt once the owner re-pin (m1-08) lands, proving denial is
// policy, not an expired token.
test("fixture_token_can_write_test_scratch", async () => {
  const token = await login(TEST_USER_A);
  const { status, json } = await rest("test", "scratch", {
    token,
    method: "POST",
    body: { label: "m1-06 fixture liveness", payload: { source: "platform-fence.test.mjs" } },
  });
  assert.equal(status, 201, JSON.stringify(json));
  assert.equal(json[0].label, "m1-06 fixture liveness");
});
