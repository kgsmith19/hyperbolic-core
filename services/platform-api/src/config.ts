// Runtime configuration for the local platform service (#508). Everything
// comes from the environment (a gitignored .env written by `cli.ts init`);
// nothing secret has a default.

import path from "node:path";

export interface PlatformConfig {
  /** SQLite database file. */
  dbPath: string;
  /** Directory holding db/migrations. */
  migrationsDir: string;
  port: number;
  host: string;
  /** The URL clients use for this service; the JWT issuer is `${publicUrl}/auth/v1`. */
  publicUrl: string;
  /** PKCS#8 PEM of the ES256 signing key (the env holds base64 DER: no spaces, so .env files stay simple). */
  privateKeyPem: string;
  ownerId: string;
  ownerEmail: string;
  /** scrypt$<N>$<salt b64>$<hash b64> */
  ownerPasswordHash: string;
  accessTtlSeconds: number;
  /** Browser origins allowed to call this service (local frontends). */
  allowedOrigins: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** PLATFORM_JWT_PRIVATE_KEY is base64 PKCS#8 DER; a PEM is accepted too. */
export function privateKeyPem(value: string): string {
  if (value.startsWith("-----BEGIN")) return value.replaceAll("\\n", "\n");
  const der = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(der)) throw new Error("PLATFORM_JWT_PRIVATE_KEY must be base64 PKCS#8 DER");
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is unset. Run \`node src/cli.ts init\` to write a local .env.`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, serviceDir = path.resolve(import.meta.dirname, "..")): PlatformConfig {
  const port = Number(env.PLATFORM_PORT ?? "8400");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PLATFORM_PORT is not a port: ${env.PLATFORM_PORT}`);
  const host = env.PLATFORM_HOST ?? "127.0.0.1";
  const ownerId = required(env, "PLATFORM_OWNER_ID");
  if (!UUID.test(ownerId)) throw new Error("PLATFORM_OWNER_ID must be a lowercase UUID");
  const pem = privateKeyPem(required(env, "PLATFORM_JWT_PRIVATE_KEY"));
  return {
    dbPath: path.resolve(env.PLATFORM_DB_PATH ?? path.join(serviceDir, "../../var/platform/platform.db")),
    migrationsDir: path.join(serviceDir, "db/migrations"),
    port,
    host,
    publicUrl: (env.PLATFORM_PUBLIC_URL ?? `http://${host}:${port}`).replace(/\/+$/, ""),
    privateKeyPem: pem,
    ownerId,
    ownerEmail: required(env, "PLATFORM_OWNER_EMAIL").toLowerCase(),
    ownerPasswordHash: required(env, "PLATFORM_OWNER_PASSWORD_HASH"),
    accessTtlSeconds: Number(env.PLATFORM_ACCESS_TTL_SECONDS ?? "3600"),
    allowedOrigins: (env.PLATFORM_ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
