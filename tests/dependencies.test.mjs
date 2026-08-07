import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, TEST_USER_A } from "./helpers.mjs";

// T-A-005 -> AC-012 -> FR-006: constraint-finder's real seeded dependency on
// optimize-metrics is readable with its reason intact. Real data, not a
// throwaway fixture (PRD DR-005): sourced from
// docs/notes/2026-08-06-supabase-project-topology.md section 3, which
// states this exact edge as a literal, named pair.
test("seeded_dependency_returns_idea_and_reason__T_A_005__AC_012", async () => {
  const token = await login(TEST_USER_A);
  const dep = await rest("idea", "dependency?idea_id=eq.constraint-finder&select=depends_on,reason", { token });
  assert.deepEqual(dep.json, [
    {
      depends_on: "optimize-metrics",
      reason:
        "Constraint Finder reads metric data to find bottlenecks; Optimize Metrics owns the metric definitions that data is measured against.",
    },
  ]);
});
