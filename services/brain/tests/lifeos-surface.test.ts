// LifeOsSurface (m4-20) against a mocked global fetch -- no live LifeOS
// deploy touched. Asserts request shape (path, query params, Bearer
// header, method) against apps/lifeos/backend/src/api/main.py's actual
// routes, and the wire->camelCase mapping for each response shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLifeOsSurface, LifeOsSurfaceError } from "../src/lifeos-surface.ts";

const CONFIG = { apiUrl: "https://lifeos.example.invalid/life/api", agentToken: "agent-token-123" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("LO-4a: the surface exposes exactly 5 methods and no other", () => {
  const surface = createLifeOsSurface(CONFIG);
  assert.deepEqual(Object.keys(surface).sort(), ["getEntity", "getHistory", "listTypes", "proposeAction", "search"]);
});

test("search: no domain -> one GET /search call with the query as `text`, Bearer auth attached", async (t) => {
  let capturedUrl: string | undefined;
  let capturedHeaders: Record<string, string> | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedHeaders = init.headers as Record<string, string>;
    return jsonResponse([{ id: "e1", name: "Widget", attributes: { a: 1 }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
  });

  const surface = createLifeOsSurface(CONFIG);
  const results = await surface.search("widget");

  assert.equal(capturedUrl, "https://lifeos.example.invalid/life/api/search?text=widget");
  assert.equal(capturedHeaders!.Authorization, "Bearer agent-token-123");
  assert.deepEqual(results, [{ id: "e1", name: "Widget", attributes: { a: 1 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }]);
});

test("search: with a domain -> fans out over /types then one /search per matching type, deduped and limited", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    if (url.endsWith("/types")) {
      return jsonResponse([
        { id: "t1", name: "briefing", domain: "ops", json_schema: {}, parent_type_id: null, is_active: true, created_at: "2026-01-01T00:00:00Z" },
        { id: "t2", name: "receipt", domain: "ops", json_schema: {}, parent_type_id: null, is_active: true, created_at: "2026-01-01T00:00:00Z" },
        { id: "t3", name: "bill", domain: "bills", json_schema: {}, parent_type_id: null, is_active: true, created_at: "2026-01-01T00:00:00Z" },
      ]);
    }
    if (url.includes("type_name=briefing")) {
      return jsonResponse([{ id: "shared", name: "A", attributes: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
    }
    if (url.includes("type_name=receipt")) {
      return jsonResponse([{ id: "shared", name: "A", attributes: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }, { id: "e2", name: "B", attributes: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
    }
    throw new Error(`unexpected call: ${url}`);
  });

  const surface = createLifeOsSurface(CONFIG);
  const results = await surface.search("week", { domain: "ops" });

  assert.equal(calls.filter((u) => u.includes("type_name=bill")).length, 0, "bills-domain type must never be queried for an ops-scoped search");
  assert.deepEqual(results.map((r) => r.id).sort(), ["e2", "shared"], "duplicate entity across two matching types is merged, not repeated");
});

test("search: limit is applied after merging, not per underlying call", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse([{ id: "e1", name: "A", attributes: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }, { id: "e2", name: "B", attributes: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]));

  const surface = createLifeOsSurface(CONFIG);
  const results = await surface.search("x", { limit: 1 });
  assert.equal(results.length, 1);
});

test("getEntity: GET /entities/{id}, maps entity + edges to camelCase", async (t) => {
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    capturedUrl = url;
    return jsonResponse({
      entity: { id: "e1", name: "Widget", attributes: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      types: ["widget"],
      edges_out: [{ id: "edge1", from_entity: "e1", relation: "part_of", to_entity: "e2", attributes: {}, valid_from: "2026-01-01T00:00:00Z", valid_to: null }],
      edges_in: [],
    });
  });

  const surface = createLifeOsSurface(CONFIG);
  const detail = await surface.getEntity("e1");

  assert.equal(capturedUrl, "https://lifeos.example.invalid/life/api/entities/e1");
  assert.equal(detail.entity.id, "e1");
  assert.deepEqual(detail.types, ["widget"]);
  assert.equal(detail.edgesOut[0]!.fromEntity, "e1");
  assert.equal(detail.edgesOut[0]!.toEntity, "e2");
});

test("getHistory: GET /entities/{id}/history, maps events to camelCase", async (t) => {
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    capturedUrl = url;
    return jsonResponse([{ id: "ev1", entity_id: "e1", event_type: "entity.created", payload: { x: 1 }, valid_time: "2026-01-01T00:00:00Z", recorded_at: "2026-01-01T00:00:01Z", actor: "owner" }]);
  });

  const surface = createLifeOsSurface(CONFIG);
  const events = await surface.getHistory("e1");

  assert.equal(capturedUrl, "https://lifeos.example.invalid/life/api/entities/e1/history");
  assert.equal(events[0]!.eventType, "entity.created");
  assert.equal(events[0]!.recordedAt, "2026-01-01T00:00:01Z");
});

test("listTypes: GET /types, maps to camelCase", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse([{ id: "t1", name: "briefing", domain: "ops", json_schema: { type: "object" }, parent_type_id: null, is_active: true, created_at: "2026-01-01T00:00:00Z" }]));

  const surface = createLifeOsSurface(CONFIG);
  const types = await surface.listTypes();
  assert.deepEqual(types, [{ id: "t1", name: "briefing", domain: "ops", jsonSchema: { type: "object" }, parentTypeId: null, isActive: true, createdAt: "2026-01-01T00:00:00Z" }]);
});

