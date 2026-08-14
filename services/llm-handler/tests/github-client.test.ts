import { test } from "node:test";
import assert from "node:assert/strict";
import { findIssueByMarker, createIssue } from "../src/github-client.ts";
import { GithubSubmitError } from "../src/types.ts";

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

/** Advances the fake clock in small steps, flushing real microtasks between
 * each -- the same idiom packages/llm/tests/anthropic-driver.test.ts uses
 * for a multi-await retry chain under mocked timers. */
async function tickInSteps(t: { mock: { timers: { tick(ms: number): void } } }, totalMs: number, stepMs = 100): Promise<void> {
  for (let advanced = 0; advanced < totalMs; advanced += stepMs) {
    t.mock.timers.tick(Math.min(stepMs, totalMs - advanced));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test("createIssue: a clean 201 returns the created issue", async () => {
  await withPatchedFetch(
    async (input, init) => {
      assert.equal(String(input), "https://api.github.com/repos/kgsmith19/hyperbolic-core/issues");
      assert.equal(init?.method, "POST");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer ghp_fixture");
      assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.title, "My idea");
      assert.deepEqual(body.labels, ["from-idea-intake"]);
      return jsonResponse({ number: 42, html_url: "https://github.com/kgsmith19/hyperbolic-core/issues/42" }, 201);
    },
    async () => {
      const issue = await createIssue("ghp_fixture", "kgsmith19/hyperbolic-core", {
        title: "My idea",
        body: "body text",
        labels: ["from-idea-intake"],
      });
      assert.deepEqual(issue, { number: 42, htmlUrl: "https://github.com/kgsmith19/hyperbolic-core/issues/42" });
    }
  );
});

test("createIssue: 401 classifies as auth_invalid and never retries", async () => {
  let calls = 0;
  await withPatchedFetch(
    async () => {
      calls += 1;
      return jsonResponse({ message: "Bad credentials" }, 401);
    },
    async () => {
      await assert.rejects(
        () => createIssue("bad-pat", "o/r", { title: "t", body: "b", labels: [] }),
        (err: unknown) => err instanceof GithubSubmitError && err.class === "auth_invalid"
      );
    }
  );
  assert.equal(calls, 1, "auth_invalid must not retry");
});

test("createIssue: 404 classifies as repo_unreachable and never retries", async () => {
  let calls = 0;
  await withPatchedFetch(
    async () => {
      calls += 1;
      return jsonResponse({ message: "Not Found" }, 404);
    },
    async () => {
      await assert.rejects(
        () => createIssue("pat", "o/nonexistent", { title: "t", body: "b", labels: [] }),
        (err: unknown) => err instanceof GithubSubmitError && err.class === "repo_unreachable"
      );
    }
  );
  assert.equal(calls, 1);
});

test("createIssue: 410 classifies as issues_disabled and never retries", async () => {
  await withPatchedFetch(
    async () => jsonResponse({ message: "Issues disabled" }, 410),
    async () => {
      await assert.rejects(
        () => createIssue("pat", "o/r", { title: "t", body: "b", labels: [] }),
        (err: unknown) => err instanceof GithubSubmitError && err.class === "issues_disabled"
      );
    }
  );
});

test("createIssue: 422 classifies as validation and never retries", async () => {
  await withPatchedFetch(
    async () => jsonResponse({ message: "Validation Failed" }, 422),
    async () => {
      await assert.rejects(
        () => createIssue("pat", "o/r", { title: "t", body: "b", labels: [] }),
        (err: unknown) => err instanceof GithubSubmitError && err.class === "validation"
      );
    }
  );
});

test("createIssue: 429 with x-ratelimit-remaining: 0 waits per header then retries once, then fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const promise = withPatchedFetch(
    async () => {
      calls += 1;
      return jsonResponse({ message: "rate limited" }, 429, { "x-ratelimit-remaining": "0", "retry-after": "2" });
    },
    () => createIssue("pat", "o/r", { title: "t", body: "b", labels: [] })
  );
  // Attach the rejection assertion BEFORE ticking the clock: `promise`
  // rejects mid-tick, and a handler must already be attached at that
  // instant or Node's test runner flags it as an unhandled rejection.
  const assertion = assert.rejects(promise, (err: unknown) => err instanceof GithubSubmitError && err.class === "rate_limited");
  await tickInSteps(t, 2_500);
  await assertion;
  assert.equal(calls, 2, "rate_limited retries exactly once");
});

