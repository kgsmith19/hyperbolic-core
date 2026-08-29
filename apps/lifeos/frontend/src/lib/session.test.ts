// Regression coverage for the one-session Shell -> LifeOS document handoff.
// LifeOS owns a separate platform-client instance, so its initial getSession()
// restore can race the auth-state event emitted while the new document boots.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PlatformSession } from "@hyperbolic/platform-client";

const FIXTURE_SESSION: PlatformSession = {
  accessToken: "fixture-token",
  expiresAt: 9_999_999_999,
  userId: "00000000-0000-4000-8000-000000000372",
};

const { auth } = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
  },
}));

let authChangeHandler: ((session: PlatformSession | null) => void) | null = null;

vi.mock("@hyperbolic/platform-client", () => ({
  createPlatformClient: () => ({ auth, fetch: vi.fn() }),
}));

import { useLifeOsSession } from "./session";

function resetAuthMocks() {
  auth.getSession.mockReset();
  auth.signOut.mockReset();
  auth.onAuthStateChange.mockReset();
  authChangeHandler = null;
  auth.onAuthStateChange.mockImplementation(
    (handler: (session: PlatformSession | null) => void) => {
      authChangeHandler = handler;
      return () => {
        authChangeHandler = null;
      };
    },
  );
}

afterEach(() => {
  resetAuthMocks();
});

describe("useLifeOsSession: initial resolution", () => {
  it('starts "checking" and settles signed-out when getSession resolves null', async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(null);

    const { result } = renderHook(() => useLifeOsSession());
    expect(result.current.status).toBe("checking");

    await waitFor(() => expect(result.current.status).toBe("signed-out"));
    expect(result.current.session).toBeNull();
  });

  it("settles signed-in when getSession resolves a session", async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(FIXTURE_SESSION);

    const { result } = renderHook(() => useLifeOsSession());
    await waitFor(() => expect(result.current.status).toBe("signed-in"));
    expect(result.current.session).toEqual(FIXTURE_SESSION);
  });
});

describe("useLifeOsSession: initial restore ordering", () => {
  it("keeps the newer auth event when a stale initial getSession result resolves later", async () => {
    resetAuthMocks();
    let resolveGetSession!: (session: PlatformSession | null) => void;
    auth.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveGetSession = resolve;
      }),
    );

    const { result } = renderHook(() => useLifeOsSession());
    expect(result.current.status).toBe("checking");
    expect(authChangeHandler).not.toBeNull();

    act(() => {
      authChangeHandler?.(FIXTURE_SESSION);
    });
    expect(result.current.status).toBe("signed-in");
    expect(result.current.session).toEqual(FIXTURE_SESSION);

    await act(async () => {
      resolveGetSession(null);
      await Promise.resolve();
      await Promise.resolve();
    });

    // This is the production regression: a stale null must not transiently
    // demote LifeOS to signed-out, because App.tsx immediately navigates that
    // state back to the Shell login document.
    expect(result.current.status).toBe("signed-in");
    expect(result.current.session).toEqual(FIXTURE_SESSION);
  });

  it("keeps an explicit sign-out when the initial restore resolves afterward", async () => {
    resetAuthMocks();
    let resolveGetSession!: (session: PlatformSession | null) => void;
    auth.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveGetSession = resolve;
      }),
    );
    auth.signOut.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLifeOsSession());
    act(() => {
      result.current.signOut();
    });
    expect(result.current.status).toBe("signed-out");

    await act(async () => {
      resolveGetSession(FIXTURE_SESSION);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe("signed-out");
    expect(result.current.session).toBeNull();
  });
});

describe("useLifeOsSession: background demotion", () => {
  it("still fails closed when a later auth-state event reports null", async () => {
    resetAuthMocks();
    auth.getSession.mockResolvedValue(FIXTURE_SESSION);

    const { result } = renderHook(() => useLifeOsSession());
    await waitFor(() => expect(result.current.status).toBe("signed-in"));

    act(() => {
      authChangeHandler?.(null);
    });

    expect(result.current.status).toBe("signed-out");
    expect(result.current.session).toBeNull();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
