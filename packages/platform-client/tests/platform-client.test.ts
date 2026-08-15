import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlatformClient } from "../src/index.ts";
import { jsonResponse } from "./support.ts";

// Fixture data only; this is not a real credential or a real project.
const FIXTURE_OWNER_UUID = "00000000-0000-4000-8000-000000000001";
// Finding #47 (PR #8 security review): any OTHER authenticated Supabase
// subject is exactly the case `core.is_platform_owner()`
// (apps/toolbelt/supabase/migrations/20260814060000_core_is_platform_owner_rpc.sql)
// and src/index.ts's `enforceOwner` must reject and sign out. Deliberately a
// different, equally well-formed UUID -- not null/empty/malformed -- so
// these tests prove real, successfully-authenticated-but-wrong-subject
// rejection, not merely "garbage input is rejected".
const FIXTURE_NON_OWNER_UUID = "00000000-0000-4000-8000-000000000002";
const FIXTURE_EMAIL = "kylegsmith19@gmail.com";
const FIXTURE_NON_OWNER_EMAIL = "not-the-owner@example.invalid";
const FIXTURE_PASSWORD = "correct horse battery staple";
const FIXTURE_CONFIG = {
  supabaseUrl: "https://fixture-project.supabase.invalid",
  publishableKey: "fixture-publishable-key",
};

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// --- Finding #47 fixture plumbing -------------------------------------------
//
// `core.is_platform_owner()` is called by src/index.ts's `isOwnerSession`
// with a raw `fetch`, `session.accessToken` attached explicitly as the
// bearer token (deliberately NOT `supabase.rpc()` -- see that function's own
// doc comment on the session-race reason). The fixture responder below
// mirrors that contract: it answers strictly from whichever bearer token
// arrived on THIS request, exactly like the real SECURITY DEFINER RPC would
// answer from whichever JWT's `auth.uid()` arrived on the connection -- never
// from "whichever session the test most recently signed in" or any other
// test-side bookkeeping. That is what makes the session-race tests below
// able to actually prove something: the fixture backend has no memory of
// "current" identity, only of which token is on which request.

function isSignInUrl(url: string): boolean {
  return url.includes("grant_type=password");
}

function isOwnerRpcUrl(url: string): boolean {
  return url.includes("/rest/v1/rpc/is_platform_owner");
}

function isSignOutUrl(url: string): boolean {
  return url.includes("/auth/v1/logout");
}

/** The exact, fixed access-token string every existing test in this file already asserts on. */
const OWNER_ACCESS_TOKEN = "fixture.access.token";

function accessTokenFor(userId: string): string {
  return userId === FIXTURE_OWNER_UUID ? OWNER_ACCESS_TOKEN : `fixture.access.token.non-owner.${userId}`;
}

