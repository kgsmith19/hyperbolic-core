// Session ownership after m2-08 (docs/planning/issues/m2-08-feat-lifeos-shell-integration.md;
// docs/planning/05-e-lifeos.md section 4; ADR-03 in docs/planning/04-adrs.md):
// LifeOS is no longer its own login surface. The Shell is the ONLY place
// that ever performs a password sign-in (LO-2b's grep contract -- see this
// issue's report for the exact command; deliberately not spelled out
// verbatim in this comment, since that string is itself what the grep
// matches on); this module mirrors apps/shell/src/lib/session.ts's own
// construction of
// `createPlatformClient` almost verbatim, deliberately -- "Session from
// packages/platform-client" (this issue's own scope line) means LifeOS
// reads the SAME session mechanism the Shell does, not a lookalike one.
//
// Two platform-client INSTANCES, one session: this is a genuinely separate
// document/bundle from the Shell (docs/planning/05-a-hyperbolic-core.md
// section 4: "/life/*" is "a separate bundle" behind a "tailscale serve
// route", and cross-zone navigation is "a full document load", not
// client-side routing) -- there is no live JS object to share across that
// boundary. What IS shared is the underlying Supabase Auth session in
// same-origin `localStorage` (05-a section 6: "one origin (ADR-02) means
// both zones see one session"), and any `createPlatformClient` call
// pointed at the SAME Supabase project reads that same stored session.
// That is what makes this a real re-read of the Shell's session rather than
// a parallel login system with a similar-looking API.
import { useCallback, useEffect, useState } from "react";
import {
  createPlatformClient,
  type PlatformClient,
  type PlatformSession,
} from "@hyperbolic/platform-client";

// ADR-03: the toolbelt Supabase project (woltgcggxaehtuypkxqk) is the
// platform IdP that every zone -- Shell and LifeOS alike -- re-points to
// (docs/planning/05-e-lifeos.md section 4 steps 1-3). These are the exact
// same public defaults apps/shell/src/lib/session.ts hardcodes for the
// identical reason (that file's own comment: "the anon key is designed for
// client-side exposure, RLS is the actual boundary") -- VITE_SUPABASE_URL /
// VITE_SUPABASE_PUBLISHABLE_KEY (frontend/.env.example) override for a
// different project, exactly as they did before this issue, just re-pointed
// per the runbook (backend/docs/runbook.md, "Auth re-point to the platform
// IdP (m2-08)").
const DEFAULT_SUPABASE_URL = "https://woltgcggxaehtuypkxqk.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || DEFAULT_SUPABASE_PUBLISHABLE_KEY;

export const platformClient: PlatformClient = createPlatformClient({
  supabaseUrl: SUPABASE_URL,
  publishableKey: SUPABASE_PUBLISHABLE_KEY,
});

export type SessionStatus = "checking" | "signed-in" | "signed-out";

export interface LifeOsSession {
  /**
   * "checking": the one `getSession()` call this hook owns hasn't resolved
   * yet -- App.tsx's gate renders neither the zone's content nor triggers
   * the redirect-to-login navigation while this holds, matching
   * apps/shell/src/components/protected-layout.tsx's own "no flash of
   * gated content before redirect".
   */
  status: SessionStatus;
  session: PlatformSession | null;
  /**
   * Deliberately NO `signIn` here (contrast with apps/shell/src/lib/session.ts's
   * `ShellSession.signIn`): LifeOS has no login form to call it from
   * (Login.tsx is deleted by this same issue) and must never grow one --
   * that is the one-sentence version of LO-2b.
   */
  signOut: () => void;
}

/**
 * Reads the platform session for the lifetime of this document. Exactly one
 * `getSession()` call, same shape as `useShellSession` minus `signIn` --
 * see this module's own top comment for why a second, independent
 * `createPlatformClient()` instance here is still "the same session" and
 * not a parallel one.
 */
export function useLifeOsSession(): LifeOsSession {
  const [status, setStatus] = useState<SessionStatus>("checking");
  const [session, setSession] = useState<PlatformSession | null>(null);

  useEffect(() => {
    let cancelled = false;

    function apply(next: PlatformSession | null) {
      if (cancelled) return;
      setSession(next);
      // Fail closed: an IdP outage, an expired token that cannot refresh,
      // or any other non-truthy result all collapse to "signed-out" --
      // never a status that would let App.tsx's gate render zone content
      // or let a stale token reach an authenticated API call.
      setStatus(next ? "signed-in" : "signed-out");
    }

    platformClient.auth.getSession().then(apply);
    const unsubscribe = platformClient.auth.onAuthStateChange(apply);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const signOut = useCallback(() => {
    setSession(null);
    setStatus("signed-out");
    platformClient.auth.signOut().catch(() => {});
  }, []);

  return { status, session, signOut };
}
