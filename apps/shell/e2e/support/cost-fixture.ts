// m6-02 (docs/planning/issues/m6-02-feat-shell-cost-dashboard.md) e2e
// harness for the `core.llm_call` half of the cost dashboard. Same real-
// Postgres-plus-shim technique e2e/support/registry-fixture.ts already
// established for `core.app` -- see that file's own header comment for the
// full rationale. This fixture is narrower: no toolbelt-cli scaffold step
// (there is nothing to register), just the real DDL applied verbatim, then
// direct SQL inserts the spec itself controls, then a shim that answers
// `GET /rest/v1/llm_call` from real SQL against real rows -- so the panel's
// "matches direct SQL group-bys" acceptance criterion can be checked
// against an actual `group by caller_app, purpose` query, not a mock.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../.."); // e2e/support -> shell -> apps -> repo root
const TOOLBELT_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/toolbelt/supabase/migrations");

// The real migration files this harness applies, in order: `core` (the
// schema `core.llm_call` lives in), `platform` (its RLS policy's `using`
// clause calls `platform.owner()`, which must already exist for `create
// policy` itself to validate), then the real `core.llm_call` migration
// (table, RLS, `core.log_llm_call` RPC, retention) applied byte-for-byte.
const REAL_MIGRATIONS = [
  "20260806190000_core_create_schema.sql",
  "20260812140000_platform_owner_bootstrap.sql",
  "20260814140000_core_llm_call.sql",
];

const BOOTSTRAP_ROLES_SQL = `
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end
$$;
`;

// Same judgment call as registry-fixture.ts's own BOOTSTRAP_AUTH_SQL: not
// part of any real migration, added purely so `core.llm_call`'s real RLS
// policy (`(select auth.uid()) = (select platform.owner())`) resolves
// against a vanilla (non-Supabase) Postgres 16 instance.
const BOOTSTRAP_AUTH_SQL = `
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
`;

// `core.llm_call`'s real migration ends with a `select cron.schedule(...)`
// call (its own 180-day retention job) -- pg_cron is not installed in this
// sandbox's Postgres. A stub `cron.schedule` with the real signature lets
// the migration file apply completely unmodified; the fixture never runs
// the purge job itself, so a no-op body is all it needs.
const BOOTSTRAP_CRON_SQL = `
create schema cron;
create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
`;

function sudoPostgres(args: string[], input?: string): string {
  return execFileSync("sudo", ["-n", "-u", "postgres", ...args], { encoding: "utf8", input });
}

function psqlFile(dbName: string, filePath: string): void {
  sudoPostgres(["psql", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", "-"], readFileSync(filePath, "utf8"));
}

function psqlInline(dbName: string, sql: string): void {
  sudoPostgres(["psql", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-c", sql]);
}

function psqlJsonQuery(dbName: string, sql: string): string {
  return sudoPostgres(["psql", "-d", dbName, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
}

function uniqueDbName(): string {
  const pid = process.pid;
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1_000_000);
  return `m6_02_shell_cost_e2e_${pid}_${ts}_${rand}`;
}

export interface LlmCallFixtureRow {
  id: string;
  ts: string;
  caller_app: string;
  purpose: string;
  run_ref: string | null;
  provider: "anthropic" | "openai" | "gemini";
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  usd_estimate: number | null;
  latency_ms: number | null;
  status: "ok" | "error";
  error_class: string | null;
}

export interface CostFixture {
  dbName: string;
  /** Base URL of the local Postgres-backed PostgREST-shaped shim for `/rest/v1/llm_call`. */
  shimBaseUrl: string;
  /** Inserts one `core.llm_call` row via real SQL (bypassing the RPC -- this harness controls the database directly, matching registry-fixture.ts's own direct-SQL precedent for fixture state). */
  insertLlmCall(row: LlmCallFixtureRow): void;
  /** Runs an arbitrary read-only `group by` query against the real fixture rows, returning parsed JSON -- the ground truth the spec compares the rendered panel against. */
  queryJson<T>(sql: string): T;
  teardown(): void;
}

export async function setupCostFixture(): Promise<CostFixture> {
  const dbName = uniqueDbName();
  sudoPostgres(["createdb", dbName]);

  psqlInline(dbName, BOOTSTRAP_ROLES_SQL);
  psqlInline(dbName, BOOTSTRAP_AUTH_SQL);
  psqlInline(dbName, BOOTSTRAP_CRON_SQL);

  for (const filename of REAL_MIGRATIONS) {
    psqlFile(dbName, path.join(TOOLBELT_MIGRATIONS_DIR, filename));
  }

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/rest/v1/llm_call") {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "not found" }));
        return;
      }
      const where: string[] = [];
      const ts = url.searchParams.get("ts");
      if (ts !== null) where.push(pgGteFilter("ts", ts));
      const callerApp = url.searchParams.get("caller_app");
      if (callerApp !== null) where.push(pgEqFilter("caller_app", callerApp));
      const purpose = url.searchParams.get("purpose");
      if (purpose !== null) where.push(pgEqFilter("purpose", purpose));

      const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
      const sql = `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from (
        select id, ts, caller_app, purpose, run_ref, provider, model,
               input_tokens, output_tokens, cache_read_tokens,
               usd_estimate, latency_ms, status, error_class
        from core.llm_call
        ${whereSql}
        order by ts desc
      ) t;`;

      const body = psqlJsonQuery(dbName, sql);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("cost-fixture: shim server did not report a port"));
        return;
      }
      resolve(address.port);
    });
  });

  function insertLlmCall(row: LlmCallFixtureRow): void {
    const sql = `insert into core.llm_call (
      id, ts, caller_app, purpose, run_ref, provider, model,
      input_tokens, output_tokens, cache_read_tokens,
      usd_estimate, latency_ms, status, error_class
    ) values (
      ${pgQuote(row.id)}::uuid, ${pgQuote(row.ts)}::timestamptz, ${pgQuote(row.caller_app)}, ${pgQuote(row.purpose)},
      ${row.run_ref === null ? "null" : pgQuote(row.run_ref)}, ${pgQuote(row.provider)}, ${pgQuote(row.model)},
      ${row.input_tokens}, ${row.output_tokens}, ${row.cache_read_tokens},
      ${row.usd_estimate === null ? "null" : row.usd_estimate}, ${row.latency_ms === null ? "null" : row.latency_ms},
      ${pgQuote(row.status)}, ${row.error_class === null ? "null" : pgQuote(row.error_class)}
    );`;
    psqlInline(dbName, sql);
  }

  function queryJson<T>(sql: string): T {
    return JSON.parse(psqlJsonQuery(dbName, sql)) as T;
  }

  function teardown(): void {
    server.close();
    sudoPostgres(["dropdb", dbName]);
  }

  return { dbName, shimBaseUrl: `http://127.0.0.1:${port}`, insertLlmCall, queryJson, teardown };
}

function pgQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function pgGteFilter(column: "ts", raw: string): string {
  const m = /^gte\.(.*)$/.exec(raw);
  if (!m) throw new Error(`cost-fixture shim: unsupported filter for ${column}: ${raw}`);
  return `${column} >= ${pgQuote(m[1])}::timestamptz`;
}

function pgEqFilter(column: "caller_app" | "purpose", raw: string): string {
  const m = /^eq\.(.*)$/.exec(raw);
  if (!m) throw new Error(`cost-fixture shim: unsupported filter for ${column}: ${raw}`);
  return `${column} = ${pgQuote(m[1])}`;
}
