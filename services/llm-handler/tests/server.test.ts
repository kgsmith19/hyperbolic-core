import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.ts";
import type { HandlerConfig } from "../src/types.ts";

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// The test's own HTTP client (talking to the local loopback server under
// test) and the server's internal outbound calls (Supabase/GitHub) share
// ONE global fetch. Only the outbound calls should be mocked -- a request
// to 127.0.0.1 (the server under test) must fall through to the real fetch,
// or every server-level test would need to fully emulate its own transport.
async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("127.0.0.1") || url.includes("localhost")) {
      return original(input as RequestInfo, init);
    }
    return impl(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const CONFIG: HandlerConfig = {
  port: 0,
  supabaseUrl: "https://proj.supabase.co",
  supabasePublishableKey: "anon-key",
  githubIntakePat: "ghp_fixture",
};
const SERVICE_ROLE_KEY = "service-role-key";
const IDEA_ID = "11111111-1111-1111-1111-111111111111";

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await startServer(CONFIG, SERVICE_ROLE_KEY);
  try {
    const { port } = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("GET /api/healthz (the path tailscale's /api/ mount actually forwards) also returns 200 {status: ok}", async () => {
  // tailscale serve does not strip the /api/ mount prefix (verified against
  // apps/lifeos/backend/tests/api/test_root_path.py's identical claim for
  // its own /life/api/ mount) -- a public health check through the real
  // origin hits this path, not bare /healthz.
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("GET /healthz returns 200 {status: ok} with no auth required", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("POST /api/intake/submit with no Authorization header returns 401 fast, no network call", async () => {
  let networkCalled = false;
  await withPatchedFetch(
    async () => {
      networkCalled = true;
      return new Response("{}", { status: 200 });
    },
    () =>
      withServer(async (baseUrl) => {
        const started = performance.now();
        const res = await fetch(`${baseUrl}/api/intake/submit`, {
          method: "POST",
          body: JSON.stringify({ ideaId: IDEA_ID }),
        });
        const elapsedMs = performance.now() - started;
        assert.equal(res.status, 401);
        assert.ok(elapsedMs < 1000, `expected a fast local rejection, took ${elapsedMs}ms`);
      })
  );
  assert.equal(networkCalled, false, "a missing token must never reach the owner-session RPC");
});

test("POST /api/intake/submit with a malformed Authorization header returns 401, no network call", async () => {
  let networkCalled = false;
  await withPatchedFetch(
    async () => {
      networkCalled = true;
      return new Response("{}", { status: 200 });
    },
    () =>
      withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/intake/submit`, {
          method: "POST",
          headers: { authorization: "Basic garbage" },
          body: JSON.stringify({ ideaId: IDEA_ID }),
        });
        assert.equal(res.status, 401);
      })
  );
  assert.equal(networkCalled, false);
});

test("POST /api/intake/submit with a non-owner session returns 401", async () => {
  await withPatchedFetch(
    async (input) => {
      assert.match(String(input), /is_platform_owner/);
      return new Response("false", { status: 200 });
    },
    () =>
      withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/intake/submit`, {
          method: "POST",
          headers: { authorization: "Bearer non-owner-token" },
          body: JSON.stringify({ ideaId: IDEA_ID }),
        });
        assert.equal(res.status, 401);
      })
  );
});

test("POST /api/intake/submit with a missing ideaId returns 400 after a valid owner session", async () => {
  await withPatchedFetch(
    async (input) => {
      if (String(input).includes("is_platform_owner")) return new Response("true", { status: 200 });
      throw new Error(`unexpected call: ${input}`);
    },
    () =>
      withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/intake/submit`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify({}),
        });
        assert.equal(res.status, 400);
      })
  );
});

test("POST /api/intake/submit: full happy path returns 200 with the created issue", async () => {
  await withPatchedFetch(
    async (input, init) => {
      const url = String(input);
      if (url.includes("is_platform_owner")) return new Response("true", { status: 200 });
      if (url.includes("/rest/v1/idea") && !url.includes("rpc")) {
        return new Response(
          JSON.stringify([
            {
              status: "idea",
              title: "T",
              problem: "P",
              outcome: "O",
              notes: "N",
              confidence: "high",
              source: "S",
              target_repo: "o/r",
              idempotency_key: "22222222-2222-2222-2222-222222222222",
              github_issue_number: null,
              github_issue_url: null,
              parent: null,
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes("api.github.com") && url.includes("issues?")) return new Response("[]", { status: 200 });
      if (url.includes("api.github.com") && init?.method === "POST") {
        return new Response(JSON.stringify({ number: 9, html_url: "https://github.com/o/r/issues/9" }), { status: 201 });
      }
      if (url.includes("rpc/mark_submitted_to_github")) return new Response("{}", { status: 200 });
      throw new Error(`unexpected call: ${url}`);
    },
    () =>
      withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/intake/submit`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify({ ideaId: IDEA_ID }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { issueNumber: 9, issueUrl: "https://github.com/o/r/issues/9" });
      })
  );
});

test("POST /api/intake/submit: a draft idea returns 409", async () => {
  await withPatchedFetch(
    async (input) => {
      const url = String(input);
      if (url.includes("is_platform_owner")) return new Response("true", { status: 200 });
      if (url.includes("/rest/v1/idea")) {
        return new Response(
          JSON.stringify([
            {
              status: "draft",
              title: "T",
              problem: "",
              outcome: "",
              notes: "",
              confidence: "medium",
              source: "",
              target_repo: null,
              idempotency_key: "22222222-2222-2222-2222-222222222222",
              github_issue_number: null,
              github_issue_url: null,
              parent: null,
            },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`unexpected call: ${url}`);
    },
    () =>
      withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/intake/submit`, {
          method: "POST",
          headers: { authorization: "Bearer owner-token" },
          body: JSON.stringify({ ideaId: IDEA_ID }),
        });
        assert.equal(res.status, 409);
      })
  );
});

test("GET on the submit route (wrong method) returns 404, not a 405 that leaks route existence differently", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/intake/submit`);
    assert.equal(res.status, 404);
  });
});

test("an oversized request body is refused (connection closed, not a crash or a hang)", async () => {
  // Matches apps/agentic-command-center/backend/gui/server.mjs's own reviewed
  // over-cap behavior exactly (req.destroy() once the cap is exceeded):
  // the server refuses to buffer the payload at all rather than parsing an
  // oversized body, which severs the connection instead of completing an
  // HTTP round trip -- the client observes a transport failure, not a
  // clean 400 response. The real assertion is what matters here: the
  // server process itself survives (proved by the /healthz probe after)
  // and every OTHER connection stays completely unaffected.
  await withPatchedFetch(
    async (input) => {
      if (String(input).includes("is_platform_owner")) return new Response("true", { status: 200 });
      throw new Error("unexpected call");
    },
    () =>
      withServer(async (baseUrl) => {
        await assert.rejects(
          fetch(`${baseUrl}/api/intake/submit`, {
            method: "POST",
            headers: { authorization: "Bearer owner-token" },
            body: JSON.stringify({ ideaId: IDEA_ID, padding: "x".repeat(64 * 1024) }),
          })
        );
        const health = await fetch(`${baseUrl}/healthz`);
        assert.equal(health.status, 200, "the server must still be alive and serving other requests");
      })
  );
});
