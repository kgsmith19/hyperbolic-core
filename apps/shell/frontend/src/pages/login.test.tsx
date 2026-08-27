import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigationType } from "react-router";
import LoginPage from "./login";
import type { SessionStatus } from "../lib/session";

function NavigationTypeProbe() {
  return <div data-testid="navigation-type">{useNavigationType()}</div>;
}

function renderLogin(
  initialPath: string,
  status: SessionStatus,
  onSignIn = vi.fn(),
  replaceDocument?: (href: string) => void
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/login"
          element={
            <LoginPage
              status={status}
              onSignIn={onSignIn}
              replaceDocument={replaceDocument}
            />
          }
        />
        <Route
          path="/tools"
          element={
            <>
              <div data-testid="tools-page">tools</div>
              <NavigationTypeProbe />
            </>
          }
        />
        <Route path="/life/*" element={<div data-testid="life-client-route">life client route</div>} />
        <Route
          path="/"
          element={
            <>
              <div data-testid="home-page">home</div>
              <NavigationTypeProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

function LoginWhoseSignInUpdatesStatus({
  onSignIn,
  replaceDocument,
}: {
  onSignIn: (email: string, password: string) => void;
  replaceDocument: (href: string) => void;
}) {
  const [status, setStatus] = useState<SessionStatus>("signed-out");

  return (
    <LoginPage
      status={status}
      onSignIn={async (email, password) => {
        onSignIn(email, password);
        // Mirrors useShellSession.signIn(): publish signed-in state before
        // the promise observed by LoginPage resolves.
        setStatus("signed-in");
      }}
      replaceDocument={replaceDocument}
    />
  );
}

describe("LoginPage: rendering by status", () => {
  it("renders the login form with email/password inputs and a submit button when signed out", () => {
    renderLogin("/login", "signed-out");
    expect(screen.getByTestId("login-form")).toBeInTheDocument();
    expect(screen.getByTestId("login-email")).toBeInTheDocument();
    expect(screen.getByTestId("login-password")).toBeInTheDocument();
    expect(screen.getByTestId("login-submit")).toBeInTheDocument();
  });

  it("renders no form while status is checking (avoids a flash of the wrong surface)", () => {
    renderLogin("/login", "checking");
    expect(screen.queryByTestId("login-form")).toBeNull();
    expect(screen.getByTestId("auth-checking")).toBeInTheDocument();
  });

  it("redirects to / when already signed in and no return target is given", () => {
    renderLogin("/login", "signed-in");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
    expect(screen.queryByTestId("login-form")).toBeNull();
  });

  it("redirects to the sanitized ?return= target when already signed in", () => {
    renderLogin("/login?return=%2Ftools", "signed-in");
    expect(screen.getByTestId("tools-page")).toBeInTheDocument();
    expect(screen.getByTestId("navigation-type")).toHaveTextContent("REPLACE");
  });

  it("replaces the document for an already-signed-in LifeOS return and preserves path, query, and fragment", async () => {
    const replaced: string[] = [];
    const returnTo = "/life/today?view=compact#entry-4";

    renderLogin(
      `/login?return=${encodeURIComponent(returnTo)}`,
      "signed-in",
      vi.fn(),
      (href) => replaced.push(href)
    );

    await waitFor(() => expect(replaced).toEqual([returnTo]));
    expect(screen.queryByTestId("life-client-route")).toBeNull();
  });

  it("preserves an encoded LifeOS return unchanged while selecting document navigation", async () => {
    const replaced: string[] = [];
    const returnTo = "/%6cife/capture?mode=quick#entry";

    renderLogin(
      `/login?return=${encodeURIComponent(returnTo)}`,
      "signed-in",
      vi.fn(),
      (href) => replaced.push(href)
    );

    await waitFor(() => expect(replaced).toEqual([returnTo]));
    expect(screen.queryByTestId("life-client-route")).toBeNull();
  });

  it("falls back to / when already signed in with an unsafe ?return= target", () => {
    renderLogin("/login?return=" + encodeURIComponent("https://evil.example.com"), "signed-in");
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
  });
});

describe("LoginPage: submitting", () => {
  it("calls onSignIn with the typed credentials and navigates to the return target on success", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn().mockResolvedValue(undefined);
    renderLogin("/login?return=%2Ftools", "signed-out", onSignIn);

    await user.type(screen.getByTestId("login-email"), "operator@example.com");
    await user.type(screen.getByTestId("login-password"), "hunter2");
    await user.click(screen.getByTestId("login-submit"));

    await waitFor(() => expect(onSignIn).toHaveBeenCalledWith("operator@example.com", "hunter2"));
    await waitFor(() => expect(screen.getByTestId("tools-page")).toBeInTheDocument());
    expect(screen.getByTestId("navigation-type")).toHaveTextContent("REPLACE");
  });

  it("replaces the document after sign-in for a LifeOS return without routing inside Shell", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn().mockResolvedValue(undefined);
    const replaced: string[] = [];
    const returnTo = "/life/?focus=health#today";
    renderLogin(
      `/login?return=${encodeURIComponent(returnTo)}`,
      "signed-out",
      onSignIn,
      (href) => replaced.push(href)
    );

    await user.type(screen.getByTestId("login-email"), "operator@example.com");
    await user.type(screen.getByTestId("login-password"), "hunter2");
    await user.click(screen.getByTestId("login-submit"));

    await waitFor(() => expect(replaced).toEqual([returnTo]));
    expect(screen.queryByTestId("life-client-route")).toBeNull();
  });

  it("replaces a LifeOS document exactly once when sign-in publishes signed-in status before resolving", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn();
    const replaced: string[] = [];
    const returnTo = "/life/today?focus=health#entry-4";

    render(
      <MemoryRouter initialEntries={[`/login?return=${encodeURIComponent(returnTo)}`]}>
        <LoginWhoseSignInUpdatesStatus
          onSignIn={onSignIn}
          replaceDocument={(href) => replaced.push(href)}
        />
      </MemoryRouter>
    );

    await user.type(screen.getByTestId("login-email"), "operator@example.com");
    await user.type(screen.getByTestId("login-password"), "hunter2");
    await user.click(screen.getByTestId("login-submit"));

    await waitFor(() => expect(screen.queryByTestId("login-form")).toBeNull());
    expect(onSignIn).toHaveBeenCalledWith("operator@example.com", "hunter2");
    expect(replaced).toEqual([returnTo]);
  });

  it("shows an error message and keeps the form when sign-in rejects, without navigating away", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn().mockRejectedValue(new Error("Invalid login credentials"));
    renderLogin("/login", "signed-out", onSignIn);

    await user.type(screen.getByTestId("login-email"), "operator@example.com");
    await user.type(screen.getByTestId("login-password"), "wrong");
    await user.click(screen.getByTestId("login-submit"));

    await waitFor(() => expect(screen.getByTestId("login-error")).toHaveTextContent("Invalid login credentials"));
    expect(screen.getByTestId("login-form")).toBeInTheDocument();
  });

  it("disables the submit button while a sign-in is in flight", async () => {
    const user = userEvent.setup();
    let resolveSignIn: () => void = () => {};
    const onSignIn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSignIn = resolve;
        })
    );
    renderLogin("/login", "signed-out", onSignIn);

    await user.type(screen.getByTestId("login-email"), "operator@example.com");
    await user.type(screen.getByTestId("login-password"), "hunter2");
    await user.click(screen.getByTestId("login-submit"));

    await waitFor(() => expect(screen.getByTestId("login-submit")).toBeDisabled());
    resolveSignIn();
  });
});
