// The LifeOS-zone login gate's decision function (m2-08), mirroring
// apps/shell/frontend/src/lib/auth-gate.ts's `computeGateDecision` shape and its own
// rationale for staying a plain, router-free function: directly
// unit-testable without mounting a component tree.
//
// One real difference from the Shell's version, and it is the whole reason
// this is not a byte-for-byte copy: the Shell's gate redirects with
// react-router's client-side `<Navigate>`, because `/login` is one of ITS
// OWN routes (apps/shell/frontend/src/app.tsx). LifeOS has no `/login` route at all
// (Login.tsx is deleted by this issue) -- the Shell owns the one login
// surface (ADR-03), and LifeOS is a SEPARATE bundle behind a SEPARATE
// `tailscale serve` mount (docs/planning/05-a-hyperbolic-core.md section 4:
// "/life/*" is "a separate bundle"). Sending a signed-out operator to
// "/login" therefore has to be a real, full-document browser navigation
// (`window.location.assign`, in App.tsx) to the Shell's document, not a
// client-side route change against a route table that does not have one --
// so this module's "redirect" variant carries an `href` for that
// navigation, not an in-app `to` path.
import type { SessionStatus } from "./session";

export type GateDecision =
  | { kind: "loading" }
  | { kind: "redirect-to-shell-login"; href: string }
  | { kind: "render" };

/**
 * Fail-closed by construction, same as the Shell's gate: `render` is
 * returned only for the literal "signed-in" status. The `default` arm
 * (reached by "signed-out" and by any status value outside the declared
 * union, should it ever grow) falls to the redirect branch, never to
 * render.
 */
export function computeGateDecision(status: SessionStatus, pathname: string, search: string): GateDecision {
  switch (status) {
    case "checking":
      return { kind: "loading" };
    case "signed-in":
      return { kind: "render" };
    case "signed-out":
    default: {
      // `pathname`/`search` must be the REAL browser location (App.tsx
      // passes `window.location.pathname`/`.search`, not react-router's
      // `useLocation()`), i.e. still carrying the `/life` prefix --
      // react-router's own location has already stripped the `basename`
      // this app renders under, and a `return=` value missing that prefix
      // would send a completed Shell login back to a path that does not
      // exist inside the Shell's own route table. Carried through so a
      // signed-in return trip can eventually land back on it -- see
      // App.tsx's own comment on why the Shell's `?return=` handling does
      // not (yet) complete that round trip for a cross-zone target
      // automatically.
      const returnTo = `${pathname}${search}`;
      return {
        kind: "redirect-to-shell-login",
        href: `/login?return=${encodeURIComponent(returnTo)}`,
      };
    }
  }
}
