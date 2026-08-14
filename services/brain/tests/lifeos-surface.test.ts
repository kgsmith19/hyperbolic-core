// M4-20 / LO-4: createLifeOsSurface against a mocked global fetch -- no
// live LifeOS instance touched. Asserts the request shape (method, path,
// bearer header, body) each method sends and that snake_case LifeOS JSON
// is mapped to the camelCase contract shape from 05-e-lifeos.md section 3.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLifeOsSurface,
  LifeOsRequestError,
  type LifeOsSurface,
} from "../src/lifeos-surface.ts";

// LO-4a's own verification bullet, satisfied at compile time (`tsc -b`):
// if a method is ever added or removed, this line stops compiling because
// the two key sets no longer mutually extend each other.
type ExpectedMethod = "search" | "getEntity" | "getHistory" | "listTypes" | "proposeAction";
type ExactlyExpectedMethods = [ExpectedMethod] extends [keyof LifeOsSurface]
  ? [keyof LifeOsSurface] extends [ExpectedMethod]
    ? true
    : never
  : never;
const _typeLevelExactlyFiveMethods: ExactlyExpectedMethods = true;
void _typeLevelExactlyFiveMethods;

const CONFIG = { baseUrl: "https://lifeos.example.invalid", agentToken: "agent-token-test" };

function mockFetch(t: import("node:test").TestContext, handler: (url: string, init?: RequestInit) => Response) {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return handler(url, init);
  });
  return {
    url: () => capturedUrl,
    init: () => capturedInit,
  };
}

test("LifeOsSurface: runtime shape also has exactly 5 methods, matching the compile-time check above", () => {
  const surface = createLifeOsSurface(CONFIG);
  assert.deepEqual(
    Object.keys(surface).sort(),
    ["getEntity", "getHistory", "listTypes", "proposeAction", "search"].sort()
  );
});

