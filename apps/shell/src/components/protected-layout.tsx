// The login gate every non-/login route in app.tsx renders through
// (SH-2a/SH-2b, docs/planning/05-a-hyperbolic-core.md section 4's route
// map). All branching lives in lib/auth-gate.ts's computeGateDecision so it
// is unit-testable without a router; this component only wires that
// decision to react-router (Navigate/Outlet) and to Chrome.
import { useCallback, useMemo } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { Chrome, type ToolPaletteEntry } from "@hyperbolic/ui";
import { computeGateDecision } from "../lib/auth-gate";
import { activeZoneForPath } from "../lib/active-zone";
import type { AuthState } from "../lib/session";
import { splitByRoute, useRegisteredTools } from "../lib/registry";
import { notificationSurface } from "../lib/notifications";

interface ProtectedLayoutProps {
  /**
   * Finding #77 (PR #8 security review): a single discriminated-union field
   * instead of the previous two independent `status`/`session` props --
   * see session.ts's `AuthState` doc comment for why. Narrowed directly on
   * `.status` below before `.session` is ever read.
   */
  auth: AuthState;
  onSignOut: () => void;
}

function ProtectedLayout({ auth, onSignOut }: ProtectedLayoutProps) {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const decision = computeGateDecision(auth.status, location.pathname, location.search);

  // m3-04 (05-a section 5): the command palette's tool entries, fetched here
  // (not inside Chrome/CommandPalette, which own no registry client -- see
  // packages/ui/src/chrome/chrome.tsx's own doc comment) so they're
  // available on EVERY gated route, not just /tools. `enabled` gates the
  // fetch itself (not just this hook call, which -- rules of hooks -- must
  // always run) so a signed-out operator on /login never issues an
  // authenticated registry request; registryClient's own getAccessToken
  // would reject it anyway (fail closed, zero network calls), but skipping
  // it here avoids the pointless loading/error churn on every unauthenticated
  // render. Same `useRegisteredTools()` call src/pages/tools.tsx makes for
  // its own full catalog -- src/lib/registry.ts's in-flight dedupe collapses
  // the common case (landing on /tools) into one real network request.
  const registryState = useRegisteredTools(undefined, { enabled: auth.status === "signed-in" });
  const toolEntries = useMemo<ToolPaletteEntry[]>(
    () =>
      splitByRoute(registryState.tools).navTools.map((tool) => ({
        id: tool.id,
        label: tool.name,
        // splitByRoute only puts a row in navTools when tool.route is
        // truthy, so this cast is safe -- narrower than TypeScript can
        // itself infer through the array filter above.
        href: tool.route as string,
      })),
    [registryState.tools]
  );

  // Finding #70 (PR #8 security review): the client-side navigation adapter
  // threaded into Chrome (ChromeProps.navigate) so NavRail/CommandPalette
  // clicks on genuinely internal Shell routes route through react-router
  // instead of forcing a full document reload. zones.ts's `hardNavigate`
  // flag (currently just `life`) opts specific entries out of this
  // regardless of what's wired here -- see shouldNavigateClientSide.
  const navigate = useCallback((href: string) => routerNavigate(href), [routerNavigate]);

  if (decision.kind === "loading") {
    // SH-2a / this issue's own "no flash of gated content before redirect":
    // the session status isn't resolved yet, so render NEITHER the
    // protected app content NOR the login form -- an empty, themed shell
    // only, carrying no [data-app-data] node and no chrome. This window is
    // normally sub-frame (getSession() resolves from local storage with no
    // network round trip for a non-expired session) but must never be
    // skipped: skipping it is exactly the flash this gate exists to
    // prevent.
    return <div className="min-h-dvh bg-bg" data-testid="auth-checking" />;
  }

  if (decision.kind === "redirect-to-login") {
    return <Navigate to={decision.to} replace />;
  }

  // Finding #77 (PR #8 security review): `decision.kind === "render"` (per
  // computeGateDecision's own contract, see auth-gate.ts) implies
  // `auth.status === "signed-in"`, but that relationship holds only because
  // both are independently derived from the same underlying status -- the
  // type system can't see through two separate functions to know it. This
  // re-check, directly on `auth.status`, is what actually narrows
  // `auth.session` to a real, non-null `PlatformSession` for the `Chrome`
  // prop below, replacing what used to be an unenforced `as
  // NonNullable<...>` cast at the SettingsPage call site (app.tsx). In
  // practice this branch is unreachable (both checks agree by
  // construction), but "unreachable only because of an invariant the
  // compiler can't verify" is exactly the gap this finding closes -- if it
  // is ever reached, failing closed to /login is the same fail-closed
  // choice SH-6 makes everywhere else in this gate.
  if (auth.status !== "signed-in") {
    return <Navigate to="/login" replace />;
  }

  const activeZone = activeZoneForPath(location.pathname);

  return (
    // m2-05: Chrome would fall back to the same per-document singleton on
    // its own, but the Shell passes it explicitly -- this component is
    // where the platform's one notification surface is mounted, and that
    // should be readable here rather than implied by a default two packages
    // away.
    <Chrome
      activeZone={activeZone}
      session={auth.session}
      onSignOut={onSignOut}
      tools={toolEntries}
      notifications={notificationSurface}
      navigate={navigate}
    >
      {/* SH-2a's e2e assertion (05-a section 12) checks for the LITERAL
          absence of [data-app-data] while gated. One coarse wrapper here
          (rather than annotating every individual page's data-bearing
          elements) is sufficient and robust: this whole subtree, chrome
          included, simply does not exist in the DOM for any status other
          than "signed-in" -- see the two branches above. */}
      <div data-app-data="shell-zone">
        <Outlet />
      </div>
    </Chrome>
  );
}

export default ProtectedLayout;
