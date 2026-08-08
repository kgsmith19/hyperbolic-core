import { test } from "node:test";
import assert from "node:assert/strict";
import { isCurrentVersion } from "../web/restore.mjs";
import { login, rest, USER_A, USER_B } from "./helpers.mjs";

// SPEC-0005 (SL-008): restore a prior version as the new current version.
// T-I-015 is the only two-identity test in this file; isolation's general
// case is already SL-000's T-I-003.

// T-I-012 -> AC-001 -> FR-009. Fresh fixture (Date.now()-suffixed title, per
// tests/versions.test.mjs's T-A-003/T-I-005 pattern): insert plus two PATCHes
// with distinct bodies gives 3 real trigger-written version rows to list.
test("lists_three_versions_newest_first_with_distinct_timestamps__T_I_012__AC_001", async () => {
  const token = await login(USER_A);
  const title = `Restore History Fixture ${Date.now()}`;
  const created = await rest("prompt", { token, method: "POST", body: { title, body: "body one" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const patch1 = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: "body two" } });
  assert.equal(patch1.status, 200, JSON.stringify(patch1.json));
  const patch2 = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: "body three" } });
  assert.equal(patch2.status, 200, JSON.stringify(patch2.json));

  const versions = await rest(
    `prompt_version?prompt_id=eq.${id}&select=version_no,body,created_at&order=version_no.desc`,
    { token },
  );
  assert.equal(versions.status, 200, JSON.stringify(versions.json));
  assert.equal(versions.json.length, 3, "all three versions must be listed");
  assert.deepEqual(
    versions.json.map((v) => v.version_no),
    [3, 2, 1],
    "newest first",
  );
  assert.deepEqual(
    versions.json.map((v) => v.body),
    ["body three", "body two", "body one"],
    "each version holds its own body",
  );
  const timestamps = new Set(versions.json.map((v) => v.created_at));
  assert.equal(timestamps.size, 3, "each version must have a distinct creation timestamp");
});

// T-A-004 -> AC-002, PROP-002, PROP-003 -> FR-009. A prompt at version 3;
// restoring version 1 must append version 4 holding version 1's body,
// version 1 itself must stay byte-identical, and max(version_no) becomes 4.
test("restoring_an_old_version_appends_a_new_version_holding_its_body__T_A_004__AC_002", async () => {
  const token = await login(USER_A);
  const title = `Restore Apply Fixture ${Date.now()}`;
  const created = await rest("prompt", { token, method: "POST", body: { title, body: "original body" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const patch1 = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: "second body" } });
  assert.equal(patch1.status, 200, JSON.stringify(patch1.json));
  const patch2 = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: "third body" } });
  assert.equal(patch2.status, 200, JSON.stringify(patch2.json));

  const v1Before = await rest(`prompt_version?prompt_id=eq.${id}&version_no=eq.1&select=body`, { token });
  assert.equal(v1Before.status, 200, JSON.stringify(v1Before.json));
  assert.deepEqual(v1Before.json, [{ body: "original body" }]);

  // The restore itself: PATCH the prompt's body to version 1's stored body.
  const restored = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: "original body" } });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json[0].body, "original body", "the prompt's current body must equal the restored source");

  const versions = await rest(
    `prompt_version?prompt_id=eq.${id}&select=version_no,body&order=version_no.desc`,
    { token },
  );
  assert.equal(versions.status, 200, JSON.stringify(versions.json));
  assert.deepEqual(
    versions.json[0],
    { version_no: 4, body: "original body" },
    "version 4 is created holding version 1's body",
  );
  assert.equal(versions.json.length, 4, "max(version_no) is now 4");

  const v1After = await rest(`prompt_version?prompt_id=eq.${id}&version_no=eq.1&select=body`, { token });
  assert.deepEqual(v1After.json, v1Before.json, "version 1 itself is byte-identical to before the restore");
});

