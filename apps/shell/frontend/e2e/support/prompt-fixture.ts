// m5-01/m5-02 e2e harness: a REAL local Postgres 16 database with the real,
// unmodified `prompt` schema migrations applied (the record_version
// trigger, the title-uniqueness index, and owner-pinned RLS all exist for
// real -- mirrors ./intake-fixture.ts's own approach and accepted scope: a
// small local HTTP server answers PostgREST-shaped requests by running real
// SQL against this real database, as the `postgres` superuser, which
// bypasses RLS and grants by construction. RLS/grant ENFORCEMENT itself is
// already exhaustively proven by
// apps/toolbelt/apps/prompt-organizer/tests/contract.test.mjs; this fixture
// exists to prove the Shell's OWN code (src/lib/prompts.ts,
// src/pages/prompts/*) against real data and real triggers, not to
// re-prove RLS.
//
// Only the get_prompt/get_prompt_source/render_prompt RPCs and their
// security-hardening migrations are deliberately NOT applied here: the
// Shell's management UI never calls them (it renders locally with
// src/lib/prompt-render.ts's render(), matching web/panel.mjs's own
// behavior) -- those RPCs are packages/llm's own injection-client concern,
// covered by packages/llm's and get-prompt.test.mjs's own suites. `rpc/log_run`
// (core.log_run, a DIFFERENT schema entirely) is stubbed rather than backed
// by the real core schema, for the same reason ./intake-fixture.ts stubs
// `rpc/is_platform_owner`: it is a telemetry side-effect this fixture's
// scope isn't about, and the shim records every call so a spec can still
// assert it happened.
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../.."); // e2e/support -> shell -> apps -> repo root
const PO_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/toolbelt/apps/prompt-organizer/supabase/migrations");
const PLATFORM_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/toolbelt/supabase/migrations");

const REAL_MIGRATIONS = [
  { dir: PLATFORM_MIGRATIONS_DIR, file: "20260812140000_platform_owner_bootstrap.sql" },
  { dir: PO_MIGRATIONS_DIR, file: "20260807020000_prompt_create_prompt.sql" },
  { dir: PO_MIGRATIONS_DIR, file: "20260807041000_prompt_versions_and_unique_title.sql" },
  { dir: PO_MIGRATIONS_DIR, file: "20260807051000_prompt_create_tag.sql" },
  { dir: PO_MIGRATIONS_DIR, file: "20260807070000_prompt_create_usage.sql" },
  { dir: PO_MIGRATIONS_DIR, file: "20260808000000_prompt_add_is_active.sql" },
  { dir: PO_MIGRATIONS_DIR, file: "20260808100000_prompt_create_configuration.sql" },
  { dir: PO_MIGRATIONS_DIR, file: "20260812180000_prompt_owner_pin.sql" },
];

export const OWNER_UUID = "00000000-0000-4000-8000-000000000099";

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
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator;
  end if;
end
$$;
`;

const BOOTSTRAP_AUTH_SQL = `
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select '${OWNER_UUID}'::uuid $$;
insert into auth.users (id) values ('${OWNER_UUID}');
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

