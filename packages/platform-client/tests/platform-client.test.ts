import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlatformClient } from "../src/index.ts";

// Fixture data only; this is not a real credential or a real project.
const FIXTURE_OWNER_UUID = "00000000-0000-4000-8000-000000000001";
const FIXTURE_EMAIL = "kylegsmith19@gmail.com";
const FIXTURE_PASSWORD = "correct horse battery staple";
const FIXTURE_CONFIG = {
  supabaseUrl: "https://fixture-project.supabase.invalid",
  publishableKey: "fixture-publishable-key",
};

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Body shape of a Supabase Auth `/token` grant response, for the fixture owner. */
function fixtureSignInBody(expiresAt: number) {
  return {
    access_token: "fixture.access.token",
    token_type: "bearer",
    expires_in: expiresAt - nowSeconds(),
    expires_at: expiresAt,
    refresh_token: "fixture-refresh-token",
    user: {
      id: FIXTURE_OWNER_UUID,
      aud: "authenticated",
      role: "authenticated",
      email: FIXTURE_EMAIL,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

/**
 * Swaps `globalThis.fetch` for `impl` for the duration of `run`, always
 * restoring the original afterwards. This is the seam `createPlatformClient`
 * is written to observe: it never captures `fetch` at module load, only at
 * call time, via `@supabase/supabase-js`'s own default fetch resolution and
 * this package's own `authedFetch` pass-through (see src/index.ts).
 */
async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Stubs `globalThis.location` for the duration of `run`, restoring whatever
 * was there before (nothing, in this plain `node:test` environment) after.
 * This is the seam `authedFetch`'s origin check (src/index.ts,
 * `resolveRequestOrigin` / `isOriginAllowed`) reads to resolve same-origin
 * relative paths and protocol-relative URLs exactly the way a real browser
 * tab would -- a `URL` instance supplies the same `.href`/`.origin` shape
 * `authedFetch` actually reads off `Location`, so it stands in for one
 * without needing a DOM.
 */
async function withStubbedLocation<T>(href: string, run: () => Promise<T>): Promise<T> {
  const hadLocation = "location" in globalThis;
  const original = (globalThis as { location?: unknown }).location;
  Object.defineProperty(globalThis, "location", {
    value: new URL(href),
    configurable: true,
    writable: true,
  });
  try {
    return await run();
  } finally {
    if (hadLocation) {
      Object.defineProperty(globalThis, "location", {
        value: original,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
  }
}

/**
 * A `globalThis.fetch` stand-in for the authedFetch-origin-allowlist tests
 * below: routes Supabase's own `/auth/v1/token?grant_type=password` sign-in
 * call to a fixture session response (so `client.auth.signInWithPassword`
 * keeps working exactly as in the tests above), and records every OTHER
 * call's URL and headers into `captured` -- this is the seam the "never
 * attaches/sends the Authorization header" assertions read, since asserting
 * only that a promise rejected would miss a bug that rejects AFTER already
 * calling `fetch` with the token attached.
 */
function makeAuthAndCaptureSpy(
  expiresAt: number,
  captured: Array<{ url: string; headers: Headers }>
): FetchImpl {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("grant_type=password")) {
      return jsonResponse(fixtureSignInBody(expiresAt));
    }
    captured.push({ url, headers: new Headers(init?.headers) });
    return jsonResponse({ ok: true });
  };
}

test("signInWithPassword against a mocked IdP resolves a session for the fixture owner", async (t) => {
  const spy = t.mock.fn(async (input: RequestInfo | URL) => {
    assert.match(String(input), /grant_type=password/);
    return jsonResponse(fixtureSignInBody(nowSeconds() + 3600));
  });

  const session = await withPatchedFetch(spy, async () => {
    const client = createPlatformClient(FIXTURE_CONFIG);
    return client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
  });

  assert.equal(session.userId, FIXTURE_OWNER_UUID);
  assert.equal(session.accessToken, "fixture.access.token");
  assert.equal(typeof session.expiresAt, "number");
  assert.equal(spy.mock.callCount(), 1);
});

test("AuthedFetch rejects with zero network calls when there is no session", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse({}));

  await withPatchedFetch(spy, async () => {
    const client = createPlatformClient(FIXTURE_CONFIG);
    await assert.rejects(() => client.fetch("https://api.fixture.invalid/resource"));
  });

  // The reject path must never reach the network: not for a session check
  // that hits the IdP (there is nothing in storage to refresh) and not for
  // the pass-through request itself.
  assert.equal(spy.mock.callCount(), 0);
});

test(
  "getSession resolves null, without throwing or attempting an authenticated call, " +
    "when the IdP is unreachable and the token is expired",
  async (t) => {
    const spy = t.mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("grant_type=password")) {
        // Sign-in succeeds but hands back a token that is already expired,
        // so the very next getSession() must attempt (and fail) a refresh.
        return jsonResponse(fixtureSignInBody(nowSeconds() - 60));
      }
      // Every other call is the refresh attempt: simulate an unreachable IdP.
      throw new Error("simulated network failure: IdP unreachable");
    });

    // supabase-js retries a failed refresh with exponential backoff for up
    // to ~30s (its own AUTO_REFRESH_TICK_DURATION_MS budget) before giving
    // up. Drive its internal setTimeout-based backoff with the fake clock
    // instead of spending 30 real seconds proving a fail-closed return value.
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const session = await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);
      await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);

      const pending = client.auth.getSession();
      let settled = false;
      pending.then(() => {
        settled = true;
      });
      for (let i = 0; i < 60 && !settled; i++) {
        t.mock.timers.tick(1000);
        // Yield to the real event loop so the rejected-fetch promise chain
        // and each newly-scheduled retry timer can actually run in between
        // fake-clock advances.
        await new Promise((resolve) => setImmediate(resolve));
      }
      return pending;
    });

    assert.equal(session, null);
    // No call ever carried the stale token to an application resource; every
    // observed call was a call to the IdP's own token endpoint.
    for (const call of spy.mock.calls) {
      assert.match(String(call.arguments[0]), /\/auth\/v1\/token\?grant_type=/);
    }
  },
);

