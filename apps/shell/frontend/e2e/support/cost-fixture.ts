// m6-02 e2e harness: a REAL local Postgres 16 database with the real,
// unmodified core.run/core.cost/core.llm_call DDL applied (20260806190000_
// core_create_schema.sql, 20260814140000_core_llm_call.sql), the same
// "small local HTTP server answers PostgREST-shaped requests by running
// real SQL, as the postgres superuser" approach ./prompt-fixture.ts and
// ./intake-fixture.ts already established -- RLS/grant enforcement itself
// is proven separately (apps/toolbelt/tests/log_run_service_role_gate.test.mjs,
// owner-repin.test.mjs); this fixture exists to prove the Shell's OWN code
// (src/lib/cost.ts, src/pages/acc/cost.tsx) against real data and a real
// schema, not to re-prove RLS.
//
// Minimal migration chain, verified empirically to apply cleanly on its
// own (not every migration between core_create_schema and core_llm_call is
// needed -- core.log_run's own owner-gate migrations are irrelevant here,
// since this dashboard never calls that RPC, only reads core.run/core.cost/
// core.llm_call directly): platform_owner_bootstrap (platform.owner(), which
// core.llm_call's own owner_rw policy references), core_create_schema
// (core.run/core.cost/core.app), core_llm_call with its trailing
// `select cron.schedule(...)` call stripped -- this sandbox's local
// Postgres has no pg_cron control file installed, the same constraint
// apps/toolbelt/tests/log_run_owner_null_guard.test.mjs's own header
// comment documents for a different migration file.
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../../.."); // e2e/support -> e2e -> frontend -> shell -> apps -> repo root
const PLATFORM_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/toolbelt/supabase/migrations");

