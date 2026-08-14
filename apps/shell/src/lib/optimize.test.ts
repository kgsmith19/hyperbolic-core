// Idea Intake's LLM optimize flow (m4-06). This module is the only place
// that talks to rpc/get_prompt, POST /api/v1/complete, or intake.optimization
// -- a bug here is invisible to editor.test.tsx, which mocks this module
// away entirely. Covers: the get_prompt request shape, the Handler A
// request/response contract, defensive JSON-draft parsing (the model's own
// "produce exactly this JSON and nothing else" instruction is not trusted
// to hold), the unconditional intake.optimization log, and every failure
// mode surfacing as a clean thrown Error.
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, authedFetch } = vi.hoisted(() => ({
  auth: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() },
  authedFetch: vi.fn(),
}));

vi.mock("@hyperbolic/platform-client", () => ({
  createPlatformClient: () => ({ auth, fetch: authedFetch }),
  createRegistryClient: () => ({ listTools: vi.fn(), getTool: vi.fn() }),
}));

import { optimizeIdea } from "./optimize";
import type { Idea } from "./intake";

const FIXTURE_TOKEN = "fixture-access-token";

const IDEA: Idea = {
  id: "00000000-0000-4000-8000-000000000001",
  parentIdeaId: null,
  title: "Add dark mode",
  problem: "No dark mode",
  outcome: "A dark theme toggle",
  notes: "Nice to have",
  confidence: "medium",
  status: "idea",
  source: "manual",
  targetRepo: "kgsmith19/hyperbolic-core",
  idempotencyKey: "aaaaaaaa-0000-4000-8000-000000000002",
  githubIssueNumber: null,
  githubIssueUrl: null,
  submittedAt: null,
  parentGithubIssueUrl: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
};

