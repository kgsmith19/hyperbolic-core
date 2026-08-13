// The login gate every non-/login route in app.tsx renders through
// (SH-2a/SH-2b, docs/planning/05-a-hyperbolic-core.md section 4's route
// map). All branching lives in lib/auth-gate.ts's computeGateDecision so it
// is unit-testable without a router; this component only wires that
// decision to react-router (Navigate/Outlet) and to Chrome.
import { Navigate, Outlet, useLocation } from "react-router";
import { Chrome } from "@hyperbolic/ui";
import type { PlatformSession } from "@hyperbolic/platform-client";
import { computeGateDecision } from "../lib/auth-gate";
import { activeZoneForPath } from "../lib/active-zone";
import type { SessionStatus } from "../lib/session";

interface ProtectedLayoutProps {
  status: SessionStatus;
  session: PlatformSession | null;
  onSignOut: () => void;
}

function ProtectedLayout({ status, session, onSignOut }: ProtectedLayoutProps) {
  const location = useLocation();
  const decision = computeGateDecision(status, location.pathname, location.search);

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

  const activeZone = activeZoneForPath(location.pathname);

  return (
    <Chrome activeZone={activeZone} session={session} onSignOut={onSignOut}>
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
