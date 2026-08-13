// useShellSession is the one hook every route's session state flows through
// (SH-3). These tests mock @hyperbolic/platform-client's public surface only
// (createPlatformClient) -- never platform-client internals -- and prove
// the status-transition contract this hook adds on top of it, including the
// SH-6 "background demotion" case platform-client's own tests don't cover
// (that package tests getSession()'s fail-closed return value in isolation;
// this tests that the Shell's hook actually propagates it into UI state).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PlatformSession } from "@hyperbolic/platform-client";

const FIXTURE_SESSION: PlatformSession = {
  accessToken: "fixture-token",
  expiresAt: 9_999_999_999,
  userId: "00000000-0000-4000-8000-000000000001",
};

// vi.mock(...) is hoisted above every import in this file, including
// @hyperbolic/platform-client's own -- which session.ts's module-level
// `createPlatformClient(...)` call resolves against as soon as it's
// imported below. That means the factory can't close over a plain
// module-scope `const auth = {...}` declared later in file order (it would
// still be in its temporal dead zone when the factory first runs); vi.hoisted
// lifts `auth`'s own initialization above the mock too, so the factory
// always sees it already constructed.
const { auth } = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  },
}));

let authChangeHandler: ((session: PlatformSession | null) => void) | null = null;

vi.mock("@hyperbolic/platform-client", () => ({
  createPlatformClient: () => ({ auth, fetch: vi.fn() }),
  // m3-04: session.ts's module-level `createRegistryClient(...)` call
  // (registryClient) resolves against this mock the same way
  // createPlatformClient does above -- a trivial stub is enough here since
  // this file only tests useShellSession, not registry behavior (that's
  // packages/platform-client/tests/registry.test.ts and
  // src/lib/registry.test.ts's job).
  createRegistryClient: () => ({ listTools: vi.fn(), getTool: vi.fn() }),
}));

import { useShellSession } from "./session";

function resetAuthMocks() {
  auth.getSession.mockReset();
  auth.signInWithPassword.mockReset();
  auth.signOut.mockReset();
  auth.onAuthStateChange.mockReset();
  authChangeHandler = null;
  auth.onAuthStateChange.mockImplementation((handler: (session: PlatformSession | null) => void) => {
    authChangeHandler = handler;
    return () => {
      authChangeHandler = null;
    };
  });
}

afterEach(() => {
  resetAuthMocks();
});

describe("useShellSession: initial resolution", () => {
  it('starts "checking" and settles to "signed-out" when getSession resolves null', async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(null);

    const { result } = renderHook(() => useShellSession());
    expect(result.current.status).toBe("checking");

    await waitFor(() => expect(result.current.status).toBe("signed-out"));
    expect(result.current.session).toBeNull();
  });

  it('settles to "signed-in" when getSession resolves a real session', async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(FIXTURE_SESSION);

    const { result } = renderHook(() => useShellSession());
    await waitFor(() => expect(result.current.status).toBe("signed-in"));
    expect(result.current.session).toEqual(FIXTURE_SESSION);
  });
});

describe("useShellSession: signIn", () => {
  it("calls signInWithPassword with the given credentials and reflects signed-in immediately", async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(null);
    auth.signInWithPassword.mockResolvedValue(FIXTURE_SESSION);

    const { result } = renderHook(() => useShellSession());
    await waitFor(() => expect(result.current.status).toBe("signed-out"));

    await act(async () => {
      await result.current.signIn("operator@example.com", "hunter2");
    });

    expect(auth.signInWithPassword).toHaveBeenCalledWith("operator@example.com", "hunter2");
    expect(result.current.status).toBe("signed-in");
    expect(result.current.session).toEqual(FIXTURE_SESSION);
  });

  it("propagates a sign-in rejection to the caller and leaves status signed-out (never fakes success)", async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(null);
    auth.signInWithPassword.mockRejectedValue(new Error("Invalid login credentials"));

    const { result } = renderHook(() => useShellSession());
    await waitFor(() => expect(result.current.status).toBe("signed-out"));

    await expect(
      act(async () => {
        await result.current.signIn("operator@example.com", "wrong");
      })
    ).rejects.toThrow("Invalid login credentials");

    expect(result.current.status).toBe("signed-out");
    expect(result.current.session).toBeNull();
  });
});

