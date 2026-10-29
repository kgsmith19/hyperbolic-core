import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { after, before, test } from "node:test";

import { hashPassword, verifyPassword } from "../src/auth.ts";
import { startPlatform } from "./support.ts";

let p: Awaited<ReturnType<typeof startPlatform>>;
before(async () => (p = await startPlatform()));
after(() => p.close());

test("the password grant issues a supabase-js shaped session for the owner, and refuses a wrong password or email", async () => {
  const session = await p.login();
  assert.equal(session.token_type, "bearer");
  assert.equal(session.user.id, p.config.ownerId);
  assert.equal(session.user.email, "owner@example.test");
  assert.ok(session.expires_at > Date.now() / 1000);
  for (const body of [{ email: "owner@example.test", password: "nope" }, { email: "other@example.test", password: "correct horse battery staple" }, {}]) {
    const res = await p.call("POST", "/auth/v1/token?grant_type=password", { body });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_grant");
  }
  assert.equal((await p.call("POST", "/auth/v1/token?grant_type=pkce", { body: {} })).body.error, "unsupported_grant_type");
});

test("a refresh token works once, then is refused; logout revokes every outstanding one", async () => {
  const first = await p.login();
  const refreshed = await p.call("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: first.refresh_token } });
  assert.equal(refreshed.status, 200);
  const replay = await p.call("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: first.refresh_token } });
  assert.equal(replay.status, 400, "a used refresh token is single-use");
  assert.equal((await p.call("POST", "/auth/v1/logout", { token: refreshed.body.access_token })).status, 204);
  const afterLogout = await p.call("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: refreshed.body.refresh_token } });
  assert.equal(afterLogout.status, 400);
});

test("/user answers only for a valid owner token", async () => {
  assert.equal((await p.call("GET", "/auth/v1/user", { token: p.owner })).body.id, p.config.ownerId);
  for (const token of [undefined, p.anon, p.service, `${p.owner}x`, "a.b.c"]) {
    assert.equal((await p.call("GET", "/auth/v1/user", { token })).status, 401);
  }
});

test("owner tokens verify against the published JWKS with ES256, the way LifeOS checks them", async () => {
  const jwks = (await p.call("GET", "/auth/v1/.well-known/jwks.json")).body;
  const [jwk] = jwks.keys;
  assert.equal(jwk.alg, "ES256");
  assert.equal(jwk.d, undefined, "the private key is never published");
  const [header, payload, signature] = p.owner.split(".");
  const ok = verify("sha256", Buffer.from(`${header}.${payload}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"));
  assert.ok(ok);
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
  assert.equal(claims.iss, `${p.config.publicUrl}/auth/v1`);
  assert.equal(claims.aud, "authenticated");
  assert.equal(JSON.parse(Buffer.from(header!, "base64url").toString()).kid, jwk.kid);
});

test("an expired or foreign-issuer token is not a principal", () => {
  assert.equal(p.auth.principal(p.auth.token("authenticated", p.config.ownerId, -5)), null, "expired");
  assert.ok(p.auth.principal(p.auth.token("authenticated", p.config.ownerId, 60))?.isOwner);
  assert.equal(p.auth.principal(p.auth.token("authenticated", "00000000-0000-4000-8000-000000000000", 60))?.isOwner, false, "another subject is not the owner");
});

test("scrypt hashes verify only the right password and reject malformed records", () => {
  const stored = hashPassword("pw-1");
  assert.ok(verifyPassword("pw-1", stored));
  assert.ok(!verifyPassword("pw-2", stored));
  for (const bad of ["", "plain", "scrypt$1$AAAA$BBBB", stored.replace(/\$[^$]+$/, "$AAAA")]) assert.ok(!verifyPassword("pw-1", bad));
});