function psqlScalar(dbName: string, sql: string): string {
  return sudoPostgres(["psql", "-d", dbName, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
}

function uniqueDbName(): string {
  return `m5_01_shell_prompt_e2e_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function pgQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function pgJsonbQuote(value: unknown): string {
  return `${pgQuote(JSON.stringify(value))}::jsonb`;
}

function pgLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return pgQuote(String(value));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_WRITABLE = new Set(["title", "body", "is_active"]);

const ROW_SELECT = `
  select p.id, p.title, p.body, p.is_active, p.created_at,
         coalesce(
           (select json_agg(json_build_object('tag', t.tag)) from prompt.tag t where t.prompt_id = p.id),
           '[]'::json
         ) as tag,
         coalesce(
           (select json_agg(json_build_object('version_no', v.version_no))
            from (select version_no from prompt.prompt_version where prompt_id = p.id order by version_no desc limit 1) v),
           '[]'::json
         ) as prompt_version,
         coalesce(
           (select json_agg(json_build_object('name', c.name, 'values', c.values, 'sections', c.sections))
            from prompt.configuration c where c.prompt_id = p.id),
           '[]'::json
         ) as configuration
  from prompt.prompt p
`;

interface ShimError {
  status: number;
  message: string;
}

function sqlErrorToShimError(err: unknown): ShimError {
  const raw = err instanceof Error ? err.message : String(err);
  const match = /ERROR:\s+(.*)/.exec(raw);
  return { status: 400, message: (match?.[1] ?? raw).trim() };
}

export interface PromptFixture {
  dbName: string;
  shimBaseUrl: string;
  ownerUuid: string;
  logRunCalls: Array<{ p_app_id: string; p_kind: string; p_wall_clock_ms: number }>;
  seedPrompt(fields: { title: string; body: string; isActive?: boolean; tags?: string[] }): string;
  seedUsage(promptId: string, versionNo: number, count: number): void;
  readPromptRow(id: string): Record<string, unknown> | null;
  teardown(): void;
}

export async function setupPromptFixture(): Promise<PromptFixture> {
  const dbName = uniqueDbName();
  sudoPostgres(["createdb", dbName]);

  psqlInline(dbName, BOOTSTRAP_ROLES_SQL);
  psqlInline(dbName, BOOTSTRAP_AUTH_SQL);
  for (const { dir, file } of REAL_MIGRATIONS) {
    psqlFile(dbName, path.join(dir, file));
  }

  function selectRows(whereSql: string, orderSql: string): unknown[] {
    const sql = `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from (
      ${ROW_SELECT} ${whereSql} ${orderSql}
    ) t;`;
    return JSON.parse(psqlScalar(dbName, sql)) as unknown[];
  }

  function handleGetPrompt(url: URL): { status: number; body: unknown } {
    const where: string[] = [];
    const id = url.searchParams.get("id");
    if (id !== null) {
      const m = /^eq\.(.+)$/.exec(id);
      if (!m || !UUID_RE.test(m[1]!)) return { status: 400, body: { message: "bad id filter" } };
      where.push(`p.id = ${pgQuote(m[1]!)}`);
    }
    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const orderSql = url.searchParams.get("order") === "created_at.desc" ? "order by p.created_at desc" : "";
    return { status: 200, body: selectRows(whereSql, orderSql) };
  }

  function handlePostPrompt(bodyText: string): { status: number; body: unknown } {
    const payload = JSON.parse(bodyText || "{}") as Record<string, unknown>;
    const columns = Object.keys(payload).filter((k) => {
      if (!PROMPT_WRITABLE.has(k)) throw new Error(`prompt-fixture shim: refusing unexpected insert column "${k}"`);
      return true;
    });
    try {
      const newId = psqlScalar(
        dbName,
        `with ins as (
          insert into prompt.prompt (${columns.join(",")})
          values (${columns.map((c) => pgLiteral(payload[c])).join(",")})
          returning id
        )
        select id::text from ins;`
      );
      return { status: 201, body: selectRows(`where p.id = ${pgQuote(newId)}`, "") };
    } catch (err) {
      const shimErr = sqlErrorToShimError(err);
      return { status: shimErr.status, body: { message: shimErr.message } };
    }
  }

  function handlePatchPrompt(url: URL, bodyText: string): { status: number; body: unknown } {
    const idParam = url.searchParams.get("id");
    const m = idParam ? /^eq\.(.+)$/.exec(idParam) : null;
    if (!m || !UUID_RE.test(m[1]!)) return { status: 400, body: { message: "bad id filter" } };
    const id = m[1]!;
    const payload = JSON.parse(bodyText || "{}") as Record<string, unknown>;
    const columns = Object.keys(payload).filter((k) => {
      if (!PROMPT_WRITABLE.has(k)) throw new Error(`prompt-fixture shim: refusing unexpected update column "${k}"`);
      return true;
    });
    if (columns.length === 0) return { status: 200, body: selectRows(`where p.id = ${pgQuote(id)}`, "") };
    try {
      const setSql = columns.map((c) => `${c} = ${pgLiteral(payload[c])}`).join(", ");
      sudoPostgres(["psql", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-c", `update prompt.prompt set ${setSql} where id = ${pgQuote(id)};`]);
      return { status: 200, body: selectRows(`where p.id = ${pgQuote(id)}`, "") };
    } catch (err) {
      const shimErr = sqlErrorToShimError(err);
      return { status: shimErr.status, body: { message: shimErr.message } };
    }
  }

  function handleGetVersions(url: URL): { status: number; body: unknown } {
    const promptId = url.searchParams.get("prompt_id");
    const m = promptId ? /^eq\.(.+)$/.exec(promptId) : null;
    if (!m || !UUID_RE.test(m[1]!)) return { status: 400, body: { message: "bad prompt_id filter" } };
    const sql = `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from (
      select version_no, body, created_at from prompt.prompt_version
      where prompt_id = ${pgQuote(m[1]!)} order by version_no desc
    ) t;`;
    return { status: 200, body: JSON.parse(psqlScalar(dbName, sql)) };
  }

  function handlePostTag(bodyText: string): { status: number; body: unknown } {
    const rows = JSON.parse(bodyText || "[]") as Array<{ prompt_id: string; tag: string }>;
    try {
      for (const row of rows) {
        if (!UUID_RE.test(row.prompt_id)) throw new Error("prompt-fixture shim: bad prompt_id in tag insert");
        psqlInline(dbName, `insert into prompt.tag (prompt_id, tag) values (${pgQuote(row.prompt_id)}, ${pgQuote(row.tag)});`);
      }
      return { status: 201, body: rows };
    } catch (err) {
      const shimErr = sqlErrorToShimError(err);
      return { status: shimErr.status, body: { message: shimErr.message } };
    }
  }

  function handleGetUsage(url: URL): { status: number; body: unknown } {
    void url;
    const sql = `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from (
      select prompt_id from prompt.usage
    ) t;`;
    return { status: 200, body: JSON.parse(psqlScalar(dbName, sql)) };
  }

  function handlePostUsage(bodyText: string): { status: number; body: unknown } {
    const payload = JSON.parse(bodyText || "{}") as { prompt_id: string; version_no: number };
    try {
      psqlInline(
        dbName,
        `insert into prompt.usage (prompt_id, version_no) values (${pgQuote(payload.prompt_id)}, ${Number(payload.version_no)});`
      );
      return { status: 201, body: [] };
    } catch (err) {
      const shimErr = sqlErrorToShimError(err);
      return { status: shimErr.status, body: { message: shimErr.message } };
    }
  }

  function handlePostConfiguration(bodyText: string): { status: number; body: unknown } {
    const payload = JSON.parse(bodyText || "{}") as {
      prompt_id: string;
      name: string;
      values: Record<string, string>;
      sections: string[];
    };
    try {
      psqlInline(
        dbName,
        `insert into prompt.configuration (prompt_id, name, values, sections)
         values (${pgQuote(payload.prompt_id)}, ${pgQuote(payload.name)}, ${pgJsonbQuote(payload.values)}, array[${payload.sections
          .map((s) => pgQuote(s))
          .join(",")}]::text[]);`
      );
      return { status: 201, body: [{ name: payload.name, values: payload.values, sections: payload.sections }] };
    } catch (err) {
      const shimErr = sqlErrorToShimError(err);
      return { status: shimErr.status, body: { message: shimErr.message } };
    }
  }

  const logRunCalls: PromptFixture["logRunCalls"] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let result: { status: number; body: unknown };
        if (url.pathname === "/rest/v1/prompt" && req.method === "GET") {
          result = handleGetPrompt(url);
        } else if (url.pathname === "/rest/v1/prompt" && req.method === "POST") {
          result = handlePostPrompt(bodyText);
        } else if (url.pathname === "/rest/v1/prompt" && req.method === "PATCH") {
          result = handlePatchPrompt(url, bodyText);
        } else if (url.pathname === "/rest/v1/prompt_version" && req.method === "GET") {
          result = handleGetVersions(url);
        } else if (url.pathname === "/rest/v1/tag" && req.method === "POST") {
          result = handlePostTag(bodyText);
        } else if (url.pathname === "/rest/v1/usage" && req.method === "GET") {
          result = handleGetUsage(url);
        } else if (url.pathname === "/rest/v1/usage" && req.method === "POST") {
          result = handlePostUsage(bodyText);
        } else if (url.pathname === "/rest/v1/configuration" && req.method === "POST") {
          result = handlePostConfiguration(bodyText);
        } else if (url.pathname === "/rest/v1/rpc/log_run" && req.method === "POST") {
          logRunCalls.push(JSON.parse(bodyText || "{}"));
          result = { status: 200, body: "00000000-0000-4000-8000-000000000abc" };
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
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("prompt-fixture: shim server did not report a port"));
        return;
      }
      resolve(address.port);
    });
  });

  function seedPrompt(fields: { title: string; body: string; isActive?: boolean; tags?: string[] }): string {
    const id = psqlScalar(
      dbName,
      `with ins as (
        insert into prompt.prompt (title, body) values (${pgQuote(fields.title)}, ${pgQuote(fields.body)})
        returning id
      )
      select id::text from ins;`
    );
    if (fields.isActive === false) {
      psqlInline(dbName, `update prompt.prompt set is_active = false where id = ${pgQuote(id)};`);
    }
    for (const tag of fields.tags ?? []) {
      psqlInline(dbName, `insert into prompt.tag (prompt_id, tag) values (${pgQuote(id)}, ${pgQuote(tag)});`);
    }
    return id;
  }

  function seedUsage(promptId: string, versionNo: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      psqlInline(dbName, `insert into prompt.usage (prompt_id, version_no) values (${pgQuote(promptId)}, ${versionNo});`);
    }
  }

  function readPromptRow(id: string): Record<string, unknown> | null {
    const rows = selectRows(`where p.id = ${pgQuote(id)}`, "") as Record<string, unknown>[];
    return rows[0] ?? null;
  }

  function teardown(): void {
    server.close();
    sudoPostgres(["dropdb", dbName]);
  }

  return {
    dbName,
    shimBaseUrl: `http://127.0.0.1:${port}`,
    ownerUuid: OWNER_UUID,
    logRunCalls,
    seedPrompt,
    seedUsage,
    readPromptRow,
    teardown,
  };
}
