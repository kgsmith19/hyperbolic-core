// computeGateDecision is the single auth chokepoint's decision function
// (see auth-gate.ts's own doc comment). These tests are the fast, direct
// regression net for that one branch; e2e/auth-gate.spec.ts and
// e2e/idp-down.spec.ts prove the same guarantee end to end.
import { describe, expect, it } from "vitest";
import { computeGateDecision } from "./auth-gate";
import type { SessionStatus } from "./session";

describe("computeGateDecision: checking", () => {
  it("never renders and never redirects while the session status is unresolved", () => {
    expect(computeGateDecision("checking", "/tools", "")).toEqual({ kind: "loading" });
  });

  it("checking is independent of the current path", () => {
    expect(computeGateDecision("checking", "/", "?x=1")).toEqual({ kind: "loading" });
  });
});

describe("computeGateDecision: signed-in", () => {
  it("renders gated content", () => {
    expect(computeGateDecision("signed-in", "/tools", "")).toEqual({ kind: "render" });
  });

  it("renders regardless of which path is active", () => {
    for (const path of ["/", "/acc", "/tools", "/prompts", "/ideas", "/settings"]) {
      expect(computeGateDecision("signed-in", path, "")).toEqual({ kind: "render" });
    }
  });
});

describe("computeGateDecision: signed-out (SH-2a/SH-2b)", () => {
  it("redirects to /login carrying the exact requested path as ?return=", () => {
    expect(computeGateDecision("signed-out", "/tools", "")).toEqual({
      kind: "redirect-to-login",
      to: "/login?return=%2Ftools",
    });
  });

  it("preserves the query string in the return target", () => {
    expect(computeGateDecision("signed-out", "/tools", "?tab=registry")).toEqual({
      kind: "redirect-to-login",
      to: `/login?return=${encodeURIComponent("/tools?tab=registry")}`,
    });
  });

  it("the root path still round-trips through the redirect (never left blank)", () => {
    expect(computeGateDecision("signed-out", "/", "")).toEqual({
      kind: "redirect-to-login",
      to: "/login?return=%2F",
    });
  });

  it("every route-map prefix redirects with itself as the return target", () => {
    for (const path of ["/", "/acc", "/tools", "/prompts", "/ideas", "/settings"]) {
      expect(computeGateDecision("signed-out", path, "")).toEqual({
        kind: "redirect-to-login",
        to: `/login?return=${encodeURIComponent(path)}`,
      });
    }
  });
});

describe("computeGateDecision: fail-closed on an unrecognized status (SH-6 regression net)", () => {
  it("never renders gated content for a status outside the declared union", () => {
    // Deliberately outside SessionStatus's declared members -- proves the
    // switch's default falls to redirect, not render, for anything this
    // function doesn't explicitly recognize as authenticated. This is the
    // exact shape of bug SH-6 depends on never regressing: a session that
    // is demoted/expired/unknown must never fall through to "render".
    const unrecognized = "expired" as unknown as SessionStatus;
    const decision = computeGateDecision(unrecognized, "/", "");
    expect(decision.kind).toBe("redirect-to-login");
    expect(decision.kind).not.toBe("render");
  });
});
