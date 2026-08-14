import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
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

export {
  createRegistryClient,
  buildListToolsParams,
} from "./registry.ts";
export type {
  RegisteredTool,
  RegistryClient,
  RegistryFilter,
  ToolKind,
  ToolStatus,
} from "./registry.ts";

export { createBrainClient, SseLineParser } from "./brain.ts";
export type {
  BrainClient,
  BrainRun,
  BrainTask,
  CreateRunParams,
  CreateRunResult,
  TaskActionResult,
  BrainEvent,
  StreamRunEventsOptions,
  ParsedSseEvent,
} from "./brain.ts";

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
 * Finding #47 (PR #8 security review, re-verified against current HEAD):
 * this client used to hand back any authenticated Supabase subject's
 * session, though types.ts's own PlatformSession doc comment has always
 * said the subject "Must equal the owner UUID; any other subject is a bug
 * (ADR-03, fail closed)". `core.is_platform_owner()`
 * (apps/toolbelt/supabase/migrations/20260814060000_core_is_platform_owner_rpc.sql)
 * is the narrow, PostgREST-exposed, SECURITY DEFINER RPC that closes the
 * gap: it answers `auth.uid() = platform.owner()` for the CALLING request's
 * bearer token without ever exposing the owner UUID itself.
 *
 * Deliberately a raw `fetch` with `session.accessToken` attached explicitly
 * -- NOT `supabase.rpc()` -- for exactly the session-race reason this
 * finding calls out by name: `supabase.rpc()` resolves its own Authorization
 * header from whatever session is LIVE on the client at the moment the
 * request is actually sent (see `fetchWithAuth` in
 * `@supabase/supabase-js`'s `src/lib/fetch.ts`), not necessarily the
 * `session` object a caller here is about to accept or reject. Between this
 * function being called with a session snapshot and its underlying request
 * actually reaching the network, the live client session can change (a
 * background token refresh, a cross-tab sign-in/sign-out via
 * `onAuthStateChange`'s own broadcast channel) -- if the RPC's identity were
 * resolved from "whatever is live now" instead of "the exact session this
 * call is about", a caller could receive a session object that was never
 * actually the one checked (e.g. `getSession()` snapshots a non-owner
 * session A, a same-tick cross-tab sign-in swaps the live client session to
 * owner session B before the request goes out, `supabase.rpc()` would
 * answer "true" for B while this function still hands back A's unvetted
 * token). Pinning the bearer token to `session.accessToken` makes that race
 * impossible by construction: this RPC can only ever answer for the exact
 * session passed in, never a different one that happens to be live.
 *
 * Same request shape `packages/platform-client/src/registry.ts` already
 * uses for its own PostgREST calls (raw `fetch`, explicit `apikey` +
 * `Authorization`), for the same underlying reason documented there: this
 * package's frozen interfaces resolve exactly the token a caller already
 * has in hand, never one implicitly re-resolved by a client's own live
 * state. `Content-Profile: core` selects the schema this RPC lives in
 * (PostgREST's schema-switching header for POST/RPC requests; `core` is
 * already exposed via `pgrst.db_schemas` -- see the migration's own header
 * comment for why it is not `platform`).
 *
 * Fails closed on every inconclusive outcome, not just an explicit `false`:
 * a network error, a non-2xx response, or any body other than the literal
 * boolean `true` all mean "not proven to be the owner", never "assume yes".
 */
async function isOwnerSession(
  config: PlatformClientConfig,
  session: PlatformSession
): Promise<boolean> {
  try {
    const res = await globalThis.fetch(
      `${config.supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/is_platform_owner`,
      {
        method: "POST",
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Profile": "core",
          "Content-Type": "application/json",
        },
        body: "{}",
      }
    );
    if (!res.ok) {
      return false;
    }
    const data: unknown = await res.json();
    return data === true;
  } catch {
    return false;
  }
}

/**
 * The single place every session-resolution path (signInWithPassword's
 * success path, getSession's resolution, and every onAuthStateChange
 * delivery) routes through to enforce Finding #47's fail-closed contract --
 * deliberately inside platform-client itself, not apps/shell: every zone
 * that will ever consume this package (not just the Shell) gets the
 * guarantee for free, consistent with this package's role as the frozen
 * ADR-03 contract (see this file's own top-of-file doc comment on
 * createPlatformClient).
 *
 * A `null` input (no session at all) passes through untouched -- there is
 * nothing to check ownership of. A non-null session that is NOT the owner
 * is best-effort signed out (mirrors apps/shell/src/lib/session.ts's own
 * signOut(), which also swallows a failed network call rather than letting
 * it block state transitions) so a non-owner session never lingers half-real
 * in browser storage, and this function resolves `null` either way --
 * callers never see a non-owner session shape, only ever a real owner
 * session or nothing.
 */
async function enforceOwner(
  supabase: SupabaseClient,
  config: PlatformClientConfig,
  session: PlatformSession | null
): Promise<PlatformSession | null> {
  if (!session) {
    return null;
  }
  if (await isOwnerSession(config, session)) {
    return session;
  }
  await supabase.auth.signOut().catch(() => {});
  return null;
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
      // Finding #47 (fail closed, ADR-03): a real, successfully-authenticated
      // Supabase session is not enough -- it must also be the platform
      // owner. enforceOwner already signs a non-owner session out before
      // resolving null here, so there is nothing left to clean up on this
      // rejection path; it only needs to turn that null into a thrown error,
      // since this method's contract (types.ts) is Promise<PlatformSession>,
      // never a null.
      const ownerSession = await enforceOwner(supabase, config, session);
      if (!ownerSession) {
        throw new Error(
          "platform-client: sign-in succeeded but the authenticated subject is not the " +
            "platform owner (ADR-03, fail closed); session revoked"
        );
      }
      return ownerSession;
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
        // Finding #47: a restored session must clear the same owner check
        // as a fresh sign-in -- enforceOwner returns null for a non-owner
        // subject (and best-effort signs it out), matching this method's
        // documented "resolves null, never throws" contract exactly.
        return await enforceOwner(supabase, config, toPlatformSession(data.session));
      } catch {
        return null;
      }
    },

    onAuthStateChange(handler) {
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        const platformSession = toPlatformSession(session);
        if (!platformSession) {
          handler(null);
          return;
        }
        // Finding #47: every live auth-state delivery gets the same
        // fail-closed owner check as the other two entry points, not just
        // the initial resolution -- e.g. a background TOKEN_REFRESHED event
        // must not silently keep reporting a non-owner subject as signed in
        // just because it was already past the sign-in/getSession gate once.
        // Deliberately not awaited by this callback itself (only the
        // eventual `handler` call is): supabase-js's own onAuthStateChange
        // callback may run async work and call other auth methods (signOut,
        // inside enforceOwner) safely from here -- the one documented hazard
        // is triggering a nested refresh from a TOKEN_REFRESHED handler,
        // which this never does.
        void enforceOwner(supabase, config, platformSession).then(handler);
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

  const allowedOrigins = buildAllowedOrigins(config);

  const authedFetch: AuthedFetch = async (input, init) => {
    // P1 fix (see resolveRequestOrigin's doc comment for the full writeup):
    // refuse to attach the live bearer token to any request whose resolved
    // origin isn't same-origin-with-the-page or on the explicit allowlist.
    // This throws -- it does NOT silently drop the header and let the
    // request go out unauthenticated, because a caller that gets back an
    // unexpected 401 from what it thinks is its own backend is much harder
    // to debug than a caller that gets a clear "refused" error naming
    // exactly why.
    const origin = resolveRequestOrigin(input);
    if (!isOriginAllowed(origin, allowedOrigins)) {
      throw new Error(
        `platform-client: refusing to attach the platform session token to a request ` +
          `targeting origin "${origin}" -- it is neither same-origin with the current ` +
          `page nor in the configured allowlist (${[...allowedOrigins].join(", ") || "<empty>"}). ` +
          `This is the fix for the authedFetch token-exfiltration finding (packages/platform-client/src/index.ts): ` +
          `add the origin to config.additionalAllowedOrigins if this request is legitimate.`
      );
    }

    const session = await auth.getSession();
    if (!session) {
      throw new Error("platform-client: no active session, refusing to send request");
    }

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    headers.set("Authorization", `Bearer ${session.accessToken}`);
    return globalThis.fetch(input, { ...init, headers, redirect: "manual" });
  };

  return { auth, fetch: authedFetch };
}