// T-I-013 -> AC-003, PROP-004 -> FR-009. AC-003's Given ("version 2's body
// already equals version 1's body, a prior restore") cannot literally arise
// between two *adjacent* version numbers: SL-004's distinct-body guard
// (T-I-007) only ever writes a new version when the incoming body differs
// from the row's current value, so a version can never repeat the body of
// the version immediately before it. The Given is realized instead the way
// its own parenthetical says it must -- "a prior restore": insert bodyA (v1),
// patch to bodyB (v2, a real edit), patch back to bodyA (v3 -- this *is* a
// restore of v1, making the current body equal an old version's body again).
// "Version 1 is restored again" is then a same-value PATCH against the
// current row (already bodyA), which SL-004's guard makes a no-op: no new
// version, and the version count does not increase.
test("restoring_a_version_matching_the_current_body_creates_no_new_version__T_I_013__AC_003", async () => {
  const token = await login(USER_A);
  const title = `Restore Boundary Fixture ${Date.now()}`;
  const bodyA = "restore boundary body A";
  const bodyB = "restore boundary body B";
  const created = await rest("prompt", { token, method: "POST", body: { title, body: bodyA } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const editToB = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: bodyB } });
  assert.equal(editToB.status, 200, JSON.stringify(editToB.json));
  const priorRestoreToA = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: bodyA } });
  assert.equal(priorRestoreToA.status, 200, JSON.stringify(priorRestoreToA.json));

  const before = await rest(`prompt_version?prompt_id=eq.${id}&select=version_no`, { token });
  assert.equal(before.status, 200, JSON.stringify(before.json));
  assert.equal(before.json.length, 3, "given: insert + one real edit + one prior restore = 3 versions, current body already equals an old version's body (bodyA)");

  // When: version 1 (bodyA) is restored again -- current body is already bodyA.
  const restoreAgain = await rest(`prompt?id=eq.${id}`, { token, method: "PATCH", body: { body: bodyA } });
  assert.equal(restoreAgain.status, 200, JSON.stringify(restoreAgain.json));

  const after = await rest(`prompt_version?prompt_id=eq.${id}&select=version_no`, { token });
  assert.equal(after.status, 200, JSON.stringify(after.json));
  assert.equal(after.json.length, before.json.length, "the version count must not increase");
});

// T-U-015 -> AC-004 -> FR-009. Pure decision the version-history panel uses
// to withhold a restore control for the already-current version.
test("isCurrentVersion_true_only_when_bodies_match__T_U_015__AC_004", () => {
  assert.equal(isCurrentVersion("same body", "same body"), true, "matching bodies are the current version");
  assert.equal(isCurrentVersion("old body", "new body"), false, "differing bodies are not the current version");
  assert.equal(isCurrentVersion("", ""), true, "empty bodies still compare equal");
});

// T-I-015 -> AC-005, NFR-003 -> FR-009. The failure case: user B (a
// different authenticated identity) attempts to restore user A's prompt.
// RLS's owner_all policy scopes the UPDATE's row visibility, so a PATCH
// whose WHERE clause matches zero rows under B's session returns 200 with
// an empty representation array (Prefer: return=representation), not an
// error -- the same shape any UPDATE matching zero rows produces. No new
// version is written and user A's version count stays unchanged.
test("cross_user_restore_affects_zero_rows_under_rls__T_I_015__AC_005", async () => {
  const tokenA = await login(USER_A);
  const tokenB = await login(USER_B);
  const title = `Restore RLS Fixture ${Date.now()}`;
  const created = await rest("prompt", { token: tokenA, method: "POST", body: { title, body: "owner body v1" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;
  const editToV2 = await rest(`prompt?id=eq.${id}`, { token: tokenA, method: "PATCH", body: { body: "owner body v2" } });
  assert.equal(editToV2.status, 200, JSON.stringify(editToV2.json));

  const before = await rest(`prompt_version?prompt_id=eq.${id}&select=version_no`, { token: tokenA });
  assert.equal(before.status, 200, JSON.stringify(before.json));
  assert.equal(before.json.length, 2, "given: user A's prompt is at version 2");

  // When: user B attempts to restore version 1's body onto user A's prompt.
  const attempt = await rest(`prompt?id=eq.${id}`, { token: tokenB, method: "PATCH", body: { body: "owner body v1" } });
  assert.equal(attempt.status, 200, JSON.stringify(attempt.json), "RLS makes a blocked PATCH a zero-row match, not an error");
  assert.deepEqual(attempt.json, [], "the request affects 0 rows -- user B's session sees none of user A's rows to update");

  const after = await rest(`prompt_version?prompt_id=eq.${id}&select=version_no`, { token: tokenA });
  assert.equal(after.status, 200, JSON.stringify(after.json));
  assert.equal(after.json.length, 2, "max(version_no) for user A's prompt stays 2 -- no new version");
});
