import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, TEST_USER_A, TEST_USER_B } from "./helpers.mjs";

// T-I-001 -> AC-002 -> NFR-001: an anon caller (no user session, just the
// public anon key) reading idea.idea gets zero rows, not an error and not
// someone else's data. RLS on idea.idea is "authenticated" role only.
test("rejects_anon_read_of_idea_idea__T_I_001__AC_002", async () => {
  const { status, json } = await rest("idea", "idea?select=id&limit=5");
  assert.equal(status, 200);
  assert.deepEqual(json, []);
});

// T-A-001 -> AC-001 -> FR-001: the exact data contract the idea list page
// reads (name, category, one_liner, status for a known seeded row) is
// retrievable by an authenticated caller. This proves the data half of the
// page's contract; the browser rendering itself has no automated test here
// (no headless-browser dependency was added, per MAX_NEW_LIBRARIES: 0 -
// verified by hand instead, see SPEC-0000 section 12 evidence).
test("authenticated_read_returns_seeded_prompt_organizer_row__T_A_001__AC_001", async () => {
  const token = await login(TEST_USER_A);
  const { status, json } = await rest(
    "idea",
    "idea?id=eq.prompt-organizer&select=name,category,one_liner,status",
    { token }
  );
  assert.equal(status, 200);
  assert.deepEqual(json, [
    {
      name: "Prompt Organizer",
      category: "Agentic / LLM systems tooling",
      one_liner: "A place to save AI prompts and reuse them instead of retyping them.",
      status: "idea",
    },
  ]);
});

// T-I-002 -> AC-006 -> NFR-001: core.run uses user_id = auth.uid(). User A
// creates a run; user A can see it (positive control, avoids a vacuous
// pass), user B cannot (the actual isolation guarantee).
test("user_b_cannot_read_user_a_core_run_row__T_I_002__AC_006", async () => {
  const tokenA = await login(TEST_USER_A);
  const tokenB = await login(TEST_USER_B);
  const appId = "test-app-rls";

  await rest("core", "app", {
    token: tokenA,
    method: "POST",
    body: { id: appId, name: "RLS test app", schema_name: "test" },
  }).catch(() => {}); // ignore conflict if a prior run already created it

  const created = await rest("core", "run", {
    token: tokenA,
    method: "POST",
    body: { app_id: appId, kind: "job", ref: "rls-test" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const runId = created.json[0].id;

  const asA = await rest("core", `run?id=eq.${runId}&select=id`, { token: tokenA });
  assert.deepEqual(asA.json, [{ id: runId }], "user A must see her own run");

  const asB = await rest("core", `run?id=eq.${runId}&select=id`, { token: tokenB });
  assert.deepEqual(asB.json, [], "user B must not see user A's run");
});
