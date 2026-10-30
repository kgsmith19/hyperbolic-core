// Single-owner auth (#508): the GoTrue subset supabase-js calls
// (password and refresh_token grants, /user, /logout), for exactly one local
// owner whose password is stored as a scrypt hash. Refresh tokens are random,
// stored only as sha256 digests, single-use and revocable.

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { PlatformConfig } from "./config.ts";
import type { Claims, Signer } from "./jwt.ts";

const SCRYPT_N = 16384;

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const salt = Buffer.from(parts[2] ?? "", "base64");
  const expected = Buffer.from(parts[3] ?? "", "base64");
  if (!Number.isInteger(n) || n < 1024 || salt.length < 8 || expected.length !== 32) return false;
  const actual = scryptSync(password, salt, 32, { N: n });
  return timingSafeEqual(actual, expected);
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface Session {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: ReturnType<Auth["user"]>;
}

export class Auth {
  readonly #db: DatabaseSync;
  readonly #config: PlatformConfig;
  readonly #signer: Signer;
  readonly issuer: string;

  constructor(db: DatabaseSync, config: PlatformConfig, signer: Signer) {
    this.#db = db;
    this.#config = config;
    this.#signer = signer;
    this.issuer = `${config.publicUrl}/auth/v1`;
    // The configured owner is the only user; re-seeding on every start keeps a
    // rotated password (a new hash in .env) authoritative.
    db.prepare(
      `insert into auth_user (id, email, password_hash) values (?, ?, ?)
       on conflict (id) do update set email = excluded.email, password_hash = excluded.password_hash`,
    ).run(config.ownerId, config.ownerEmail, config.ownerPasswordHash);
    db.prepare(
      `insert into platform_config (singleton, owner_uuid) values (1, ?)
       on conflict (singleton) do update set owner_uuid = excluded.owner_uuid`,
    ).run(config.ownerId);
  }

  user() {
    return {
      id: this.#config.ownerId,
      aud: "authenticated",
      role: "authenticated",
      email: this.#config.ownerEmail,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
    };
  }

  /** A signed token for any principal (used by `cli.ts` for anon/service keys). */
  token(role: string, sub: string, ttlSeconds: number, extra: Partial<Claims> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    return this.#signer.sign({ sub, role, iss: this.issuer, aud: "authenticated", iat: now, exp: now + ttlSeconds, ...extra });
  }

  #session(): Session {
    const now = Math.floor(Date.now() / 1000);
    const ttl = this.#config.accessTtlSeconds;
    const refresh = randomBytes(32).toString("base64url");
    this.#db.prepare("insert into auth_refresh_token (token_sha256, user_id) values (?, ?)").run(sha256(refresh), this.#config.ownerId);
    return {
      access_token: this.token("authenticated", this.#config.ownerId, ttl, { email: this.#config.ownerEmail, session_id: randomUUID() }),
      token_type: "bearer",
      expires_in: ttl,
      expires_at: now + ttl,
      refresh_token: refresh,
      user: this.user(),
    };
  }

  passwordGrant(email: unknown, password: unknown): Session | null {
    if (typeof email !== "string" || typeof password !== "string") return null;
    const row = this.#db.prepare("select password_hash from auth_user where email = ?").get(email.trim().toLowerCase()) as
      | { password_hash: string }
      | undefined;
    // Always run the hash so a wrong email and a wrong password cost the same.
    const ok = verifyPassword(password, row?.password_hash ?? this.#config.ownerPasswordHash);
    return row && ok ? this.#session() : null;
  }

  refreshGrant(refreshToken: unknown): Session | null {
    if (typeof refreshToken !== "string" || refreshToken.length < 16) return null;
    const used = this.#db
      .prepare(
        `update auth_refresh_token set revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         where token_sha256 = ? and revoked_at is null returning user_id`,
      )
      .get(sha256(refreshToken)) as { user_id: string } | undefined;
    return used ? this.#session() : null;
  }

  logout(): void {
    this.#db.prepare("update auth_refresh_token set revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where revoked_at is null").run();
  }

  /** The verified principal behind an Authorization bearer, or null. */
  principal(bearer: string | undefined): Principal | null {
    if (!bearer) return null;
    const claims = this.#signer.verify(bearer, this.issuer);
    if (!claims) return null;
    const isOwner = claims.role === "authenticated" && claims.sub === this.#config.ownerId;
    return { claims, isOwner, isService: claims.role === "service_role" };
  }
}

export interface Principal {
  claims: Claims;
  isOwner: boolean;
  isService: boolean;
}
