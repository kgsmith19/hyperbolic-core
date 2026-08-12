import { test } from "node:test";
import assert from "node:assert/strict";
import { rest, primaryToken } from "./helpers.mjs";

async function newRun(token) {
  const res = await rest("core", "rpc/log_run", {
    token,
    method: "POST",
    body: { p_app_id: "prompt-organizer", p_kind: "test", p_wall_clock_ms: 1 },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

// T-A-007 -> AC-016 -> FR-008: purge_old_events deletes an event older than
// 90 days, keeps a recent one, and records the old one's month before
// deleting it. Fixed past date (safely >90 days before any run of this
// suite, and only more so as time passes), so the test is deterministic
// regardless of when it executes.
test("purge_deletes_old_keeps_recent_and_records_month__T_A_007__AC_016", async () => {
  const token = primaryToken();
  const runId = await newRun(token);
  const monthKey = "2026-03-01";
  const recentAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

  const oldEvent = await rest("core", "event", {
    token,
    method: "POST",
    body: { run_id: runId, at: "2026-03-15T12:00:00.000Z", kind: "test", name: "old" },
  });
  assert.equal(oldEvent.status, 201, JSON.stringify(oldEvent.json));
  const oldId = oldEvent.json[0].id;

  const recentEvent = await rest("core", "event", {
    token,
    method: "POST",
    body: { run_id: runId, at: recentAt, kind: "test", name: "recent" },
  });
  assert.equal(recentEvent.status, 201, JSON.stringify(recentEvent.json));
  const recentId = recentEvent.json[0].id;

  const before = await rest("core", `event_monthly_agg?month=eq.${monthKey}&select=event_count`, { token });
  const countBefore = before.json[0]?.event_count ?? 0;

  const purge = await rest("core", "rpc/purge_old_events", { token, method: "POST", body: {} });
  assert.equal(purge.status, 200, JSON.stringify(purge.json));

  const oldGone = await rest("core", `event?id=eq.${oldId}`, { token });
  assert.deepEqual(oldGone.json, []);

  const recentStill = await rest("core", `event?id=eq.${recentId}&select=id`, { token });
  assert.equal(recentStill.json.length, 1);

  const after = await rest("core", `event_monthly_agg?month=eq.${monthKey}&select=event_count`, { token });
  assert.equal(after.json.length, 1);
  assert.ok(after.json[0].event_count >= countBefore + 1, JSON.stringify(after.json));
});

// T-I-010 -> AC-017 -> FR-008: two separate purge calls for the same
// calendar month add to the existing total rather than replacing it.
test("purge_accumulates_monthly_total_across_calls__T_I_010__AC_017", async () => {
  const token = primaryToken();
  const runId = await newRun(token);
  const monthKey = "2026-04-01";

  const baseline = await rest("core", `event_monthly_agg?month=eq.${monthKey}&select=event_count`, { token });
  const countBaseline = baseline.json[0]?.event_count ?? 0;

  await rest("core", "event", {
    token,
    method: "POST",
    body: { run_id: runId, at: "2026-04-10T12:00:00.000Z", kind: "test", name: "first" },
  });
  const firstPurge = await rest("core", "rpc/purge_old_events", { token, method: "POST", body: {} });
  assert.equal(firstPurge.status, 200, JSON.stringify(firstPurge.json));
  const afterFirst = await rest("core", `event_monthly_agg?month=eq.${monthKey}&select=event_count`, { token });
  assert.equal(afterFirst.json[0].event_count, countBaseline + 1, JSON.stringify(afterFirst.json));

  await rest("core", "event", {
    token,
    method: "POST",
    body: { run_id: runId, at: "2026-04-25T12:00:00.000Z", kind: "test", name: "second" },
  });
  const secondPurge = await rest("core", "rpc/purge_old_events", { token, method: "POST", body: {} });
  assert.equal(secondPurge.status, 200, JSON.stringify(secondPurge.json));
  const afterSecond = await rest("core", `event_monthly_agg?month=eq.${monthKey}&select=event_count`, { token });
  assert.equal(afterSecond.json[0].event_count, countBaseline + 2, JSON.stringify(afterSecond.json));
});
