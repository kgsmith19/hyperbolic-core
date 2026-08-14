// Finding #80 (PR #8 security review): e2e/idp-down.spec.ts's two Playwright
// specs each wait out @supabase/auth-js's REAL exponential backoff (~30s,
// deliberately un-faked -- see that file's own header comment), and ran in
// the PR-BLOCKING pr-gate job on every Shell/packages PR. That real-timing
// proof is now relocated to .github/workflows/shell-idp-down.yml (manual
// workflow_dispatch, mirroring toolbelt-network-checker-release.yml's own
// manual-trigger pattern) -- see that spec file's own updated header
// comment for the full reasoning.
//
// This file is the fast, deterministic half that stays on every PR: the
// IdP-down UI CONTRACT (what the operator sees when auth resolves
// fail-closed) with NO real or fake-timer wait at all. It doesn't need one:
// packages/platform-client's own test suite (tests/platform-client.test.ts,
// using node:test's fake timers) already proves getSession() itself
// eventually resolves null after the real backoff, without a real wait --
// that is the TIMING half of the contract, and it is that package's
// concern, not the Shell's. What the Shell's own useShellSession hook adds
// on top is simple and needs no timer faking to test: whatever
// getSession()/onAuthStateChange eventually resolve to, apply it verbatim
// (session.ts has no retry/backoff of its own). So mocking those calls to
// resolve immediately with the SAME fail-closed value (null) they'd
// eventually settle on after a real 30s backoff exercises the exact same
// downstream UI contract auth-gate.test.ts, session.test.ts, and
// protected-layout.test.tsx already prove piecemeal -- this file is what
// ties them together end to end through the real <App/> component tree,
// as a fast, deterministic regression net for the exact UI behavior
// idp-down.spec.ts proves the slow way.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const { auth } = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(() => () => {}),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock("@hyperbolic/platform-client", () => ({
  createPlatformClient: () => ({ auth, fetch: vi.fn() }),
  createRegistryClient: () => ({ listTools: vi.fn().mockResolvedValue([]), getTool: vi.fn() }),
  createBrainClient: () => ({
    createRun: vi.fn(),
    getRun: vi.fn(),
    approveTask: vi.fn(),
    rejectTask: vi.fn(),
    streamRunEvents: vi.fn(),
    health: vi.fn(),
    getCostSummary: vi.fn(),
  }),
  createCostClient: () => ({ listLlmCalls: vi.fn() }),
}));

import App from "./app";

describe("IdP-down UI contract (Finding #80's fast half): fail-closed getSession() redirects to login, no chrome, no data nodes", () => {
  it("a cached session whose refresh has already failed (getSession() resolves null, mirroring the real backoff's eventual fail-closed result) renders the login form, not gated content", async () => {
    auth.getSession.mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={["/tools"]}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("login-form")).toBeInTheDocument());
    expect(document.querySelectorAll("[data-app-data]")).toHaveLength(0);
    expect(screen.queryByTestId("platform-nav")).toBeNull();
  });

  it("the same fail-closed contract holds regardless of which gated route was requested", async () => {
    auth.getSession.mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={["/prompts"]}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId("login-form")).toBeInTheDocument());
    expect(document.querySelectorAll("[data-app-data]")).toHaveLength(0);
    expect(screen.queryByTestId("platform-nav")).toBeNull();
  });
});