const PLATFORM_BOOTSTRAP_UP = path.join(PLATFORM_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");
const CORE_CREATE_SCHEMA_UP = path.join(PLATFORM_MIGRATIONS_DIR, "20260806190000_core_create_schema.sql");
const CORE_LLM_CALL_UP = path.join(PLATFORM_MIGRATIONS_DIR, "20260814140000_core_llm_call.sql");

const CRON_SPLIT_MARKER = "select cron.schedule(";

function coreLlmCallWithoutCron(): string {
  const full = readFileSync(CORE_LLM_CALL_UP, "utf8");
  const idx = full.indexOf(CRON_SPLIT_MARKER);
  if (idx <= 0) throw new Error("cost-fixture: expected to find the pg_cron marker in the real core.llm_call migration");
  return full.slice(0, idx);
}

export const OWNER_UUID = "00000000-0000-4000-8000-000000000099";

const BOOTSTRAP_ROLES_SQL = `
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
  if not exists (select from pg_roles where rolname = 'authenticator') then create role authenticator; end if;
end
$$;
`;

const BOOTSTRAP_AUTH_SQL = `
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select '${OWNER_UUID}'::uuid $$;
insert into auth.users (id) values ('${OWNER_UUID}');
`;

const APP_FIXTURE_SQL = `insert into core.app (id, name, schema_name) values ('brain', 'The Brain', 'core');`;

function sudoPostgres(args: string[], input?: string): string {
  return execFileSync("sudo", ["-n", "-u", "postgres", ...args], { encoding: "utf8", input });
}

function psqlFile(dbName: string, filePath: string): void {
  sudoPostgres(["psql", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", "-"], readFileSync(filePath, "utf8"));
}

function psqlText(dbName: string, sql: string): void {
  sudoPostgres(["psql", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", "-"], sql);
}

function psqlScalar(dbName: string, sql: string): string {
  return sudoPostgres(["psql", "-d", dbName, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
}

/** The same ground-truth path a spec's own "compare against psql group-by
 * output" assertion uses -- a plain scalar/JSON text query against the
 * fixture's real database, independent of the shim's own SQL. */
export function psqlJsonQuery(dbName: string, sql: string): unknown {
  return JSON.parse(psqlScalar(dbName, `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from (${sql}) t;`));
}

function uniqueDbName(): string {
  return `m6_02_shell_cost_e2e_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function pgQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface CostFixture {
  dbName: string;
  shimBaseUrl: string;
  ownerUuid: string;
  /** Inserts one core.run row (app_id='brain', kind='run', matching
   * services/brain/src/core-mirror.ts's own literal call) and its linked
   * core.cost row. Returns the run id. */
  seedBrainRun(fields: {
    startedAt: string;
    endedAt?: string | null;
    status?: string;
    inputTokens: number;
    outputTokens: number;
    usd: number;
  }): string;
  /** Inserts one core.llm_call row. */
  seedLlmCall(fields: {
    ts: string;
    callerApp: string;
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    usdEstimate: number;
  }): void;
  teardown(): void;
}

export async function setupCostFixture(): Promise<CostFixture> {
  const dbName = uniqueDbName();
  sudoPostgres(["createdb", dbName]);

  psqlText(dbName, BOOTSTRAP_ROLES_SQL);
  psqlText(dbName, BOOTSTRAP_AUTH_SQL);
  psqlFile(dbName, PLATFORM_BOOTSTRAP_UP);
  psqlFile(dbName, CORE_CREATE_SCHEMA_UP);
  psqlText(dbName, coreLlmCallWithoutCron());
  psqlText(dbName, APP_FIXTURE_SQL);

  function handleGetRun(url: URL): { status: number; body: unknown } {
    // Only the one filter shape src/lib/cost.ts's listBrainRunCosts() ever
    // sends: app_id=eq.brain&kind=eq.run, ordered newest-first.
    if (url.searchParams.get("app_id") !== "eq.brain" || url.searchParams.get("kind") !== "eq.run") {
      return { status: 400, body: { message: "cost-fixture shim: unexpected run query shape" } };
    }
    const limit = Number(url.searchParams.get("limit") ?? "200");
    const rows = psqlJsonQuery(
      dbName,
      `select id::text, started_at, ended_at, status from core.run
       where app_id = 'brain' and kind = 'run'
       order by started_at desc limit ${Number.isFinite(limit) ? limit : 200}`
    );
    return { status: 200, body: rows };
  }

  function handleGetCost(_url: URL): { status: number; body: unknown } {
    // lib/cost.ts's listBrainRunCosts() fetches every core.cost row
    // unfiltered (fired concurrently with the run query, joined
    // client-side) specifically so it never waits on the run query's own
    // result first -- see that function's own header comment.
    const rows = psqlJsonQuery(
      dbName,
      `select run_id::text, input_tokens, output_tokens, cache_read_tokens, wall_clock_ms, usd
       from core.cost`
    );
    return { status: 200, body: rows };
  }

  function handleGetLlmCall(url: URL): { status: number; body: unknown } {
    const tsParam = url.searchParams.get("ts");
    const m = tsParam ? /^gte\.(.+)$/.exec(tsParam) : null;
    if (!m) return { status: 400, body: { message: "cost-fixture shim: expected ts=gte.<iso>" } };
    const limit = Number(url.searchParams.get("limit") ?? "2000");
    const rows = psqlJsonQuery(
      dbName,
      `select caller_app, purpose, input_tokens, output_tokens, usd_estimate
       from core.llm_call where ts >= ${pgQuote(m[1]!)}
       order by ts desc limit ${Number.isFinite(limit) ? limit : 2000}`
    );
    return { status: 200, body: rows };
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let result: { status: number; body: unknown };
      if (url.pathname === "/rest/v1/run" && req.method === "GET") {
        result = handleGetRun(url);
      } else if (url.pathname === "/rest/v1/cost" && req.method === "GET") {
        result = handleGetCost(url);
      } else if (url.pathname === "/rest/v1/llm_call" && req.method === "GET") {
        result = handleGetLlmCall(url);
      } else {
        result = { status: 404, body: { message: "not found" } };
      }
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
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

  function seedBrainRun(fields: {
    startedAt: string;
    endedAt?: string | null;
    status?: string;
    inputTokens: number;
    outputTokens: number;
    usd: number;
  }): string {
    const id = psqlScalar(
      dbName,
      `with ins as (
        insert into core.run (app_id, kind, started_at, ended_at, status)
        values ('brain', 'run', ${pgQuote(fields.startedAt)}, ${fields.endedAt ? pgQuote(fields.endedAt) : "null"}, ${pgQuote(fields.status ?? "ok")})
        returning id
      )
      select id::text from ins;`
    );
    sudoPostgres([
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      dbName,
      "-c",
      `insert into core.cost (run_id, input_tokens, output_tokens, usd) values (${pgQuote(id)}, ${fields.inputTokens}, ${fields.outputTokens}, ${fields.usd});`,
    ]);
    return id;
  }

  function seedLlmCall(fields: {
    ts: string;
    callerApp: string;
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    usdEstimate: number;
  }): void {
    sudoPostgres([
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      dbName,
      "-c",
      `insert into core.llm_call (ts, caller_app, purpose, provider, model, input_tokens, output_tokens, usd_estimate, status)
       values (${pgQuote(fields.ts)}, ${pgQuote(fields.callerApp)}, ${pgQuote(fields.purpose)}, 'anthropic', 'test-model', ${fields.inputTokens}, ${fields.outputTokens}, ${fields.usdEstimate}, 'ok');`,
    ]);
  }

  function teardown(): void {
    server.close();
    sudoPostgres(["dropdb", dbName]);
  }

  return {
    dbName,
    shimBaseUrl: `http://127.0.0.1:${port}`,
    ownerUuid: OWNER_UUID,
    seedBrainRun,
    seedLlmCall,
    teardown,
  };
}
