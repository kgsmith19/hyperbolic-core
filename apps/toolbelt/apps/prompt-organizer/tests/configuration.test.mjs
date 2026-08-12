import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, USER_A, USER_B } from "./helpers.mjs";

// SPEC-0011 (SL-005): named configurations.

// T-I-019 -> AC-002 -> FR-008
test("configuration_values_and_sections_round_trip_exactly__T_I_019__AC_002", async () => {
  const token = await login(USER_A);
  const title = `Configuration Fixture ${Date.now()}`;
  const prompt = await rest("prompt", { token, method: "POST", body: { title, body: "{{REPO}}" } });
  assert.equal(prompt.status, 201, JSON.stringify(prompt.json));
  const promptId = prompt.json[0].id;

  const values = { REPO: "toolbelt" };
  const sections = ["a"];
  const saved = await rest("configuration", {
    token, method: "POST", body: { prompt_id: promptId, name: "lean", values, sections },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));

  const readBack = await rest(`configuration?prompt_id=eq.${promptId}&name=eq.lean&select=values,sections`, { token });
  assert.deepEqual(readBack.json, [{ values, sections }], "values and sections must round-trip exactly");
});

// T-I-020 -> AC-003 -> FR-008, NFR-003
test("cross_user_cannot_read_another_users_configurations__T_I_020__AC_003", async () => {
  const tokenA = await login(USER_A);
  const tokenB = await login(USER_B);
  const title = `Configuration RLS Fixture ${Date.now()}`;
  const prompt = await rest("prompt", { token: tokenA, method: "POST", body: { title, body: "{{REPO}}" } });
  assert.equal(prompt.status, 201, JSON.stringify(prompt.json));
  const promptId = prompt.json[0].id;

  const saved = await rest("configuration", {
    token: tokenA, method: "POST", body: { prompt_id: promptId, name: "lean", values: {}, sections: [] },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));

  const asB = await rest(`configuration?prompt_id=eq.${promptId}&select=name`, { token: tokenB });
  assert.deepEqual(asB.json, [], "user B must not see user A's configurations");
});