/** Body shape of a Supabase Auth `/token` grant response, for a configurable subject. */
function fixtureSignInBody(expiresAt: number, userId: string = FIXTURE_OWNER_UUID) {
  return {
    access_token: accessTokenFor(userId),
    token_type: "bearer",
    expires_in: expiresAt - nowSeconds(),
    expires_at: expiresAt,
    refresh_token: `fixture-refresh-token.${userId}`,
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: userId === FIXTURE_OWNER_UUID ? FIXTURE_EMAIL : FIXTURE_NON_OWNER_EMAIL,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

/**
 * The fixture `core.is_platform_owner()` responder: reads the `Authorization`
 * header actually attached to THIS request and answers `true` only for the
 * exact fixed owner token, `false` for anything else (a non-owner's token,
 * a missing header, a stale/mismatched one). Also asserts the request
 * targets the `core` schema (`Content-Profile: core`, the header
 * src/index.ts's `isOwnerSession` sets) -- the one thing every caller of
 * this RPC must get right per the migration's own header comment (`platform`
 * is deliberately not PostgREST-exposed; `core` is).
 */
function isOwnerRpcResponse(init: RequestInit | undefined): Response {
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("content-profile"), "core", "expected the owner-check RPC to target the core schema");
  const isOwner = headers.get("authorization") === `Bearer ${accessTokenFor(FIXTURE_OWNER_UUID)}`;
  return jsonResponse(isOwner);
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
 * The default fixture backend most tests below build on: routes Supabase
 * Auth's sign-in endpoint to a configurable-subject fixture session,
 * `core.is_platform_owner()` to `isOwnerRpcResponse` (Finding #47 -- answers
 * from whichever token the request under test actually attached), and
 * Auth's sign-out endpoint to a bare success. Anything else falls through to
 * `onOther` (default: a generic ok response) -- this is the seam tests that
 * care about a specific non-auth resource call plug into.
 */
function makeFetchStub(options: {
  signInUserId?: string;
  expiresAt?: number;
  onOther?: FetchImpl;
} = {}): FetchImpl {
  const { signInUserId = FIXTURE_OWNER_UUID, expiresAt = nowSeconds() + 3600, onOther } = options;
  return async (input, init) => {
    const url = String(input);
    if (isSignInUrl(url)) {
      return jsonResponse(fixtureSignInBody(expiresAt, signInUserId));
    }
    if (isOwnerRpcUrl(url)) {
      return isOwnerRpcResponse(init);
    }
    if (isSignOutUrl(url)) {
      return jsonResponse({});
    }
    if (onOther) {
      return onOther(input, init);
    }
    return jsonResponse({ ok: true });
  };
}

test("signInWithPassword against a mocked IdP resolves a session for the fixture owner", async (t) => {
  const spy = t.mock.fn(makeFetchStub());

  const session = await withPatchedFetch(spy, async () => {
    const client = createPlatformClient(FIXTURE_CONFIG);
    return client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
  });

  assert.equal(session.userId, FIXTURE_OWNER_UUID);
  assert.equal(session.accessToken, OWNER_ACCESS_TOKEN);
  assert.equal(typeof session.expiresAt, "number");

  // Finding #47: a successful sign-in for the real owner must ALSO have
  // called the owner-check RPC (not just the token grant) -- the fix is
  // "verify on every path", not "verify only the non-owner path".
  const urls = spy.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(urls.some(isSignInUrl), "expected the sign-in call");
  assert.ok(urls.some(isOwnerRpcUrl), "expected the core.is_platform_owner() owner-check call");
});

test("AuthedFetch rejects with zero network calls when there is no session", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse({}));

  await withPatchedFetch(spy, async () => {
    const client = createPlatformClient(FIXTURE_CONFIG);
    await assert.rejects(() => client.fetch("https://api.fixture.invalid/resource"));
  });

  // The reject path must never reach the network: not for a session check
  // that hits the IdP (there is nothing in storage to refresh) and not for
  // the pass-through request itself, and (Finding #47) not for the
  // owner-check RPC either -- there is no session to check ownership of.
  assert.equal(spy.mock.callCount(), 0);
});

test(
  "getSession resolves null, without throwing or attempting an authenticated call, " +
    "when the IdP is unreachable and the token is expired",
  async (t) => {
    const spy = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("grant_type=password")) {
        // Sign-in succeeds but hands back a token that is already expired,
        // so the very next getSession() must attempt (and fail) a refresh.
        return jsonResponse(fixtureSignInBody(nowSeconds() - 60));
      }
      if (isOwnerRpcUrl(url)) {
        // Finding #47: signInWithPassword's OWN owner-check RPC call fires
        // (and must succeed) immediately after the token grant above,
        // BEFORE this test's real subject -- getSession()'s refresh-failure
        // path -- is ever reached. If this answered anything other than
        // "yes, owner", sign-in itself would reject here and this test
        // would never get to exercise getSession() at all.
        return isOwnerRpcResponse(init);
      }
      // Every other call (the refresh attempt inside getSession()) is the
      // one this test is actually about: simulate an unreachable IdP.
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
    // observed call was either the IdP's own token endpoint or (Finding #47)
    // the sign-in-time owner-check RPC.
    for (const call of spy.mock.calls) {
      const url = String(call.arguments[0]);
      assert.ok(
        /\/auth\/v1\/token\?grant_type=/.test(url) || isOwnerRpcUrl(url),
        `unexpected call to ${url}`
      );
    }
  },
);

// --- Finding #47: platform-client accepts any authenticated Supabase subject
//
// PR #8 security review. `types.ts`'s own PlatformSession doc comment always
// said the session subject "Must equal the owner UUID; any other subject is
// a bug (ADR-03, fail closed)" -- these tests prove that is now enforced,
// not just documented, on every session-resolution path: signInWithPassword,
// getSession (including a session already established earlier in the same
// process -- the closest this in-memory-only test environment can get to a
// real restored-from-storage session, see the comment on the "re-checks on
// every call" test below for why), and onAuthStateChange. Session races the
// finding calls out by name get their own tests further down.

