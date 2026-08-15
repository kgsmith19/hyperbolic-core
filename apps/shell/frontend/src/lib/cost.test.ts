// Cost dashboard data access (m6-02). Same mocking convention
// src/lib/prompts.test.ts already established: mock
// @hyperbolic/platform-client's createPlatformClient so auth.getSession()
// and the raw fetch calls this module makes are both fully controlled,
// then assert the exact request shape and the exact client-side
// grouping/mapping.
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth } = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock("@hyperbolic/platform-client", () => ({
  createPlatformClient: () => ({ auth, fetch: vi.fn() }),
  createRegistryClient: () => ({ listTools: vi.fn(), getTool: vi.fn() }),
  createBrainClient: () => ({
    createRun: vi.fn(),
    getRun: vi.fn(),
    approveTask: vi.fn(),
    rejectTask: vi.fn(),
    streamRunEvents: vi.fn(),
    health: vi.fn(),
    getCostSummary: vi.fn(),
  }),
}));

import { groupBrainCostByDay, listBrainRunCosts, listLlmCallGroups, type BrainRunCost } from "./cost";

const FIXTURE_TOKEN = "fixture-access-token";

function mockFetchSequence(bodies: Array<{ status: number; body: unknown }>) {
  const spy = vi.fn();
  for (const { status, body } of bodies) {
    spy.mockImplementationOnce(
      async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    );
  }
  vi.stubGlobal("fetch", spy);
  return spy;
}

function resetMocks() {
  auth.getSession.mockReset();
  auth.getSession.mockResolvedValue({
    accessToken: FIXTURE_TOKEN,
    expiresAt: 9_999_999_999,
    userId: "00000000-0000-4000-8000-000000000099",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listBrainRunCosts", () => {
  it("sends the caller's bearer token and the core profile header, filtered to brain/run", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 200, body: [{ id: "run-1", started_at: "2026-08-10T00:00:00Z", ended_at: null, status: "ok" }] },
      { status: 200, body: [] },
    ]);

    await listBrainRunCosts();

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/run?app_id=eq.brain&kind=eq.run");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(headers.get("Accept-Profile")).toBe("core");
  });

  it("joins core.cost rows onto core.run rows by run_id, defaulting to zero when a run has no cost row yet", async () => {
    resetMocks();
    mockFetchSequence([
      {
        status: 200,
        body: [
          { id: "run-1", started_at: "2026-08-10T00:00:00Z", ended_at: "2026-08-10T00:05:00Z", status: "ok" },
          { id: "run-2", started_at: "2026-08-11T00:00:00Z", ended_at: null, status: "running" },
        ],
      },
      {
        status: 200,
        body: [{ run_id: "run-1", input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, wall_clock_ms: 1000, usd: 0.01 }],
      },
    ]);

    const runs = await listBrainRunCosts();

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ runId: "run-1", inputTokens: 100, outputTokens: 50, usd: 0.01 });
    expect(runs[1]).toMatchObject({ runId: "run-2", inputTokens: 0, outputTokens: 0, usd: 0 });
  });

  it("returns an empty list when there are zero runs, still firing both requests concurrently", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 200, body: [] },
      { status: 200, body: [] },
    ]);

    const runs = await listBrainRunCosts();

    expect(runs).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("fires the run and cost requests concurrently, not sequentially -- the cost query never waits on the run query's result", async () => {
    resetMocks();
    let costRequestStartedBeforeRunResponseResolved = false;
    let resolveRunResponse!: (value: Response) => void;
    const spy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/rest/v1/run")) {
        return new Promise<Response>((resolve) => {
          resolveRunResponse = resolve;
        });
      }
      costRequestStartedBeforeRunResponseResolved = true;
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", spy);

    const pending = listBrainRunCosts();
    // Flush the microtask queue (getAccessToken's own await chain runs
    // through a few ticks before either fetch() call fires) before
    // resolving the run request -- if the cost request truly fires
    // without waiting on it, its handler has already run by now.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(costRequestStartedBeforeRunResponseResolved).toBe(true);
    resolveRunResponse(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }));

    await pending;
  });
});

describe("groupBrainCostByDay", () => {
  const run = (overrides: Partial<BrainRunCost>): BrainRunCost => ({
    runId: "r",
    startedAt: "2026-08-10T00:00:00Z",
    endedAt: null,
    status: "ok",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    wallClockMs: 0,
    usd: 0,
    ...overrides,
  });

  it("groups by the run's own UTC calendar date, not local time, and sums tokens/usd", () => {
    const daily = groupBrainCostByDay([
      run({ startedAt: "2026-08-10T23:59:59Z", inputTokens: 10, usd: 0.1 }),
      run({ startedAt: "2026-08-10T00:00:01Z", inputTokens: 20, usd: 0.2 }),
      run({ startedAt: "2026-08-11T00:00:00Z", inputTokens: 5, usd: 0.05 }),
    ]);

    expect(daily).toEqual([
      { date: "2026-08-11", runs: 1, inputTokens: 5, outputTokens: 0, usd: 0.05 },
      { date: "2026-08-10", runs: 2, inputTokens: 30, outputTokens: 0, usd: expect.closeTo(0.3, 10) },
    ]);
  });

  it("returns an empty list for an empty input", () => {
    expect(groupBrainCostByDay([])).toEqual([]);
  });
});

describe("listLlmCallGroups", () => {
  it("sends the caller's bearer token, the core profile header, and a since-date lower bound", async () => {
    resetMocks();
    const spy = mockFetchSequence([{ status: 200, body: [] }]);

    await listLlmCallGroups("2026-08-01T00:00:00.000Z");

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/llm_call?ts=gte.2026-08-01T00%3A00%3A00.000Z");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(headers.get("Accept-Profile")).toBe("core");
  });

  it("groups rows by (caller_app, purpose), summing calls/tokens/usd, sorted by usd descending", async () => {
    resetMocks();
    mockFetchSequence([
      {
        status: 200,
        body: [
          { caller_app: "idea-intake", purpose: "optimize-idea", input_tokens: 100, output_tokens: 50, usd_estimate: 0.01 },
          { caller_app: "idea-intake", purpose: "optimize-idea", input_tokens: 200, output_tokens: 100, usd_estimate: 0.02 },
          { caller_app: "idea-intake", purpose: "score", input_tokens: 10, output_tokens: 5, usd_estimate: 0.1 },
        ],
      },
    ]);

    const groups = await listLlmCallGroups("2026-08-01T00:00:00.000Z");

    expect(groups).toEqual([
      { callerApp: "idea-intake", purpose: "score", calls: 1, inputTokens: 10, outputTokens: 5, usd: 0.1 },
      {
        callerApp: "idea-intake",
        purpose: "optimize-idea",
        calls: 2,
        inputTokens: 300,
        outputTokens: 150,
        usd: expect.closeTo(0.03, 10),
      },
    ]);
  });

  it("treats a null usd_estimate as zero rather than propagating NaN", async () => {
    resetMocks();
    mockFetchSequence([
      { status: 200, body: [{ caller_app: "a", purpose: "p", input_tokens: 1, output_tokens: 1, usd_estimate: null }] },
    ]);

    const [group] = await listLlmCallGroups("2026-08-01T00:00:00.000Z");

    expect(group.usd).toBe(0);
  });
});
