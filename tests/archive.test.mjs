import { test } from "node:test";
import assert from "node:assert/strict";

// SPEC-0010 (SL-011): archive a prompt via is_active, the delete half of CRUD.
// Not secret: the anon key is designed for client-side exposure; RLS is the
// boundary (docs/SYSTEM-REQUIREMENTS.md SR-05). Same project as toolbelt.
const SUPABASE_URL = "https://woltgcggxaehtuypkxqk.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";

// Project-level fixture users (toolbelt SPEC-0000 ASM-003). Not real people.
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

// T-A-006 -> AC-001 -> FR-014
test("archives_then_reactivates_a_prompt_without_losing_data__T_A_006__AC_001", async () => {
  const token = await login(USER_A);
  const title = `Archive Fixture ${Date.now()}`;
  const created = await rest("prompt", { token, method: "POST", body: { title, body: "archive me" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;
  assert.equal(created.json[0].is_active, true, "a new prompt starts active");

  const archived = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { is_active: false } });
  assert.equal(archived.status, 200, JSON.stringify(archived.json));
  assert.equal(archived.json[0].is_active, false);

  const hidden = await rest(`prompt?id=eq.${id}&is_active=eq.true&select=id`, { token });
  assert.deepEqual(hidden.json, [], "archived prompt must not appear in the active-only view");

  const stillThere = await rest(`prompt?id=eq.${id}&select=id,body,is_active`, { token });
  assert.deepEqual(stillThere.json, [{ id, body: "archive me", is_active: false }], "the row itself is untouched");

  const versions = await rest(`prompt_version?prompt_id=eq.${id}&select=version_no`, { token });
  assert.deepEqual(versions.json, [{ version_no: 1 }], "archiving must not touch version history");

  const reactivated = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { is_active: true } });
  assert.equal(reactivated.status, 200, JSON.stringify(reactivated.json));

  const visibleAgain = await rest(`prompt?id=eq.${id}&is_active=eq.true&select=id`, { token });
  assert.deepEqual(visibleAgain.json, [{ id }], "reactivated prompt must reappear in the active-only view");
});

// T-I-017 -> AC-002 -> FR-014, FR-002
test("archived_prompt_title_still_blocks_a_duplicate_title__T_I_017__AC_002", async () => {
  const token = await login(USER_A);
  const title = `Archived Title Fixture ${Date.now()}`;
  const created = await rest("prompt", { token, method: "POST", body: { title, body: "will be archived" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const archived = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { is_active: false } });
  assert.equal(archived.status, 200, JSON.stringify(archived.json));

  const dup = await rest("prompt", { token, method: "POST", body: { title: title.toLowerCase(), body: "dup" } });
  assert.equal(dup.status, 409, JSON.stringify(dup.json));
  assert.equal(dup.json.code, "23505", "archiving a prompt must not free its title for reuse");
});

// T-I-018 -> AC-003 -> FR-014, NFR-003
test("cross_user_cannot_archive_another_users_prompt__T_I_018__AC_003", async () => {
  const tokenA = await login(USER_A);
  const tokenB = await login(USER_B);
  const title = `Cross User Archive Fixture ${Date.now()}`;
  const created = await rest("prompt", { token: tokenA, method: "POST", body: { title, body: "owned by A" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const attempt = await rest(`prompt?id=eq.${id}`, { token: tokenB, method: "PATCH", body: { is_active: false } });
  assert.equal(attempt.status, 200, JSON.stringify(attempt.json));
  assert.deepEqual(attempt.json, [], "RLS must silently filter a non-owner's update, affecting 0 rows");

  const asOwner = await rest(`prompt?id=eq.${id}&select=is_active`, { token: tokenA });
  assert.deepEqual(asOwner.json, [{ is_active: true }], "the prompt must remain active for its real owner");
});