const DRAFT_JSON = {
  title: "Ship a dark theme toggle",
  problem: "Users have no dark mode option",
  outcome: "A working dark theme toggle in settings",
  notes: "",
  confidence: "high",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function resetMocks() {
  auth.getSession.mockReset();
  authedFetch.mockReset();
  auth.getSession.mockResolvedValue({ accessToken: FIXTURE_TOKEN, expiresAt: 9_999_999_999, userId: "owner" });
}

/** Ordered raw-fetch stub: optimizeIdea makes exactly two raw fetch calls
 * (rpc/get_prompt, then the intake.optimization insert) around one
 * authedFetch call (POST /api/v1/complete) in between. */
function stubRawFetch(getPromptResponse: Response, optimizationLogResponse: Response) {
  const spy = vi.fn().mockResolvedValueOnce(getPromptResponse).mockResolvedValueOnce(optimizationLogResponse);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("optimizeIdea: the happy path", () => {
  it("fetches the rendered prompt, calls Handler A, logs one optimization row, and returns the parsed draft", async () => {
    resetMocks();
    const rawFetchSpy = stubRawFetch(jsonResponse(200, { text: "RENDERED PROMPT", version_no: 1 }), jsonResponse(201, {}));
    authedFetch.mockResolvedValue(jsonResponse(200, { text: JSON.stringify(DRAFT_JSON), provider: "anthropic", model: "claude-sonnet-5" }));

    const result = await optimizeIdea(IDEA);

    expect(result.draft).toEqual(DRAFT_JSON);
    expect(result.model).toBe("claude-sonnet-5");
    expect(typeof result.handlerRunId).toBe("string");
    expect(result.handlerRunId.length).toBeGreaterThan(0);

    // Call 1: rpc/get_prompt with this idea's fields as p_values.
    const [getPromptUrl, getPromptInit] = rawFetchSpy.mock.calls[0] as [string, RequestInit];
    expect(getPromptUrl).toContain("/rest/v1/rpc/get_prompt");
    const getPromptHeaders = new Headers(getPromptInit.headers);
    expect(getPromptHeaders.get("Authorization")).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(getPromptHeaders.get("Content-Profile")).toBe("prompt");
    expect(JSON.parse(getPromptInit.body as string)).toEqual({
      p_name: "idea-intake/optimize-v1",
      p_values: { TITLE: IDEA.title, PROBLEM: IDEA.problem, OUTCOME: IDEA.outcome, NOTES: IDEA.notes, TARGET_REPO: IDEA.targetRepo },
    });

    // Handler A call rides platformClient.fetch (authedFetch), not raw fetch.
    expect(authedFetch).toHaveBeenCalledTimes(1);
    const [completeUrl, completeInit] = authedFetch.mock.calls[0] as [string, RequestInit];
    expect(completeUrl).toBe("/api/v1/complete");
    const completeBody = JSON.parse(completeInit.body as string);
    expect(completeBody.messages).toEqual([{ role: "user", content: "RENDERED PROMPT" }]);
    expect(completeBody.metadata).toMatchObject({ callerApp: "idea-intake", purpose: "optimize-idea", runRef: result.handlerRunId });

    // Call 2: the intake.optimization append, carrying the same runRef as handler_run_id.
    const [logUrl, logInit] = rawFetchSpy.mock.calls[1] as [string, RequestInit];
    expect(logUrl).toContain("/rest/v1/optimization");
    const logHeaders = new Headers(logInit.headers);
    expect(logHeaders.get("Content-Profile")).toBe("intake");
    expect(JSON.parse(logInit.body as string)).toEqual({
      input_idea_id: IDEA.id,
      prompt_name: "idea-intake/optimize-v1",
      model: "claude-sonnet-5",
      handler_run_id: result.handlerRunId,
    });
  });

  it("parses a JSON draft even when the model wraps it in prose or a code fence", async () => {
    resetMocks();
    stubRawFetch(jsonResponse(200, { text: "RENDERED PROMPT" }), jsonResponse(201, {}));
    authedFetch.mockResolvedValue(
      jsonResponse(200, { text: "Here you go:\n```json\n" + JSON.stringify(DRAFT_JSON) + "\n```", model: "claude-sonnet-5" })
    );

    await expect(optimizeIdea(IDEA)).resolves.toMatchObject({ draft: DRAFT_JSON });
  });
});

describe("optimizeIdea: failure modes surface as thrown Errors", () => {
  it("throws when get_prompt itself fails", async () => {
    resetMocks();
    stubRawFetch(new Response("not found", { status: 404 }), jsonResponse(201, {}));
    await expect(optimizeIdea(IDEA)).rejects.toThrow(/get_prompt failed with 404/);
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("throws when Handler A returns a non-2xx status, without logging an optimization row", async () => {
    resetMocks();
    const rawFetchSpy = stubRawFetch(jsonResponse(200, { text: "RENDERED PROMPT" }), jsonResponse(201, {}));
    authedFetch.mockResolvedValue(jsonResponse(429, { error: "rate_limit", message: "caller is at its concurrency cap" }));

    await expect(optimizeIdea(IDEA)).rejects.toThrow(/Handler A returned 429/);
    expect(rawFetchSpy).toHaveBeenCalledTimes(1); // only get_prompt; the optimization insert never fires
  });

  it("throws when the model response has no JSON object at all", async () => {
    resetMocks();
    stubRawFetch(jsonResponse(200, { text: "RENDERED PROMPT" }), jsonResponse(201, {}));
    authedFetch.mockResolvedValue(jsonResponse(200, { text: "I could not complete this task.", model: "claude-sonnet-5" }));

    await expect(optimizeIdea(IDEA)).rejects.toThrow(/did not contain a JSON object/);
  });

  it("throws when the parsed JSON is missing a required draft field", async () => {
    resetMocks();
    stubRawFetch(jsonResponse(200, { text: "RENDERED PROMPT" }), jsonResponse(201, {}));
    authedFetch.mockResolvedValue(jsonResponse(200, { text: JSON.stringify({ title: "Only a title" }), model: "claude-sonnet-5" }));

    await expect(optimizeIdea(IDEA)).rejects.toThrow(/did not match the expected draft shape/);
  });

  it("throws when the logging insert itself fails, after the draft was already produced", async () => {
    resetMocks();
    stubRawFetch(jsonResponse(200, { text: "RENDERED PROMPT" }), new Response("db unreachable", { status: 500 }));
    authedFetch.mockResolvedValue(jsonResponse(200, { text: JSON.stringify(DRAFT_JSON), model: "claude-sonnet-5" }));

    await expect(optimizeIdea(IDEA)).rejects.toThrow(/logging the optimization failed with 500/);
  });
});
