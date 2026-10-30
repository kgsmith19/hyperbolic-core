// `node src/cli.ts init [--env <path>] [--email <owner email>]` (#508): writes
// a local .env for the platform service and prints the anon and service keys
// clients need. Refuses to overwrite an existing file. Never commit the output.

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hashPassword } from "./auth.ts";
import { Signer } from "./jwt.ts";

const TEN_YEARS = 10 * 365 * 24 * 3600;

export function initEnv(options: { email: string; password?: string; publicUrl?: string }) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signer = new Signer(pem);
  const publicUrl = options.publicUrl ?? "http://127.0.0.1:8400";
  const issuer = `${publicUrl}/auth/v1`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const key = (role: string, sub: string) => signer.sign({ sub, role, iss: issuer, aud: "authenticated", iat: nowSeconds, exp: nowSeconds + TEN_YEARS });
  const ownerId = randomUUID();
  const password = options.password ?? randomBytes(18).toString("base64url");
  const env = {
    PLATFORM_PUBLIC_URL: publicUrl,
    PLATFORM_OWNER_ID: ownerId,
    PLATFORM_OWNER_EMAIL: options.email,
    PLATFORM_OWNER_PASSWORD_HASH: hashPassword(password),
    PLATFORM_JWT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    PLATFORM_ANON_KEY: key("anon", "anon"),
    PLATFORM_SERVICE_KEY: key("service_role", "service_role"),
  };
  return { env, password };
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command !== "init") {
    console.error("usage: node src/cli.ts init [--env <path>] [--email <owner email>] [--public-url <url>]");
    process.exit(2);
  }
  const target = path.resolve(flag("--env") ?? ".env");
  if (existsSync(target)) {
    console.error(`${target} exists; refusing to overwrite it (move it aside to rotate keys)`);
    process.exit(1);
  }
  const { env, password } = initEnv({ email: flag("--email") ?? "owner@localhost", publicUrl: flag("--public-url") });
  writeFileSync(target, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
  console.log(`wrote ${target}`);
  console.log(`owner: ${env.PLATFORM_OWNER_EMAIL}  password: ${password}  (shown once; only its scrypt hash is stored)`);
}
