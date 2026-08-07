import { test } from "node:test";
import assert from "node:assert/strict";

// Not secret: the anon key is designed for client-side exposure; RLS is the
// boundary (docs/SYSTEM-REQUIREMENTS.md SR-05). Same project as toolbelt.
const SUPABASE_URL = "https://woltgcggxaehtuypkxqk.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";

// Project-level fixture users, created for toolbelt SPEC-0000 (its ASM-003);
// reuse recorded as this spec's ASM-002. Not real people.
const USER_A = { email: "kylegsmith19+toolbelt-test-a@gmail.com", password: "Test-Passw0rd-A1!" };
const USER_B = { email: "kylegsmith19+toolbelt-test-b@gmail.com", password: "Test-Passw0rd-B1!" };

async function login(user) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(user),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login failed for ${user.email}: ${res.status}`);
  return body.access_token;
}

async function rest(path, { token, method = "GET", body } = {}) {
  const headers = { apikey: ANON_KEY, "Accept-Profile": "prompt", "Content-Profile": "prompt" };
  headers.Authorization = `Bearer ${token || ANON_KEY}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers.Prefer = "return=representation";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

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
  const token = await login(USER_A);

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
  const token = await login(USER_A);

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
  const tokenA = await login(USER_A);
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
