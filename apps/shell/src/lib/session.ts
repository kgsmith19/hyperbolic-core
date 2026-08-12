// Session ownership (docs/planning/05-a-hyperbolic-core.md section 6, ADR-03):
// the Shell is the ONLY place that constructs the platform client and holds
// the session. This module does that -- but the real login FORM is m2-03's
// scope, explicitly excluded here (see this issue's own "out of scope" list).
//
// Interim behavior, stated plainly: every route in this app assumes an
// authenticated operator, per this issue's own text ("assume/stub an
// authenticated session ... do not build a real auth flow"). STUB_SESSION
// below is that stub. Real plumbing is wired anyway -- createPlatformClient,
// auth.getSession(), auth.onAuthStateChange(), auth.signOut() -- so a real
// session (should one already exist in this browser profile, e.g. a
// developer signed in out-of-band against the platform project) is preferred
// the moment it resolves, and m2-03 only has to add a login form on top of
// this, not replumb session handling.
import { useCallback, useEffect, useState } from "react";
import { createPlatformClient, type PlatformSession } from "@hyperbolic/platform-client";

// ADR-03: the toolbelt Supabase project (woltgcggxaehtuypkxqk) is the
// platform IdP. URL + publishable key are public by design (apps/toolbelt/config.mjs's
// own comment says exactly this: "the anon key is designed for client-side
// exposure, RLS is the actual boundary"), so hardcoding them as the default
// here is deliberate, not a leak -- VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY
// override for a different project (.env.example).
const DEFAULT_SUPABASE_URL = "https://woltgcggxaehtuypkxqk.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";

export const platformClient = createPlatformClient({
  supabaseUrl: import.meta.env?.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL,
  publishableKey: import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || DEFAULT_SUPABASE_PUBLISHABLE_KEY,
});

/**
 * m2-03's login gate is not built yet, so no real session will normally
 * exist. This placeholder lets every zone render as if SH-1's "authenticated
 * operator" precondition already holds, per this issue's explicit stub
 * allowance. `expiresAt` is generated fresh (now + 24h) rather than a fixed
 * epoch constant so it never reads as "expired" no matter when the app runs.
 */
export function makeStubSession(): PlatformSession {
  return {
    accessToken: "stub-dev-session-pending-m2-03-login-gate",
    expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    userId: "00000000-0000-4000-8000-000000000000",
  };
}

export interface ShellSession {
  session: PlatformSession;
  /** True once a REAL session (not the stub) is in effect. */
  isStubSession: boolean;
  onSignOut: () => void;
}

/**
 * Owns the Shell's session for the lifetime of the app. Real session state
 * from `platformClient.auth` wins whenever present; STUB_SESSION is only the
 * fallback so Chrome's authenticated-only regions (session menu, sign-out)
 * have something concrete to render before m2-03 exists.
 */
export function useShellSession(): ShellSession {
  const [stub] = useState(makeStubSession);
  const [realSession, setRealSession] = useState<PlatformSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    platformClient.auth.getSession().then((session) => {
      if (!cancelled && session) setRealSession(session);
    });
    const unsubscribe = platformClient.auth.onAuthStateChange((session) => {
      if (!cancelled) setRealSession(session);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const onSignOut = useCallback(() => {
    // Best-effort: signOut() throws when there is no session, which is the
    // common case pre-m2-03. Never let that surface as an unhandled
    // rejection or crash the chrome every zone renders.
    platformClient.auth.signOut().catch(() => {});
    setRealSession(null);
  }, []);

  return {
    session: realSession ?? stub,
    isStubSession: realSession === null,
    onSignOut,
  };
}