test("proposeAction: POST /action-proposals with kind/summary/payload, maps proposed -> pending", async (t) => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({ proposal_id: "p1", kind: "cleanup", state: "proposed", subject_ids: [], verification_receipt_id: null, points: [], unresolved_count: 0, authority_receipt_id: null, body: "do the thing", draft_digest: "abc" });
  });

  const surface = createLifeOsSurface(CONFIG);
  const result = await surface.proposeAction({ kind: "cleanup", summary: "do the thing", payload: { target: "x" } });

  assert.equal(capturedUrl, "https://lifeos.example.invalid/life/api/action-proposals");
  assert.equal(capturedInit!.method, "POST");
  assert.deepEqual(JSON.parse(capturedInit!.body as string), { kind: "cleanup", summary: "do the thing", payload: { target: "x" } });
  assert.deepEqual(result, { proposalId: "p1", status: "pending" });
});

test("proposeAction: an already-decided proposal (idempotent replay hit a resolved record) throws rather than lying about status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ proposal_id: "p1", kind: "cleanup", state: "approved", subject_ids: [], verification_receipt_id: null, points: [], unresolved_count: 0, authority_receipt_id: null, body: null, draft_digest: null }));

  const surface = createLifeOsSurface(CONFIG);
  await assert.rejects(() => surface.proposeAction({ kind: "cleanup", summary: "do the thing", payload: {} }), LifeOsSurfaceError);
});

test("a non-2xx response throws LifeOsSurfaceError carrying the status and the FastAPI `detail` message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ detail: "insufficient scope" }), { status: 403 }));

  const surface = createLifeOsSurface(CONFIG);
  await assert.rejects(
    () => surface.listTypes(),
    (err: unknown) => {
      assert.ok(err instanceof LifeOsSurfaceError);
      assert.equal(err.status, 403);
      assert.match(err.message, /insufficient scope/);
      return true;
    },
  );
});

test("proposeAction never requests a scope other than what the caller passes -- no wildcard, no forged domain", async (t) => {
  // Not a scope test (scope enforcement is server-side, LO-4c is
  // mcp_server/tokens.py's own read_scopes -- covered there and in
  // apps/lifeos/backend/tests/api/test_auth.py's M4-20 section). This
  // asserts the client-side contract: the body sent is exactly kind/
  // summary/payload, never anything scope-shaped smuggled in alongside it.
  let capturedBody: unknown;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return jsonResponse({ proposal_id: "p1", kind: "x", state: "proposed", subject_ids: [], verification_receipt_id: null, points: [], unresolved_count: 0, authority_receipt_id: null, body: "s", draft_digest: "d" });
  });

  const surface = createLifeOsSurface(CONFIG);
  await surface.proposeAction({ kind: "x", summary: "s", payload: { note: "n" } });
  assert.deepEqual(Object.keys(capturedBody as object).sort(), ["kind", "payload", "summary"]);
});
