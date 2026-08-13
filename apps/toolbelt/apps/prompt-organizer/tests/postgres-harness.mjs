import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const DATABASE_URL = process.env.PROMPT_TEST_DATABASE_URL?.trim();
const REQUIRE_POSTGRES = process.env.PROMPT_REQUIRE_POSTGRES === "1";

function databaseUrl(dbName) {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function runnerArgs(runner, dbName) {
  if (runner.kind === "url") return [databaseUrl(dbName)];
  return [...runner.prefix, "-d", dbName];
}

function canConnect(runner) {
  try {
    const result = spawnSync(
      runner.cmd,
      [...runnerArgs(runner, "postgres"), "-X", "-tAc", "select 1;"],
      { encoding: "utf8", timeout: 5000 },
    );
    return result.status === 0 && result.stdout.trim() === "1";
  } catch {
    return false;
  }
}

function detectRunner() {
  const candidates = DATABASE_URL
    ? [{ kind: "url", cmd: "psql", prefix: [] }]
    : [
        { kind: "local", cmd: "psql", prefix: [] },
        { kind: "local", cmd: "sudo", prefix: ["-n", "-u", "postgres", "psql"] },
      ];
  return candidates.find(canConnect) ?? null;
}

const RUNNER = detectRunner();

if (REQUIRE_POSTGRES && !RUNNER) {
  throw new Error(
    "PROMPT_REQUIRE_POSTGRES=1 but no PostgreSQL server is reachable" +
      (DATABASE_URL ? " through PROMPT_TEST_DATABASE_URL" : " (PROMPT_TEST_DATABASE_URL is unset)"),
  );
}

function assertIdentifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/, `unsafe PostgreSQL identifier: ${value}`);
}

export function supabaseHarnessSql(userIds) {
  const values = userIds.map((id) => `('${id}'::uuid)`).join(", ");
  return `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('app.test_uid', true), '')::uuid $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end
$$;

insert into auth.users (id) values ${values};
`;
}

export function asAuthenticated(uuid, sqlText) {
  const claims = JSON.stringify({ role: "authenticated", sub: uuid }).replaceAll("'", "''");
  return `set role authenticated;
do $$ begin
  perform set_config('app.test_uid', '${uuid}', false);
  perform set_config('request.jwt.claims', '${claims}', false);
end $$;
${sqlText}`;
}

export function asJwtRole(role, claims, sqlText) {
  assertIdentifier(role);
  const encoded = JSON.stringify({ ...claims, role }).replaceAll("'", "''");
  return `set role ${role};
do $$ begin
  perform set_config('app.test_uid', '${claims.sub ?? ""}', false);
  perform set_config('request.jwt.claims', '${encoded}', false);
end $$;
${sqlText}`;
}

export function createPostgresHarness(prefix, { timeout = 20000 } = {}) {
  assertIdentifier(prefix);

  function psql(dbName, sqlText, extraArgs = []) {
    assertIdentifier(dbName);
    if (!RUNNER) throw new Error("PostgreSQL harness used without a reachable server");
    return spawnSync(
      RUNNER.cmd,
      [
        ...runnerArgs(RUNNER, dbName),
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=verbose",
        "-tA",
        "-q",
        ...extraArgs,
      ],
      { encoding: "utf8", input: sqlText, timeout },
    );
  }

  function psqlOk(dbName, sqlText, extraArgs = []) {
    const result = psql(dbName, sqlText, extraArgs);
    assert.equal(result.status, 0, `psql failed against ${dbName}: ${result.stderr || result.stdout}`);
    return result.stdout;
  }

  function applyMigrationWithRetry(dbName, sqlText, attempts = 5) {
    const wrapped = `begin;\n${sqlText}\ncommit;\n`;
    let lastResult;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      lastResult = psql(dbName, wrapped);
      if (lastResult.status === 0) return lastResult.stdout;
      if (!/tuple concurrently updated/.test(lastResult.stderr || "")) break;
    }
    assert.equal(lastResult.status, 0, `psql failed against ${dbName}: ${lastResult.stderr || lastResult.stdout}`);
    return lastResult.stdout;
  }

  function freshDatabaseName() {
    return `${prefix}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }

  function withDatabase(fn) {
    const dbName = freshDatabaseName();
    psqlOk("postgres", `drop database if exists ${dbName};\ncreate database ${dbName};`);
    try {
      return fn(dbName);
    } finally {
      psqlOk("postgres", `drop database if exists ${dbName};`);
    }
  }

  return {
    available: Boolean(RUNNER),
    skipReason: RUNNER
      ? false
      : "no PostgreSQL server reachable; set PROMPT_TEST_DATABASE_URL, or set PROMPT_REQUIRE_POSTGRES=1 in CI to fail instead of skip",
    psql,
    psqlOk,
    applyMigrationWithRetry,
    freshDatabaseName,
    withDatabase,
  };
}