describe("useShellSession: signOut", () => {
  it("flips to signed-out immediately even when the underlying signOut() call rejects", async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(FIXTURE_SESSION);
    auth.signOut.mockRejectedValue(new Error("network unreachable"));

    const { result } = renderHook(() => useShellSession());
    await waitFor(() => expect(result.current.status).toBe("signed-in"));

    act(() => {
      result.current.signOut();
    });

    expect(result.current.status).toBe("signed-out");
    expect(result.current.session).toBeNull();
  });
});

describe("useShellSession: initial getSession() vs. onAuthStateChange ordering (Finding #78, PR #8 security review)", () => {
  it("an onAuthStateChange event that fires BEFORE the initial getSession() resolves wins -- the stale getSession() result is dropped, not applied on top", async () => {
    resetAuthMocks();

    // getSession() is deliberately NEVER resolved by this test until after
    // the assertions below -- it stands in for "still in flight" for the
    // whole test. If session.ts's version-guard fix were absent, resolving
    // it manually LAST (see below) would overwrite whatever
    // onAuthStateChange already applied, which is exactly the bug this
    // guards against.
    let resolveGetSession!: (session: PlatformSession | null) => void;
    auth.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveGetSession = resolve;
      })
    );

    const { result } = renderHook(() => useShellSession());

    // Still "checking": the initial getSession() call hasn't resolved yet,
    // and onAuthStateChange hasn't fired yet either.
    expect(result.current.status).toBe("checking");

    // onAuthStateChange fires with a NEWER result WHILE getSession() is
    // still in flight -- e.g. a background token refresh landing first.
    expect(authChangeHandler).not.toBeNull();
    act(() => {
      authChangeHandler?.(FIXTURE_SESSION);
    });

    expect(result.current.status).toBe("signed-in");
    expect(result.current.session).toEqual(FIXTURE_SESSION);

    // NOW the slower, semantically-STALE initial getSession() call
    // resolves -- with a DIFFERENT (null) result, so a failure to guard
    // this would be immediately visible as a demotion back to signed-out.
    await act(async () => {
      resolveGetSession(null);
      // Let the resolved promise's .then() actually run.
      await Promise.resolve();
      await Promise.resolve();
    });

    // The newer onAuthStateChange result must still stand: the stale
    // getSession() resolution must be dropped, not applied on top of it.
    expect(result.current.status).toBe("signed-in");
    expect(result.current.session).toEqual(FIXTURE_SESSION);
  });

  it("without a race, the initial getSession() result still applies normally (guard doesn't suppress the ordinary case)", async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(FIXTURE_SESSION);

    const { result } = renderHook(() => useShellSession());
    await waitFor(() => expect(result.current.status).toBe("signed-in"));
    expect(result.current.session).toEqual(FIXTURE_SESSION);
  });
});

describe("useShellSession: background demotion (SH-6 regression net)", () => {
  it("an onAuthStateChange(null) event -- e.g. a background refresh failing while the IdP is unreachable -- flips an already signed-in session to signed-out with no explicit signOut() call", async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(FIXTURE_SESSION);

    const { result } = renderHook(() => useShellSession());
    await waitFor(() => expect(result.current.status).toBe("signed-in"));

    expect(authChangeHandler).not.toBeNull();
    act(() => {
      authChangeHandler?.(null);
    });

    expect(result.current.status).toBe("signed-out");
    expect(result.current.session).toBeNull();
    // Never touched signOut() itself -- this is a demotion the underlying
    // client observed on its own, not an operator-initiated sign-out.
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
