// Cloudflare Access SSO (#562): the cloudflare_access grant trusts only a
// correctly signed, unexpired Access token for this app and the owner's email.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { after, before, test } from "node:test";

import { AccessVerifier } from "../src/cf-access.ts";
import { startPlatform } from "./support.ts";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-of-the-core-app";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "k1", alg: "RS256" };

function token(claims: Record<string, unknown>, key = privateKey, kid = "k1"): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc({ iss: `https://${TEAM}`, aud: [AUD], exp: now + 300, iat: now, ...claims })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
}

let p: Awaited<ReturnType<typeof startPlatform>>;
before(async () => {
  p = await startPlatform({ access: new AccessVerifier({ teamDomain: TEAM, audience: AUD, fetchKeys: async () => [jwk] }) });
});
after(() => p.close());

const grant = (assertion?: string) =>
  p.call("POST", "/auth/v1/token?grant_type=cloudflare_access", {
    body: {},
    headers: assertion ? { "cf-access-jwt-assertion": assertion } : {},
  });

test("the owner's Access identity signs in without a password", async () => {
  const res = await grant(token({ email: "Owner@Example.test" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, p.config.ownerId);
  assert.equal((await p.call("GET", "/auth/v1/user", { token: res.body.access_token })).status, 200);
});

test("anyone else, and anything not genuinely from Access for this app, is refused", async () => {
  const cases = {
    "another email": token({ email: "someone@else.test" }),
    "another app's audience": token({ email: "owner@example.test", aud: ["other-app"] }),
    "another issuer": token({ email: "owner@example.test", iss: "https://evil.cloudflareaccess.com" }),
    "expired": token({ email: "owner@example.test", exp: Math.floor(Date.now() / 1000) - 5 }),
    "forged signature": token({ email: "owner@example.test" }, otherKey),
    "unknown key id": token({ email: "owner@example.test" }, privateKey, "k2"),
    "garbage": "not.a.jwt",
  };
  for (const [name, assertion] of Object.entries(cases)) {
    const res = await grant(assertion);
    assert.equal(res.status, 400, name);
    assert.equal(res.body.error, "invalid_grant", name);
  }
  assert.equal((await grant()).body.error, "invalid_grant", "no header");
});

test("the grant does not exist unless Access is configured", async () => {
  const plain = await startPlatform();
  try {
    const res = await plain.call("POST", "/auth/v1/token?grant_type=cloudflare_access", {
      body: {},
      headers: { "cf-access-jwt-assertion": token({ email: "owner@example.test" }) },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "unsupported_grant_type");
  } finally {
    await plain.close();
  }
});
