import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(TEST_DIR, "..", "supabase", "migrations", "20260813002605_intake_create_schema.sql"),
  "utf8",
);
const IDEMPOTENCY_SQL = readFileSync(
  join(TEST_DIR, "..", "supabase", "migrations", "20260814120100_intake_forgepad_idempotency_key.sql"),
  "utf8",
);
const HARDENING_SQL = readFileSync(
  join(TEST_DIR, "..", "supabase", "migrations", "20260814120000_intake_submission_metadata_integrity.sql"),
  "utf8",
);
const HARDENING_DOWN_SQL = readFileSync(
  join(TEST_DIR, "..", "supabase", "migrations", "20260814120000_intake_submission_metadata_integrity_down.sql"),
  "utf8",
);

test("GitHub submission fields are all present only for submitted rows and all absent otherwise", () => {
  assert.match(
    HARDENING_SQL,
    /constraint submitted_fields_all_or_none check\s*\(\s*\(status = 'submitted_to_github'[\s\S]*?github_issue_number is not null[\s\S]*?github_issue_url is not null[\s\S]*?submitted_at is not null\)[\s\S]*?or\s*\(status <> 'submitted_to_github'[\s\S]*?github_issue_number is null[\s\S]*?github_issue_url is null[\s\S]*?submitted_at is null\)\s*\)/i,
  );
});

test("the update guard rejects any GitHub metadata outside the submit transition", () => {
  assert.match(
    HARDENING_SQL,
    /new\.status <> 'submitted_to_github'\s+and\s+\(new\.github_issue_number is not null\s+or new\.github_issue_url is not null\s+or new\.submitted_at is not null\)/i,
  );
});

test("Forgepad timestamp preservation is limited to explicit BYPASSRLS import sessions", () => {
  assert.match(HARDENING_SQL, /current_setting\('intake\.preserve_updated_at', true\) = 'on'/i);
  assert.match(HARDENING_SQL, /from pg_roles[\s\S]*?rolname = current_user[\s\S]*?\(rolsuper or rolbypassrls\)/i);
});

test("integrity hardening is additive and its down migration restores prior behavior", () => {
  assert.match(HARDENING_SQL, /drop constraint if exists submitted_fields_all_or_none/i);
  assert.match(HARDENING_SQL, /validate constraint submitted_fields_all_or_none/i);
  assert.match(HARDENING_DOWN_SQL, /\(status = 'submitted_to_github'\)[\s\S]*?= \(github_issue_number is not null/i);
  assert.match(HARDENING_DOWN_SQL, /new\.updated_at := now\(\)/i);
});

test("Forgepad identity preserves the original column and safely reconciles older schemas", () => {
  assert.match(SQL, /idempotency_key\s+uuid\s+not null\s+unique\s+default gen_random_uuid\(\)/i);
  assert.match(IDEMPOTENCY_SQL, /add\s+column\s+if\s+not\s+exists\s+idempotency_key\s+uuid/i);
  assert.match(IDEMPOTENCY_SQL, /md5\s*\([\s\S]+hyperbolic-core\/forgepad\//i);
  assert.match(IDEMPOTENCY_SQL, /create\s+unique\s+index\s+if\s+not\s+exists\s+intake_idea_idempotency_key/i);
  assert.match(IDEMPOTENCY_SQL, /revoke\s+insert\s*\(idempotency_key\)\s*,\s*update\s*\(idempotency_key\)/i);
});
