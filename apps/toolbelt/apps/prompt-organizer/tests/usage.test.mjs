import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, USER_A } from "./helpers.mjs";

// SPEC-0008 (SL-007): usage tracking on copy.

// T-A-005 -> AC-001, PROP-011 -> FR-011. Fresh throwaway prompt (Date.now()
// suffix, matching tests/tags.test.mjs's fixture pattern), copied twice --
// two usage rows, distinct timestamps, both naming version 1 (the only
// version a fresh insert has).
test("copying_twice_writes_two_usage_rows_with_distinct_timestamps__T_A_005__AC_001", async () => {
  const token = await login(USER_A);
  const created = await rest("prompt", {
    token, method: "POST",
    body: { title: `Usage Fixture ${Date.now()}`, body: "usage fixture body" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const first = await rest("usage", { token, method: "POST", body: { prompt_id: id, version_no: 1 } });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const second = await rest("usage", { token, method: "POST", body: { prompt_id: id, version_no: 1 } });
  assert.equal(second.status, 201, JSON.stringify(second.json));

  const readBack = await rest(`usage?prompt_id=eq.${id}&select=version_no,created_at&order=created_at.asc`, { token });
  assert.equal(readBack.status, 200, JSON.stringify(readBack.json));
  assert.equal(readBack.json.length, 2, "exactly two usage rows");
  assert.equal(readBack.json[0].version_no, 1);
  assert.equal(readBack.json[1].version_no, 1);
  assert.notEqual(readBack.json[0].created_at, readBack.json[1].created_at, "distinct timestamps");
});

// T-I-016 -> AC-002, PROP-012 -> FR-011. A real prompt, but version_no 2 was
// never created for it (only version 1 exists) -- the composite FK must
// reject this, proving usage rows can never name a version that never
// happened.
test("rejects_usage_row_naming_a_version_that_was_never_created__T_I_016__AC_002", async () => {
  const token = await login(USER_A);
  const created = await rest("prompt", {
    token, method: "POST",
    body: { title: `Usage FK Fixture ${Date.now()}`, body: "usage fk fixture body" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json[0].id;

  const { status, json } = await rest("usage", { token, method: "POST", body: { prompt_id: id, version_no: 2 } });
  assert.equal(status, 409, JSON.stringify(json));
  assert.equal(json.code, "23503");
});
