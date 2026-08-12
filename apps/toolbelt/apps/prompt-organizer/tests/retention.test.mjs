import { test } from "node:test";
import assert from "node:assert/strict";
import { login, rest, USER_A } from "./helpers.mjs";

// m1-09-feat-db-indexes-retention: prompt.purge_old_usage(), like
// core.purge_old_events post-m1-08, carries no EXECUTE grant to
// "authenticated" at all (docs/planning/06-supabase-schema.md section 8:
// "cron-only, like core.purge_old_events post-re-pin"). PostgREST grants are
// role-based, so this is unreachable for every API caller, not just fixture
// tokens. Purge correctness itself (old usage rows aggregated into
// prompt.usage_monthly_agg and deleted, recent rows kept) is therefore not
// testable through this anon-key-only REST harness -- same posture as
// apps/toolbelt/tests/retention.test.mjs's equivalent core.purge_old_events
// case -- and is a manual/CI-operator verification (direct psql invocation,
// or observing the pg_cron 'prompt-purge-old-usage' job's own log) rather
// than something faked here.
test("purge_old_usage_rpc_is_unreachable_via_the_api", async () => {
  const token = await login(USER_A);
  const { status } = await rest("rpc/purge_old_usage", { token, method: "POST", body: {} });
  assert.notEqual(status, 200, `expected the RPC to be unreachable for API roles, got ${status}`);
});

// The two new indexes (Q1: prompt_created_at, Q3: usage_prompt) are
// structural, not behavior-changing: no query result differs with or
// without them. There is no REST-observable "index exists" assertion (that
// is psql's pg_indexes catalog, per the issue's own verification command);
// covered instead by proving the query shapes they exist for still return
// correct results, which is already exercised by
// apps/toolbelt/apps/prompt-organizer/tests/usage.test.mjs (Q3: usage
// inserts and reads) and the prompt list/search suites (Q1: created_at
// ordering). No new assertion needed here for that half of this migration.
