import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJwtSubject, resolveOwnerAccessToken, verifyOwnerAccessToken } from "./owner-session.mjs";

const options = {
  supabaseUrl: "https://project.supabase.co",
  anonKey: "anon-key",
};

test("uses a supplied short-lived owner access token without a network request", async () => {
  const token = await resolveOwnerAccessToken({
    ...options,
    accessToken: " owner-access ",
    fetchImpl: () => assert.fail("must not fetch"),
  });
  assert.equal(token, "owner-access");
});

test("exchanges the managed owner refresh token without putting it in the URL", async () => {
  let request;
  const token = await resolveOwnerAccessToken({
    ...options,
    refreshToken: "owner-refresh",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => ({ access_token: "fresh-access" }) };
    },
  });

  assert.equal(token, "fresh-access");
  assert.equal(request.url, "https://project.supabase.co/auth/v1/token?grant_type=refresh_token");
  assert.equal(request.init.headers.apikey, "anon-key");
  assert.deepEqual(JSON.parse(request.init.body), { refresh_token: "owner-refresh" });
  assert.ok(!request.url.includes("owner-refresh"));
});

test("fails closed when no owner credential is configured", async () => {
  await assert.rejects(() => resolveOwnerAccessToken(options), /TOOLBELT_OWNER_REFRESH_TOKEN is required/);
});

test("reports only the response status when the exchange fails", async () => {
  await assert.rejects(
    () =>
      resolveOwnerAccessToken({
        ...options,
        refreshToken: "do-not-echo-me",
        fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: "secret detail" }) }),
      }),
    (error) => error.message === "owner refresh-token exchange failed: 401",
  );
});

function unsignedJwt(subject) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: subject })).toString("base64url"),
    "signature",
  ].join(".");
}

test("extracts the JWT subject for owner matching", () => {
  assert.equal(parseJwtSubject(unsignedJwt("owner-uuid")), "owner-uuid");
  assert.throws(() => parseJwtSubject("not-a-jwt"), /not a JWT/);
});

test("preflights the credential subject against platform.owner", async () => {
  const token = unsignedJwt("owner-uuid");
  const subject = await verifyOwnerAccessToken({
    ...options,
    token,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://project.supabase.co/rest/v1/rpc/platform_owner_subject");
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      return { ok: true, status: 200, json: async () => "owner-uuid" };
    },
  });
  assert.equal(subject, "owner-uuid");
});

test("rejects a valid credential for a different platform user", async () => {
  await assert.rejects(
    () =>
      verifyOwnerAccessToken({
        ...options,
        token: unsignedJwt("fixture-uuid"),
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => "owner-uuid" }),
      }),
    /does not match platform\.owner/,
  );
});
