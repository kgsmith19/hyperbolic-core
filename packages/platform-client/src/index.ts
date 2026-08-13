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

  const allowedOrigins = buildAllowedOrigins(config);

  const authedFetch: AuthedFetch = async (input, init) => {
    const session = await auth.getSession();
    if (!session) {
      throw new Error("platform-client: no active session, refusing to send request");
    }

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

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${session.accessToken}`);
    return globalThis.fetch(input, { ...init, headers });
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
 * existed, `input` (typed `string | URL`, see AuthedFetch in ./types.ts) was
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
 * Redirect-based exfiltration (an allowlisted origin 30x-redirects to an
 * attacker origin) is deliberately OUT of scope for this check: the Fetch
 * Standard's HTTP-redirect-fetch algorithm strips the `Authorization`
 * request header whenever a redirect's destination origin differs from the
 * request's current origin (https://fetch.spec.whatwg.org/#http-redirect-fetch),
 * and both browsers and Node's `undici`-backed `fetch` (Node 18+, this
 * repo's runtime) implement that step -- so the bearer token is already
 * dropped by the fetch implementation itself before it would ever reach a
 * cross-origin redirect target. Reimplementing that check here would be
 * redundant with a guarantee the runtime already provides, not a gap this
 * function needs to close.
 */
function resolveRequestOrigin(input: string | URL): string {
  const base = typeof globalThis.location !== "undefined" ? globalThis.location.href : undefined;
  return new URL(input, base).origin;
}

function isOriginAllowed(origin: string, allowedOrigins: ReadonlySet<string>): boolean {
  const sameOriginAsPage =
    typeof globalThis.location !== "undefined" && origin === globalThis.location.origin;
  return sameOriginAsPage || allowedOrigins.has(origin);
}