/**
 * Builds the fixed set of absolute origins `authedFetch` will attach the
 * bearer token to, in addition to same-origin-with-the-page (always allowed,
 * checked separately in `isOriginAllowed` since it depends on
 * `globalThis.location` at CALL time, not at client-construction time).
 *
 * `config.supabaseUrl`'s origin is included unconditionally: it is the one
 * absolute origin ADR-03's "one IdP" posture makes legitimate for every zone
 * (registry.ts's own PostgREST calls sit beside authedFetch, not through it,
 * today -- but a future direct-to-Supabase caller going through
 * `client.fetch` is exactly the case this exists for). It is derived from
 * the caller's own config, never hardcoded, so it tracks VITE_SUPABASE_URL /
 * whatever project the client was actually constructed against.
 *
 * `config.additionalAllowedOrigins` is the escape hatch for any other origin
 * a real caller needs (e.g. a LifeOS API that stops being same-origin under
 * some future deployment topology) without reopening `authedFetch` to
 * arbitrary hosts again. Every current real call site in this repo
 * (apps/shell/e2e/single-session.spec.ts, idp-down.spec.ts,
 * src/lib/session.ts) uses same-origin relative paths -- ADR-02's one-origin
 * V1 topology -- so this list is empty by default; nothing in the current
 * repo needs to populate it.
 */
