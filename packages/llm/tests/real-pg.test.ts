// m4-04: real-Postgres proof that packages/llm/src/prompt-client.ts is
// correctly wired to the real `prompt.get_prompt` and
// `prompt.get_prompt_source` RPCs and speaks the cache's conditional wire
// protocol -- not just a hand-rolled fetch mock that could
// silently diverge from what PostgREST actually returns.
//
// This session's own testing bar asked for exactly this: apply the real
// committed prompt-organizer migrations to a local PostgreSQL 16 instance
// and either point a real PostgREST process at it or build a lightweight
// local HTTP shim answering the two RPC endpoints this client calls, backed
// by real SQL. No `postgrest` binary is
// installed in this sandbox (confirmed: `which postgrest` finds nothing), so
// this file takes the shim route, following
// apps/shell/frontend/e2e/support/registry-fixture.ts's (m3-04) established pattern:
// a real disposable database, real migrations applied verbatim via `psql
// -f`, and a tiny node:http server that turns PostgREST-shaped querystrings
// into real SQL against that real database.
//
// Migration list, HARNESS_SQL, and the psql/detection helpers below are
// adapted from apps/toolbelt/apps/prompt-organizer/backend/tests/get-prompt.test.mjs
// (m4-03's own real-Postgres suite for this exact RPC) -- same migration
// files, same order, same local-auth-schema stub, same skip mechanics --
// because that file is the authoritative source for "how to stand up this
// schema on a bare Postgres 16." What's new here is the HTTP shim layer and
// wiring the REAL packages/llm client (not hand-called SQL) against it, plus
// mapping the RPCs' raised PT404/PT422 SQLSTATEs to HTTP status codes the
// way PostgREST itself does (a raised exception with SQLSTATE `PTnnn` maps
// directly to HTTP status `nnn` -- confirmed against the render_prompt
// endpoint over live Supabase in render-endpoint.test.mjs's own PT404/PT422
// assertions, which is the same mapping this shim reproduces here).
//
// apps/toolbelt/** itself is untouched by this file: it only reads real
// migration files from disk, the same read-only relationship
// registry-fixture.ts already has with apps/toolbelt's migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPromptClient, MissingVariablesError, PromptNotFoundError } from "../src/prompt-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const ROOT_MIGRATIONS_DIR = join(REPO_ROOT, "apps", "toolbelt", "supabase", "migrations");
const PO_MIGRATIONS_DIR = join(REPO_ROOT, "apps", "toolbelt", "apps", "prompt-organizer", "supabase", "migrations");
const PLATFORM_BOOTSTRAP_UP = join(ROOT_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");

// Verbatim from get-prompt.test.mjs: the exact real migration files, in
// order, that build this schema on a bare Postgres 16. See that file's own
// header comment for why 20260812210000_prompt_usage_retention.sql is
// deliberately excluded (pg_cron is not installed in this sandbox, and
// get_prompt reads nothing that migration creates).
const PO_MIGRATIONS_IN_ORDER = [
  "20260807020000_prompt_create_prompt.sql",
  "20260807041000_prompt_versions_and_unique_title.sql",
  "20260807051000_prompt_create_tag.sql",
  "20260807070000_prompt_create_usage.sql",
  "20260808000000_prompt_add_is_active.sql",
  "20260808100000_prompt_create_configuration.sql",
  "20260808130000_prompt_create_render_function.sql",
  "20260812180000_prompt_owner_pin.sql",
  "20260812200000_prompt_observed_query_indexes.sql",
  "20260813120000_prompt_create_get_prompt_function.sql",
  "20260813140000_prompt_security_hardening.sql",
  "20260813150000_prompt_create_get_prompt_source_function.sql",
];

test("real Postgres fixture applies prompt security hardening immediately before the cache-source RPC", () => {
  const hardeningIndex = PO_MIGRATIONS_IN_ORDER.indexOf("20260813140000_prompt_security_hardening.sql");
  const sourceIndex = PO_MIGRATIONS_IN_ORDER.indexOf("20260813150000_prompt_create_get_prompt_source_function.sql");
  assert.ok(hardeningIndex >= 0, "the source RPC requires the prompt_get_agent role created by the security-hardening migration");
  assert.equal(sourceIndex, hardeningIndex + 1);
});

const OWNER_UUID = "9a50a35a-8a1e-4f0c-8495-7f26777982d8";
const STRANGER_UUID = "b2222222-2222-4222-8222-222222222222";

const HARNESS_SQL = `
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

insert into auth.users (id) values ('${OWNER_UUID}'), ('${STRANGER_UUID}');
`;

const OWNER_BOOTSTRAP_SQL = `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`;

function tryRunner(cmd: string, args: string[]): boolean {
  try {
    const result = spawnSync(cmd, [...args, "-d", "postgres", "-tAc", "select 1;"], { encoding: "utf8", timeout: 5000 });
    return result.status === 0 && result.stdout.trim() === "1";
  } catch {
    return false;
  }
}

function detectRunner(): { cmd: string; args: string[] } | null {
  if (tryRunner("psql", [])) return { cmd: "psql", args: [] };
  if (tryRunner("sudo", ["-n", "-u", "postgres", "psql"])) return { cmd: "sudo", args: ["-n", "-u", "postgres", "psql"] };
  return null;
}

const RUNNER = detectRunner();
const SKIP_REASON = RUNNER
  ? false
  : "no local Postgres reachable (tried direct `psql` and `sudo -n -u postgres psql`); this suite has nothing honest to " +
    "assert against without a reachable engine to apply the real prompt-organizer migrations to";

function psql(dbName: string, sqlText: string) {
  return spawnSync(
    RUNNER!.cmd,
    [...RUNNER!.args, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-tA", "-q"],
    { encoding: "utf8", input: sqlText, timeout: 20000 },
  );
}

function psqlOk(dbName: string, sqlText: string): string {
  const result = psql(dbName, sqlText);
  assert.equal(result.status, 0, `psql failed against ${dbName}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

// Same retry-on-contention wrapper as get-prompt.test.mjs (20260807020000
// sets a role-wide GUC that other concurrently-applying scratch databases in
// this same sandbox can contend on).
function applyMigrationWithRetry(dbName: string, sqlText: string, attempts = 5): string {
  const wrapped = `begin;\n${sqlText}\ncommit;\n`;
  let lastResult;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastResult = psql(dbName, wrapped);
    if (lastResult.status === 0) return lastResult.stdout;
    if (!/tuple concurrently updated/.test(lastResult.stderr || "")) break;
  }
  assert.equal(lastResult!.status, 0, `psql failed against ${dbName}: ${lastResult!.stderr || lastResult!.stdout}`);
  return lastResult!.stdout;
}

function asAuthenticated(uuid: string, sqlText: string): string {
  return `set role authenticated;\ndo $$ begin perform set_config('app.test_uid', '${uuid}', false); end $$;\n${sqlText}`;
}

function freshDbName(): string {
  return `m4_04_prompt_client_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function migrateDb(): string {
  const db = freshDbName();
  psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
  psqlOk(db, HARNESS_SQL);
  psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
  psqlOk(db, OWNER_BOOTSTRAP_SQL);
  for (const name of PO_MIGRATIONS_IN_ORDER) {
    const sql = readFileSync(join(PO_MIGRATIONS_DIR, name), "utf8");
    if (name === "20260807020000_prompt_create_prompt.sql") applyMigrationWithRetry(db, sql);
    else psqlOk(db, sql);
  }
  return db;
}

function dropDb(db: string): void {
  psqlOk("postgres", `drop database if exists ${db};`);
}

// ---------------------------------------------------------------------------
// SQL literal builders for the shim's own generated psql calls. Dollar
// quoting (a fixed, unlikely-to-collide tag) sidesteps hand-rolled
// quote-escaping bugs for arbitrary text/JSON payloads coming off the wire.
// ---------------------------------------------------------------------------

function pgLit(value: string): string {
  return `$pglit$${value}$pglit$`;
}
function pgNullableText(value: unknown): string {
  return value === null || value === undefined ? "null" : pgLit(String(value));
}
function pgNullableInt(value: unknown): string {
  return value === null || value === undefined ? "null" : String(Number(value));
}
function pgNullableJsonb(value: unknown): string {
  return value === null || value === undefined ? "null" : `${pgLit(JSON.stringify(value))}::jsonb`;
}
function pgNullableTextArray(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const arr = value as string[];
  return `array[${arr.map((v) => pgLit(v)).join(",")}]::text[]`;
}
// ---------------------------------------------------------------------------
// The shim: a real node:http server answering exactly the two RPC request
// shapes prompt-client.ts issues, each turned into a real SQL statement run with `psql`
// against the real migrated database, as the `authenticated` role with
// auth.uid() pinned from the request's own Bearer token (mirroring what
// PostgREST + GoTrue do per-request). The Bearer token IS the uuid string in
// this harness -- there is no real GoTrue here, and prompt-client.ts never
// interprets the token itself, it only forwards it as an Authorization
// header, so a plain uuid-as-token is sufficient to prove the RPC's real
// owner authorization end to end.
// ---------------------------------------------------------------------------

interface RpcResult {
  status: number;
  body: unknown;
}

function runGetPromptRpc(dbName: string, uid: string, args: Record<string, unknown>): RpcResult {
  const argsSql = [
    pgNullableText(args.p_name),
    pgNullableInt(args.p_version),
    pgNullableText(args.p_config),
    pgNullableJsonb(args.p_values),
    pgNullableTextArray(args.p_sections),
  ].join(", ");
  const result = psql(dbName, asAuthenticated(uid, `select prompt.get_prompt(${argsSql});`));
  return mapSqlRpcResult(result);
}

function runGetPromptSourceRpc(dbName: string, uid: string, args: Record<string, unknown>): RpcResult {
  const argsSql = [pgNullableText(args.p_name), pgNullableInt(args.p_version), pgNullableInt(args.p_if_version)].join(", ");
  const result = psql(dbName, asAuthenticated(uid, `select prompt.get_prompt_source(${argsSql});`));
  return mapSqlRpcResult(result);
}

function mapSqlRpcResult(result: ReturnType<typeof psql>): RpcResult {
  if (result.status === 0) {
    return { status: 200, body: JSON.parse(result.stdout.trim()) };
  }
  const stderr = result.stderr || "";
  const codeMatch = /\b(PT\d{3})\b/.exec(stderr);
  if (codeMatch) {
    const status = Number(codeMatch[1]!.slice(2));
    const messageMatch = /ERROR:\s+PT\d{3}:\s*(.+)/.exec(stderr);
    return { status, body: { code: codeMatch[1], message: (messageMatch ? messageMatch[1] : stderr).trim() } };
  }
  return { status: 400, body: { code: "42000", message: stderr.trim() || "unknown error" } };
}

interface Shim {
  baseUrl: string;
  requestCount: number;
  requestLog: string[];
  close(): Promise<void>;
}

async function startShim(dbName: string): Promise<Shim> {
  const state = { requestCount: 0, requestLog: [] as string[] };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      state.requestCount += 1;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      state.requestLog.push(`${req.method} ${url.pathname}${url.search}`);
      const auth = req.headers.authorization ?? "";
      const uid = auth.startsWith("Bearer ") ? auth.slice(7) : "";

      try {
        let result: RpcResult;
        if (req.method === "POST" && (url.pathname === "/rest/v1/rpc/get_prompt" || url.pathname === "/rest/v1/rpc/get_prompt_source")) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          result = url.pathname === "/rest/v1/rpc/get_prompt"
            ? runGetPromptRpc(dbName, uid, args)
            : runGetPromptSourceRpc(dbName, uid, args);
        } else {
          result = { status: 404, body: { message: `unhandled shim route: ${req.method} ${url.pathname}` } };
        }
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("real-pg shim: server did not report a port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requestCount() {
      return state.requestCount;
    },
    get requestLog() {
      return state.requestLog;
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function withRealBackedClient(fn: (ctx: { dbName: string; shim: Shim; asOwner: ReturnType<typeof createPromptClient>; ownerToken: string }) => Promise<void>): Promise<void> {
  const dbName = migrateDb();
  const shim = await startShim(dbName);
  try {
    const asOwner = createPromptClient(shim.baseUrl, async () => OWNER_UUID);
    await fn({ dbName, shim, asOwner, ownerToken: OWNER_UUID });
  } finally {
    await shim.close();
    dropDb(dbName);
  }
}

function insertPrompt(dbName: string, title: string, body: string): void {
  psqlOk(dbName, asAuthenticated(OWNER_UUID, `insert into prompt.prompt (title, body) values (${pgLit(title)}, ${pgLit(body)});`));
}

function updatePromptBody(dbName: string, title: string, body: string): void {
  psqlOk(dbName, asAuthenticated(OWNER_UUID, `update prompt.prompt set body = ${pgLit(body)} where title = ${pgLit(title)};`));
}

function archivePrompt(dbName: string, title: string): void {
  psqlOk(dbName, asAuthenticated(OWNER_UUID, `update prompt.prompt set is_active = false where title = ${pgLit(title)};`));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(
  "real Postgres + shim: a pinned fetch through the real RPC populates the cache, then repeat calls with different variables render locally with zero shim requests",
  { skip: SKIP_REASON },
  async () => {
    await withRealBackedClient(async ({ dbName, shim, asOwner }) => {
      insertPrompt(dbName, "m4-04/pinned-fixture", "Hello {{NAME}}, repo is {{REPO}}.");

      const first = await asOwner.getPrompt("m4-04/pinned-fixture", { version: 1, variables: { NAME: "A", REPO: "toolbelt" } });
      assert.equal(first.text, "Hello A, repo is toolbelt.");
      assert.equal(first.version, 1);
      const requestsAfterFirst = shim.requestCount;
      assert.equal(requestsAfterFirst, 1, "the miss must use one atomic cache-source RPC");
      assert.deepEqual(shim.requestLog, ["POST /rest/v1/rpc/get_prompt_source"]);

      const second = await asOwner.getPrompt("m4-04/pinned-fixture", { version: 1, variables: { NAME: "B", REPO: "toolbelt" } });
      assert.equal(second.text, "Hello B, repo is toolbelt.", "must reflect the NEW variables via a real local render, not stale text");
      assert.equal(shim.requestCount, requestsAfterFirst, "the second pinned call must issue zero additional HTTP requests to the shim");
    });
  },
);

test("real Postgres + shim: an unknown prompt name maps the real PT404 raise to PromptNotFoundError", { skip: SKIP_REASON }, async () => {
  await withRealBackedClient(async ({ asOwner }) => {
    await assert.rejects(() => asOwner.getPrompt(`m4-04/does-not-exist-${Date.now()}`), PromptNotFoundError);
  });
});

test(
  "real Postgres + shim: a missing variable in the real source body maps to MissingVariablesError locally",
  { skip: SKIP_REASON },
  async () => {
    await withRealBackedClient(async ({ dbName, asOwner }) => {
      insertPrompt(dbName, "m4-04/needs-var", "{{A}} needs {{B}}");
      await assert.rejects(
        () => asOwner.getPrompt("m4-04/needs-var", { version: 1, variables: { A: "x" } }),
        (err: unknown) => {
          assert.ok(err instanceof MissingVariablesError);
          assert.deepEqual(err.missing, ["B"]);
          return true;
        },
      );
    });
  },
);

test("real Postgres + shim: a different authenticated user is denied before source data can leak", { skip: SKIP_REASON }, async () => {
  await withRealBackedClient(async ({ dbName, shim }) => {
    insertPrompt(dbName, "m4-04/owner-only", "no vars here");
    const asStranger = createPromptClient(shim.baseUrl, async () => STRANGER_UUID);
    await assert.rejects(() => asStranger.getPrompt("m4-04/owner-only"), /400/);
    assert.deepEqual(shim.requestLog, ["POST /rest/v1/rpc/get_prompt_source"]);
  });
});

test(
  "real Postgres + shim: one conditional source RPC revalidates name@latest against a REAL version bump",
  { skip: SKIP_REASON },
  async () => {
    await withRealBackedClient(async ({ dbName, shim }) => {
      insertPrompt(dbName, "m4-04/latest-fixture", "v1 body {{X}}");
      const client = createPromptClient(shim.baseUrl, async () => OWNER_UUID, { latestTtlMs: 5 });

      const first = await client.getPrompt("m4-04/latest-fixture", { variables: { X: "y" } });
      assert.equal(first.version, 1);
      assert.equal(first.text, "v1 body y");
      const requestsAfterFirst = shim.requestCount;

      updatePromptBody(dbName, "m4-04/latest-fixture", "v2 body {{X}}"); // real UPDATE; record_version trigger fires for real

      await new Promise((resolve) => setTimeout(resolve, 25)); // cross the TTL boundary

      const second = await client.getPrompt("m4-04/latest-fixture", { variables: { X: "z" } });
      assert.equal(second.version, 2, "must resolve the real new max version_no, not the stale cached one");
      assert.equal(second.text, "v2 body z");

      const revalidationLog = shim.requestLog.slice(requestsAfterFirst);
      assert.deepEqual(revalidationLog, ["POST /rest/v1/rpc/get_prompt_source"]);

      const requestsAfterSecond = shim.requestCount;
      const third = await client.getPrompt("m4-04/latest-fixture", { variables: { X: "w" } });
      assert.equal(third.text, "v2 body w");
      assert.equal(shim.requestCount, requestsAfterSecond, "the replaced cache entry must serve the next call with zero further requests");
    });
  },
);

test(
  "real Postgres + shim: conditional latest revalidation observes archival without a version bump",
  { skip: SKIP_REASON },
  async () => {
    await withRealBackedClient(async ({ dbName, shim }) => {
      insertPrompt(dbName, "m4-04/archive-latest", "active {{X}}");
      const client = createPromptClient(shim.baseUrl, async () => OWNER_UUID, { latestTtlMs: 5 });
      await client.getPrompt("m4-04/archive-latest", { variables: { X: "once" } });
      const requestsAfterFirst = shim.requestCount;

      archivePrompt(dbName, "m4-04/archive-latest");
      await new Promise((resolve) => setTimeout(resolve, 25));

      await assert.rejects(
        () => client.getPrompt("m4-04/archive-latest", { variables: { X: "stale" } }),
        PromptNotFoundError,
      );
      assert.deepEqual(shim.requestLog.slice(requestsAfterFirst), ["POST /rest/v1/rpc/get_prompt_source"]);
    });
  },
);

test(
  "real Postgres + shim: a pinned version stays immutable against a REAL later body update through get_prompt_source",
  { skip: SKIP_REASON },
  async () => {
    await withRealBackedClient(async ({ dbName, asOwner }) => {
      insertPrompt(dbName, "m4-04/pin-vs-latest", "v1 body {{X}}");
      const pinned = await asOwner.getPrompt("m4-04/pin-vs-latest", { version: 1, variables: { X: "y" } });
      assert.equal(pinned.text, "v1 body y");

      updatePromptBody(dbName, "m4-04/pin-vs-latest", "v2 body {{X}}"); // real UPDATE lands version 2

      const stillPinned = await asOwner.getPrompt("m4-04/pin-vs-latest", { version: 1, variables: { X: "z" } });
      assert.equal(stillPinned.text, "v1 body z", "the pinned version must keep resolving v1's real body forever, unaffected by the later real edit");
      assert.equal(stillPinned.version, 1);

      const latest = await asOwner.getPrompt("m4-04/pin-vs-latest", { variables: { X: "z" } });
      assert.equal(latest.version, 2, "an unpinned call, meanwhile, must see the real new latest version");
      assert.equal(latest.text, "v2 body z");
    });
  },
);
