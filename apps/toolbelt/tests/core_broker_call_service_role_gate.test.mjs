// Real-Postgres proof for 20260817170000_core_broker_call.sql's own trust
// boundary claim: core.log_broker_call/core.broker_call_spend_today are
// service_role-ONLY (no owner-JWT fallback, unlike core.log_run --
// services/broker has no per-request owner JWT to fall back to at all, see
// that migration's own header comment), and the internal
// `auth.role() = 'service_role'` check inside each function body is real
// defense-in-depth, not merely decorative alongside the revoke/grant.
//
// Same harness/detection/skip mechanics as
// apps/toolbelt/tests/log_run_service_role_gate.test.mjs and
// apps/toolbelt/apps/idea-intake/backend/tests/mark_submitted_to_github_rpc.test.mjs
// (this file's closest precedent -- also a single-caller, no-owner-fallback
// service_role-only RPC gate): a bare local Postgres has none of Supabase's
// managed auth schema/roles, so HARNESS_SQL stubs auth.uid()/auth.role(),
// and the real, committed migration files are applied from disk verbatim.
import { test } from "node:test";
import { asRole, createPostgresHarness, supabaseHarnessSql } from "./postgres-harness.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

const PLATFORM_BOOTSTRAP_UP = join(MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");
const CORE_CREATE_SCHEMA_UP = join(MIGRATIONS_DIR, "20260806190000_core_create_schema.sql");
const IDEA_CREATE_SCHEMA_UP = join(MIGRATIONS_DIR, "20260806190100_idea_create_schema.sql");
const RLS_BASELINE_UP = join(MIGRATIONS_DIR, "20260806190200_rls_baseline.sql");
const BROKER_CALL_UP = join(MIGRATIONS_DIR, "20260817170000_core_broker_call.sql");

const { psql, psqlOk, withDatabase, skipReason: SKIP_REASON } = createPostgresHarness("f_broker_call_svc_gate");
const psqlAllowError = psql;

const HARNESS_SQL = supabaseHarnessSql([]);

const LOG_CALL = (caller, host, cost) => `select core.log_broker_call('${caller}', '${host}', ${cost});`;
const SPEND_TODAY = (caller) => `select core.broker_call_spend_today('${caller}');`;

function withDb(fn) {
  return withDatabase((db) => {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, readFileSync(CORE_CREATE_SCHEMA_UP, "utf8"));
    psqlOk(db, readFileSync(IDEA_CREATE_SCHEMA_UP, "utf8"));
    psqlOk(db, readFileSync(RLS_BASELINE_UP, "utf8"));
    psqlOk(db, readFileSync(BROKER_CALL_UP, "utf8"));
    return fn(db);
  });
}

test(
  "real Postgres GREEN: anon cannot reach log_broker_call at all (no EXECUTE grant)",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      const result = psqlAllowError(db, asRole("anon", null, LOG_CALL("llm-handler", "api.anthropic.com", "0.01")));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /permission denied for function log_broker_call/);
    });
  },
);

test(
  "real Postgres GREEN: authenticated cannot reach log_broker_call at all (no owner-JWT fallback exists for this RPC)",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      const result = psqlAllowError(db, asRole("authenticated", null, LOG_CALL("llm-handler", "api.anthropic.com", "0.01")));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /permission denied for function log_broker_call/);

      const rowCount = psqlOk(db, "select count(*) from core.broker_call;").trim();
      assert.equal(rowCount, "0", "the rejected call must not have inserted anything");
    });
  },
);

test(
  "real Postgres GREEN: even if PUBLIC's EXECUTE grant were mistakenly restored, the internal auth.role() check still rejects a non-service_role caller (defense-in-depth, not just the grant)",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      psqlOk(db, "grant execute on function core.log_broker_call(text, text, numeric) to authenticated;");
      const result = psqlAllowError(db, asRole("authenticated", null, LOG_CALL("llm-handler", "api.anthropic.com", "0.01")));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /service_role only/, "expected the function body's own auth.role() gate to fire, not a grant-level denial");

      const rowCount = psqlOk(db, "select count(*) from core.broker_call;").trim();
      assert.equal(rowCount, "0");
    });
  },
);

test(
  "real Postgres GREEN: service_role can call log_broker_call (the broker's own only caller shape) and it inserts a row with exactly the supplied caller/target_host/cost_usd",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      const id = psqlOk(db, asRole("service_role", null, LOG_CALL("llm-handler", "api.anthropic.com", "0.0123"))).trim();
      assert.match(id, /^[0-9a-f-]{36}$/);

      const row = psqlOk(db, `select caller, target_host, cost_usd from core.broker_call where id = '${id}';`).trim();
      assert.equal(row, "llm-handler|api.anthropic.com|0.0123");
    });
  },
);

test(
  "real Postgres GREEN: anon and authenticated cannot reach broker_call_spend_today at all",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      const anonResult = psqlAllowError(db, asRole("anon", null, SPEND_TODAY("llm-handler")));
      assert.notEqual(anonResult.status, 0);
      assert.match(anonResult.stderr, /permission denied for function broker_call_spend_today/);

      const authResult = psqlAllowError(db, asRole("authenticated", null, SPEND_TODAY("llm-handler")));
      assert.notEqual(authResult.status, 0);
      assert.match(authResult.stderr, /permission denied for function broker_call_spend_today/);
    });
  },
);

test(
  "real Postgres GREEN: even with PUBLIC's EXECUTE grant mistakenly restored on broker_call_spend_today, the internal auth.role() check still rejects a non-service_role caller",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      psqlOk(db, "grant execute on function core.broker_call_spend_today(text) to authenticated;");
      const result = psqlAllowError(db, asRole("authenticated", null, SPEND_TODAY("llm-handler")));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /service_role only/);
    });
  },
);

test(
  "real Postgres GREEN: service_role's broker_call_spend_today sums only today's rows for the named caller, excluding other callers and prior days",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      psqlOk(db, asRole("service_role", null, LOG_CALL("llm-handler", "api.anthropic.com", "1.5")));
      psqlOk(db, asRole("service_role", null, LOG_CALL("llm-handler", "api.openai.com", "2.25")));
      // A different caller's spend must never bleed into llm-handler's sum.
      psqlOk(db, asRole("service_role", null, LOG_CALL("other-caller", "api.anthropic.com", "100")));
      // A prior-day row (inserted directly, bypassing the RPC's own
      // now()-only ts default, the same fixture technique
      // insertPromotedIdea's sibling suites use for direct-insert setup)
      // must never count toward "today".
      psqlOk(
        db,
        "insert into core.broker_call (ts, caller, target_host, cost_usd) values (now() - interval '1 day', 'llm-handler', 'api.anthropic.com', 999);",
      );

      const total = psqlOk(db, asRole("service_role", null, SPEND_TODAY("llm-handler"))).trim();
      assert.equal(total, "3.7500", "expected only today's 1.5 + 2.25 for llm-handler, excluding the other caller and the prior-day row");
    });
  },
);

test(
  "real Postgres GREEN: broker_call_spend_today returns 0 (not null, not an error) for a caller with no logged calls at all",
  { skip: SKIP_REASON },
  () => {
    withDb((db) => {
      const total = psqlOk(db, asRole("service_role", null, SPEND_TODAY("never-called-before"))).trim();
      // coalesce(sum(numeric_col), 0) with zero matching rows returns the
      // bare integer literal's numeric cast, not the column's declared
      // numeric(10,4) display scale (that scale only shows once a real
      // stored value contributes to the sum, as in the previous test) --
      // "0" is the correct real-Postgres output here, not "0.0000".
      assert.equal(total, "0");
    });
  },
);
