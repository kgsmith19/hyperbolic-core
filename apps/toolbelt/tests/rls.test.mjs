import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, primaryToken, TEST_USER_A, TEST_USER_B } from "./helpers.mjs";

// T-I-001 -> AC-002 -> NFR-001: an anon caller (no user session, just the
// public anon key) reading idea.idea gets zero rows, not an error and not
// someone else's data. RLS on idea.idea is "authenticated" role only. This
// assertion is unaffected by the m1-08 owner re-pin: anon was never a
// candidate for access before or after it.
test("rejects_anon_read_of_idea_idea__T_I_001__AC_002", async () => {
  const { status, json } = await rest("idea", "idea?select=id&limit=5");
  assert.equal(status, 200);
  assert.deepEqual(json, []);
});

// T-A-001 -> AC-001 -> FR-001: the exact data contract the idea list page
// reads (name, category, one_liner, status for a known seeded row) is
// retrievable by the authenticated principal. This proves the data half of
// the page's contract; the browser rendering itself has no automated test
// here (no headless-browser dependency was added, per MAX_NEW_LIBRARIES: 0 -
// verified by hand instead, see SPEC-0000 section 12 evidence).
//
// 2026-08-07: this test previously asserted status 'idea', matching the seed
// rather than AC-001, which names 'specced'. The seed was the defect; migration
// 20260807010000_idea_fix_prompt_organizer_status.sql corrected it. Later the
// same day, migration 20260807030000 legitimately moved the row from 'specced'
// to 'building' when implementation started. This assertion follows that
// shipped status transition.
//
// 2026-08-12: switched from a fixture login to primaryToken() (m1-08). Once
// the owner re-pin (20260812160000_core_idea_owner_pin.sql) lands, idea.idea
// is owner_rw, not authenticated_all -- a fixture token would see zero rows
// here, same as the anon case above. See owner-repin.test.mjs for the
// fixture-negative-path assertions this split off from this test's old
// premise.
test("authenticated_read_returns_seeded_prompt_organizer_row__T_A_001__AC_001", async () => {
  const token = await primaryToken();
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
      status: "building",
    },
  ]);
});

// T-I-002 -> AC-006 -> NFR-001, superseded 2026-08-12 (m1-08): this used to
// prove fixture-user-B could not read fixture-user-A's core.run row (plain
// per-row auth.uid() isolation). The owner re-pin makes a strictly stronger
// claim true instead -- no fixture user can write or read core.run at all,
// regardless of who created what -- so the old two-fixture isolation premise
// no longer applies (neither fixture can create the row this test used to
// set up). The full fixture-negative-path sweep across core/idea/prompt
// lives in owner-repin.test.mjs; this case narrows to the specific
// regression the original test protected against, restated for the new
// policy: a fixture token can never see a core.run row it did not create
// and never could have created.
test("fixture_tokens_cannot_write_or_read_core_run__T_I_002__AC_006", async () => {
  const tokenA = await login(TEST_USER_A);
  const tokenB = await login(TEST_USER_B);

  const createdAsA = await rest("core", "run", {
    token: tokenA,
    method: "POST",
    body: { app_id: "prompt-organizer", kind: "job", ref: "rls-test" },
  });
  assert.notEqual(createdAsA.status, 201, "fixture A must not be able to create a core.run row");

  const anyRowAsA = await rest("core", "run?select=id&limit=1", { token: tokenA });
  assert.deepEqual(anyRowAsA.json, [], "fixture A must see zero core.run rows");

  const anyRowAsB = await rest("core", "run?select=id&limit=1", { token: tokenB });
  assert.deepEqual(anyRowAsB.json, [], "fixture B must see zero core.run rows");
});