function buildAllowedOrigins(config: PlatformClientConfig): ReadonlySet<string> {
  const origins = new Set<string>();
  origins.add(new URL(config.supabaseUrl).origin);
  for (const extra of config.additionalAllowedOrigins ?? []) {
    origins.add(new URL(extra).origin);
  }
  return origins;
}

/**
 * Resolves `input` to the absolute origin `globalThis.fetch` will actually
 * send the request to, and is the crux of the P1 fix this function exists
 * for (packages/platform-client/src/index.ts, authedFetch): before this
 * existed, `input` (typed `RequestInfo | URL`, see AuthedFetch in ./types.ts) was
 * handed straight to `fetch` with the live bearer token attached and NO
 * origin check at all -- any absolute URL, from a caller bug, a compromised
 * dependency, or attacker-controlled input reaching a call site three layers
 * up, would exfiltrate the platform session token to that URL's origin.
 *
 * Uses the WHATWG URL parser's own base-resolution semantics
 * (`new URL(input, base)`) rather than any bespoke string parsing, for two
 * reasons that both matter for an allowlist a token's safety depends on:
 *
 * 1. Same-origin relative paths -- "/life/api/entities", every real call
 *    site in this repo today -- resolve against `globalThis.location.href`
 *    exactly the way the browser's own `fetch()` would resolve them, so the
 *    common case keeps working unchanged.
 * 2. A PROTOCOL-RELATIVE url ("//evil.com/x") needs no special-case
 *    detection: WHATWG URL parsing already defines "//" as "keep the base's
 *    scheme, take the host (and everything after) from the reference" --
 *    resolving it against the same base used for every other input is
 *    exactly what turns it into the absolute URL `https://evil.com/x`, whose
 *    origin then fails the allowlist below like any other cross-origin
 *    absolute URL. Hand-rolling a "does this string start with //" check
 *    would be redundant with, and easier to get subtly wrong than, just
 *    letting the spec-compliant parser do it.
 *
 * `javascript:`/`data:` inputs need no special-casing either: the URL
 * Standard gives both of those schemes an opaque origin, serialized as the
 * literal string "null" by `URL#origin` -- which can never equal a real
 * `https://host` allowlist entry, so `isOriginAllowed` rejects them for free.
 *
 * Host casing/encoding tricks (`HTTPS://EVIL.COM`, IDNA homograph hosts,
 * percent-encoded host octets) also need no special-casing: `URL#origin` is
 * defined to lowercase the scheme and host and apply IDNA/punycode
 * normalization while parsing, and the allowlist itself is built by running
 * every configured origin through that exact same `new URL(...).origin`
 * normalization (see `buildAllowedOrigins`) -- so both sides of the
 * comparison are normalized identically and a casing/encoding trick buys an
 * attacker nothing.
 *
 * When neither an absolute `input` nor a `globalThis.location` base is
 * available (a relative path used outside a browser, e.g. a future
 * server-side caller), `new URL` throws `TypeError: Invalid URL` -- which
 * propagates out of `authedFetch` as a thrown rejection, same fail-closed
 * shape as every other refusal here. That is not a new failure mode this
 * fix introduces: `fetch` itself already requires an absolute URL outside a
 * browser, so a relative path in that environment was already broken before
 * this fix: the new behavior is only where in the code the throw happens.
 *
 * `authedFetch` also forces `redirect: "manual"`, so an allowlisted origin
 * cannot redirect the authenticated request to a target that was never
 * checked here. Callers receive the 3xx response and can choose a new target
 * explicitly, which sends that target through this same origin check.
 */
function resolveRequestOrigin(input: RequestInfo | URL): string {
  const base = typeof globalThis.location !== "undefined" ? globalThis.location.href : undefined;
  const target = input instanceof Request ? input.url : input;
  return new URL(target, base).origin;
}

function isOriginAllowed(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  const sameOriginAsPage =
    typeof globalThis.location !== "undefined" && origin === globalThis.location.origin;
  return sameOriginAsPage || allowedOrigins.has(origin);
}