// --- authedFetch origin allowlist (P1 fix, src/index.ts authedFetch) -------
//
// Every test below signs in for real first (through the same mocked
// `/auth/v1/token` path the tests above use) so `authedFetch` has a live
// session to attach -- these tests are about WHICH requests get that
// session's token attached, not about the no-session fail-closed path
// already covered above.

test("authedFetch: a same-origin relative URL proceeds and gets the Authorization header attached (positive case)", async (t) => {
  const captured: Array<{ url: string; headers: Headers }> = [];
  const spy = t.mock.fn(makeAuthAndCaptureSpy(nowSeconds() + 3600, captured));

  await withStubbedLocation("https://shell.example.invalid/tools", async () => {
    await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);
      await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      const res = await client.fetch("/life/api/entities");
      assert.equal(res.status, 200);
    });
  });

  assert.equal(captured.length, 1);
  // authedFetch passes `input` through to globalThis.fetch UNCHANGED (still
  // the original relative string) -- only the origin-allowlist CHECK
  // resolves it against the stubbed page origin, exactly like a real
  // browser's own fetch() would resolve this same relative path itself.
  // Rewriting `input` before the pass-through isn't this fix's job and
  // would be an unrelated behavior change.
  assert.equal(captured[0]?.url, "/life/api/entities");
  assert.equal(captured[0]?.headers.get("authorization"), "Bearer fixture.access.token");
});

test("authedFetch: an absolute URL on the configured Supabase origin proceeds and gets the Authorization header attached (positive case)", async (t) => {
  const captured: Array<{ url: string; headers: Headers }> = [];
  const spy = t.mock.fn(makeAuthAndCaptureSpy(nowSeconds() + 3600, captured));

  await withPatchedFetch(spy, async () => {
    const client = createPlatformClient(FIXTURE_CONFIG);
    await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
    const res = await client.fetch(`${FIXTURE_CONFIG.supabaseUrl}/rest/v1/app?select=id`);
    assert.equal(res.status, 200);
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.headers.get("authorization"), "Bearer fixture.access.token");
});

test(
  "authedFetch: an absolute URL to a different, non-allowlisted origin is rejected and the " +
    "Authorization header is NEVER attached or sent (the actual point of the fix)",
  async (t) => {
    const captured: Array<{ url: string; headers: Headers }> = [];
    const spy = t.mock.fn(makeAuthAndCaptureSpy(nowSeconds() + 3600, captured));

    await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);
      await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      await assert.rejects(
        () => client.fetch("https://evil.invalid/steal"),
        /refusing to attach the platform session token/
      );
    });

    // The point of this test: not merely that the call rejected, but that
    // globalThis.fetch was never invoked for it at all -- so there is no
    // world in which the token reached evil.invalid before the rejection.
    assert.equal(captured.length, 0);
  }
);

test(
  "authedFetch: a protocol-relative URL (//evil.invalid/...) pointed at a non-allowlisted host is rejected, " +
    "token never attached or sent",
  async (t) => {
    const captured: Array<{ url: string; headers: Headers }> = [];
    const spy = t.mock.fn(makeAuthAndCaptureSpy(nowSeconds() + 3600, captured));

    await withStubbedLocation("https://shell.example.invalid/tools", async () => {
      await withPatchedFetch(spy, async () => {
        const client = createPlatformClient(FIXTURE_CONFIG);
        await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
        // "//evil.invalid/steal" resolved against the stubbed page origin
        // becomes the absolute URL https://evil.invalid/steal -- the classic
        // protocol-relative escalation an attacker would try against code
        // that only origin-checks strings starting with "http".
        await assert.rejects(
          () => client.fetch("//evil.invalid/steal"),
          /refusing to attach the platform session token/
        );
      });
    });

    assert.equal(captured.length, 0);
  }
);
