// Session ownership (docs/planning/05-a-hyperbolic-core.md section 6,
// ADR-03): the Shell is the ONLY place that constructs the platform client
// and holds the session. This module does that, and -- as of this issue
// (m2-03) -- also owns the real login/session lifecycle: a single
// `getSession()` call at app start, kept live via `onAuthStateChange`, with
// `signIn`/`signOut` as the only two mutation entry points. m2-02's
// STUB_SESSION placeholder is gone: every route now genuinely requires an
// authenticated operator (src/components/protected-layout.tsx is the gate
// that enforces that; this module only owns session STATE, not the
// redirect decision -- see src/lib/auth-gate.ts for that).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPlatformClient,
  createRegistryClient,
  type PlatformClient,
  type PlatformSession,
  type RegistryClient,
} from "@hyperbolic/platform-client";

// ADR-03: the toolbelt Supabase project (woltgcggxaehtuypkxqk) is the
// platform IdP. URL + publishable key are public by design (apps/toolbelt/config.mjs's
// own comment says exactly this: "the anon key is designed for client-side
// exposure, RLS is the actual boundary"), so hardcoding them as the default
// here is deliberate, not a leak -- VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY
// override for a different project (.env.example).
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

// m3-04: the registry client rides the SAME session URL/token as
// platformClient above -- not a second, ad-hoc Supabase client (this
// module's whole reason to exist is being the one place the Shell's session
// lives, ADR-03). getAccessToken() defers to platformClient.auth.getSession()
// (the single source of truth every route already reads from) and rejects
// with zero network calls when there is no session, matching AuthedFetch's
// own fail-closed contract in packages/platform-client/src/index.ts.
export const registryClient: RegistryClient = createRegistryClient(
  SUPABASE_URL,
  async () => {
    const session = await platformClient.auth.getSession();
    if (!session) {
      throw new Error("registry-client: no active session, refusing to send request");
    }
    return session.accessToken;
  },
  SUPABASE_PUBLISHABLE_KEY,
);

declare global {
  interface Window {
    __hyperbolicPlatformClient?: PlatformClient;
  }
}

// e2e-only hook: exposes the SAME platform-client singleton every Shell page
// renders from on `window`, so Playwright's e2e suite (which runs against a
// REAL production build, per playwright.config.ts's own webServer command)
// can drive the frozen PlatformAuth/AuthedFetch contract directly (SH-3,
// SH-6) without a real composed-app backend existing in this sandbox --
// LifeOS zone wiring is m2-08's scope, not this issue's; see this issue's
// report for that judgment call.
//
// Gated behind VITE_E2E_HOOKS, which ONLY playwright.config.ts's webServer
// command sets (env: { VITE_E2E_HOOKS: "1" }); apps/shell's own plain
// `npm run build` -- and therefore any real deploy, m2-04 -- never sets it,
// so this branch never assigns anything on `window` outside an e2e run.
if (import.meta.env?.VITE_E2E_HOOKS === "1" && typeof window !== "undefined") {
  window.__hyperbolicPlatformClient = platformClient;
}

export type SessionStatus = "checking" | "signed-in" | "signed-out";

export type ShellSessionState =
  | { status: "checking"; session: null }
  | { status: "signed-out"; session: null }
  | { status: "signed-in"; session: PlatformSession };

export type ShellSession = ShellSessionState & {
  /**
   * "checking": the one `getSession()` call this hook owns hasn't resolved
   * yet -- components/protected-layout.tsx renders neither gated content
   * nor the login form while this holds (this issue's own "no flash of
   * gated content before redirect").
   */
  status: SessionStatus;
  session: PlatformSession | null;
  /** The Shell's one login surface (ADR-03) calls this; rethrows on failure. */
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
};

/**
 * Owns the Shell's session for the lifetime of the app: exactly one
 * `getSession()` call, backing every route (SH-3) via the props threaded
 * through app.tsx. Real session state from `platformClient.auth` is the
 * only source of truth -- there is no stub/fallback session anymore.
 */
export function useShellSession(): ShellSession {
  const [authState, setAuthState] = useState<ShellSessionState>({
    status: "checking",
    session: null,
  });
  const revision = useRef(0);

  useEffect(() => {
    let cancelled = false;

    function apply(next: PlatformSession | null) {
      if (cancelled) return;
      // Fail closed (SH-6): ANY non-truthy result -- including the null
      // platform-client itself already returns when the IdP is unreachable
      // and the cached token has expired (packages/platform-client's own
      // getSession() contract) -- collapses to "signed-out", never a status
      // that would let components/protected-layout.tsx render gated
      // content or let a stale token reach an authenticated call.
      setAuthState(
        next
          ? { status: "signed-in", session: next }
          : { status: "signed-out", session: null }
      );
    }

    // Keeps this hook's status live for the rest of the session, not just
    // at mount: a background auto-refresh failure (e.g. the IdP going
    // unreachable while this tab stays open past the cached token's
    // expiry) surfaces through this same listener, not just through a
    // future getSession() call -- see session.test.ts's "background
    // demotion" case.
    const unsubscribe = platformClient.auth.onAuthStateChange((next) => {
      revision.current += 1;
      apply(next);
    });

    const restoreRevision = revision.current;
    platformClient.auth
      .getSession()
      .then((next) => {
        if (revision.current === restoreRevision) apply(next);
      })
      .catch(() => {
        if (revision.current === restoreRevision) apply(null);
      });

    return () => {
      cancelled = true;
      revision.current += 1;
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const requestRevision = ++revision.current;
    const next = await platformClient.auth.signInWithPassword(email, password);
    // onAuthStateChange (registered above) will also observe this same
    // session and re-apply the identical state, but setting it here too
    // means the caller's very next statement after `await signIn(...)`
    // (LoginPage's own post-await `navigate()`) already sees "signed-in"
    // rather than racing the listener's own async state update.
    if (revision.current === requestRevision) {
      setAuthState({ status: "signed-in", session: next });
    }
  }, []);

  const signOut = useCallback(() => {
    // Flip to signed-out immediately, before the network round trip
    // resolves: never let a slow or failed signOut() leave the app
    // appearing authenticated for even one extra render. Best-effort on
    // the network call itself -- signOut() rejecting (e.g. already no
    // session server-side) must never crash the chrome every zone renders.
    revision.current += 1;
    setAuthState({ status: "signed-out", session: null });
    platformClient.auth.signOut().catch(() => {});
  }, []);

  return { ...authState, signIn, signOut };
}
