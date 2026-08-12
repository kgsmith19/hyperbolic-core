import { test } from "node:test";
import assert from "node:assert/strict";
import { rest, primaryToken } from "./helpers.mjs";

// T-A-004 -> AC-008 -> FR-004: an idea with a recorded score shows that
// score's value and its metric's name. idea.score is user-visible product
// data (the idea list page reads it), unlike core.run/core.app in T-I-002,
// so the throwaway row this test creates is deleted, not left behind.
test("scored_idea_returns_value_and_metric_name__T_A_004__AC_008", async () => {
  const token = primaryToken();
  const inserted = await rest("idea", "score", {
    token,
    method: "POST",
    body: { idea_id: "prompt-organizer", metric_id: "idea_effectiveness", value: 8, scored_by: "kyle" },
  });
  assert.equal(inserted.status, 201, JSON.stringify(inserted.json));
  const scoreId = inserted.json[0].id;

  try {
    const score = await rest("idea", "score?idea_id=eq.prompt-organizer&select=metric_id,value", { token });
    assert.deepEqual(score.json, [{ metric_id: "idea_effectiveness", value: 8 }]);

    const metric = await rest("core", "metric_def?id=eq.idea_effectiveness&select=name", { token });
    assert.deepEqual(metric.json, [{ name: "Idea effectiveness" }]);
  } finally {
    await rest("idea", `score?id=eq.${scoreId}`, { token, method: "DELETE" });
  }
});

// T-I-007 -> AC-010 -> FR-005: a score above its metric's max_value is
// rejected. A CHECK constraint cannot look up core.metric_def, so a trigger
// is the mechanism; this proves it is wired.
test("rejects_score_above_metric_max__T_I_007__AC_010", async () => {
  const token = primaryToken();
  const { status, json } = await rest("idea", "score", {
    token,
    method: "POST",
    body: { idea_id: "prompt-organizer", metric_id: "idea_effectiveness", value: 11, scored_by: "kyle" },
  });
  assert.equal(status, 400);
  assert.equal(json.code, "23514");
});

// T-I-008 -> AC-011 -> FR-005: the symmetric case, below min_value.
test("rejects_score_below_metric_min__T_I_008__AC_011", async () => {
  const token = primaryToken();
  const { status, json } = await rest("idea", "score", {
    token,
    method: "POST",
    body: { idea_id: "prompt-organizer", metric_id: "idea_effectiveness", value: -1, scored_by: "kyle" },
  });
  assert.equal(status, 400);
  assert.equal(json.code, "23514");
});