test("createIssue: 500 retries twice with 1s/4s backoff, then fails as server_network", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const promise = withPatchedFetch(
    async () => {
      calls += 1;
      return jsonResponse({ message: "internal error" }, 500);
    },
    () => createIssue("pat", "o/r", { title: "t", body: "b", labels: [] })
  );
  const assertion500 = assert.rejects(promise, (err: unknown) => err instanceof GithubSubmitError && err.class === "server_network");
  await tickInSteps(t, 6_000);
  await assertion500;
  assert.equal(calls, 3, "one initial attempt plus two retries");
});

test("createIssue: a thrown network error (DNS/timeout) is classified server_network and retried the same way", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const promise = withPatchedFetch(
    async () => {
      calls += 1;
      throw new Error("ENOTFOUND api.github.com");
    },
    () => createIssue("pat", "o/r", { title: "t", body: "b", labels: [] })
  );
  const assertionNetwork = assert.rejects(promise, (err: unknown) => err instanceof GithubSubmitError && err.class === "server_network");
  await tickInSteps(t, 6_000);
  await assertionNetwork;
  assert.equal(calls, 3);
});

test("createIssue: a transient 500 that recovers on retry succeeds without exhausting all retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const promise = withPatchedFetch(
    async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ message: "internal error" }, 500);
      return jsonResponse({ number: 7, html_url: "https://github.com/o/r/issues/7" }, 201);
    },
    () => createIssue("pat", "o/r", { title: "t", body: "b", labels: [] })
  );
  await tickInSteps(t, 2_000);
  const issue = await promise;
  assert.deepEqual(issue, { number: 7, htmlUrl: "https://github.com/o/r/issues/7" });
  assert.equal(calls, 2);
});

// --- findIssueByMarker: idempotency marker scan (05-h section 6.5 step 2) ---

test("findIssueByMarker: no pages, no match resolves null without creating anything", async () => {
  let calls = 0;
  await withPatchedFetch(
    async (input) => {
      calls += 1;
      assert.match(String(input), /page=1/);
      return jsonResponse([], 200);
    },
    async () => {
      const result = await findIssueByMarker("pat", "o/r", "<!-- marker -->");
      assert.equal(result, null);
    }
  );
  assert.equal(calls, 1, "an empty (short) first page must not fetch page 2");
});

test("findIssueByMarker: finds the marker on page 1 and stops (no page 2 request)", async () => {
  let calls = 0;
  await withPatchedFetch(
    async () => {
      calls += 1;
      return jsonResponse(
        [{ number: 5, html_url: "https://github.com/o/r/issues/5", body: "text\n<!-- marker -->" }],
        200
      );
    },
    async () => {
      const result = await findIssueByMarker("pat", "o/r", "<!-- marker -->");
      assert.deepEqual(result, { number: 5, htmlUrl: "https://github.com/o/r/issues/5" });
    }
  );
  assert.equal(calls, 1);
});

test("findIssueByMarker: scans up to exactly 3 pages, then stops even without a match (the documented bound)", async () => {
  const requestedPages: number[] = [];
  await withPatchedFetch(
    async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      // Every page returns a FULL page (100 items) with no marker match, so
      // the scan would keep going forever if not capped.
      const issues = Array.from({ length: 100 }, (_, i) => ({
        number: page * 1000 + i,
        html_url: "https://github.com/o/r/issues/x",
        body: "no marker here",
      }));
      return jsonResponse(issues, 200);
    },
    async () => {
      const result = await findIssueByMarker("pat", "o/r", "<!-- marker -->");
      assert.equal(result, null);
    }
  );
  assert.deepEqual(requestedPages, [1, 2, 3], "must request exactly pages 1-3, never a 4th page");
});

test("findIssueByMarker: finds the marker on page 3 (the cap boundary itself)", async () => {
  const requestedPages: number[] = [];
  await withPatchedFetch(
    async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      if (page < 3) {
        return jsonResponse(
          Array.from({ length: 100 }, (_, i) => ({ number: i, html_url: "x", body: "no marker" })),
          200
        );
      }
      return jsonResponse(
        [{ number: 99, html_url: "https://github.com/o/r/issues/99", body: "<!-- marker -->" }],
        200
      );
    },
    async () => {
      const result = await findIssueByMarker("pat", "o/r", "<!-- marker -->");
      assert.deepEqual(result, { number: 99, htmlUrl: "https://github.com/o/r/issues/99" });
    }
  );
  assert.deepEqual(requestedPages, [1, 2, 3]);
});

test("findIssueByMarker: a null issue body never matches (no crash on null.includes)", async () => {
  await withPatchedFetch(
    async () => jsonResponse([{ number: 1, html_url: "x", body: null }], 200),
    async () => {
      const result = await findIssueByMarker("pat", "o/r", "<!-- marker -->");
      assert.equal(result, null);
    }
  );
});
