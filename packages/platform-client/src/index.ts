import { createClient, type Session } from "@supabase/supabase-js";
import type {
  AuthedFetch,
  PlatformAuth,
  PlatformClient,
  PlatformClientConfig,
  PlatformSession,
} from "./types.ts";

export type {
  AuthedFetch,
  PlatformAuth,
  PlatformClient,
  PlatformClientConfig,
  PlatformSession,
  Unsubscribe,
} from "./types.ts";

function toPlatformSession(session: Session | null): PlatformSession | null {
  if (!session) {
    return null;
  }
  return {
    accessToken: session.access_token,
    expiresAt: session.expires_at ?? 0,
    userId: session.user.id,
  };
}

/**
 * Creates the platform session client (ADR-03). This is the ONLY entry point
 * in this package that can construct a client or sign a user in: zones other
 * than the Shell must call only `auth.getSession()`, `auth.onAuthStateChange()`,
 * `auth.signOut()`, and `fetch` (LO-2 grep contract, 03-v1-definition.md).
 *
 * Wraps `@supabase/supabase-js` and deliberately leaves session storage at
 * the client's default (same-origin browser storage): one origin (ADR-02)
 * is what lets every zone share the one login session.
 */
export function createPlatformClient(config: PlatformClientConfig): PlatformClient {
  const supabase = createClient(config.supabaseUrl, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  const auth: PlatformAuth = {
    async signInWithPassword(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      const session = toPlatformSession(data.session);
      if (error || !session) {
        throw error ?? new Error("platform-client: sign-in returned no session");
      }
      return session;
    },

    async getSession() {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) {
          // Includes the fail-closed case: IdP unreachable while refreshing
          // an expired token. supabase-js resolves an error here rather
          // than throwing; either way we collapse to null and never surface
          // the stale, expired access token to a caller.
          return null;
        }
        return toPlatformSession(data.session);
      } catch {
        return null;
      }
    },

    onAuthStateChange(handler) {
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        handler(toPlatformSession(session));
      });
      return () => subscription.unsubscribe();
    },

    async signOut() {
      const { error } = await supabase.auth.signOut();
      if (error) {
        throw error;
      }
    },
  };

  const authedFetch: AuthedFetch = async (input, init) => {
    const session = await auth.getSession();
    if (!session) {
      throw new Error("platform-client: no active session, refusing to send request");
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${session.accessToken}`);
    return globalThis.fetch(input, { ...init, headers });
  };

  return { auth, fetch: authedFetch };
}
