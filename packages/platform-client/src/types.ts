/**
 * Public type contract for `@hyperbolic/platform-client`.
 *
 * Verbatim from docs/planning/05-a-hyperbolic-core.md section 6, itself
 * mandated by ADR-03 (docs/planning/04-adrs.md). This is a frozen interface:
 * every zone that will later consume this package depends on this exact
 * shape, so changes here are cross-cutting and must update the binding
 * interface doc first.
 */

/** Detaches a previously registered listener. */
export type Unsubscribe = () => void;

export interface PlatformClientConfig {
  /** Platform IdP project URL (ADR-03): the toolbelt Supabase project. */
  supabaseUrl: string;
  /** Supabase publishable key; public by design, safe in a browser bundle. */
  publishableKey: string;
}

export interface PlatformSession {
  /** Supabase Auth JWT, ES256. Sent as `Authorization: Bearer <accessToken>`. */
  readonly accessToken: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
  /** Must equal the owner UUID; any other subject is a bug (ADR-03, fail closed). */
  readonly userId: string;
}

export interface PlatformAuth {
  /** The Shell's login flow only (ADR-03); other zones must not call this. */
  signInWithPassword(email: string, password: string): Promise<PlatformSession>;
  /**
   * Returns the current session, refreshing it first if it is expired.
   * Resolves `null` (never throws) when there is no session, or when a
   * required refresh cannot complete (IdP unreachable, refresh rejected).
   */
  getSession(): Promise<PlatformSession | null>;
  onAuthStateChange(handler: (session: PlatformSession | null) => void): Unsubscribe;
  signOut(): Promise<void>;
}

/**
 * Attaches `Authorization: Bearer <accessToken>` to every request. Rejects
 * without issuing any network request when there is no active session
 * (fail closed, ADR-03).
 */
export type AuthedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PlatformClient {
  auth: PlatformAuth;
  fetch: AuthedFetch;
}