test(
  "signInWithPassword: a real, successfully-authenticated NON-owner subject is rejected and best-effort " +
    "signed out, never resolved as a session (Finding #47, fail closed)",
  async (t) => {
    const spy = t.mock.fn(makeFetchStub({ signInUserId: FIXTURE_NON_OWNER_UUID }));

    await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);
      await assert.rejects(
        () => client.auth.signInWithPassword(FIXTURE_NON_OWNER_EMAIL, FIXTURE_PASSWORD),
        /not the platform owner/
      );
    });

    const urls = spy.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(urls.some(isOwnerRpcUrl), "expected the owner-check RPC to have been called");
    assert.ok(urls.some(isSignOutUrl), "expected the rejected non-owner session to be signed out");
  }
);

test("signInWithPassword: the real owner still resolves normally (positive control, unchanged contract)", async (t) => {
  const spy = t.mock.fn(makeFetchStub({ signInUserId: FIXTURE_OWNER_UUID }));

  const session = await withPatchedFetch(spy, async () => {
    const client = createPlatformClient(FIXTURE_CONFIG);
    return client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
  });

  assert.equal(session.userId, FIXTURE_OWNER_UUID);
  const urls = spy.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(!urls.some(isSignOutUrl), "the real owner's session must never be signed out");
});

test(
  "getSession(): re-checks ownership on EVERY call, not just once at sign-in time -- a session valid at " +
    "sign-in that the RPC no longer confirms on a LATER, independent getSession() call is rejected and " +
    "signed out (Finding #47, the closest this in-memory-only test environment can get to a real restored " +
    "session: this package has no real localStorage in node:test, so 'a session already established, seen " +
    "again by a later, separate getSession() call' is how a restored session's shape is exercised here -- " +
    "the fixture backend's answer for the SAME still-live token changing between the two calls stands in for " +
    "the one real thing that can change server-side between two getSession() calls for an unexpired token: " +
    "platform.config's owner_uuid singleton itself being reassigned)",
  async (t) => {
    let rpcCallCount = 0;
    const signOutUrls: string[] = [];
    const spy = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isSignInUrl(url)) {
        return jsonResponse(fixtureSignInBody(nowSeconds() + 3600, FIXTURE_OWNER_UUID));
      }
      if (isOwnerRpcUrl(url)) {
        rpcCallCount += 1;
        // Answer honestly (true) the first time (at sign-in); every
        // subsequent call answers false. If getSession() cached the
        // sign-in-time verdict instead of asking again, this test could
        // never observe a rejection.
        return jsonResponse(rpcCallCount === 1);
      }
      if (isSignOutUrl(url)) {
        signOutUrls.push(url);
        return jsonResponse({});
      }
      return jsonResponse({ ok: true });
    });

    const secondCallResult = await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);
      const first = await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      assert.equal(first.userId, FIXTURE_OWNER_UUID, "sanity: sign-in itself must have succeeded");
      return client.auth.getSession();
    });

    assert.equal(
      secondCallResult,
      null,
      "a later, independent getSession() call must re-check ownership, not trust the sign-in-time verdict forever"
    );
    assert.ok(rpcCallCount >= 2, "expected at least two independent owner-check calls (sign-in, then getSession)");
    assert.ok(signOutUrls.length > 0, "expected the now-rejected session to be signed out");
  }
);

test(
  "getSession(): an owner session already established resolves normally on a later, independent call " +
    "(positive control -- proves the new check doesn't break the owner's own path)",
  async (t) => {
    const spy = t.mock.fn(makeFetchStub({ signInUserId: FIXTURE_OWNER_UUID }));

    const session = await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);
      await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      return client.auth.getSession();
    });

    assert.equal(session?.userId, FIXTURE_OWNER_UUID);
    assert.equal(session?.accessToken, OWNER_ACCESS_TOKEN);
  }
);

