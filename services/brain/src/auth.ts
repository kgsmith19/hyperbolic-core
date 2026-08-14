/**
 * ADR-03 auth for the Brain's HTTP API (m4-14, 07-brain-architecture.md
 * section 7.8 Programmatic: "operator session JWT, or a scoped agent
 * token"). Two credential kinds:
 *
 * - Operator session JWT: services/llm-handler/src/auth.ts's
 *   extractBearerToken/verifyOwnerSession, copied verbatim (same header
 *   comment's own reasoning applies here: no shared cross-service auth
 *   package exists, the established convention is copying this file per
 *   service, and packages/platform-client's isOwnerSession() is the
 *   browser-side twin of the same RPC/fail-closed contract).
 * - Scoped agent token: ADR-03's "a scoped self-issued agent token
 *   following LifeOS's existing mint pattern [mcp_server/tokens.py]" --
 *   self-issued ES256 JWT, mint side holds the private key, this side
 *   holds only the public key. No minting exists anywhere for Brain yet
 *   (m4-20's job, LifeOS-side); this is the verification half only.
 *   Hand-rolled against node:crypto rather than a jose/jsonwebtoken
 *   dependency -- ES256 (ECDSA P-256 + SHA-256, IEEE P1363 signature
 *   encoding per RFC 7518 section 3.4) is a small, well-specified
 *   primitive node:crypto already implements natively, and this service
 *   has stayed dependency-light so far (ajv/ajv-formats/@hyperbolic/llm
 *   only). Fails closed on every malformed/expired/wrong-algorithm/
 *   signature-mismatch case.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

const BEARER_RE = /^Bearer ([^\s]+)$/;

/** Extracts the bearer token from an Authorization header, or null if the
 * header is missing or not shaped like `Bearer <token>`. Pure and
 * synchronous so a malformed/absent header is rejected before any network
 * call -- the fast path the SH-4-style latency budget for the reject case
 * depends on (m4-14's own acceptance criterion: 401 within 50 ms). */
export function extractBearerToken(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader) return null;
  const match = BEARER_RE.exec(authorizationHeader);
  return match ? match[1]! : null;
}

/** Answers "is `bearerToken` a live session for the platform owner". Fails
 * closed on every inconclusive outcome: a network error, a non-2xx
 * response, or any body other than the literal boolean `true`. */
export async function verifyOwnerSession(supabaseUrl: string, supabasePublishableKey: string, bearerToken: string): Promise<boolean> {
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
    if (!res.ok) return false;
    const data: unknown = await res.json();
    return data === true;
  } catch {
    return false;
  }
}

// --- Scoped agent token (self-issued ES256 JWT) --------------------------

export const BRAIN_RUN_PROPOSE_SCOPE = "brain:run:propose";

export interface AgentTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  scopes: string[];
  iat: number;
  exp: number;
}

export interface VerifyAgentTokenOptions {
  publicKeyPem: string;
  issuer: string;
  audience: string;
  /** Injectable for tests; defaults to the real wall clock. */
  nowS?: number;
}

function base64UrlDecode(input: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

const MAX_CLOCK_SKEW_S = 60;

/** Verifies a self-issued ES256 JWT and returns its claims, or null on
 * ANY failure -- malformed structure, wrong/absent algorithm (algorithm
 * confusion is the classic JWT vulnerability class: the token's own
 * claimed `alg` is never trusted for anything but rejecting every value
 * except "ES256"), bad signature, expired, not-yet-valid beyond clock
 * skew, or a mismatched issuer/audience/missing scopes. */
export function verifyAgentToken(token: string, options: VerifyAgentTokenOptions): AgentTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const headerBuf = base64UrlDecode(headerB64);
  const payloadBuf = base64UrlDecode(payloadB64);
  const signature = base64UrlDecode(signatureB64);
  if (!headerBuf || !payloadBuf || !signature) return null;

  let header: { alg?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(headerBuf.toString("utf8")) as { alg?: unknown };
    payload = JSON.parse(payloadBuf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (header.alg !== "ES256") return null;

  let publicKey;
  try {
    publicKey = createPublicKey(options.publicKeyPem);
  } catch {
    return null;
  }

  let signatureValid: boolean;
  try {
    signatureValid = cryptoVerify("SHA256", Buffer.from(`${headerB64}.${payloadB64}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return null;
  }
  if (!signatureValid) return null;

  const nowS = options.nowS ?? Math.floor(Date.now() / 1000);
  const { iss, aud, sub, scopes, iat, exp } = payload;
  if (typeof exp !== "number" || exp <= nowS) return null;
  if (typeof iat !== "number" || iat > nowS + MAX_CLOCK_SKEW_S) return null;
  if (iss !== options.issuer) return null;
  if (aud !== options.audience) return null;
  if (typeof sub !== "string" || !sub) return null;
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")) return null;

  return { iss, aud, sub, scopes: scopes as string[], iat, exp };
}

export function hasScope(claims: AgentTokenClaims, scope: string): boolean {
  return claims.scopes.includes(scope);
}

// --- Combined authentication ------------------------------------------

export type Principal = { kind: "owner" } | { kind: "agent"; claims: AgentTokenClaims };

export interface AuthenticateOptions {
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  agentTokenPublicKeyPem?: string;
  agentTokenIssuer?: string;
  agentTokenAudience?: string;
}

/** Tries the local, synchronous agent-token check first (no network call),
 * then falls back to the owner-session RPC round trip -- either
 * credential kind satisfies ADR-03; server.ts's job is deciding what each
 * ROUTE requires beyond "authenticated at all" (e.g. brain:run:propose's
 * autonomy cap). Returns null (never throws) on any failure to
 * authenticate by either method. */
export async function authenticate(authorizationHeader: string | undefined | null, options: AuthenticateOptions): Promise<Principal | null> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) return null;

  if (options.agentTokenPublicKeyPem && options.agentTokenIssuer && options.agentTokenAudience) {
    const claims = verifyAgentToken(token, {
      publicKeyPem: options.agentTokenPublicKeyPem,
      issuer: options.agentTokenIssuer,
      audience: options.agentTokenAudience,
    });
    if (claims) return { kind: "agent", claims };
  }

  if (options.supabaseUrl && options.supabasePublishableKey) {
    const isOwner = await verifyOwnerSession(options.supabaseUrl, options.supabasePublishableKey, token);
    if (isOwner) return { kind: "owner" };
  }

  return null;
}
