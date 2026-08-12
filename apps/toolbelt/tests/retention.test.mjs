import { test } from "node:test";
import assert from "node:assert/strict";
import { rest, primaryToken } from "./helpers.mjs";

// T-A-007/T-I-010 -> AC-016/AC-017 -> FR-008, superseded 2026-08-12 (m1-08):
// these two tests used to call rpc/purge_old_events directly and assert on
// its effects (old row gone, recent row kept, monthly total accumulated).
// docs/planning/issues/m1-08-feat-db-rls-owner-repin.md revokes
// "authenticated"'s EXECUTE on core.purge_old_events entirely (cron-only
// from 20260812160000_core_idea_owner_pin.sql onward) -- and PostgREST
// grants are role-based, not user-based, so this makes the RPC unreachable
// for the owner too, not just fixtures. There is no REST-observable way
// left to trigger the function at all, so its purge correctness (the actual
// behavior these tests protected) is no longer testable through this
// anon-key-only harness; it moves to a manual/CI-operator verification
// (direct psql invocation, or observing the pg_cron job's own log), same
// posture as the InitPlan check in owner-repin.test.mjs. What stays
// testable and worth asserting here is that the API surface is really gone,
// not just narrowed -- kept as one case rather than duplicating
// owner-repin.test.mjs's equivalent fixture-token assertion.
test("purge_old_events_rpc_is_unreachable_via_the_api__T_A_007__T_I_010", async () => {
  const token = await primaryToken();
  const { status } = await rest("core", "rpc/purge_old_events", { token, method: "POST", body: {} });
  assert.notEqual(status, 200, `expected the RPC to be unreachable for API roles (owner included), got ${status}`);
});