test(
  "onAuthStateChange: a delivered non-owner session is converted to null before it ever reaches a " +
    "registered handler (Finding #47), independent of signInWithPassword's own rejection of the same event",
  async (t) => {
    const seen: unknown[] = [];
    const spy = t.mock.fn(makeFetchStub({ signInUserId: FIXTURE_NON_OWNER_UUID }));

    await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);
      client.auth.onAuthStateChange((session) => {
        seen.push(session);
      });

      // signInWithPassword's OWN gate rejects this (proven by the dedicated
      // test above) -- this test only cares that the SAME underlying
      // SIGNED_IN event, observed independently by onAuthStateChange, is
      // ALSO converted to null before ever reaching a registered handler.
      await assert.rejects(() => client.auth.signInWithPassword(FIXTURE_NON_OWNER_EMAIL, FIXTURE_PASSWORD));

      // onAuthStateChange's own owner-check is deliberately not awaited by
      // the internal callback itself (see src/index.ts's own comment on
      // exactly this) -- only the eventual `handler` call is. Give that
      // detached promise chain a tick to land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.ok(seen.length > 0, "expected onAuthStateChange to have delivered at least one event");
    for (const session of seen) {
      assert.equal(session, null, "a non-owner session must never reach a registered onAuthStateChange handler");
    }
  }
);

test(
  "onAuthStateChange: a delivered owner session reaches the handler normally (positive control)",
  async (t) => {
    const seen: unknown[] = [];
    const spy = t.mock.fn(makeFetchStub({ signInUserId: FIXTURE_OWNER_UUID }));

    await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);
      client.auth.onAuthStateChange((session) => {
        seen.push(session);
      });

      await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const delivered = seen.filter((session) => session !== null) as Array<{ userId: string }>;
    assert.ok(delivered.length > 0, "expected at least one non-null delivery for a real owner sign-in");
    for (const session of delivered) {
      assert.equal(session.userId, FIXTURE_OWNER_UUID);
    }
  }
);

// --- Finding #47: session races ---------------------------------------------
//
// The finding's own text: "test all session races and restore flows". Two
// distinct races, each with its own test: (1) an in-flight getSession() call
// racing a LIVE onAuthStateChange delivery for the same non-owner session
// (both paths must independently fail closed, with no cross-path leakage or
// unhandled rejection); (2) the TOCTOU race that motivated pinning the
// owner-check's bearer token to the exact session snapshot rather than
// letting `supabase.rpc()` re-resolve "whatever is live" (see
// src/index.ts's `isOwnerSession` doc comment) -- proven by holding one
// session's owner-check in flight while a DIFFERENT session becomes live on
// the same client, then showing the held check still resolves for the
// session it was actually given.

test(
  "session race: an in-flight getSession() call racing a live onAuthStateChange delivery for the same " +
    "non-owner session both resolve fail-closed, with no cross-path leakage or unhandled rejection " +
    "(Finding #47's own named race: 'an initial getSession() racing a later onAuthStateChange event')",
  async (t) => {
    const seenFromAuthStateChange: unknown[] = [];
    const spy = t.mock.fn(makeFetchStub({ signInUserId: FIXTURE_NON_OWNER_UUID }));

    await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);
      client.auth.onAuthStateChange((session) => {
        seenFromAuthStateChange.push(session);
      });

      // Fire signInWithPassword (which the underlying auth-js client will
      // ALSO broadcast to the onAuthStateChange listener registered above,
      // independent of this wrapper's own promise) and getSession()
      // concurrently -- getSession() here races the live onAuthStateChange
      // delivery this same sign-in triggers.
      const [signInResult, sessionResult] = await Promise.allSettled([
        client.auth.signInWithPassword(FIXTURE_NON_OWNER_EMAIL, FIXTURE_PASSWORD),
        client.auth.getSession(),
      ]);

      assert.equal(signInResult.status, "rejected");
      // getSession() must never resolve the non-owner session, regardless
      // of exactly how it interleaved with the concurrent sign-in and the
      // onAuthStateChange delivery it triggers.
      assert.equal(sessionResult.status, "fulfilled");
      if (sessionResult.status === "fulfilled") {
        assert.equal(sessionResult.value, null);
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    for (const session of seenFromAuthStateChange) {
      assert.equal(session, null, "onAuthStateChange must never deliver the non-owner session to its handler");
    }
  }
);

