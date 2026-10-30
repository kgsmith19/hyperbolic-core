import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, "..", "supabase", "migrations");

function sql(name) {
  return readFileSync(join(migrations, name), "utf8");
}

test("retention hardening claims rows once and removes purge execution from every API role", () => {
  const up = sql("20260814121000_prompt_purge_old_usage_hardening.sql");
  const statements = up.replaceAll(/--.*$/gm, "");

  assert.match(up, /set\s+search_path\s*=\s*''/i);
  assert.match(up, /delete\s+from\s+prompt\.usage[\s\S]+returning\s+prompt_id\s*,\s*created_at/i);
  assert.match(up, /insert\s+into\s+prompt\.usage_monthly_agg[\s\S]+from\s+deleted/i);
  assert.doesNotMatch(
    statements,
    /select[\s\S]+from\s+prompt\.usage[\s\S]+insert\s+into\s+prompt\.usage_monthly_agg/i,
    "the aggregate must be derived from rows claimed by DELETE RETURNING, not a separate pre-delete scan",
  );

  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    assert.match(
      up,
      new RegExp(`revoke\\s+execute[\\s\\S]+purge_old_usage[\\s\\S]+from[\\s\\S]+${role}`, "i"),
      `purge_old_usage EXECUTE must be revoked from ${role}`,
    );
  }
});

test("get_prompt migration gives scoped agents no table grants and validates ad-hoc JSON at the database boundary", () => {
  const original = sql("20260813120000_prompt_create_get_prompt_function.sql");
  const up = sql("20260813140000_prompt_security_hardening.sql");
  const down = sql("20260813140000_prompt_security_hardening_down.sql");

  assert.match(original, /security\s+invoker/i);
  assert.doesNotMatch(original, /prompt_get_agent/i);
  assert.match(up, /create\s+role\s+prompt_get_agent\s+nologin\s+noinherit\s+nobypassrls/i);
  assert.match(up, /security\s+definer/i);
  assert.match(up, /grant\s+usage\s+on\s+schema\s+prompt\s+to\s+prompt_get_agent/i);
  assert.match(up, /grant\s+execute[\s\S]+get_prompt[\s\S]+to\s+prompt_get_agent/i);
  assert.doesNotMatch(up, /grant\s+(select|insert|update|delete)[^;]+prompt_get_agent/i);
  assert.match(up, /prompt:get/);
  assert.match(up, /jsonb_typeof\s*\(\s*p_values\s*\)[\s\S]+object/i);
  assert.match(up, /jsonb_each\s*\(\s*p_values\s*\)[\s\S]+jsonb_typeof[\s\S]+string/i);
  assert.match(up, /p\.user_id\s*=\s*\(\s*select\s+platform\.owner\(\)\s*\)/i);
  assert.match(up, /pv\.user_id\s*=\s*\(\s*select\s+platform\.owner\(\)\s*\)/i);
  assert.match(up, /owner_prompt\.user_id\s*=\s*\(\s*select\s+platform\.owner\(\)\s*\)/i);
  assert.match(down, /security\s+invoker/i);
  assert.match(down, /drop\s+role\s+prompt_get_agent/i);
});

test("get_prompt_source is an execute-only conditional cache protocol that observes archival", () => {
  const up = sql("20260813150000_prompt_create_get_prompt_source_function.sql");

  assert.match(up, /create\s+or\s+replace\s+function\s+prompt\.get_prompt_source/i);
  assert.match(up, /security\s+definer/i);
  assert.match(up, /set\s+search_path\s*=\s*''/i);
  assert.match(up, /p_if_version\s+integer/i);
  assert.match(up, /not_modified/i);
  assert.match(up, /is_active/i);
  assert.match(up, /prompt:get/);
  assert.match(up, /grant\s+execute[\s\S]+get_prompt_source[\s\S]+to\s+prompt_get_agent/i);
  assert.doesNotMatch(up, /grant\s+(select|insert|update|delete)[^;]+prompt_get_agent/i);
});

test("prompt titles are unique per principal so legacy fixture rows cannot squat owner names", () => {
  const up = sql("20260813151000_prompt_scope_title_uniqueness.sql");
  const down = sql("20260813151000_prompt_scope_title_uniqueness_down.sql");

  assert.match(up, /drop\s+index\s+prompt\.prompt_title_unique/i);
  assert.match(
    up,
    /create\s+unique\s+index\s+prompt_title_unique\s+on\s+prompt\.prompt\s*\(\s*user_id\s*,\s*lower\s*\(\s*title\s*\)\s*\)/i,
  );
  assert.match(down, /create\s+unique\s+index\s+prompt_title_unique\s+on\s+prompt\.prompt\s*\(\s*lower\s*\(\s*title\s*\)\s*\)/i);

  const seed = sql("20260813160000_prompt_seed_starters.sql");
  assert.match(seed, /on\s+conflict\s*\(\s*user_id\s*,\s*lower\s*\(\s*title\s*\)\s*\)\s+do\s+nothing/i);
});

test("starter rollback identifies rows by stable migration-owned ids, never by a colliding title", () => {
  const up = sql("20260813160000_prompt_seed_starters.sql");
  const down = sql("20260813160000_prompt_seed_starters_down.sql");
  const ids = [...up.matchAll(/'([0-9a-f]{8}-[0-9a-f-]{27})'\s*,\s*'[^']+'/gi)].map((match) => match[1]);

  assert.equal(ids.length, 9, "every starter row needs one stable provenance id");
  assert.equal(new Set(ids).size, ids.length, "starter provenance ids must be unique");
  for (const id of ids) assert.match(down, new RegExp(id, "i"));
  assert.match(down, /delete\s+from\s+prompt\.prompt\s+where\s+id\s+in/i);
  assert.doesNotMatch(down, /where\s+lower\s*\(\s*title\s*\)/i);
});

test("the real-Postgres harness has an explicit CI fail-on-unavailable contract", () => {
  const harness = readFileSync(join(here, "..", "..", "..", "..", "tests", "postgres-harness.mjs"), "utf8");
  // Both prefixes stay honoured: the Toolbelt CI gate sets TOOLBELT_* for the
  // root and Idea Intake steps and PROMPT_* for this one, and the shared
  // harness must fail closed for either rather than silently skipping.
  for (const v of ["TOOLBELT_TEST_DATABASE_URL", "PROMPT_TEST_DATABASE_URL", "TOOLBELT_REQUIRE_POSTGRES", "PROMPT_REQUIRE_POSTGRES"]) {
    assert.match(harness, new RegExp(v));
  }
});
