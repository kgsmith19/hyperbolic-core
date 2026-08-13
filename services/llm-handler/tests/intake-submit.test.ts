import { test } from "node:test";
import assert from "node:assert/strict";
import { submitIdea, type SubmitDeps } from "../src/intake-submit.ts";

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const DEPS: SubmitDeps = {
  supabaseUrl: "https://proj.supabase.co",
  supabasePublishableKey: "anon-key",
  serviceRoleKey: "service-role-key",
  githubIntakePat: "ghp_fixture",
};

const IDEA_ID = "11111111-1111-1111-1111-111111111111";

function ideaRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "idea",
    title: "Faster onboarding",
    problem: "New devs take 2 days",
    outcome: "Env ready in under 1 hour",
    notes: "n/a",
    confidence: "high",
    source: "team retro",
    target_repo: "kgsmith19/hyperbolic-core",
    idempotency_key: "22222222-2222-2222-2222-222222222222",
    github_issue_number: null,
    github_issue_url: null,
    parent: null,
    ...overrides,
  };
}

/** A router keyed by (method, url substring) -> handler, mirroring the real
 * three endpoints submitIdea() calls: PostgREST select, GitHub list/create,
 * PostgREST RPC write-back. Records every call for call-count assertions. */
function router(handlers: Array<{ match: (url: string, method: string) => boolean; respond: (url: string, init?: RequestInit) => Response }>) {
  const calls: Array<{ url: string; method: string }> = [];
  const impl: FetchImpl = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const handler = handlers.find((h) => h.match(url, method));
    if (!handler) {
      throw new Error(`unexpected fetch call: ${method} ${url}`);
    }
    return handler.respond(url, init);
  };
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("submitIdea: draft status resolves draft_not_promoted with no GitHub call", async () => {
  const { impl, calls } = router([
    { match: (url) => url.includes("/rest/v1/idea"), respond: () => jsonResponse([ideaRow({ status: "draft" })]) },
  ]);
  await withPatchedFetch(impl, async () => {
    const outcome = await submitIdea(DEPS, "token", IDEA_ID);
    assert.deepEqual(outcome, { kind: "draft_not_promoted" });
  });
  assert.ok(!calls.some((c) => c.url.includes("api.github.com")), "draft must never reach GitHub");
});

test("submitIdea: already submitted_to_github resolves a no-op with the stored issue, no GitHub call", async () => {
  const { impl, calls } = router([
    {
      match: (url) => url.includes("/rest/v1/idea"),
      respond: () =>
        jsonResponse([
          ideaRow({
            status: "submitted_to_github",
            github_issue_number: 42,
            github_issue_url: "https://github.com/o/r/issues/42",
          }),
        ]),
    },
  ]);
  await withPatchedFetch(impl, async () => {
    const outcome = await submitIdea(DEPS, "token", IDEA_ID);
    assert.deepEqual(outcome, { kind: "already_submitted", issueNumber: 42, issueUrl: "https://github.com/o/r/issues/42" });
  });
  assert.ok(!calls.some((c) => c.url.includes("api.github.com")), "an already-submitted idea must never re-call GitHub");
});

test("submitIdea: idea with no marker match creates a new issue and writes back", async () => {
  const { impl, calls } = router([
    { match: (url) => url.includes("/rest/v1/idea") && !url.includes("rpc"), respond: () => jsonResponse([ideaRow()]) },
    { match: (url) => url.includes("api.github.com") && url.includes("issues?"), respond: () => jsonResponse([]) },
    {
      match: (url, method) => url.includes("api.github.com") && method === "POST",
      respond: (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.match(body.body, /<!-- idea-intake:v1 idea=11111111-1111-1111-1111-111111111111 key=22222222-2222-2222-2222-222222222222 -->/);
        assert.deepEqual(body.labels, ["from-idea-intake"]);
        return jsonResponse({ number: 100, html_url: "https://github.com/o/r/issues/100" }, 201);
      },
    },
    {
      match: (url) => url.includes("rpc/mark_submitted_to_github"),
      respond: (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.p_idea_id, IDEA_ID);
        assert.equal(body.p_issue_number, 100);
        return jsonResponse({ id: IDEA_ID }, 200);
      },
    },
  ]);
  await withPatchedFetch(impl, async () => {
    const outcome = await submitIdea(DEPS, "token", IDEA_ID);
    assert.deepEqual(outcome, { kind: "submitted", issueNumber: 100, issueUrl: "https://github.com/o/r/issues/100" });
  });
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("api.github.com/repos")).length, 1, "exactly one issue must be created");
});

