// ES256 JWTs with node:crypto only (#508). ES256, not HS256, because LifeOS
// verifies owner tokens against this service's public JWKS, exactly as it
// verified Supabase's.

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export interface Claims {
  sub: string;
  role: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  email?: string;
  scope?: string;
  session_id?: string;
  [key: string]: unknown;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export class Signer {
  readonly #privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly kid: string;

  constructor(privateKeyPem: string) {
    this.#privateKey = createPrivateKey(privateKeyPem);
    const details = this.#privateKey.asymmetricKeyDetails;
    if (this.#privateKey.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1") {
      throw new Error("PLATFORM_JWT_PRIVATE_KEY must be a P-256 (ES256) private key");
    }
    this.publicKey = createPublicKey(this.#privateKey);
    const jwk = this.publicKey.export({ format: "jwk" });
    this.kid = createHash("sha256").update(`${jwk.x}.${jwk.y}`).digest("base64url").slice(0, 16);
  }

  jwks(): { keys: object[] } {
    return { keys: [{ ...this.publicKey.export({ format: "jwk" }), kid: this.kid, alg: "ES256", use: "sig" }] };
  }

  sign(claims: Claims): string {
    const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: this.kid }));
    const payload = b64url(JSON.stringify(claims));
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: this.#privateKey, dsaEncoding: "ieee-p1363" });
    return `${header}.${payload}.${b64url(signature)}`;
  }

  /** Verified claims, or null for anything malformed, forged, expired or from another issuer. */
  verify(token: string, issuer: string, now = Math.floor(Date.now() / 1000)): Claims | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts as [string, string, string];
    try {
      const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: string };
      if (parsedHeader.alg !== "ES256") return null;
      const ok = verify("sha256", Buffer.from(`${header}.${payload}`), { key: this.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
      if (!ok) return null;
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
      if (typeof claims.sub !== "string" || typeof claims.role !== "string") return null;
      if (claims.iss !== issuer || typeof claims.exp !== "number" || claims.exp <= now) return null;
      return claims;
    } catch {
      return null;
    }
  }
}
