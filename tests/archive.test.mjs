import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, USER_A, USER_B } from "./helpers.mjs";

// SPEC-0010 (SL-011): archive a prompt via is_active, the delete half of CRUD.

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
