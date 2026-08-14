// Prompt Organizer data access (m5-01/m5-02). Same mocking convention
// src/lib/intake.test.ts already established: mock @hyperbolic/platform-client's
// createPlatformClient so auth.getSession() and the raw fetch calls this
// module makes are both fully controlled, then assert the exact request
// shape (URL, headers, body) and the exact response mapping for every
// exported function.
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
  }),
}));

import {
  addTags,
  createPrompt,
  estimateTokenCount,
  getPrompt,
  listPrompts,
  listVersions,
  parseTagInput,
  recordUsage,
  saveConfiguration,
  setArchived,
  updateBody,
  updateTitle,
} from "./prompts";

const FIXTURE_TOKEN = "fixture-access-token";

const RAW_ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "brain/task-contract",
  body: "Do {{THING}}.",
  is_active: true,
  created_at: "2026-08-01T00:00:00.000Z",
  tag: [{ tag: "brain" }],
  prompt_version: [{ version_no: 3 }],
  configuration: [{ name: "default", values: { THING: "x" }, sections: [] }],
};

function mockFetchJson(status: number, body: unknown) {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const spy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

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

describe("listPrompts", () => {
  it("sends the caller's bearer token and the prompt profile headers, ordered newest-first", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 200, body: [RAW_ROW] },
      { status: 200, body: [{ prompt_id: RAW_ROW.id }, { prompt_id: RAW_ROW.id }] },
    ]);

    await listPrompts();

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/prompt?select=");
    expect(url).toContain("order=created_at.desc");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(headers.get("Accept-Profile")).toBe("prompt");
    expect(headers.get("Content-Profile")).toBe("prompt");
  });

  it("maps tags/current-version/configurations, and counts usage rows client-side per prompt id", async () => {
    resetMocks();
    mockFetchSequence([
      { status: 200, body: [RAW_ROW] },
      { status: 200, body: [{ prompt_id: RAW_ROW.id }, { prompt_id: RAW_ROW.id }, { prompt_id: "other-id" }] },
    ]);

    const [prompt] = await listPrompts();

    expect(prompt).toEqual({
      id: RAW_ROW.id,
      title: "brain/task-contract",
      body: "Do {{THING}}.",
      isActive: true,
      tags: ["brain"],
      currentVersionNo: 3,
      configurations: [{ name: "default", values: { THING: "x" }, sections: [] }],
      usageCount: 2,
      createdAt: RAW_ROW.created_at,
    });
  });

  it("a prompt with zero embedded tags/configs maps to empty arrays, and version defaults to 1 if the embed is somehow empty", async () => {
    resetMocks();
    mockFetchSequence([
      { status: 200, body: [{ ...RAW_ROW, tag: [], prompt_version: [], configuration: [] }] },
      { status: 200, body: [] },
    ]);

    const [prompt] = await listPrompts();
    expect(prompt).toMatchObject({ tags: [], configurations: [], currentVersionNo: 1, usageCount: 0 });
  });

  it("never issues a network call when there is no session (fails closed)", async () => {
    resetMocks();
    auth.getSession.mockResolvedValue(null);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(listPrompts()).rejects.toThrow(/no active session/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a non-ok response throws an error including the status and body", async () => {
    resetMocks();
    const spy = vi.fn().mockResolvedValue(new Response("db is down", { status: 500 }));
    vi.stubGlobal("fetch", spy);
    await expect(listPrompts()).rejects.toThrow(/500.*db is down/s);
  });
});

describe("getPrompt", () => {
  it("filters by id and returns null when PostgREST returns zero rows", async () => {
    resetMocks();
    const spy = mockFetchJson(200, []);
    await expect(getPrompt("missing")).resolves.toBeNull();
    const [url] = spy.mock.calls[0] as [string];
    expect(url).toContain("id=eq.missing");
  });
});

describe("createPrompt", () => {
  it("sends only title and body on the initial insert -- no other column is ever client-supplied", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 201, body: [{ id: RAW_ROW.id }] },
      { status: 200, body: [RAW_ROW] },
      { status: 200, body: [] },
    ]);

    await createPrompt({ title: "My prompt", body: "The body" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ title: "My prompt", body: "The body" });
  });

  it("attaches tags in a second bulk call, only when tags are given", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 201, body: [{ id: RAW_ROW.id }] },
      { status: 201, body: [] },
      { status: 200, body: [RAW_ROW] },
      { status: 200, body: [] },
    ]);

    await createPrompt({ title: "My prompt", body: "The body", tags: ["a", "b"] });

    expect(spy).toHaveBeenCalledTimes(4);
    const [tagUrl, tagInit] = spy.mock.calls[1] as [string, RequestInit];
    expect(tagUrl).toContain("/rest/v1/tag");
    expect(JSON.parse(tagInit.body as string)).toEqual([
      { prompt_id: RAW_ROW.id, tag: "a" },
      { prompt_id: RAW_ROW.id, tag: "b" },
    ]);
  });

  it("skips the tag call entirely when no tags are given", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 201, body: [{ id: RAW_ROW.id }] },
      { status: 200, body: [RAW_ROW] },
      { status: 200, body: [] },
    ]);

    await createPrompt({ title: "My prompt", body: "The body" });

    for (const call of spy.mock.calls) {
      expect((call[0] as string)).not.toContain("/rest/v1/tag");
    }
  });

  it("throws if the insert returns no row", async () => {
    resetMocks();
    mockFetchJson(201, []);
    await expect(createPrompt({ title: "x", body: "y" })).rejects.toThrow(/no row/);
  });
});

