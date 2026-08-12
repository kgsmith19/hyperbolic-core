import { test } from "node:test";
import assert from "node:assert/strict";
import { rest, primaryToken } from "./helpers.mjs";

// T-A-006 -> AC-014 -> FR-007: log_run creates one core.run row and one
// core.cost row, linked, with the caller's supplied wall_clock_ms.
test("log_run_creates_linked_run_and_cost_rows__T_A_006__AC_014", async () => {
  const token = primaryToken();
  const called = await rest("core", "rpc/log_run", {
    token,
    method: "POST",
    body: { p_app_id: "prompt-organizer", p_kind: "render", p_wall_clock_ms: 42 },
  });
  assert.equal(called.status, 200, JSON.stringify(called.json));
  const runId = called.json;
  assert.equal(typeof runId, "string");

  const run = await rest("core", `run?id=eq.${runId}&select=app_id,kind,status,ended_at`, { token });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.equal(run.json.length, 1);
  assert.equal(run.json[0].app_id, "prompt-organizer");
  assert.equal(run.json[0].kind, "render");
  assert.equal(run.json[0].status, "ok");
  assert.notEqual(run.json[0].ended_at, null);

  const cost = await rest("core", `cost?run_id=eq.${runId}&select=wall_clock_ms`, { token });
  assert.equal(cost.status, 200, JSON.stringify(cost.json));
  assert.deepEqual(cost.json, [{ wall_clock_ms: 42 }]);
});

// T-I-009 -> AC-015 -> FR-007: an unregistered app_id is rejected by the
// same FK the RPC's insert relies on, not swallowed or masked.
test("log_run_rejects_unregistered_app_id__T_I_009__AC_015", async () => {
  const token = primaryToken();
  const { status, json } = await rest("core", "rpc/log_run", {
    token,
    method: "POST",
    body: { p_app_id: "nonexistent-tool", p_kind: "render", p_wall_clock_ms: 1 },
  });
  assert.equal(status, 409, JSON.stringify(json));
  assert.equal(json.code, "23503");
});
