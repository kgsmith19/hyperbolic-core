// ADR-03 session verification, server-side. There is exactly one real IdP
// session in this system (the platform owner's); this mirrors
// packages/platform-client/src/index.ts's isOwnerSession() line for line
// (same RPC, same fail-closed contract), because that function only exists
// as a browser-side helper -- a server process needs its own copy to verify
// an INCOMING bearer token rather than a live client session object.
//
// Deliberately no local JWT verification (no JWKS/jose dependency anywhere
// in this repo, confirmed before writing this): core.is_platform_owner()
// is the single source of truth for both "is this JWT valid" and "is this
// subject the owner" in one round trip, and every non-2xx or non-`true`
// outcome fails closed to `false` -- never "assume yes".

const BEARER_RE = /^Bearer ([^\s]+)$/;

/** Extracts the bearer token from an Authorization header, or null if the
 * header is missing or not shaped like `Bearer <token>`. Pure and
 * synchronous so a malformed/absent header is rejected before any network
 * call -- the fast path the SH-4-style latency budget for the reject case
 * depends on. */
export function extractBearerToken(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader) {
    return null;
  }
  const match = BEARER_RE.exec(authorizationHeader);
  return match ? match[1]! : null;
}

/** Answers "is `bearerToken` a live session for the platform owner",
 * exactly as packages/platform-client's isOwnerSession does. Fails closed
 * on every inconclusive outcome: a network error, a non-2xx response, or
 * any body other than the literal boolean `true`.
 *
 * COST, stated because the call site does not show it: server.ts gates EVERY
 * request through this, so each one spends a Supabase round trip before any
 * real work begins. On /v1/complete and /v1/stream that is small beside the
 * upstream model call; on /v1/count, which is otherwise fast, it can dominate
 * the request.
 *
 * Memoizing per bearer token would be correctness-preserving against the
 * token (this RPC answers for exactly that token, nothing else) and would
 * collapse the cost to once per token lifetime. It is NOT done, for the same
 * reason packages/platform-client/src/index.ts's authedFetch does not do it:
 * today a change to platform.owner() takes effect on the very next request,
 * where a cache would let a revoked owner keep transacting until the token
 * expired. Decide that trade deliberately, in both places at once, or not at
 * all. */
export async function verifyOwnerSession(
  supabaseUrl: string,
  supabasePublishableKey: string,
  bearerToken: string
): Promise<boolean> {
  try {
    const res = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/is_platform_owner`, {
      method: "POST",
      headers: {
        apikey: supabasePublishableKey,
        Authorization: `Bearer ${bearerToken}`,
        "Content-Profile": "core",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) {
      return false;
    }
    const data: unknown = await res.json();
    return data === true;
  } catch {
    return false;
  }
}
