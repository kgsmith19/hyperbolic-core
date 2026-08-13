import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListToolsParams, createRegistryClient } from "../src/registry.ts";

// Fixture data only; not a real project or credential.
const FIXTURE_URL = "https://fixture-project.supabase.invalid";
const FIXTURE_TOKEN = "fixture.session.token";

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function fixtureRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "prompt-organizer",
    name: "Prompt Organizer",
    schema_name: "prompt",
    status: "building",
    kind: "ui",
    route: "/prompts",
    version: "0.1.0",
    description: "Stores reusable AI prompts.",
    manifest_hash: "abc123",
    registered_at: "2026-08-07T04:00:00+00:00",
    ...overrides,
  };
}

// --- buildListToolsParams: pure filter-building logic -----------------------
// This is one of the two places the issue's own testing bar names as where a
// bug would silently leak or hide a tool (the other is the Shell's
// route-vs-status-page split, apps/shell/src/lib/registry.ts's splitByRoute).

test("buildListToolsParams: no filter omits status/kind entirely (unfiltered, not zero-match)", () => {
  const params = buildListToolsParams();
  assert.equal(params.get("status"), null);
  assert.equal(params.get("kind"), null);
  assert.equal(params.get("select"), "id,name,schema_name,status,kind,route,version,description,manifest_hash,registered_at");
});

test("buildListToolsParams: status filter becomes an in.(...) PostgREST param", () => {
  const params = buildListToolsParams({ status: ["building", "live"] });
  assert.equal(params.get("status"), "in.(building,live)");
});

test("buildListToolsParams: retired is never silently included when the caller didn't ask for it", () => {
  const params = buildListToolsParams({ status: ["building", "live"] });
  assert.ok(!params.get("status")!.includes("retired"));
});

test("buildListToolsParams: kind filter becomes an in.(...) PostgREST param", () => {
  const params = buildListToolsParams({ kind: ["ui", "hybrid"] });
  assert.equal(params.get("kind"), "in.(ui,hybrid)");
});

test("buildListToolsParams: both status and kind filters compose", () => {
  const params = buildListToolsParams({ status: ["live"], kind: ["cli"] });
  assert.equal(params.get("status"), "in.(live)");
  assert.equal(params.get("kind"), "in.(cli)");
});

test("buildListToolsParams: an empty status array omits the filter (does not degrade to in.() / zero-match)", () => {
  const params = buildListToolsParams({ status: [] });
  assert.equal(params.get("status"), null);
});

test("buildListToolsParams: always requests deterministic ordering", () => {
  const params = buildListToolsParams();
  assert.equal(params.get("order"), "id.asc");
});

// --- createRegistryClient: request shape -------------------------------------

test("listTools issues GET /rest/v1/app with apikey + Authorization headers and the built querystring", async (t) => {
  const spy = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, new URL(FIXTURE_URL).origin);
    assert.equal(url.pathname, "/rest/v1/app");
    assert.equal(url.searchParams.get("status"), "in.(building,live)");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${FIXTURE_TOKEN}`);
    assert.ok(headers.get("apikey"), "expected an apikey header to be present");
    return jsonResponse([fixtureRow()]);
  });

  const tools = await withPatchedFetch(spy, async () => {
    const client = createRegistryClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.listTools({ status: ["building", "live"] });
  });

  assert.equal(spy.mock.callCount(), 1);
  assert.equal(tools.length, 1);
});

test("a project override sends its matching publishable key instead of the default project key", async (t) => {
  const overrideUrl = "https://local-project.example";
  const overrideKey = "local-project-publishable-key";
  const spy = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new URL(String(input)).origin, overrideUrl);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), overrideKey);
    assert.equal(headers.get("authorization"), `Bearer ${FIXTURE_TOKEN}`);
    return jsonResponse([]);
  });

  await withPatchedFetch(spy, async () => {
    const client = createRegistryClient(overrideUrl, async () => FIXTURE_TOKEN, overrideKey);
    await client.listTools();
  });
  assert.equal(spy.mock.callCount(), 1);
});

test("an empty explicit publishable key fails before any request", () => {
  assert.throws(
    () => createRegistryClient(FIXTURE_URL, async () => FIXTURE_TOKEN, "  "),
    /publishable key is required/,
  );
});

test("listTools maps snake_case PostgREST columns to the RegisteredTool camelCase shape exactly", async (t) => {
  const spy = t.mock.fn(async () =>
    jsonResponse([
      fixtureRow({
        id: "network-checker",
        name: "Network Checker",
        schema_name: "netcheck",
        status: "building",
        kind: "cli",
        route: null,
        version: "0.1.0",
        description: "Local-first network diagnostics.",
        manifest_hash: "def456",
        registered_at: null,
      }),
    ])
  );

  const [tool] = await withPatchedFetch(spy, async () => {
    const client = createRegistryClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.listTools();
  });

  assert.deepEqual(tool, {
    id: "network-checker",
    name: "Network Checker",
    schemaName: "netcheck",
    status: "building",
    kind: "cli",
    route: null,
    version: "0.1.0",
    description: "Local-first network diagnostics.",
    manifestHash: "def456",
    registeredAt: null,
  });
});

test("getTool sends an id=eq.<id> filter and limit=1", async (t) => {
  const spy = t.mock.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("id"), "eq.idea-intake");
    assert.equal(url.searchParams.get("limit"), "1");
    return jsonResponse([fixtureRow({ id: "idea-intake", name: "Idea Intake", route: "/ideas" })]);
  });

  const tool = await withPatchedFetch(spy, async () => {
    const client = createRegistryClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.getTool("idea-intake");
  });

  assert.equal(spy.mock.callCount(), 1);
  assert.equal(tool?.id, "idea-intake");
});

test("getTool resolves null (not throw) when PostgREST returns zero rows", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse([]));

  const tool = await withPatchedFetch(spy, async () => {
    const client = createRegistryClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.getTool("does-not-exist");
  });

  assert.equal(tool, null);
});

test("a non-ok PostgREST response rejects with a descriptive error, never a swallowed empty list", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse({ message: "permission denied" }, 401));

  await withPatchedFetch(spy, async () => {
    const client = createRegistryClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await assert.rejects(() => client.listTools(), /401/);
  });
});

test("getAccessToken rejecting (no session) reaches zero network calls, fail-closed like AuthedFetch", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse([]));

  await withPatchedFetch(spy, async () => {
    const client = createRegistryClient(FIXTURE_URL, async () => {
      throw new Error("no active session");
    });
    await assert.rejects(() => client.listTools());
  });

  assert.equal(spy.mock.callCount(), 0);
});
