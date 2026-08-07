import { test } from "node:test";
import assert from "node:assert/strict";

// SPEC-0002 (SL-004): versions on every body change, unique titles.
// Not secret: the anon key is designed for client-side exposure; RLS is the
// boundary (docs/SYSTEM-REQUIREMENTS.md SR-05). Same project as toolbelt.
const SUPABASE_URL = "https://woltgcggxaehtuypkxqk.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";

// Project-level fixture user (toolbelt SPEC-0000 ASM-003). Not a real person.
// All four tests are single-identity; isolation already owned by T-I-003.
const USER_A = { email: "kylegsmith19+toolbelt-test-a@gmail.com", password: "Test-Passw0rd-A1!" };

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

// Re-runnable fixture (spec 7.3 pattern): POST; on 409, PATCH by title.
// `patch` must differ from the stored body when a fresh version row is needed.
async function ensureByTitle(token, title, body) {
  const posted = await rest("prompt", { token, method: "POST", body: { title, body } });
  if (posted.status !== 409) return posted;
  return rest(`prompt?title=eq.${encodeURIComponent(title)}`, {
    token, method: "PATCH", body: { body },
  });
}

// T-I-004 -> AC-001, PROP-001 -> FR-002
test("rejects_case_folded_duplicate_title_with_23505__T_I_004__AC_001", async () => {
  const token = await login(USER_A);
  const seeded = await ensureByTitle(token, "Version Fixture", "canonical casing row");
  assert.ok([200, 201].includes(seeded.status), JSON.stringify(seeded.json));

  const dup = await rest("prompt", {
    token, method: "POST", body: { title: "version fixture", body: "case-folded duplicate" },
  });

  assert.equal(dup.status, 409, JSON.stringify(dup.json));
  assert.equal(dup.json.code, "23505");
  assert.match(String(dup.json.details), /version fixture/, "detail must name the conflicting value");
  const ghost = await rest(`prompt?title=eq.${encodeURIComponent("version fixture")}&select=id`, { token });
  assert.deepEqual(ghost.json, [], "the rejected duplicate must not create a row");
});

// T-I-005 -> AC-002, PROP-004 -> FR-003
test("insert_records_exactly_one_version__T_I_005__AC_002", async () => {
  const token = await login(USER_A);
  const body = "fresh insert body";
  const created = await rest("prompt", {
    token, method: "POST", body: { title: `Fresh Version Fixture ${Date.now()}`, body },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const versions = await rest(`prompt_version?prompt_id=eq.${id}&select=version_no,body`, { token });
  assert.equal(versions.status, 200, JSON.stringify(versions.json));
  assert.deepEqual(versions.json, [{ version_no: 1, body }], "exactly one version: no 1, body verbatim");
});

// T-A-003 -> AC-003, PROP-002, PROP-003 -> FR-003
test("edit_appends_version_2_and_preserves_version_1__T_A_003__AC_003", async () => {
  const token = await login(USER_A);
  const created = await rest("prompt", {
    token, method: "POST", body: { title: `Version Trail Fixture ${Date.now()}`, body: "original body" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const patched = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: "edited body" } });

  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const versions = await rest(`prompt_version?prompt_id=eq.${id}&select=version_no,body&order=version_no.asc`, { token });
  assert.equal(versions.status, 200, JSON.stringify(versions.json));
  assert.deepEqual(
    versions.json,
    [{ version_no: 1, body: "original body" }, { version_no: 2, body: "edited body" }],
    "version 1 unchanged, version 2 is the edit, max(version_no) = 2",
  );
});

// T-I-006 -> AC-004, PROP-002 -> NFR-005
test("version_rows_reject_update_and_delete_with_42501__T_I_006__AC_004", async () => {
  const token = await login(USER_A);
  // A distinct body every run guarantees the trigger writes a version row even
  // when the fixture prompt predates the trigger (red-phase runs insert it).
  const seeded = await ensureByTitle(token, "Immutable Fixture", `immutable probe ${Date.now()}`);
  assert.ok([200, 201].includes(seeded.status), JSON.stringify(seeded.json));
  const promptId = seeded.json[0].id;

  const before = await rest(
    `prompt_version?prompt_id=eq.${promptId}&select=version_no,body&order=version_no.desc&limit=1`,
    { token },
  );
  assert.equal(before.status, 200, JSON.stringify(before.json));
  assert.equal(before.json.length, 1, "fixture must have a version row to probe");
  const target = before.json[0];
  const rowPath = `prompt_version?prompt_id=eq.${promptId}&version_no=eq.${target.version_no}`;

  const patchProbe = await rest(rowPath, { token, method: "PATCH", body: { body: "tampered" } });
  assert.equal(patchProbe.status, 403, JSON.stringify(patchProbe.json));
  assert.equal(patchProbe.json.code, "42501", "update must be rejected by grant absence");

  const deleteProbe = await rest(rowPath, { token, method: "DELETE" });
  assert.equal(deleteProbe.status, 403, JSON.stringify(deleteProbe.json));
  assert.equal(deleteProbe.json.code, "42501", "delete must be rejected by grant absence");

  const after = await rest(`${rowPath}&select=version_no,body`, { token });
  assert.deepEqual(after.json, [target], "the probed row must be byte-for-byte unchanged");
});