test("search: sends only `text`, never a domain param, and maps snake_case rows to EntitySummary", async (t) => {
  const captured = mockFetch(t, () =>
    Response.json([
      { id: "e1", name: "Acme bill", attributes: { total: 12 }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
    ])
  );
  const surface = createLifeOsSurface(CONFIG);

  const results = await surface.search("acme", { domain: "bills" });

  const url = new URL(captured.url()!);
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("text"), "acme");
  assert.equal(url.searchParams.has("domain"), false, "no server-side domain filter exists; forwarding it would silently misfilter");
  assert.equal((captured.init()!.headers as Record<string, string>).Authorization, "Bearer agent-token-test");
  assert.deepEqual(results, [{ id: "e1", name: "Acme bill", attributes: { total: 12 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" }]);
});

test("search: opts.limit slices the result client-side (the API has no limit param)", async (t) => {
  mockFetch(t, () =>
    Response.json(
      Array.from({ length: 5 }, (_, i) => ({
        id: `e${i}`,
        name: null,
        attributes: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }))
    )
  );
  const surface = createLifeOsSurface(CONFIG);

  const results = await surface.search("x", { limit: 2 });

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.id), ["e0", "e1"]);
});

test("getEntity: GETs /entities/{id} and maps entity + both edge directions", async (t) => {
  const captured = mockFetch(t, () =>
    Response.json({
      entity: { id: "e1", name: "Acme bill", attributes: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      types: ["bill"],
      edges_out: [
        {
          id: "edge1",
          from_entity: "e1",
          relation: "disputes",
          to_entity: "e2",
          attributes: {},
          valid_from: "2026-01-01T00:00:00Z",
          valid_to: null,
          recorded_at: "2026-01-01T00:00:00Z",
          superseded_at: null,
        },
      ],
      edges_in: [],
    })
  );
  const surface = createLifeOsSurface(CONFIG);

  const detail = await surface.getEntity("e1");

  assert.equal(new URL(captured.url()!).pathname, "/entities/e1");
  assert.equal(detail.entity.id, "e1");
  assert.deepEqual(detail.types, ["bill"]);
  assert.equal(detail.edgesOut.length, 1);
  assert.equal(detail.edgesOut[0]!.fromEntity, "e1");
  assert.equal(detail.edgesOut[0]!.toEntity, "e2");
  assert.deepEqual(detail.edgesIn, []);
});

test("getEntity: URL-encodes the id into the path", async (t) => {
  const captured = mockFetch(t, () =>
    Response.json({ entity: { id: "a/b", name: null, attributes: {}, created_at: "x", updated_at: "x" }, types: [], edges_out: [], edges_in: [] })
  );
  const surface = createLifeOsSurface(CONFIG);
  await surface.getEntity("a/b");
  assert.equal(new URL(captured.url()!).pathname, "/entities/a%2Fb");
});

test("getHistory: GETs /entities/{id}/history and maps events", async (t) => {
  const captured = mockFetch(t, () =>
    Response.json([
      {
        id: "ev1",
        entity_id: "e1",
        event_type: "captured",
        payload: { a: 1 },
        valid_time: "2026-01-01T00:00:00Z",
        recorded_at: "2026-01-01T00:00:01Z",
        actor: "agent:brain",
      },
    ])
  );
  const surface = createLifeOsSurface(CONFIG);

  const events = await surface.getHistory("e1");

  assert.equal(new URL(captured.url()!).pathname, "/entities/e1/history");
  assert.deepEqual(events, [
    { id: "ev1", entityId: "e1", eventType: "captured", payload: { a: 1 }, validTime: "2026-01-01T00:00:00Z", recordedAt: "2026-01-01T00:00:01Z", actor: "agent:brain" },
  ]);
});

test("listTypes: GETs /types and maps type definitions", async (t) => {
  const captured = mockFetch(t, () =>
    Response.json([
      { id: "t1", name: "bill", domain: "bills", json_schema: { type: "object" }, parent_type_id: null, is_active: true, created_at: "2026-01-01T00:00:00Z" },
    ])
  );
  const surface = createLifeOsSurface(CONFIG);

  const types = await surface.listTypes();

  assert.equal(new URL(captured.url()!).pathname, "/types");
  assert.deepEqual(types, [
    { id: "t1", name: "bill", domain: "bills", jsonSchema: { type: "object" }, parentTypeId: null, isActive: true, createdAt: "2026-01-01T00:00:00Z" },
  ]);
});

test("proposeAction: POSTs kind/summary/payload and reports the create-intent 'pending' status", async (t) => {
  const captured = mockFetch(t, () => Response.json({ proposal_id: "p1", state: "proposed" }));
  const surface = createLifeOsSurface(CONFIG);

  const result = await surface.proposeAction({ kind: "test.kind", summary: "do the thing", payload: { note: "x" } });

  assert.equal(captured.init()!.method, "POST");
  assert.equal(new URL(captured.url()!).pathname, "/action-proposals");
  const body = JSON.parse(captured.init()!.body as string);
  assert.deepEqual(body, { kind: "test.kind", summary: "do the thing", payload: { note: "x" } });
  assert.deepEqual(result, { proposalId: "p1", status: "pending" });
});

test("proposeAction: an omitted payload defaults to {} in the request body", async (t) => {
  const captured = mockFetch(t, () => Response.json({ proposal_id: "p2", state: "proposed" }));
  const surface = createLifeOsSurface(CONFIG);

  await surface.proposeAction({ kind: "test.kind", summary: "do the thing" });

  const body = JSON.parse(captured.init()!.body as string);
  assert.deepEqual(body.payload, {});
});

test("a non-2xx response throws LifeOsRequestError naming the method, path, and status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("proposal not found", { status: 404 }));
  const surface = createLifeOsSurface(CONFIG);

  await assert.rejects(() => surface.getEntity("missing"), (err: unknown) => {
    assert.ok(err instanceof LifeOsRequestError);
    assert.equal(err.status, 404);
    assert.match(err.message, /GET \/entities\/missing failed with status 404/);
    return true;
  });
});
