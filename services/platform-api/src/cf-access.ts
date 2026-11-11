// Cloudflare Access single sign-on (#562). Behind core.kylegsmith.com every
// request has already passed Cloudflare Access, which forwards a signed
// identity in `Cf-Access-Jwt-Assertion` (RS256, keys at
// https://<team domain>/cdn-cgi/access/certs). The `cloudflare_access` grant
// verifies that token here -- signature, issuer, audience (the Access app's
// AUD tag), expiry -- and only then trusts its email. It is off unless both
// PLATFORM_CF_ACCESS_TEAM_DOMAIN and PLATFORM_CF_ACCESS_AUD are set, so the
// local stack keeps password-only sign-in.
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export interface AccessIdentity {
  email: string;
}

export interface AccessVerifierOptions {
  teamDomain: string;
  audience: string;
  /** Injected in tests; defaults to fetching the team's certs endpoint. */
  fetchKeys?: () => Promise<JsonWebKey[]>;
  now?: () => number;
}

const b64urlJson = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

export class AccessVerifier {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #fetchKeys: () => Promise<JsonWebKey[]>;
  readonly #now: () => number;
  #keys = new Map<string, KeyObject>();
  #fetchedAt = 0;

  constructor(options: AccessVerifierOptions) {
    const domain = options.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.#issuer = `https://${domain}`;
    this.#audience = options.audience;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#fetchKeys =
      options.fetchKeys ??
      (async () => {
        const res = await fetch(`${this.#issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
        return ((await res.json()) as { keys: JsonWebKey[] }).keys;
      });
  }

  async #key(kid: string): Promise<KeyObject | undefined> {
    // Refresh on an unknown kid (Cloudflare rotates keys), at most once a minute.
    if (!this.#keys.has(kid) && this.#now() - this.#fetchedAt > 60) {
      const keys = await this.#fetchKeys();
      this.#keys = new Map(keys.filter((k) => typeof k.kid === "string").map((k) => [k.kid as string, createPublicKey({ key: k, format: "jwk" })]));
      this.#fetchedAt = this.#now();
    }
    return this.#keys.get(kid);
  }

  /** The verified identity, or null for anything missing, malformed, forged, expired or for another app. */
  async verify(token: unknown): Promise<AccessIdentity | null> {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const header = b64urlJson(parts[0]!);
      if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
      const key = await this.#key(header.kid);
      if (!key) return null;
      const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
      if (!verify("RSA-SHA256", signed, key, Buffer.from(parts[2]!, "base64url"))) return null;
      const claims = b64urlJson(parts[1]!);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const now = this.#now();
      if (claims.iss !== this.#issuer || !aud.includes(this.#audience)) return null;
      if (typeof claims.exp !== "number" || claims.exp <= now) return null;
      if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
      if (typeof claims.email !== "string" || !claims.email) return null;
      return { email: claims.email.trim().toLowerCase() };
    } catch {
      return null;
    }
  }
}
