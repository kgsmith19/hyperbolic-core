import { describe, expect, it } from "vitest";

import { computeGateDecision } from "./auth-gate";

describe("computeGateDecision", () => {
  it("renders nothing while the session status is still resolving", () => {
    expect(computeGateDecision("checking", "/life", "")).toEqual({ kind: "loading" });
  });

  it("renders the zone once signed in, regardless of path", () => {
    expect(computeGateDecision("signed-in", "/life/capture", "?x=1")).toEqual({ kind: "render" });
  });

  it("redirects to the Shell's login, carrying the full browser path as ?return=", () => {
    expect(computeGateDecision("signed-out", "/life/capture", "")).toEqual({
      kind: "redirect-to-shell-login",
      href: "/login?return=%2Flife%2Fcapture",
    });
  });

  it("carries the query string through the encoded return path", () => {
    expect(computeGateDecision("signed-out", "/life/entities/e1", "?tab=history")).toEqual({
      kind: "redirect-to-shell-login",
      href: "/login?return=%2Flife%2Fentities%2Fe1%3Ftab%3Dhistory",
    });
  });

  it("fails closed for any status outside the declared union", () => {
    // Fail-closed by construction (this module's own doc comment): the
    // `default` arm of the switch reaches redirect, never render, even for
    // a status value that should be structurally impossible.
    const decision = computeGateDecision("bogus" as never, "/life", "");
    expect(decision.kind).toBe("redirect-to-shell-login");
  });
});