test("submitIdea: derived label is applied when parent_idea_id / parentGithubIssueUrl is set", async () => {
  const { impl } = router([
    {
      match: (url) => url.includes("/rest/v1/idea") && !url.includes("rpc"),
      respond: () => jsonResponse([ideaRow({ parent: { github_issue_url: "https://github.com/o/r/issues/1" } })]),
    },
    { match: (url) => url.includes("api.github.com") && url.includes("issues?"), respond: () => jsonResponse([]) },
    {
      match: (url, method) => url.includes("api.github.com") && method === "POST",
      respond: (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.labels, ["from-idea-intake", "derived"]);
        assert.match(body.body, /Derived from: https:\/\/github\.com\/o\/r\/issues\/1/);
        return jsonResponse({ number: 101, html_url: "https://github.com/o/r/issues/101" }, 201);
      },
    },
    { match: (url) => url.includes("rpc/mark_submitted_to_github"), respond: () => jsonResponse({}, 200) },
  ]);
  await withPatchedFetch(impl, async () => {
    const outcome = await submitIdea(DEPS, "token", IDEA_ID);
    assert.equal(outcome.kind, "submitted");
  });
});

test("submitIdea: a marker found via the existence check skips creation and reuses the found issue (crash recovery)", async () => {
  const marker = "<!-- idea-intake:v1 idea=11111111-1111-1111-1111-111111111111 key=22222222-2222-2222-2222-222222222222 -->";
  let createCalls = 0;
  const { impl } = router([
    { match: (url) => url.includes("/rest/v1/idea") && !url.includes("rpc"), respond: () => jsonResponse([ideaRow()]) },
    {
      match: (url) => url.includes("api.github.com") && url.includes("issues?"),
      respond: () => jsonResponse([{ number: 55, html_url: "https://github.com/o/r/issues/55", body: `text\n${marker}` }]),
    },
    {
      match: (url, method) => url.includes("api.github.com") && method === "POST",
      respond: () => {
        createCalls += 1;
        return jsonResponse({ number: 999, html_url: "x" }, 201);
      },
    },
    { match: (url) => url.includes("rpc/mark_submitted_to_github"), respond: () => jsonResponse({}, 200) },
  ]);
  await withPatchedFetch(impl, async () => {
    const outcome = await submitIdea(DEPS, "token", IDEA_ID);
    assert.deepEqual(outcome, { kind: "submitted", issueNumber: 55, issueUrl: "https://github.com/o/r/issues/55" });
  });
  assert.equal(createCalls, 0, "a found marker must skip creation entirely");
});

// --- II-5 row-state invariant: every 05-h section 6.4 error class leaves
// the row untouched (no write-back call at all) ---

for (const status of [401, 404, 410, 422]) {
  test(`submitIdea: a ${status} from GitHub resolves an error outcome and never calls write-back (II-5)`, async () => {
    let writeBackCalled = false;
    const { impl } = router([
      { match: (url) => url.includes("/rest/v1/idea") && !url.includes("rpc"), respond: () => jsonResponse([ideaRow()]) },
      { match: (url) => url.includes("api.github.com") && url.includes("issues?"), respond: () => jsonResponse([]) },
      {
        match: (url, method) => url.includes("api.github.com") && method === "POST",
        respond: () => jsonResponse({ message: "fixture error" }, status),
      },
      {
        match: (url) => url.includes("rpc/mark_submitted_to_github"),
        respond: () => {
          writeBackCalled = true;
          return jsonResponse({}, 200);
        },
      },
    ]);
    await withPatchedFetch(impl, async () => {
      const outcome = await submitIdea(DEPS, "token", IDEA_ID);
      assert.equal(outcome.kind, "error");
    });
    assert.equal(writeBackCalled, false, `a ${status} failure must never write back (row must stay 'idea' with null github fields)`);
  });
}

test("submitIdea: a write-back failure after a successful create resolves error, not submitted (crash-recovery window, not silent success)", async () => {
  const { impl } = router([
    { match: (url) => url.includes("/rest/v1/idea") && !url.includes("rpc"), respond: () => jsonResponse([ideaRow()]) },
    { match: (url) => url.includes("api.github.com") && url.includes("issues?"), respond: () => jsonResponse([]) },
    {
      match: (url, method) => url.includes("api.github.com") && method === "POST",
      respond: () => jsonResponse({ number: 200, html_url: "https://github.com/o/r/issues/200" }, 201),
    },
    { match: (url) => url.includes("rpc/mark_submitted_to_github"), respond: () => jsonResponse({ message: "db down" }, 500) },
  ]);
  await withPatchedFetch(impl, async () => {
    const outcome = await submitIdea(DEPS, "token", IDEA_ID);
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.kind === "error" ? outcome.errorClass : null, "server_network");
  });
});

test("submitIdea: an idea row that vanishes/is RLS-hidden resolves a validation error, never throws", async () => {
  const { impl } = router([{ match: (url) => url.includes("/rest/v1/idea"), respond: () => jsonResponse([]) }]);
  await withPatchedFetch(impl, async () => {
    const outcome = await submitIdea(DEPS, "token", IDEA_ID);
    assert.equal(outcome.kind, "error");
  });
});

