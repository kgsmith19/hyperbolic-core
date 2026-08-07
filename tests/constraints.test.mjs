import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, TEST_USER_A } from "./helpers.mjs";

// T-I-003 -> AC-003 -> FR-002: core.run.app_id must reference a real core.app row.
test("rejects_core_run_with_unregistered_app_id__T_I_003__AC_003", async () => {
  const token = await login(TEST_USER_A);
  const { status, json } = await rest("core", "run", {
    token,
    method: "POST",
    body: { app_id: "test-app-does-not-exist", kind: "job" },
  });
  assert.equal(status, 409);
  assert.equal(json.code, "23503");
});

// T-I-004 -> AC-004 -> FR-003: core.metric_def.gaming_risk is NOT NULL by
// design (topology note: "a metric that has not had its gaming risk
// written down does not get to exist").
test("rejects_metric_def_with_no_gaming_risk__T_I_004__AC_004", async () => {
  const token = await login(TEST_USER_A);
  const { status, json } = await rest("core", "metric_def", {
    token,
    method: "POST",
    body: {
      // AC-004 names this literal id. No wall-clock suffix is needed for
      // uniqueness (GATE-TEST-JUSTIFIED J8): the insert always fails the
      // gaming_risk NOT NULL check, so no row is ever created to collide with.
      id: "cost_per_requirement",
      name: "Cost per requirement",
      formula: "total cost / total requirements shipped",
      unit: "USD",
    },
  });
  assert.equal(status, 400);
  assert.equal(json.code, "23502");
});
