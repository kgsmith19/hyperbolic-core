// Idea Intake data access (m3-07). This module is the ONLY place that talks
// to intake.idea over PostgREST or to services/llm-handler's submit API, so
// a bug here is invisible to every page-level test that mocks it away.
// Covers: exact header/URL shape sent to PostgREST (the boundary between
// this repo's two established fetch conventions -- see this file's own
// top-of-file comment), snake_case<->camelCase mapping including the nested
// parent embed, the createDraft/updateIdea guardrails against ever sending
// a forged status/github_* write, and submitIdea's four-way SubmitResult
// contract (05-h section 6.5/9's outcome taxonomy as the client sees it).
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, authedFetch } = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  },
  authedFetch: vi.fn(),
}));

vi.mock("@hyperbolic/platform-client", () => ({
  createPlatformClient: () => ({ auth, fetch: authedFetch }),
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

import {
  buildSubmitPreview,
  createDraft,
  deleteIdea,
  getIdea,
  listIdeas,
  submitIdea,
  updateIdea,
  type Idea,
} from "./intake";
import { mockFetchJson } from "../test-support.js";

const FIXTURE_TOKEN = "fixture-access-token";

const RAW_ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  parent_idea_id: null,
  title: "Add dark mode",
  problem: "No dark mode",
  outcome: "A dark theme toggle",
  notes: "",
  confidence: "medium",
  status: "idea",
  source: "manual",
  target_repo: "kgsmith19/hyperbolic-core",
  idempotency_key: "aaaaaaaa-0000-4000-8000-000000000002",
  github_issue_number: null,
  github_issue_url: null,
  submitted_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z",
  parent: null,
};

function mockFetchText(status: number, text: string) {
  const spy = vi.fn().mockResolvedValue(new Response(text, { status }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function resetMocks() {
  auth.getSession.mockReset();
  authedFetch.mockReset();
  auth.getSession.mockResolvedValue({
    accessToken: FIXTURE_TOKEN,
    expiresAt: 9_999_999_999,
    userId: "00000000-0000-4000-8000-000000000099",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listIdeas / getIdea: PostgREST request shape", () => {
  it("listIdeas sends the caller's bearer token, the intake profile headers, and the newest-first order", async () => {
    resetMocks();
    const spy = mockFetchJson(200, [RAW_ROW]);

    await listIdeas();

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/idea?select=");
    expect(url).toContain("order=updated_at.desc");
    const headers = new Headers(init.headers);
    expect(headers.get("apikey")).toBeTruthy();
    expect(headers.get("Authorization")).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(headers.get("Accept-Profile")).toBe("intake");
  });

  it("listIdeas maps every snake_case column to its camelCase field, including the nested parent embed", async () => {
    resetMocks();
    mockFetchJson(200, [
      { ...RAW_ROW, parent_idea_id: "parent-id", parent: { github_issue_url: "https://github.com/o/r/issues/1" } },
    ]);

    const [idea] = await listIdeas();

    expect(idea).toEqual<Idea>({
      id: RAW_ROW.id,
      parentIdeaId: "parent-id",
      title: "Add dark mode",
      problem: "No dark mode",
      outcome: "A dark theme toggle",
      notes: "",
      confidence: "medium",
      status: "idea",
      source: "manual",
      targetRepo: "kgsmith19/hyperbolic-core",
      idempotencyKey: RAW_ROW.idempotency_key,
      githubIssueNumber: null,
      githubIssueUrl: null,
      submittedAt: null,
      parentGithubIssueUrl: "https://github.com/o/r/issues/1",
      createdAt: RAW_ROW.created_at,
      updatedAt: RAW_ROW.updated_at,
    });
  });

  it("a row with no parent maps parentGithubIssueUrl to null, not undefined", async () => {
    resetMocks();
    mockFetchJson(200, [RAW_ROW]);
    const [idea] = await listIdeas();
    expect(idea.parentGithubIssueUrl).toBeNull();
  });

  it("never issues a network call when there is no session (fails closed, matching authedFetch's own contract)", async () => {
    resetMocks();
    auth.getSession.mockResolvedValue(null);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(listIdeas()).rejects.toThrow(/no active session/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a non-ok response throws an error that includes the status and response body", async () => {
    resetMocks();
    mockFetchText(500, "internal error detail");
    await expect(listIdeas()).rejects.toThrow(/500.*internal error detail/s);
  });

  it("getIdea returns null when PostgREST returns zero rows (not found, or RLS hides it)", async () => {
    resetMocks();
    mockFetchJson(200, []);
    await expect(getIdea("missing-id")).resolves.toBeNull();
  });

  it("getIdea filters by id and limits to one row", async () => {
    resetMocks();
    const spy = mockFetchJson(200, [RAW_ROW]);
    await getIdea(RAW_ROW.id);
    const [url] = spy.mock.calls[0] as [string];
    expect(url).toContain(`id=eq.${RAW_ROW.id}`);
    expect(url).toContain("limit=1");
  });
});

describe("createDraft: every idea is born draft", () => {
  it("never sends a status, idempotency_key, or github_* field -- those columns aren't in the INSERT grant", async () => {
    resetMocks();
    const spy = mockFetchJson(201, [RAW_ROW]);

    await createDraft({ title: "New idea" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("idempotency_key");
    expect(body).not.toHaveProperty("github_issue_number");
    expect(body).not.toHaveProperty("github_issue_url");
  });

  it("applies documented defaults for every omitted optional field", async () => {
    resetMocks();
    const spy = mockFetchJson(201, [RAW_ROW]);

    await createDraft({ title: "New idea" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      title: "New idea",
      problem: "",
      outcome: "",
      notes: "",
      confidence: "medium",
      source: "",
      target_repo: null,
      parent_idea_id: null,
    });
  });

  it("passes explicit fields through unchanged", async () => {
    resetMocks();
    const spy = mockFetchJson(201, [RAW_ROW]);

    await createDraft({ title: "New idea", confidence: "high", parentIdeaId: "parent-1" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.confidence).toBe("high");
    expect(body.parent_idea_id).toBe("parent-1");
  });

  it("throws if PostgREST returns no row", async () => {
    resetMocks();
    mockFetchJson(201, []);
    await expect(createDraft({ title: "x" })).rejects.toThrow(/no row/);
  });
});

describe("updateIdea: partial PATCH semantics", () => {
  it("only includes fields explicitly present in the patch", async () => {
    resetMocks();
    const spy = mockFetchJson(200, [RAW_ROW]);

    await updateIdea(RAW_ROW.id, { title: "Renamed" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ title: "Renamed" });
  });

  it("distinguishes an explicit targetRepo: null (clear the field) from an omitted targetRepo (leave untouched)", async () => {
    resetMocks();
    const spy = mockFetchJson(200, [RAW_ROW]);

    await updateIdea(RAW_ROW.id, { targetRepo: null });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toHaveProperty("target_repo", null);
  });

  it("omits target_repo entirely when the patch never mentions it", async () => {
    resetMocks();
    const spy = mockFetchJson(200, [RAW_ROW]);

    await updateIdea(RAW_ROW.id, { title: "Renamed" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("target_repo");
  });

  it("can promote a draft by sending status: 'idea', and never accepts 'submitted_to_github' at the type level", async () => {
    resetMocks();
    const spy = mockFetchJson(200, [{ ...RAW_ROW, status: "idea" }]);

    await updateIdea(RAW_ROW.id, { status: "idea", targetRepo: "o/r" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.status).toBe("idea");
    // @ts-expect-error -- IdeaPatch.status only accepts "draft" | "idea"; this is a compile-time guardrail check.
    const _rejectedAtCompileTime: Parameters<typeof updateIdea>[1] = { status: "submitted_to_github" };
    void _rejectedAtCompileTime;
  });

  it("throws a descriptive error when no row comes back (not found, or the guard trigger rejected the transition)", async () => {
    resetMocks();
    mockFetchJson(200, []);
    await expect(updateIdea(RAW_ROW.id, { title: "x" })).rejects.toThrow(/guard trigger/);
  });
});

describe("deleteIdea", () => {
  it("issues a DELETE scoped to the id with Prefer: return=minimal", async () => {
    resetMocks();
    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", spy);

    await deleteIdea(RAW_ROW.id);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(url).toContain(`id=eq.${RAW_ROW.id}`);
    const headers = new Headers(init.headers);
    expect(headers.get("Prefer")).toBe("return=minimal");
  });
});

describe("submitIdea: services/llm-handler POST /api/intake/submit outcome mapping", () => {
  function jsonResponse(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("sends the ideaId as JSON to the submit endpoint via platformClient.fetch (authedFetch), not raw fetch", async () => {
    resetMocks();
    authedFetch.mockResolvedValue(jsonResponse(200, { issueNumber: 42, issueUrl: "https://github.com/o/r/issues/42" }));
    const rawFetchSpy = vi.fn();
    vi.stubGlobal("fetch", rawFetchSpy);

    await submitIdea(RAW_ROW.id);

    expect(authedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = authedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/submit");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ ideaId: RAW_ROW.id });
    expect(rawFetchSpy).not.toHaveBeenCalled();
  });

  it('maps a 200 to {kind: "ok"} with the issue number and URL', async () => {
    resetMocks();
    authedFetch.mockResolvedValue(jsonResponse(200, { issueNumber: 7, issueUrl: "https://github.com/o/r/issues/7" }));
    await expect(submitIdea(RAW_ROW.id)).resolves.toEqual({ kind: "ok", issueNumber: 7, issueUrl: "https://github.com/o/r/issues/7" });
  });

  it('maps a 409 (still draft) to {kind: "draft_not_promoted"}, ignoring the body', async () => {
    resetMocks();
    authedFetch.mockResolvedValue(jsonResponse(409, { anything: "ignored" }));
    await expect(submitIdea(RAW_ROW.id)).resolves.toEqual({ kind: "draft_not_promoted" });
  });

  it('maps a 401 to {kind: "unauthorized"}', async () => {
    resetMocks();
    authedFetch.mockResolvedValue(jsonResponse(401, {}));
    await expect(submitIdea(RAW_ROW.id)).resolves.toEqual({ kind: "unauthorized" });
  });

  it('maps a 502 with a message body to {kind: "error", message}', async () => {
    resetMocks();
    authedFetch.mockResolvedValue(jsonResponse(502, { message: "GitHub unreachable" }));
    await expect(submitIdea(RAW_ROW.id)).resolves.toEqual({ kind: "error", message: "GitHub unreachable" });
  });

  it('falls back to the "error" field, then a generic status message, when message is absent', async () => {
    resetMocks();
    authedFetch.mockResolvedValueOnce(jsonResponse(502, { error: "server_network" }));
    await expect(submitIdea(RAW_ROW.id)).resolves.toEqual({ kind: "error", message: "server_network" });

    authedFetch.mockResolvedValueOnce(new Response("not json", { status: 502 }));
    await expect(submitIdea(RAW_ROW.id)).resolves.toEqual({ kind: "error", message: "submit failed with HTTP 502" });
  });

  it("propagates a genuine transport rejection (network down, CORS) instead of resolving a typed result", async () => {
    resetMocks();
    authedFetch.mockRejectedValue(new TypeError("network unreachable"));
    await expect(submitIdea(RAW_ROW.id)).rejects.toThrow("network unreachable");
  });
});

describe("buildSubmitPreview: client-side preview must match services/llm-handler's own template", () => {
  // Deliberately re-derived by hand from services/llm-handler/src/intake-submit.ts's
  // buildMarker/buildBody/buildLabels (not imported -- see this file's own
  // doc comment on why the duplication is narrow and intentional) so a
  // change to either side that silently drifts from the other fails here.
  const idea: Idea = {
    id: "idea-1",
    parentIdeaId: null,
    title: "Add dark mode",
    problem: "No dark mode option",
    outcome: "Users can toggle a dark theme",
    notes: "Nice to have",
    confidence: "high",
    status: "idea",
    source: "manual",
    targetRepo: "kgsmith19/hyperbolic-core",
    idempotencyKey: "key-123",
    githubIssueNumber: null,
    githubIssueUrl: null,
    submittedAt: null,
    parentGithubIssueUrl: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };

  it("builds the exact title/body/labels for a non-derived idea", () => {
    const preview = buildSubmitPreview(idea);
    expect(preview.title).toBe("Add dark mode");
    expect(preview.body).toBe(
      "## Problem\nNo dark mode option\n\n" +
        "## Desired outcome\nUsers can toggle a dark theme\n\n" +
        "## Notes\nNice to have\n\n" +
        "Confidence: high. Source: manual.\n" +
        "\n" +
        "<!-- idea-intake:v1 idea=idea-1 key=key-123 -->\n"
    );
    expect(preview.labels).toEqual(["from-idea-intake"]);
  });

  it("adds the 'Derived from' line and the 'derived' label only when parentGithubIssueUrl is set", () => {
    const derived: Idea = { ...idea, parentGithubIssueUrl: "https://github.com/o/r/issues/9" };
    const preview = buildSubmitPreview(derived);
    expect(preview.body).toContain("Derived from: https://github.com/o/r/issues/9\n");
    expect(preview.labels).toEqual(["from-idea-intake", "derived"]);
  });

  it("never adds the 'derived' label or line for a non-derived idea", () => {
    const preview = buildSubmitPreview(idea);
    expect(preview.body).not.toContain("Derived from:");
    expect(preview.labels).not.toContain("derived");
  });

  it("the marker embeds exactly this idea's id and idempotency key, never another idea's", () => {
    const other: Idea = { ...idea, id: "idea-2", idempotencyKey: "key-999" };
    const preview = buildSubmitPreview(other);
    expect(preview.body).toContain("<!-- idea-intake:v1 idea=idea-2 key=key-999 -->");
    expect(preview.body).not.toContain("idea=idea-1");
  });
});
