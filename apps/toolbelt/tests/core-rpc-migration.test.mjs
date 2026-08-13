import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(TEST_DIR, "..", "supabase", "migrations");
const LOG_UP = readFileSync(join(MIGRATIONS, "20260814010000_core_log_run_owner_null_guard.sql"), "utf8");
const LOG_DOWN = readFileSync(join(MIGRATIONS, "20260814010000_core_log_run_owner_null_guard_down.sql"), "utf8");
const PURGE_ACL_UP = readFileSync(join(MIGRATIONS, "20260814020000_core_purge_old_events_revoke_public.sql"), "utf8");
const PURGE_ACL_DOWN = readFileSync(join(MIGRATIONS, "20260814020000_core_purge_old_events_revoke_public_down.sql"), "utf8");
const RETENTION_UP = readFileSync(join(MIGRATIONS, "20260814070000_core_event_retention_atomic.sql"), "utf8");
const RETENTION_DOWN = readFileSync(join(MIGRATIONS, "20260814070000_core_event_retention_atomic_down.sql"), "utf8");

test("core.log_run fails closed when no owner is configured", () => {
  assert.match(
    LOG_UP,
    /if\s+\(select platform\.owner\(\)\)\s+is null\s+or\s+\(select auth\.uid\(\)\)\s+is distinct from\s+\(select platform\.owner\(\)\)/i,
  );
});

test("security-definer core RPCs explicitly remove default PUBLIC execution", () => {
  assert.match(
    LOG_UP,
    /revoke execute on function core\.log_run\(text, text, bigint, text\) from public, anon;/i,
  );
  assert.match(
    LOG_UP,
    /grant execute on function core\.log_run\(text, text, bigint, text\) to authenticated;/i,
  );
  assert.match(
    PURGE_ACL_UP,
    /revoke execute on function core\.purge_old_events\(\) from public, anon, authenticated;/i,
  );
});

test("event retention claims rows once and aggregates only deleted rows", () => {
  assert.match(
    RETENTION_UP,
    /with\s+deleted\s+as\s*\(\s*delete from core\.event[\s\S]*?returning at\s*\),\s*aggregated\s+as\s*\([\s\S]*?from deleted[\s\S]*?\)\s*select count\(\*\) into v_purged from deleted;/i,
  );
});

test("down migrations mechanically restore the vulnerable pre-hardening contracts", () => {
  assert.match(
    LOG_DOWN,
    /if\s+\(select auth\.uid\(\)\)\s+is distinct from\s+\(select platform\.owner\(\)\)/i,
  );
  assert.match(
    LOG_DOWN,
    /grant execute on function core\.log_run\(text, text, bigint, text\) to public;/i,
  );
  assert.match(
    PURGE_ACL_DOWN,
    /grant execute on function core\.purge_old_events\(\) to public;/i,
  );
  assert.match(
    RETENTION_DOWN,
    /insert into core\.event_monthly_agg[\s\S]*?from core\.event[\s\S]*?with deleted as\s*\(\s*delete from core\.event/i,
  );
});
