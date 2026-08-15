// m3-07 e2e harness: a REAL disposable local PostgreSQL 16 database (this
// sandbox's already-running cluster, same `sudo -n -u postgres psql`
// mechanism as ./registry-fixture.ts) with the REAL `intake` schema applied
// byte-for-byte from every migration already committed under
// apps/toolbelt/apps/idea-intake/supabase/migrations/ -- so
// intake.guard_idea_insert/update/delete (the II-1/II-3 state-machine and
// immutability triggers) and intake.mark_submitted_to_github (the
// service-role-only write-back RPC) all fire for real, not as a
// reimplementation.
//
// A small local HTTP server then answers the exact PostgREST-shaped
// requests this repo's own two real callers send -- apps/shell/frontend/src/lib/intake.ts
// (GET/POST/PATCH/DELETE .../rest/v1/idea, caller-JWT-shaped) and
// services/llm-handler/src/postgrest.ts (the same GET, plus
// POST .../rpc/mark_submitted_to_github, service-role-key-shaped) -- by
// running REAL SQL against the REAL database above and returning REAL rows
// as JSON. RLS itself is not exercised (every query here runs as the
// `postgres` superuser, which bypasses RLS by definition, mirroring
// registry-fixture.ts's own accepted scope); the state-machine triggers,
// CHECK constraints, and the RPC's own logic are all real and unmodified.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  REPO_ROOT,
  pgQuote,
  psqlFile,
  psqlInline,
  psqlScalar,
  sudoPostgres,
  uniqueDbName,
} from "./psql.js";
import { sqlErrorToShimError, type ShimError } from "./shim.js";

const INTAKE_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/toolbelt/apps/idea-intake/supabase/migrations");
const PLATFORM_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/toolbelt/supabase/migrations");

// Chronological order, exactly as committed -- see this file's header for
// why platform_owner_bootstrap is included (intake_create_schema.sql's own
// RLS policies reference `platform.owner()` by name, so the function must
// exist for `create policy` to parse, even though this fixture's raw-SQL
// superuser calls never actually evaluate it).
const REAL_MIGRATIONS = [
  { dir: PLATFORM_MIGRATIONS_DIR, file: "20260812140000_platform_owner_bootstrap.sql" },
  { dir: INTAKE_MIGRATIONS_DIR, file: "20260813002605_intake_create_schema.sql" },
  { dir: INTAKE_MIGRATIONS_DIR, file: "20260814040000_intake_mark_submitted_to_github_rpc.sql" },
  { dir: INTAKE_MIGRATIONS_DIR, file: "20260814050000_intake_forgepad_source_dedup.sql" },
  { dir: INTAKE_MIGRATIONS_DIR, file: "20260814090000_intake_idea_source_update_grant.sql" },
  { dir: INTAKE_MIGRATIONS_DIR, file: "20260814100000_intake_optimization_fk_cascade_and_indexes.sql" },
  { dir: INTAKE_MIGRATIONS_DIR, file: "20260814120000_intake_submission_metadata_integrity.sql" },
  { dir: INTAKE_MIGRATIONS_DIR, file: "20260814120100_intake_forgepad_idempotency_key.sql" },
];

// Matches ./e2e/support/auth.ts's FIXTURE_USER_ID -- narrative consistency
// only (auth.uid() below is a fixed SQL function, never actually derived
// from the fixture bearer token; see this file's header).
export const OWNER_UUID = "00000000-0000-4000-8000-000000000099";
export const FIXTURE_SERVICE_ROLE_KEY = "fixture-e2e-service-role-key";

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
  -- intake_create_schema.sql's own last statement ("alter role authenticator
  -- set pgrst.db_schemas = ...", mirroring every other schema-exposure
  -- migration in this repo) needs this role to exist. This sandbox's
  -- persistent Postgres cluster already had it from other fixtures/prior
  -- runs, which hid this gap locally; a fresh CI runner's Postgres does not.
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator;
  end if;
end
$$;
`;

// auth.uid() returns the FIXED owner UUID (unlike registry-fixture.ts's
// null): intake.idea.user_id is `not null references auth.users(id) default
// auth.uid()`, so a real, FK-satisfiable value is required for every real
// INSERT this fixture's shim performs.
const BOOTSTRAP_AUTH_SQL = `
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select '${OWNER_UUID}'::uuid $$;
insert into auth.users (id) values ('${OWNER_UUID}');
`;

/** Runs `sql` and returns its single-column, single-row text output (`-t -A`), or throws with the raised message on failure. */
function pgLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return pgQuote(String(value));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only columns the two real callers ever send -- an unrecognized key is a bug in the fixture or the caller, never silently accepted. */
const WRITABLE_COLUMNS = new Set([
  "parent_idea_id",
  "title",
  "problem",
  "outcome",
  "notes",
  "confidence",
  "source",
  "target_repo",
  "status",
]);

const ROW_SELECT = `
  select i.id, i.parent_idea_id, i.title, i.problem, i.outcome, i.notes, i.confidence, i.status, i.source,
         i.target_repo, i.idempotency_key, i.github_issue_number, i.github_issue_url, i.submitted_at,
         i.created_at, i.updated_at,
         case when p.id is not null then json_build_object('github_issue_url', p.github_issue_url) else null end as parent
  from intake.idea i
  left join intake.idea p on p.id = i.parent_idea_id
`;