describe("updateBody / restoreVersion", () => {
  it("PATCHes only the body field", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 200, body: [RAW_ROW] },
      { status: 200, body: [RAW_ROW] },
      { status: 200, body: [] },
    ]);

    await updateBody(RAW_ROW.id, "New body");

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`id=eq.${RAW_ROW.id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ body: "New body" });
  });

  it("throws a descriptive error when the row disappears (not found, or RLS hid it)", async () => {
    resetMocks();
    mockFetchSequence([
      { status: 200, body: [RAW_ROW] },
      { status: 200, body: [] },
    ]);
    await expect(updateBody(RAW_ROW.id, "x")).rejects.toThrow(/not found, or RLS/);
  });
});

describe("updateTitle", () => {
  it("PATCHes only the title field -- the UI layer, not this function, decides whether the call is offered", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 200, body: [{ ...RAW_ROW, title: "renamed" }] },
      { status: 200, body: [{ ...RAW_ROW, title: "renamed" }] },
      { status: 200, body: [] },
    ]);

    await updateTitle(RAW_ROW.id, "renamed");

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ title: "renamed" });
  });
});

describe("setArchived", () => {
  it("PATCHes only is_active", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 200, body: [{ ...RAW_ROW, is_active: false }] },
      { status: 200, body: [{ ...RAW_ROW, is_active: false }] },
      { status: 200, body: [] },
    ]);

    await setArchived(RAW_ROW.id, false);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ is_active: false });
  });
});

describe("listVersions", () => {
  it("filters by prompt_id, orders newest-first, and maps snake_case fields", async () => {
    resetMocks();
    const spy = mockFetchJson(200, [
      { version_no: 2, body: "v2 body", created_at: "2026-08-02T00:00:00.000Z" },
      { version_no: 1, body: "v1 body", created_at: "2026-08-01T00:00:00.000Z" },
    ]);

    const versions = await listVersions(RAW_ROW.id);

    const [url] = spy.mock.calls[0] as [string];
    expect(url).toContain(`prompt_id=eq.${RAW_ROW.id}`);
    expect(url).toContain("order=version_no.desc");
    expect(versions).toEqual([
      { versionNo: 2, body: "v2 body", createdAt: "2026-08-02T00:00:00.000Z" },
      { versionNo: 1, body: "v1 body", createdAt: "2026-08-01T00:00:00.000Z" },
    ]);
  });
});

describe("addTags", () => {
  it("bulk-inserts every tag as its own row naming the prompt id", async () => {
    resetMocks();
    const spy = mockFetchJson(201, []);
    await addTags(RAW_ROW.id, ["x", "y"]);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/tag");
    expect(JSON.parse(init.body as string)).toEqual([
      { prompt_id: RAW_ROW.id, tag: "x" },
      { prompt_id: RAW_ROW.id, tag: "y" },
    ]);
  });

  it("never calls fetch for an empty tag list", async () => {
    resetMocks();
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await addTags(RAW_ROW.id, []);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("saveConfiguration", () => {
  it("posts prompt_id/name/values/sections and returns the saved row", async () => {
    resetMocks();
    const saved = { name: "cfg", values: { A: "1" }, sections: ["s1"] };
    const spy = mockFetchJson(201, [saved]);

    const result = await saveConfiguration(RAW_ROW.id, "cfg", { A: "1" }, ["s1"]);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ prompt_id: RAW_ROW.id, name: "cfg", values: { A: "1" }, sections: ["s1"] });
    expect(result).toEqual(saved);
  });
});

describe("recordUsage", () => {
  it("posts a usage row, then logs the render via rpc/log_run under the core profile", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 201, body: [] },
      { status: 200, body: {} },
    ]);

    await recordUsage(RAW_ROW.id, 3, 42);

    expect(spy).toHaveBeenCalledTimes(2);
    const [usageUrl, usageInit] = spy.mock.calls[0] as [string, RequestInit];
    expect(usageUrl).toContain("/rest/v1/usage");
    expect(JSON.parse(usageInit.body as string)).toEqual({ prompt_id: RAW_ROW.id, version_no: 3 });

    const [logUrl, logInit] = spy.mock.calls[1] as [string, RequestInit];
    expect(logUrl).toContain("/rest/v1/rpc/log_run");
    const logHeaders = new Headers(logInit.headers);
    expect(logHeaders.get("Content-Profile")).toBe("core");
    expect(logHeaders.get("Accept-Profile")).toBe("core");
    expect(JSON.parse(logInit.body as string)).toEqual({
      p_app_id: "prompt-organizer",
      p_kind: "render",
      p_wall_clock_ms: 42,
    });
  });

  it("the usage insert itself still carries the prompt profile, not core (only log_run switches profile)", async () => {
    resetMocks();
    const spy = mockFetchSequence([
      { status: 201, body: [] },
      { status: 200, body: {} },
    ]);
    await recordUsage(RAW_ROW.id, 1, 0);
    const [, usageInit] = spy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(usageInit.headers);
    expect(headers.get("Content-Profile")).toBe("prompt");
  });
});

describe("estimateTokenCount", () => {
  it("is chars/4, rounded up", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcde")).toBe(2);
    expect(estimateTokenCount("a".repeat(100))).toBe(25);
  });
});

describe("parseTagInput", () => {
  it("trims, lowercases, and deduplicates comma-separated input", () => {
    expect(parseTagInput(" Food, food ,Travel,,  ")).toEqual(["food", "travel"]);
  });

  it("an empty or whitespace-only input yields zero tags", () => {
    expect(parseTagInput("")).toEqual([]);
    expect(parseTagInput("   ")).toEqual([]);
  });
});
