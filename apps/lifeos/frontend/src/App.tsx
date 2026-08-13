// m2-08 (docs/planning/issues/m2-08-feat-lifeos-shell-integration.md):
// Chrome adoption from packages/ui (contract C-3) and session from
// packages/platform-client, replacing this file's own `Shell` header/nav
// and `useSession`/`supabase` login gate. Mirrors
// apps/shell/src/components/protected-layout.tsx's pattern -- see
// src/lib/session.ts and src/lib/auth-gate.ts's own comments for the two
// real differences (no `signIn`, and a full-document redirect instead of a
// client-side one) forced by LifeOS being a separate zone bundle rather
// than a route inside the Shell's own router.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import { Chrome } from "@hyperbolic/ui";

import { computeGateDecision } from "./lib/auth-gate";
import { useLifeOsSession } from "./lib/session";
import { Loading } from "./components/QueryStatus";

// Route chunks stay lazy exactly as before this issue -- the initial bundle
// still shouldn't grow with every page added to the zone. There is no
// eager Login chunk anymore (SH-2/LO-2: the Shell owns the one login
// surface; this zone's route table starts directly at its real pages).
const Approvals = lazy(() => import("./pages/Approvals"));
const Browse = lazy(() => import("./pages/Browse"));
const Capture = lazy(() => import("./pages/Capture"));
const Chat = lazy(() => import("./pages/Chat"));
const EntityDetail = lazy(() => import("./pages/EntityDetail"));
const Tomorrow = lazy(() => import("./pages/Tomorrow"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

function Gate() {
  const { status, session, signOut } = useLifeOsSession();
  // react-router's own `useLocation()` returns the path with the router's
  // `basename` ("/life") already stripped off -- exactly what the ROUTES
  // below need to match against, but NOT what a redirect out to the
  // Shell's login should carry as `?return=` (see lib/auth-gate.ts's own
  // comment on this). `window.location` is the real, unstripped browser
  // path, read fresh on every render since this component re-renders on
  // every navigation.
  const routerLocation = useLocation();
  const decision = computeGateDecision(status, window.location.pathname, window.location.search);

  useEffect(() => {
    if (decision.kind === "redirect-to-shell-login") {
      window.location.assign(decision.href);
    }
    // `routerLocation` is intentionally in the dependency list even though
    // this effect reads `window.location` directly: it is what changes on
    // an in-zone navigation, and without it this effect would only ever
    // re-run when `status` itself changes, missing a same-status
    // (still-signed-out) navigation to a new path that should carry a
    // freshly-encoded `?return=`.
  }, [decision, routerLocation]);

  if (decision.kind !== "render") {
    // Renders neither the zone's content nor a login form for either
    // "loading" or "redirect-to-shell-login" -- the same "no flash of
    // gated content before redirect" property
    // apps/shell/src/components/protected-layout.tsx documents for its own
    // identical two non-"render" branches.
    return <div className="min-h-dvh bg-bg" data-testid="auth-checking" />;
  }

  return (
    <Chrome activeZone="life" session={session} onSignOut={signOut}>
      {/* Mirrors apps/shell/src/components/protected-layout.tsx's own
          `[data-app-data]` marker: this whole subtree does not exist in the
          DOM for any status other than "signed-in" (see the branch above),
          so its mere presence is what an e2e assertion checks for "gated
          content actually rendered, not a false-positive Chrome shell". */}
      <div data-app-data="lifeos-zone">
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Browse />} />
            <Route path="/capture" element={<Capture />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/tomorrow" element={<Tomorrow />} />
            <Route path="/entities/:id" element={<EntityDetail />} />
            <Route path="/approvals" element={<Approvals />} />
          </Routes>
        </Suspense>
      </div>
    </Chrome>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* 05-a section 4: Vite `base: '/life/'` (vite.config.ts) and this
          router `basename` must agree -- both name the same mount point the
          one-origin route table (docs/ops/tailscale-serve-apply.sh) serves
          this bundle from. */}
      <BrowserRouter basename="/life">
        <Gate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
