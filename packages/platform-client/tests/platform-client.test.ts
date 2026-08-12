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
