import { test } from "node:test";
import assert from "node:assert/strict";
import { rest, primaryToken } from "./helpers.mjs";

// SPEC-0002 (SL-004): versions on every body change, unique titles.
// All four tests are single-identity; isolation already owned by T-I-003.
//
// Owner-credential threading (toolbelt-ci.yml P1 finding): every test below
// authenticates via primaryToken() (owner token when supplied, fixture-A
// fallback otherwise), since they need real write access to prove anything
// once prompt.* RLS is pinned to the owner.

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
  const token = await primaryToken();
  const seeded = await ensureByTitle(token, "Version Fixture", "canonical casing row");
  assert.ok([200, 201].includes(seeded.status), JSON.stringify(seeded.json));

  const dup = await rest("prompt", {
    token, method: "POST", body: { title: "version fixture", body: "case-folded duplicate" },
  });

  // SPEC-0002 AC-001 corrected 2026-08-07: `details` is null for a
  // non-superuser role (a Postgres/PostgREST security behavior, confirmed
  // live), so `code` plus the constraint name in `message` are what's
  // actually available -- not the conflicting value itself.
  assert.equal(dup.status, 409, JSON.stringify(dup.json));
  assert.equal(dup.json.code, "23505");
  assert.match(String(dup.json.message), /prompt_title_unique/, "message must name the violated constraint");
  const ghost = await rest(`prompt?title=eq.${encodeURIComponent("version fixture")}&select=id`, { token });
  assert.deepEqual(ghost.json, [], "the rejected duplicate must not create a row");
});

// T-I-005 -> AC-002, PROP-004 -> FR-003
test("insert_records_exactly_one_version__T_I_005__AC_002", async () => {
  const token = await primaryToken();
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
  const token = await primaryToken();
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

// T-I-007 -> PROP-003 -> FR-003. Integration-drill finding, added by the
// integrator: a no-op body update (PATCH setting body to its current value)
// still fires the column-list trigger `after update of body`, since Postgres
// fires on the column being in the SET list, not on the value changing. The
// function's distinct-body guard exists for exactly this; no other test in
// this file exercises a same-value update, so a removed guard survived the
// full suite green (mutation-verified below).
test("no_op_body_update_creates_no_spurious_version__T_I_007__PROP_003", async () => {
  const token = await primaryToken();
  const created = await rest("prompt", {
    token, method: "POST", body: { title: `No-Op Update Fixture ${Date.now()}`, body: "steady body" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const patched = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: "steady body" } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));

  const versions = await rest(`prompt_version?prompt_id=eq.${id}&select=version_no`, { token });
  assert.equal(versions.status, 200, JSON.stringify(versions.json));
  assert.deepEqual(versions.json, [{ version_no: 1 }], "a same-value update must not append version 2");
});

// T-I-006 -> AC-004, PROP-002 -> NFR-005
test("version_rows_reject_update_and_delete_with_42501__T_I_006__AC_004", async () => {
  const token = await primaryToken();
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
