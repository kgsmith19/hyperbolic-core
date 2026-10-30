import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConfigValues } from "../panel.mjs";

// SPEC-0011 (SL-005): named configurations.

// T-U-028 -> AC-001 -> FR-008
test("applies_only_values_for_names_still_present__T_U_028__AC_001", () => {
  const result = applyConfigValues({ REPO: "toolbelt", GONE: "stale" }, ["REPO", "NAME"]);

  assert.deepEqual(result, { REPO: "toolbelt" }, "NAME absent (not in the config), GONE dropped (not a current name)");
});
