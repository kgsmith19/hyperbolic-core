// The single auth chokepoint's decision function (this issue's own risk
// note: "the gate is the single auth chokepoint for every zone, so its e2e
// suite is the SH regression net"). Kept as a plain, router-free function so
// it is directly unit-testable without mounting a component tree, and so a
// mutation to this exact branch -- the one thing standing between an
// unauthenticated request and rendered app content -- shows up as a failing
// unit test, not only a slower e2e failure.
import type { SessionStatus } from "./session";

export type GateDecision =
  | { kind: "loading" }
  | { kind: "redirect-to-login"; to: string }
  | { kind: "render" };

/**
 * SH-2a/SH-2b (docs/planning/05-a-hyperbolic-core.md section 12): decides,
 * for the operator's current session status and location, whether the
 * gate should render nothing yet (status not resolved), redirect to the
 * login route (carrying the exact requested path + query as `?return=`,
 * consumed by `sanitizeReturnPath`), or render the gated app content.
 *
 * Fail-closed by construction: `render` is returned ONLY for the literal
 * "signed-in" status. The switch's `default` arm (reached by "signed-out"
 * and by any status value outside the declared union, should it ever grow)
 * falls to the redirect branch, never to render -- this is what makes an
 * unrecognized or demoted session status fail closed rather than fail open.
 */
export function computeGateDecision(status: SessionStatus, pathname: string, search: string): GateDecision {
  switch (status) {
    case "checking":
      return { kind: "loading" };
    case "signed-in":
      return { kind: "render" };
    case "signed-out":
    default: {
      const returnTo = `${pathname}${search}`;
      return { kind: "redirect-to-login", to: `/login?return=${encodeURIComponent(returnTo)}` };
    }
  }
}
