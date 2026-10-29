// Starts a real platform-api on an ephemeral port against a scratch database.

import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { migrate, openDatabase } from "@hyperbolic/sqlite-kit";

import { Auth } from "../src/auth.ts";
import { initEnv } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { Signer } from "../src/jwt.ts";
import { createPlatformServer } from "../src/server.ts";

export const PASSWORD = "correct horse battery staple";

export async function startPlatform() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "platform-api-"));
  const { env } = initEnv({ email: "owner@example.test", password: PASSWORD, publicUrl: "http://127.0.0.1:0" });
  const config = loadConfig({ ...env, PLATFORM_DB_PATH: path.join(dir, "platform.db"), PLATFORM_ACCESS_TTL_SECONDS: "60" });
  const db = openDatabase(config.dbPath);
  db.exec("pragma case_sensitive_like = on;");
  migrate(db, config.migrationsDir);
  const signer = new Signer(config.privateKeyPem);
  const auth = new Auth(db, config, signer);
  const server = createPlatformServer(db, config, auth, signer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, route: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${route}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
  };
  const login = async () => (await call("POST", "/auth/v1/token?grant_type=password", { body: { email: "owner@example.test", password: PASSWORD } })).body;
  const owner = (await login()).access_token as string;
  const rest = (method: string, route: string, profile: string, token: string | undefined, body?: unknown, prefer = "return=representation") =>
    call(method, `/rest/v1${route}`, { token, body, headers: { "accept-profile": profile, "content-profile": profile, prefer } });

  return {
    base, db, config, auth, env, call, login, owner, rest,
    service: env.PLATFORM_SERVICE_KEY,
    anon: env.PLATFORM_ANON_KEY,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