test(
  "session race: getSession()'s owner-check is pinned to the EXACT session it snapshotted, even when a " +
    "DIFFERENT session becomes live on the same client while that check is still in flight " +
    "(Finding #47's own named TOCTOU race -- this is what motivates src/index.ts's isOwnerSession using a " +
    "raw fetch with session.accessToken attached explicitly, never supabase.rpc()'s own live-resolved token)",
  async (t) => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const rpcAuthHeaders: Array<string | null> = [];
    let signInCalls = 0;
    let ownerTokenRpcCalls = 0;

    const spy = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isSignInUrl(url)) {
        signInCalls += 1;
        // First sign-in in this test is the owner (session A, whose
        // getSession() owner-check gets held below); a SECOND sign-in --
        // fired later, while A's check is still in flight -- is a
        // different, non-owner identity (session B) becoming live on the
        // SAME client.
        return jsonResponse(
          signInCalls === 1
            ? fixtureSignInBody(nowSeconds() + 3600, FIXTURE_OWNER_UUID)
            : fixtureSignInBody(nowSeconds() + 3600, FIXTURE_NON_OWNER_UUID)
        );
      }
      if (isOwnerRpcUrl(url)) {
        const headers = new Headers(init?.headers);
        const authHeader = headers.get("authorization");
        rpcAuthHeaders.push(authHeader);
        if (authHeader === `Bearer ${accessTokenFor(FIXTURE_OWNER_UUID)}`) {
          ownerTokenRpcCalls += 1;
          // The FIRST owner-token RPC call is signInWithPassword's own
          // owner-check for session A itself -- that one must complete
          // normally so sign-in can succeed at all. Only the SECOND
          // (getSession()'s own, independent check) is held in flight.
          if (ownerTokenRpcCalls === 2) {
            await gate;
          }
        }
        return isOwnerRpcResponse(init);
      }
      if (isSignOutUrl(url)) {
        return jsonResponse({});
      }
      return jsonResponse({ ok: true });
    });

    await withPatchedFetch(spy, async () => {
      const client = createPlatformClient(FIXTURE_CONFIG);

      const sessionA = await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
      assert.equal(sessionA.userId, FIXTURE_OWNER_UUID);

      // Start getSession() for session A -- unexpired, so this resolves
      // its OWN supabase.auth.getSession() with zero network calls and
      // snapshots session A's data before ever reaching the (now gated)
      // owner-check RPC.
      const pendingGetSession = client.auth.getSession();

      // While A's owner-check is still held, a SECOND, different (non-owner)
      // session becomes live on the same client. If the owner-check re-
      // resolved "whichever session is live now" (supabase.rpc()'s own
      // behavior) instead of the session it was given, it would end up
      // checking THIS session instead of A's.
      await assert.rejects(() => client.auth.signInWithPassword(FIXTURE_NON_OWNER_EMAIL, FIXTURE_PASSWORD));

      releaseGate();
      const resolvedSession = await pendingGetSession;

      assert.deepEqual(
        resolvedSession,
        sessionA,
        "getSession() must resolve the EXACT session it snapshotted (A), unaffected by a different " +
          "session becoming live on the same client while its owner-check was still in flight"
      );
    });

    assert.ok(
      rpcAuthHeaders.includes(`Bearer ${accessTokenFor(FIXTURE_OWNER_UUID)}`),
      "expected the held owner-check to have been sent with session A's own token"
    );
  }
);

// --- authedFetch origin allowlist (P1 fix, src/index.ts authedFetch) -------
//
// Every test below signs in for real first (through the same mocked
// `/auth/v1/token` path the tests above use) so `authedFetch` has a live
// session to attach -- these tests are about WHICH requests get that
// session's token attached, not about the no-session fail-closed path
// already covered above.

/**
 * A `globalThis.fetch` stand-in for the authedFetch-origin-allowlist tests
 * below: routes Supabase's own `/auth/v1/token?grant_type=password` sign-in
 * call to a fixture session response (so `client.auth.signInWithPassword`
 * keeps working exactly as in the tests above), transparently answers
 * `core.is_platform_owner()` (Finding #47 -- every sign-in below is the real
 * owner, and `authedFetch` itself calls `auth.getSession()` internally,
 * which re-runs this same owner-check on every single call; none of that
 * belongs in `captured`, which is specifically about the ONE target resource
 * request each test cares about), and records every OTHER call's URL and
 * headers into `captured` -- this is the seam the "never attaches/sends the
 * Authorization header" assertions read, since asserting only that a promise
 * rejected would miss a bug that rejects AFTER already calling `fetch` with
 * the token attached.
 */
