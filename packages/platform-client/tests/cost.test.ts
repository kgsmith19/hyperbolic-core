import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListLlmCallsParams, createCostClient, groupLlmCallsByCallerAndPurpose, type LlmCallRow } from "../src/cost.ts";

const FIXTURE_URL = "https://fixture-project.supabase.invalid";
const FIXTURE_TOKEN = "fixture.session.token";

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

function fixtureApiRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "call-1",
    ts: "2026-01-01T00:00:00+00:00",
    caller_app: "idea-intake",
    purpose: "optimize-idea",
    run_ref: "run-abc",
    provider: "anthropic",
    model: "claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 10,
    usd_estimate: 0.5,
    latency_ms: 1200,
    status: "ok",
    error_class: null,
    ...overrides,
  };
}

// --- buildListLlmCallsParams: pure filter-building --------------------------

test("buildListLlmCallsParams: no filter omits since/caller_app/purpose entirely", () => {
  const params = buildListLlmCallsParams();
  assert.equal(params.get("ts"), null);
  assert.equal(params.get("caller_app"), null);
  assert.equal(params.get("purpose"), null);
  assert.equal(params.get("select"), "id,ts,caller_app,purpose,run_ref,provider,model,input_tokens,output_tokens,cache_read_tokens,usd_estimate,latency_ms,status,error_class");
});

test("buildListLlmCallsParams: since becomes a gte. PostgREST filter on ts", () => {
  const params = buildListLlmCallsParams({ since: "2026-01-01T00:00:00Z" });
  assert.equal(params.get("ts"), "gte.2026-01-01T00:00:00Z");
});

test("buildListLlmCallsParams: callerApp and purpose become eq. filters, and compose together", () => {
  const params = buildListLlmCallsParams({ callerApp: "brain", purpose: "plan" });
  assert.equal(params.get("caller_app"), "eq.brain");
  assert.equal(params.get("purpose"), "eq.plan");
});

test("buildListLlmCallsParams: always requests newest-first ordering", () => {
  assert.equal(buildListLlmCallsParams().get("order"), "ts.desc");
});

// --- createCostClient: request shape, header, mapping -----------------------

test("listLlmCalls issues GET /rest/v1/llm_call with apikey + Authorization + Accept-Profile: core", async (t) => {
  const spy = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, new URL(FIXTURE_URL).origin);
    assert.equal(url.pathname, "/rest/v1/llm_call");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${FIXTURE_TOKEN}`);
    assert.ok(headers.get("apikey"), "expected an apikey header to be present");
    // The real defect this whole client exists to not repeat (see
    // registry.ts's own fix and header comment): without this header, a
    // GET against the live project resolves against `public.llm_call`,
    // which does not exist, and PostgREST answers 404 instead of the real
    // `core.llm_call` rows.
    assert.equal(headers.get("Accept-Profile"), "core");
    return jsonResponse([fixtureApiRow()]);
  });

  const rows = await withPatchedFetch(spy, async () => {
    const client = createCostClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.listLlmCalls();
  });

  assert.equal(spy.mock.callCount(), 1);
  assert.equal(rows.length, 1);
});

test("listLlmCalls maps snake_case core.llm_call columns to the camelCase LlmCallRow shape exactly", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse([fixtureApiRow()]));

  const [row] = await withPatchedFetch(spy, async () => {
    const client = createCostClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.listLlmCalls();
  });

  assert.deepEqual(row, {
    id: "call-1",
    ts: "2026-01-01T00:00:00+00:00",
    callerApp: "idea-intake",
    purpose: "optimize-idea",
    runRef: "run-abc",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    usdEstimate: 0.5,
    latencyMs: 1200,
    status: "ok",
    errorClass: null,
  });
});

test("listLlmCalls: a run_ref inserted by one caller_app resolves back exactly as inserted (m6-02's own attribution acceptance criterion)", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse([fixtureApiRow({ caller_app: "brain", run_ref: "brain-run-42" })]));

  const [row] = await withPatchedFetch(spy, async () => {
    const client = createCostClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.listLlmCalls({ callerApp: "brain" });
  });

  assert.equal(row!.callerApp, "brain");
  assert.equal(row!.runRef, "brain-run-42");
});

test("a non-ok PostgREST response rejects with a descriptive error, never a swallowed empty list", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse({ message: "permission denied" }, 401));

  await withPatchedFetch(spy, async () => {
    const client = createCostClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await assert.rejects(() => client.listLlmCalls(), /401/);
  });
});

test("getAccessToken rejecting (no session) reaches zero network calls, fail-closed like every other client here", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse([]));

  await withPatchedFetch(spy, async () => {
    const client = createCostClient(FIXTURE_URL, async () => {
      throw new Error("no active session");
    });
    await assert.rejects(() => client.listLlmCalls());
  });

  assert.equal(spy.mock.callCount(), 0);
});

test("an empty explicit publishable key fails before any request", () => {
  assert.throws(() => createCostClient(FIXTURE_URL, async () => FIXTURE_TOKEN, "  "), /publishable key is required/);
});

// --- groupLlmCallsByCallerAndPurpose: pure aggregation -----------------------

function row(overrides: Partial<LlmCallRow> = {}): LlmCallRow {
  return {
    id: "call-1",
    ts: "2026-01-01T00:00:00Z",
    callerApp: "idea-intake",
    purpose: "optimize-idea",
    runRef: "run-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    usdEstimate: 0.5,
    latencyMs: 1000,
    status: "ok",
    errorClass: null,
    ...overrides,
  };
}

test("groupLlmCallsByCallerAndPurpose: sums tokens/usd/count within one caller_app+purpose bucket", () => {
  const buckets = groupLlmCallsByCallerAndPurpose([
    row({ id: "c1", inputTokens: 100, usdEstimate: 0.5 }),
    row({ id: "c2", inputTokens: 20, usdEstimate: 0.1 }),
  ]);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0]!.count, 2);
  assert.equal(buckets[0]!.inputTokens, 120);
  assert.equal(buckets[0]!.usdEstimate, 0.6);
});

test("groupLlmCallsByCallerAndPurpose: the same caller_app with two different purposes never merges into one bucket", () => {
  const buckets = groupLlmCallsByCallerAndPurpose([
    row({ id: "c1", callerApp: "brain", purpose: "plan" }),
    row({ id: "c2", callerApp: "brain", purpose: "eval" }),
  ]);
  assert.equal(buckets.length, 2);
  assert.ok(buckets.some((b) => b.purpose === "plan"));
  assert.ok(buckets.some((b) => b.purpose === "eval"));
});

test("groupLlmCallsByCallerAndPurpose: two different caller_apps with the SAME purpose never merge (the key is the pair, not either field alone)", () => {
  const buckets = groupLlmCallsByCallerAndPurpose([
    row({ id: "c1", callerApp: "brain", purpose: "plan" }),
    row({ id: "c2", callerApp: "idea-intake", purpose: "plan" }),
  ]);
  assert.equal(buckets.length, 2);
});

test("groupLlmCallsByCallerAndPurpose: a null usdEstimate (an error-status row that never priced) contributes zero, never NaN", () => {
  const buckets = groupLlmCallsByCallerAndPurpose([row({ usdEstimate: null, status: "error" })]);
  assert.equal(buckets[0]!.usdEstimate, 0);
});

test("groupLlmCallsByCallerAndPurpose: an empty input produces an empty result, not an error", () => {
  assert.deepEqual(groupLlmCallsByCallerAndPurpose([]), []);
});
