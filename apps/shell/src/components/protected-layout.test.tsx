// SH-2a / SH-2b at the component level: complements
// src/lib/auth-gate.test.ts (the pure decision function) by proving the
// actual rendered DOM matches that decision once wired to react-router and
// Chrome -- zero [data-app-data] nodes and zero chrome while gated, a real
// <Navigate> to /login while signed out, gated content once signed in.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import ProtectedLayout from "./protected-layout";
import type { PlatformSession } from "@hyperbolic/platform-client";
import type { AuthState, SessionStatus } from "../lib/session";

const FIXTURE_SESSION: PlatformSession = {
  accessToken: "fixture-token",
  expiresAt: 9_999_999_999,
  userId: "00000000-0000-4000-8000-000000000001",
};

// Finding #77 (PR #8 security review): builds a well-typed `AuthState` from
// the same (status, session) pair every existing call site here already
// passed -- for "signed-in" this asserts session is non-null (a test-fixture
// convenience only; the real hook can never construct the other
// combination, which is the whole point of the union).
function authStateFor(status: SessionStatus, session: PlatformSession | null): AuthState {
  if (status === "signed-in") {
    if (!session) throw new Error("test fixture: signed-in requires a non-null session");
    return { status: "signed-in", session };
  }
  return { status, session: null };
}

function renderAt(path: string, status: SessionStatus, session: PlatformSession | null = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div data-testid="login-stub">login</div>} />
        <Route element={<ProtectedLayout auth={authStateFor(status, session)} onSignOut={vi.fn()} />}>
          {/* No data-app-data on these dummy page elements themselves --
              ProtectedLayout's own wrapper (see protected-layout.tsx) is
              the one node under test here; a real page adds none of its
              own. */}
          <Route path="/" element={<div>home data</div>} />
          <Route path="/tools" element={<div>tools data</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("ProtectedLayout: checking", () => {
  it("renders zero [data-app-data] nodes and no chrome while the session status is unresolved", () => {
    renderAt("/tools", "checking");
    expect(document.querySelectorAll("[data-app-data]")).toHaveLength(0);
    expect(screen.queryByTestId("platform-nav")).toBeNull();
    expect(screen.queryByTestId("login-stub")).toBeNull();
    expect(screen.getByTestId("auth-checking")).toBeInTheDocument();
  });
});

describe("ProtectedLayout: signed-out (SH-2a)", () => {
  it("redirects a gated deep link to /login and renders zero [data-app-data] nodes", () => {
    renderAt("/tools", "signed-out");
    expect(screen.getByTestId("login-stub")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-app-data]")).toHaveLength(0);
    expect(screen.queryByTestId("platform-nav")).toBeNull();
  });

  it("still gates the root path", () => {
    renderAt("/", "signed-out");
    expect(screen.getByTestId("login-stub")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-app-data]")).toHaveLength(0);
  });
});

describe("ProtectedLayout: signed-in", () => {
  it("renders chrome and the routed page's data-app-data content", () => {
    renderAt("/tools", "signed-in", FIXTURE_SESSION);
    expect(screen.getByTestId("platform-nav")).toBeInTheDocument();
    expect(screen.getByText("tools data")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-app-data]")).toHaveLength(1);
    expect(screen.queryByTestId("login-stub")).toBeNull();
  });

  it("passes the real session through to Chrome (session menu shows the user id)", () => {
    renderAt("/", "signed-in", FIXTURE_SESSION);
    expect(screen.getByText(FIXTURE_SESSION.userId)).toBeInTheDocument();
  });
});
