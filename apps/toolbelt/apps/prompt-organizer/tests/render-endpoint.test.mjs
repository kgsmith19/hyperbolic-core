import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, USER_A, USER_B, SUPABASE_URL, ANON_KEY } from "./helpers.mjs";

// SPEC-0012 (SL-009): render endpoint. A Postgres RPC exposed by PostgREST
// (SR-02: no application server), not a new service.

async function seedPrompt(token, title, body) {
  const created = await rest("prompt", { token, method: "POST", body: { title, body } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json[0].id;
}

// T-A-007 -> AC-001 -> FR-013. Raw fetch, not the JSON-parsing rest() helper:
// content type is asserted directly from the real response headers.
//
// AC-001 corrected 2026-08-08 (confirmed live, two Accept-header variants
// tried, both 406 PGRST107): PostgREST's raw-media-type output for a
// scalar-returning function needs a server-level `db-plain-text-response`
// config this managed Supabase project doesn't expose to migrations. The
// endpoint returns JSON like every other endpoint in this app -- the text
// is exact, just JSON-quoted, same posture as SPEC-0002 AC-001's correction.
test("renders_via_rpc_as_json__T_A_007__AC_001", async () => {
  const token = await login(USER_A);
  const title = `Render Endpoint Fixture ${Date.now()}`;
  const promptId = await seedPrompt(token, title, "Repo is {{REPO}}.");
  const saved = await rest("configuration", {
    token, method: "POST", body: { prompt_id: promptId, name: "lean", values: { REPO: "toolbelt" }, sections: [] },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/render_prompt?p_name=${encodeURIComponent(title)}&p_config=lean`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Accept-Profile": "prompt" } },
  );
  const text = await res.text();

  assert.equal(res.status, 200, text);
  assert.ok(res.headers.get("content-type").startsWith("application/json"), res.headers.get("content-type"));
  assert.equal(JSON.parse(text), "Repo is toolbelt.");
});

// T-I-021 -> AC-002 -> FR-013
test("unknown_prompt_name_returns_404__T_I_021__AC_002", async () => {
  const token = await login(USER_A);

  const res = await rest(`rpc/render_prompt?p_name=${encodeURIComponent(`does-not-exist ${Date.now()}`)}`, { token });

  assert.equal(res.status, 404, JSON.stringify(res.json));
});

// T-I-022 -> AC-003 -> FR-013, FR-010
test("unfilled_variable_is_blocked_not_leaked__T_I_022__AC_003", async () => {
  const token = await login(USER_A);
  const title = `Render Missing Var Fixture ${Date.now()}`;
  await seedPrompt(token, title, "Repo is {{REPO}}.");

  const res = await rest(`rpc/render_prompt?p_name=${encodeURIComponent(title)}`, { token });

  assert.equal(res.status, 422, JSON.stringify(res.json));
  assert.match(String(res.json.message), /REPO/, "the error must name the missing variable");
});

// T-I-023 -> AC-004 -> FR-013, NFR-003
test("cross_user_cannot_render_another_users_prompt__T_I_023__AC_004", async () => {
  const tokenA = await login(USER_A);
  const tokenB = await login(USER_B);
  const title = `Render RLS Fixture ${Date.now()}`;
  await seedPrompt(tokenA, title, "no variables here");

  const res = await rest(`rpc/render_prompt?p_name=${encodeURIComponent(title)}`, { token: tokenB });

  assert.equal(res.status, 404, JSON.stringify(res.json));
});