// --- Idempotent re-submit: two calls with the same idea, second must skip
// the GitHub network entirely once the row shows submitted_to_github ---

test("submitIdea: an idempotent re-submit after success makes zero GitHub calls on the second call", async () => {
  let submitted = false;
  const { impl } = router([
    {
      match: (url) => url.includes("/rest/v1/idea") && !url.includes("rpc"),
      respond: () =>
        submitted
          ? jsonResponse([ideaRow({ status: "submitted_to_github", github_issue_number: 300, github_issue_url: "https://github.com/o/r/issues/300" })])
          : jsonResponse([ideaRow()]),
    },
    { match: (url) => url.includes("api.github.com") && url.includes("issues?"), respond: () => jsonResponse([]) },
    {
      match: (url, method) => url.includes("api.github.com") && method === "POST",
      respond: () => jsonResponse({ number: 300, html_url: "https://github.com/o/r/issues/300" }, 201),
    },
    {
      match: (url) => url.includes("rpc/mark_submitted_to_github"),
      respond: () => {
        submitted = true;
        return jsonResponse({}, 200);
      },
    },
  ]);
  await withPatchedFetch(impl, async () => {
    const first = await submitIdea(DEPS, "token", IDEA_ID);
    assert.equal(first.kind, "submitted");
    const second = await submitIdea(DEPS, "token", IDEA_ID);
    assert.deepEqual(second, { kind: "already_submitted", issueNumber: 300, issueUrl: "https://github.com/o/r/issues/300" });
  });
});

// --- Per-idea in-process serialization (05-h section 6.5 step 5) ---

test("submitIdea: two concurrent submits for the SAME idea create exactly one GitHub issue", async () => {
  let selectCalls = 0;
  let createCalls = 0;
  let submitted = false;
  const { impl } = router([
    {
      match: (url) => url.includes("/rest/v1/idea") && !url.includes("rpc"),
      respond: () => {
        selectCalls += 1;
        return submitted
          ? jsonResponse([ideaRow({ status: "submitted_to_github", github_issue_number: 400, github_issue_url: "https://github.com/o/r/issues/400" })])
          : jsonResponse([ideaRow()]);
      },
    },
    { match: (url) => url.includes("api.github.com") && url.includes("issues?"), respond: () => jsonResponse([]) },
    {
      match: (url, method) => url.includes("api.github.com") && method === "POST",
      respond: async () => {
        createCalls += 1;
        // Yield so a genuinely concurrent second call's own read would
        // interleave here if the in-process lock were not serializing them.
        await new Promise((resolve) => setImmediate(resolve));
        return jsonResponse({ number: 400, html_url: "https://github.com/o/r/issues/400" }, 201);
      },
    },
    {
      match: (url) => url.includes("rpc/mark_submitted_to_github"),
      respond: () => {
        submitted = true;
        return jsonResponse({}, 200);
      },
    },
  ]);
  await withPatchedFetch(impl, async () => {
    const [a, b] = await Promise.all([submitIdea(DEPS, "token", IDEA_ID), submitIdea(DEPS, "token", IDEA_ID)]);
    assert.equal(a.kind === "submitted" || a.kind === "already_submitted", true);
    assert.equal(b.kind === "submitted" || b.kind === "already_submitted", true);
    const issueNumbers = [a, b].map((o) => (o.kind === "submitted" || o.kind === "already_submitted" ? o.issueNumber : null));
    assert.deepEqual(issueNumbers, [400, 400]);
  });
  assert.equal(createCalls, 1, "two concurrent submits for one idea must create exactly one GitHub issue");
  assert.ok(selectCalls >= 2, "the second call must re-read fresh state, not reuse the first call's stale read");
});

test("submitIdea: concurrent submits for DIFFERENT ideas run independently (no cross-idea serialization)", async () => {
  const otherId = "33333333-3333-3333-3333-333333333333";
  let createCalls = 0;
  const { impl } = router([
    { match: (url) => url.includes("/rest/v1/idea") && !url.includes("rpc"), respond: () => jsonResponse([ideaRow()]) },
    { match: (url) => url.includes("api.github.com") && url.includes("issues?"), respond: () => jsonResponse([]) },
    {
      match: (url, method) => url.includes("api.github.com") && method === "POST",
      respond: () => {
        createCalls += 1;
        return jsonResponse({ number: createCalls, html_url: `https://github.com/o/r/issues/${createCalls}` }, 201);
      },
    },
    { match: (url) => url.includes("rpc/mark_submitted_to_github"), respond: () => jsonResponse({}, 200) },
  ]);
  await withPatchedFetch(impl, async () => {
    const [a, b] = await Promise.all([submitIdea(DEPS, "token", IDEA_ID), submitIdea(DEPS, "token", otherId)]);
    assert.equal(a.kind, "submitted");
    assert.equal(b.kind, "submitted");
  });
  assert.equal(createCalls, 2, "two different ideas must each create their own issue");
});
