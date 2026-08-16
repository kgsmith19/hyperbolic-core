/**
 * Public type contract for `@hyperbolic/platform-client`.
 *
 * Verbatim from docs/planning/05-a-hyperbolic-core.md section 6, itself
 * mandated by ADR-03 (docs/archived/2026-08-16/planning-04-adrs.md). This is a frozen interface:
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
  /**
   * Extra absolute origins `authedFetch` (src/index.ts) is willing to attach
   * the live bearer token to, beyond same-origin-with-the-page (always
   * allowed) and `supabaseUrl`'s own origin (always allowed). Optional and
   * empty by default: this is the fix for the authedFetch token-exfiltration
   * finding closed in src/index.ts, and every real call site in this repo
   * today (apps/shell) only ever needs those two origins, so nothing in the
   * current repo needs to set this. Exists as the escape hatch for a future
   * legitimate origin (e.g. a composed app that stops being same-origin)
   * without reopening authedFetch to arbitrary hosts.
   */
  additionalAllowedOrigins?: string[];
}

export interface PlatformSession {
  /** Supabase Auth JWT, ES256. Sent as `Authorization: Bearer <accessToken>`. */
  readonly accessToken: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
  /**
   * Must equal the owner UUID; any other subject is a bug (ADR-03, fail
   * closed). Enforced, not just documented: every `PlatformAuth` method that
   * can resolve a session (`signInWithPassword`, `getSession`,
   * `onAuthStateChange`) calls the `core.is_platform_owner()` RPC
   * (Finding #47, src/index.ts's `enforceOwner`) before ever handing one
   * back, and signs out + discards any session that fails that check. A
   * `PlatformSession` a caller actually receives is therefore always the
   * owner's -- this field is never a value a consumer needs to re-check.
   */
  readonly userId: string;
}

export interface PlatformAuth {
  /**
   * The Shell's login flow only (ADR-03); other zones must not call this.
   * Rejects (never resolves) when the authenticated subject is not the
   * platform owner -- see `core.is_platform_owner()` (Finding #47) -- even
   * though the credentials themselves were valid; the session is signed
   * back out before this rejects.
   */
  signInWithPassword(email: string, password: string): Promise<PlatformSession>;
  /**
   * Returns the current session, refreshing it first if it is expired.
   * Resolves `null` (never throws) when there is no session, when a
   * required refresh cannot complete (IdP unreachable, refresh rejected),
   * or when the resolved session's subject is not the platform owner
   * (Finding #47, fail closed -- the non-owner session is signed out first).
   */
  getSession(): Promise<PlatformSession | null>;
  /**
   * `handler` is invoked with `null`, never a non-owner session, for the
   * same reason as `getSession` (Finding #47): every live delivery is
   * checked before the handler sees it.
   */
  onAuthStateChange(handler: (session: PlatformSession | null) => void): Unsubscribe;
  signOut(): Promise<void>;
}

/**
 * Attaches `Authorization: Bearer <accessToken>` to every request. Rejects
 * without issuing any network request when there is no active session
 * (fail closed, ADR-03).
 */
export type AuthedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PlatformClient {
  auth: PlatformAuth;
  fetch: AuthedFetch;
}
