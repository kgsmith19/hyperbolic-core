import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, primaryToken, USER_B } from "./helpers.mjs";

// Owner-credential threading (toolbelt-ci.yml P1 finding): T-A-001 and
// T-I-001 authenticate via primaryToken() (owner token when supplied,
// fixture-A fallback otherwise) -- T-I-001 in particular must reach the
// title/body CHECK constraint (23514) rather than being turned away earlier
// by the owner-pinned RLS WITH CHECK, which only a real owner clears. T-I-003
// is about a *non-owner* being denied, so its intruding session (tokenB)
// stays login(USER_B); only its resource-owning setup session (tokenA) needs
// real write access. T-I-002 is unauthenticated (anon key only) and is
// unaffected by owner-pinning either way.

// The 500-character fixture (SPEC-0000 section 8): exercises a variable
// token, an optional-section fence, a newline, and a non-ASCII character,
// because CON-004 makes verbatim storage of exactly this syntax the contract.
const BODY_500 =
  "# Spec Author\n" +
  "Repo is {{REPO}}. é " +
  "<!--OPTIONAL:lean-->keep it lean<!--/OPTIONAL:lean-->" +
  "x".repeat(413);

// T-A-001 -> AC-001, PROP-002 -> FR-001
test("saves_and_reads_back_500_char_body_verbatim__T_A_001__AC_001", async () => {
  assert.equal(BODY_500.length, 500, "fixture must be exactly 500 characters");
  const token = await primaryToken();

  // SPEC-0002 7.3 amendment: under the unique title index a re-run's POST
  // collides; on 409, PATCH the body by title instead. Same read-back
  // contract; re-runs now also exercise the FR-003 update path.
  let created = await rest("prompt", {
    token,
    method: "POST",
    body: { title: "Spec Author", body: BODY_500 },
  });
  if (created.status === 409) {
    created = await rest(`prompt?title=eq.${encodeURIComponent("Spec Author")}`, {
      token,
      method: "PATCH",
      body: { body: BODY_500 },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
  } else {
    assert.equal(created.status, 201, JSON.stringify(created.json));
  }
  const id = created.json[0].id;

  const readBack = await rest(`prompt?id=eq.${id}&select=title,body`, { token });
  assert.equal(readBack.status, 200);
  assert.equal(readBack.json[0].title, "Spec Author");
  assert.equal(readBack.json[0].body, BODY_500, "body must round-trip character for character");
});

// T-I-001 -> AC-002, AC-003, PROP-003 -> FR-001. One failure mode: an
// out-of-bounds prompt is stored. Three boundary probes of the same CHECK
// mechanism, consolidated under the Phase 0 test cap (ledger row T-I-001).
test("rejects_title_and_body_outside_fr001_bounds__T_I_001__AC_002_AC_003", async () => {
  const token = await primaryToken();

  const emptyTitle = await rest("prompt", {
    token, method: "POST", body: { title: "", body: "b" },
  });
  assert.equal(emptyTitle.status, 400, JSON.stringify(emptyTitle.json));
  assert.equal(emptyTitle.json.code, "23514");

  const longTitle = await rest("prompt", {
    token, method: "POST", body: { title: "x".repeat(201), body: "b" },
  });
  assert.equal(longTitle.status, 400);
  assert.equal(longTitle.json.code, "23514");

  const longBody = await rest("prompt", {
    token, method: "POST", body: { title: "too long body", body: "x".repeat(100001) },
  });
  assert.equal(longBody.status, 400);
  assert.equal(longBody.json.code, "23514");
});

// T-I-002 -> AC-004 -> NFR-003: anon key alone reads zero rows, not an error
// and not data. DR-002 is confidential.
test("anon_read_returns_empty_array__T_I_002__AC_004", async () => {
  const { status, json } = await rest("prompt?select=id&limit=5");
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual(json, []);
});

// T-I-003 -> AC-005 -> NFR-003: owner-scoped RLS. A sees her own row
// (positive control, prevents a vacuous pass); B sees nothing.
test("user_b_cannot_read_user_a_prompt__T_I_003__AC_005", async () => {
  const tokenA = await primaryToken();
  const tokenB = await login(USER_B);

  // SPEC-0002 7.3 amendment: POST; on 409, PATCH the body by title instead.
  // Isolation assertions below are unchanged.
  let created = await rest("prompt", {
    token: tokenA,
    method: "POST",
    body: { title: "rls probe", body: "owner isolation probe" },
  });
  if (created.status === 409) {
    created = await rest(`prompt?title=eq.${encodeURIComponent("rls probe")}`, {
      token: tokenA,
      method: "PATCH",
      body: { body: "owner isolation probe" },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
  } else {
    assert.equal(created.status, 201, JSON.stringify(created.json));
  }
  const id = created.json[0].id;

  const asA = await rest(`prompt?id=eq.${id}&select=id`, { token: tokenA });
  assert.deepEqual(asA.json, [{ id }], "user A must see her own prompt");

  const asB = await rest(`prompt?id=eq.${id}&select=id`, { token: tokenB });
  assert.deepEqual(asB.json, [], "user B must not see user A's prompt");
});