function makeAuthAndCaptureSpy(
  expiresAt: number,
  captured: Array<{ url: string; headers: Headers }>
): FetchImpl {
  return async (input, init) => {
    const url = String(input);
    if (isSignInUrl(url)) {
      return jsonResponse(fixtureSignInBody(expiresAt));
    }
    if (isOwnerRpcUrl(url)) {
      return isOwnerRpcResponse(init);
    }
    captured.push({ url, headers: new Headers(init?.headers) });
    return jsonResponse({ ok: true });
  };
}

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

test("authedFetch: a Request input keeps its method, body, and headers and disables automatic redirects", async (t) => {
  let received: Request | undefined;
  const spy = t.mock.fn(
    makeFetchStub({
      onOther: async (input, init) => {
        received = new Request(input, init);
        return jsonResponse({ ok: true });
      },
    })
  );

  await withPatchedFetch(spy, async () => {
    const client = createPlatformClient(FIXTURE_CONFIG);
    await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
    await client.fetch(
      new Request(`${FIXTURE_CONFIG.supabaseUrl}/rest/v1/app`, {
        method: "POST",
        headers: { "X-From-Request": "preserved" },
        body: "request-body",
      })
    );
  });

  assert.ok(received);
  assert.equal(received.url, `${FIXTURE_CONFIG.supabaseUrl}/rest/v1/app`);
  assert.equal(received.method, "POST");
  assert.equal(await received.text(), "request-body");
  assert.equal(received.headers.get("x-from-request"), "preserved");
  assert.equal(received.headers.get("authorization"), "Bearer fixture.access.token");
  assert.equal(received.redirect, "manual");
});

test("authedFetch: RequestInit overrides Request fields without dropping unaffected Request headers", async (t) => {
  let received: Request | undefined;
  const spy = t.mock.fn(
    makeFetchStub({
      onOther: async (input, init) => {
        received = new Request(input, init);
        return jsonResponse({ ok: true });
      },
    })
  );

  await withPatchedFetch(spy, async () => {
    const client = createPlatformClient(FIXTURE_CONFIG);
    await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
    const request = new Request(`${FIXTURE_CONFIG.supabaseUrl}/rest/v1/app`, {
      method: "POST",
      headers: {
        "X-From-Request": "preserved",
        "X-Overridden": "request",
        Authorization: "Bearer stale-request-token",
      },
      body: "request-body",
    });

    await client.fetch(request, {
      method: "PUT",
      headers: {
        "X-From-Init": "applied",
        "X-Overridden": "init",
        Authorization: "Bearer stale-init-token",
      },
      body: "init-body",
      redirect: "follow",
    });
  });

  assert.ok(received);
  assert.equal(received.method, "PUT");
  assert.equal(await received.text(), "init-body");
  assert.equal(received.headers.get("x-from-request"), "preserved");
  assert.equal(received.headers.get("x-from-init"), "applied");
  assert.equal(received.headers.get("x-overridden"), "init");
  assert.equal(received.headers.get("authorization"), "Bearer fixture.access.token");
  assert.equal(received.redirect, "manual");
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

test("authedFetch: rejects an untrusted target before re-checking session ownership", async (t) => {
  let ownerRpcCalls = 0;
  let resourceCalls = 0;
  const spy = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (isSignInUrl(url)) {
      return jsonResponse(fixtureSignInBody(nowSeconds() + 3600));
    }
    if (isOwnerRpcUrl(url)) {
      ownerRpcCalls += 1;
      return isOwnerRpcResponse(init);
    }
    resourceCalls += 1;
    return jsonResponse({ ok: true });
  });

  await withPatchedFetch(spy, async () => {
    const client = createPlatformClient(FIXTURE_CONFIG);
    await client.auth.signInWithPassword(FIXTURE_EMAIL, FIXTURE_PASSWORD);
    const rpcCallsAfterSignIn = ownerRpcCalls;

    await assert.rejects(
      () => client.fetch("https://evil.invalid/steal"),
      /refusing to attach the platform session token/
    );

    assert.equal(ownerRpcCalls, rpcCallsAfterSignIn);
  });

  assert.equal(resourceCalls, 0);
});

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
