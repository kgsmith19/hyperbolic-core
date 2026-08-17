// The one real-Postgres harness for this monorepo's suites: connection
// discovery, a scratch database per test, the stubbed `auth` schema Supabase
// migrations expect, and role/JWT assumption. Every suite that applies real
// committed migrations to a throwaway database uses this -- previously each
// one carried its own ~50-line copy of the same primitives.
//
// Two env-var prefixes because the Toolbelt PR Gate has always set a
// different one per step (TOOLBELT_* at the root and for Idea Intake,
// PROMPT_* for Prompt Organizer). Honouring both keeps that contract intact
// while the implementation is shared.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const URL_VAR = process.env.TOOLBELT_TEST_DATABASE_URL?.trim() ? "TOOLBELT_TEST_DATABASE_URL" : "PROMPT_TEST_DATABASE_URL";
const DATABASE_URL = process.env.TOOLBELT_TEST_DATABASE_URL?.trim() || process.env.PROMPT_TEST_DATABASE_URL?.trim();
const REQUIRE_POSTGRES =
  process.env.TOOLBELT_REQUIRE_POSTGRES === "1" || process.env.PROMPT_REQUIRE_POSTGRES === "1";

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
    "TOOLBELT_REQUIRE_POSTGRES/PROMPT_REQUIRE_POSTGRES=1 but no PostgreSQL server is reachable" +
      (DATABASE_URL ? ` through ${URL_VAR}` : ` (${URL_VAR} is unset)`),
  );
}

function assertIdentifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/, `unsafe PostgreSQL identifier: ${value}`);
}

// The detected psql invocation for a given database, as [cmd, args]. Suites
// that must drive a SECOND concurrent session -- proving row-lock or advisory-
// lock behavior needs two live connections, which the synchronous helpers
// cannot express -- spawn it themselves from this rather than re-implementing
// detection. null when no server is reachable. Routing through runnerArgs()
// also means those suites honour a *_TEST_DATABASE_URL connection, which the
// hand-rolled `-d <db>` forms they replaced silently ignored.
export function psqlSpawnSpec(dbName, extraArgs = ["-q"]) {
  if (!RUNNER) return null;
  assertIdentifier(dbName);
  return [RUNNER.cmd, [...runnerArgs(RUNNER, dbName), "-v", "ON_ERROR_STOP=1", "-tA", ...extraArgs]];
}

/** True when the detected runner shells out through `sudo -u postgres`, which
 *  a few suites must know to make fixture files readable by that user. */
export const runnerUsesSudo = RUNNER?.cmd === "sudo";

/** psql as a promise instead of a blocking call. The two-session concurrency
 *  proofs need this: spawnSync would serialize the very overlap they exist to
 *  demonstrate. Never rejects -- a non-zero exit is returned as `code` so the
 *  caller can assert on the failure rather than catch it. */
export function psqlAsync(dbName, sqlText) {
  return new Promise((resolve) => {
    const child = spawn(...psqlSpawnSpec(dbName), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(sqlText);
    child.stdin.end();
  });
}

/** Poll `predicate` until it returns truthy or `timeoutMs` elapses; resolves
 *  true if it fired, false on timeout. Returning the verdict rather than
 *  throwing keeps "it never happened" assertable as a value. */
export async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** The prefix of a real migration file, cut immediately before `marker`.
 *
 *  Several suites apply a committed retention migration to a throwaway
 *  database that has no pg_cron. Rather than keeping a hand-copied excerpt --
 *  which silently rots the moment the real migration changes -- each reads the
 *  real file and stops at the point where it starts requiring the extension.
 *  The assertion matters: if the marker ever moves or is reworded, this fails
 *  loudly instead of quietly applying the whole file, or none of it. */
export function migrationBeforeMarker(migrationPath, marker) {
  const full = readFileSync(migrationPath, "utf8");
  const idx = full.indexOf(marker);
  assert.ok(idx > 0, `expected to find ${JSON.stringify(marker)} in ${migrationPath}`);
  return full.slice(0, idx);
}

// `userIds` may be empty: suites that only assert GRANT/REVOKE behavior need
// the roles and the auth.uid() stub but seed no users, and an INSERT with an
// empty VALUES list is a syntax error rather than a no-op.
export function supabaseHarnessSql(userIds) {
  const seed = userIds.length
    ? `\ninsert into auth.users (id) values ${userIds.map((id) => `('${id}'::uuid)`).join(", ")};\n`
    : "";
  return `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('app.test_uid', true), '')::uuid $$;
-- auth.role() resolves to the ambient SET ROLE, a fair stand-in for what real
-- Supabase resolves from the JWT's own role claim, because this harness's
-- whole convention IS "SET ROLE anon/authenticated/service_role before the
-- call" (see asRole/asAuthenticated). Suites gating on service_role need it;
-- it is inert for the rest.
create or replace function auth.role() returns text
language sql stable
as $$ select current_setting('role') $$;

do $$
begin
  begin
    create role anon nologin;
  exception when duplicate_object then null;
  end;
  begin
    create role authenticated nologin;
  exception when duplicate_object then null;
  end;
  begin
    create role service_role nologin;
  exception when duplicate_object then null;
  end;
  begin
    create role authenticator nologin;
  exception when duplicate_object then null;
  end;
end
$$;
${seed}`;
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

// The narrower sibling of asAuthenticated: assumes a role and sets only
// app.test_uid (what auth.uid() reads), with no request.jwt.claims. Suites
// asserting pure GRANT/REVOKE behavior use this -- a policy that consulted
// the JWT would be a different assertion than the one they mean to make.
//
// set_config goes through a DO block (PERFORM, not SELECT) so it contributes
// no row of its own. A bare top-level `select set_config(...)` would print its
// return value as real tuple output ahead of sqlText's, even under -q, because
// that line is genuine query data rather than an announcement -- which shifts
// every row index the caller then asserts on.
export function asRole(role, uuidOrNull, sqlText) {
  assertIdentifier(role);
  const setUid = uuidOrNull
    ? `do $$ begin perform set_config('app.test_uid', '${uuidOrNull}', false); end $$;\n`
    : "";
  return `set role ${role};\n${setUid}${sqlText}`;
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
      : "no PostgreSQL server reachable (tried direct `psql` and `sudo -n -u postgres psql`); this suite " +
        "proves real grant/RLS behavior against an actual engine and has nothing honest to assert without " +
        `one. Set ${URL_VAR}, or TOOLBELT_REQUIRE_POSTGRES=1 in CI to fail instead of skip`,
    psql,
    psqlOk,
    applyMigrationWithRetry,
    freshDatabaseName,
    withDatabase,
  };
}