export interface IntakeFixture {
  dbName: string;
  shimBaseUrl: string;
  ownerUuid: string;
  serviceRoleKey: string;
  /** Directly inserts a fully submitted idea via real SQL (bypassing the API), for locked-rendering fixtures. */
  seedSubmittedIdea(fields: {
    title: string;
    problem: string;
    outcome: string;
    targetRepo: string;
    githubIssueNumber: number;
    githubIssueUrl: string;
  }): string;
  seedDraftDerivative(parentId: string | null, fields: { title: string; targetRepo: string | null }): string;
  readIdeaRow(id: string): Record<string, unknown> | null;
  teardown(): void;
}

export async function setupIntakeFixture(): Promise<IntakeFixture> {
  const dbName = uniqueDbName("m3_07_shell_intake_e2e");
  sudoPostgres(["createdb", dbName]);

  psqlInline(dbName, BOOTSTRAP_ROLES_SQL);
  psqlInline(dbName, BOOTSTRAP_AUTH_SQL);
  for (const { dir, file } of REAL_MIGRATIONS) {
    psqlFile(dbName, path.join(dir, file));
  }

  function selectRows(whereSql: string, orderSql: string, limitSql: string): unknown[] {
    const sql = `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text from (
      ${ROW_SELECT} ${whereSql} ${orderSql} ${limitSql}
    ) t;`;
    return JSON.parse(psqlScalar(dbName, sql)) as unknown[];
  }

  function handleGet(url: URL): { status: number; body: unknown } {
    const where: string[] = [];
    const id = url.searchParams.get("id");
    if (id !== null) {
      const m = /^eq\.(.+)$/.exec(id);
      if (!m || !UUID_RE.test(m[1]!)) return { status: 400, body: { message: "intake-fixture shim: bad id filter" } };
      where.push(`i.id = ${pgQuote(m[1]!)}`);
    }
    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const orderSql = url.searchParams.get("order") === "updated_at.desc" ? "order by i.updated_at desc" : "";
    const limitParam = url.searchParams.get("limit");
    const limitN = limitParam !== null ? Number.parseInt(limitParam, 10) : null;
    const limitSql = limitN !== null && Number.isFinite(limitN) ? `limit ${limitN}` : "";
    return { status: 200, body: selectRows(whereSql, orderSql, limitSql) };
  }

  function handlePost(bodyText: string): { status: number; body: unknown } {
    const payload = JSON.parse(bodyText || "{}") as Record<string, unknown>;
    const columns = Object.keys(payload).filter((k) => {
      if (!WRITABLE_COLUMNS.has(k)) throw new Error(`intake-fixture shim: refusing unexpected insert column "${k}"`);
      return true;
    });
    try {
      // A data-modifying statement can only be read back via a WITH CTE,
      // never as a plain `from (insert ...) t` subquery (not valid SQL) --
      // see this repo's own prior finding on the sibling gotcha (a DELETE's
      // results not being visible to the SAME statement's ON CONFLICT
      // check) for why this file is deliberate about single-purpose CTEs.
      const insertSql = `
        with ins as (
          insert into intake.idea (${columns.join(",")})
          values (${columns.map((c) => pgLiteral(payload[c])).join(",")})
          returning id
        )
        select id::text from ins;
      `;
      const newId = psqlScalar(dbName, insertSql);
      return { status: 201, body: selectRows(`where i.id = ${pgQuote(newId)}`, "", "") };
    } catch (err) {
      const shimErr = sqlErrorToShimError(err);
      return { status: shimErr.status, body: { message: shimErr.message } };
    }
  }

  function handlePatch(url: URL, bodyText: string): { status: number; body: unknown } {
    const idParam = url.searchParams.get("id");
    const m = idParam ? /^eq\.(.+)$/.exec(idParam) : null;
    if (!m || !UUID_RE.test(m[1]!)) return { status: 400, body: { message: "intake-fixture shim: bad id filter" } };
    const id = m[1]!;
    const payload = JSON.parse(bodyText || "{}") as Record<string, unknown>;
    const columns = Object.keys(payload).filter((k) => {
      if (!WRITABLE_COLUMNS.has(k)) throw new Error(`intake-fixture shim: refusing unexpected update column "${k}"`);
      return true;
    });
    if (columns.length === 0) return { status: 200, body: selectRows(`where i.id = ${pgQuote(id)}`, "", "") };
    try {
      const setSql = columns.map((c) => `${c} = ${pgLiteral(payload[c])}`).join(", ");
      sudoPostgres([
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        dbName,
        "-c",
        `update intake.idea set ${setSql} where id = ${pgQuote(id)};`,
      ]);
      return { status: 200, body: selectRows(`where i.id = ${pgQuote(id)}`, "", "") };
    } catch (err) {
      const shimErr = sqlErrorToShimError(err);
      return { status: shimErr.status, body: { message: shimErr.message } };
    }
  }

  function handleDelete(url: URL): { status: number; body: unknown } {
    const idParam = url.searchParams.get("id");
    const m = idParam ? /^eq\.(.+)$/.exec(idParam) : null;
    if (!m || !UUID_RE.test(m[1]!)) return { status: 400, body: { message: "intake-fixture shim: bad id filter" } };
    try {
      sudoPostgres(["psql", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-c", `delete from intake.idea where id = ${pgQuote(m[1]!)};`]);
      return { status: 204, body: null };
    } catch (err) {
      const shimErr = sqlErrorToShimError(err);
      return { status: shimErr.status, body: { message: shimErr.message } };
    }
  }

  function handleMarkSubmitted(headers: IncomingMessage["headers"], bodyText: string): { status: number; body: unknown } {
    const auth = String(headers.authorization ?? "");
    if (auth !== `Bearer ${FIXTURE_SERVICE_ROLE_KEY}`) {
      return { status: 401, body: { message: "intake-fixture shim: mark_submitted_to_github requires the service-role key" } };
    }
    const payload = JSON.parse(bodyText || "{}") as { p_idea_id: string; p_issue_number: number; p_issue_url: string };
    try {
      const sql = `select row_to_json(t)::text from intake.mark_submitted_to_github(
        ${pgQuote(payload.p_idea_id)}, ${Number(payload.p_issue_number)}, ${pgQuote(payload.p_issue_url)}
      ) t;`;
      const row = JSON.parse(psqlScalar(dbName, sql)) as unknown;
      return { status: 200, body: row };
    } catch (err) {
      const shimErr = sqlErrorToShimError(err);
      return { status: shimErr.status, body: { message: shimErr.message } };
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let result: { status: number; body: unknown };
        if (url.pathname === "/rest/v1/idea" && req.method === "GET") {
          result = handleGet(url);
        } else if (url.pathname === "/rest/v1/idea" && req.method === "POST") {
          result = handlePost(bodyText);
        } else if (url.pathname === "/rest/v1/idea" && req.method === "PATCH") {
          result = handlePatch(url, bodyText);
        } else if (url.pathname === "/rest/v1/idea" && req.method === "DELETE") {
          result = handleDelete(url);
        } else if (url.pathname === "/rest/v1/rpc/mark_submitted_to_github" && req.method === "POST") {
          result = handleMarkSubmitted(req.headers, bodyText);
        } else if (url.pathname === "/rest/v1/rpc/is_platform_owner" && req.method === "POST") {
          // Server-side (Handler A) counterpart to ./auth.ts's mockAuth,
          // which only intercepts the BROWSER's own copy of this call.
          result = { status: 200, body: true };
        } else {
          result = { status: 404, body: { message: "not found" } };
        }
        if (result.status === 204) {
          res.writeHead(204).end();
          return;
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
        reject(new Error("intake-fixture: shim server did not report a port"));
        return;
      }
      resolve(address.port);
    });
  });

  function seedSubmittedIdea(fields: {
    title: string;
    problem: string;
    outcome: string;
    targetRepo: string;
    githubIssueNumber: number;
    githubIssueUrl: string;
  }): string {
    const id = psqlScalar(
      dbName,
      `with ins as (
        insert into intake.idea (title, problem, outcome, status, target_repo)
        values (${pgQuote(fields.title)}, ${pgQuote(fields.problem)}, ${pgQuote(fields.outcome)}, 'draft', ${pgQuote(fields.targetRepo)})
        returning id
      )
      select id::text from ins;`
    );
    psqlInline(dbName, `update intake.idea set status = 'idea' where id = ${pgQuote(id)};`);
    psqlScalar(
      dbName,
      `select id::text from intake.mark_submitted_to_github(${pgQuote(id)}, ${fields.githubIssueNumber}, ${pgQuote(fields.githubIssueUrl)});`
    );
    return id;
  }

  /** Inserts a draft directly via real SQL, optionally forking a submitted
   * parent (intake.guard_idea_insert only allows parent_idea_id when the
   * parent is already submitted_to_github -- II-3) -- the create-derivative
   * UI itself is m4-06 scope, out of bounds here. */
  function seedDraftDerivative(parentId: string | null, fields: { title: string; targetRepo: string | null }): string {
    const columns = ["title"];
    const values = [pgQuote(fields.title)];
    if (parentId !== null) {
      columns.push("parent_idea_id");
      values.push(pgQuote(parentId));
    }
    if (fields.targetRepo !== null) {
      columns.push("target_repo");
      values.push(pgQuote(fields.targetRepo));
    }
    return psqlScalar(
      dbName,
      `with ins as (
        insert into intake.idea (${columns.join(",")})
        values (${values.join(",")})
        returning id
      )
      select id::text from ins;`
    );
  }

  function readIdeaRow(id: string): Record<string, unknown> | null {
    const rows = selectRows(`where i.id = ${pgQuote(id)}`, "", "") as Record<string, unknown>[];
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
    serviceRoleKey: FIXTURE_SERVICE_ROLE_KEY,
    seedSubmittedIdea,
    seedDraftDerivative,
    readIdeaRow,
    teardown,
  };
}
