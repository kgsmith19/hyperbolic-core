import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractBearerToken,
  verifyOwnerSession,
  verifyAgentToken,
  authenticate,
  hasScope,
  BRAIN_RUN_PROPOSE_SCOPE,
  type AgentTokenClaims,
} from "../src/auth.ts";
import { base64Url, generateEcKeyPair, signJwt } from "./support.ts";

const ISSUER = "lifeos";
const AUDIENCE = "brain";

function fixtureClaims(overrides: Partial<Record<string, unknown>> = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "agent:lifeos",
    scopes: [BRAIN_RUN_PROPOSE_SCOPE],
    iat: nowS,
    exp: nowS + 3600,
    ...overrides,
  };
}

// --- extractBearerToken ------------------------------------------------

test("extractBearerToken: extracts the token from a well-formed header", () => {
  assert.equal(extractBearerToken("Bearer abc123"), "abc123");
});

test("extractBearerToken: null for missing, empty, or malformed headers", () => {
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(null), null);
  assert.equal(extractBearerToken(""), null);
  assert.equal(extractBearerToken("Basic abc123"), null);
  assert.equal(extractBearerToken("Bearer"), null);
  assert.equal(extractBearerToken("Bearer a b"), null);
});

// --- verifyOwnerSession (mocked fetch) ------------------------------------

test("verifyOwnerSession: true only when the RPC returns the literal boolean true", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify(true), { status: 200 })) as typeof fetch;
    assert.equal(await verifyOwnerSession("https://x.supabase.co", "anon-key", "tok"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyOwnerSession: false on a non-2xx response, fails closed", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify(true), { status: 401 })) as typeof fetch;
    assert.equal(await verifyOwnerSession("https://x.supabase.co", "anon-key", "tok"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyOwnerSession: false when the RPC body isn't exactly `true`", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify(false), { status: 200 })) as typeof fetch;
    assert.equal(await verifyOwnerSession("https://x.supabase.co", "anon-key", "tok"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyOwnerSession: false on a network error, fails closed rather than throwing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    assert.equal(await verifyOwnerSession("https://x.supabase.co", "anon-key", "tok"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- verifyAgentToken (real ES256 sign/verify) ------------------------

test("verifyAgentToken: a validly signed token verifies and returns its claims", () => {
  const { publicKeyPem, privateKey } = generateEcKeyPair();
  const claims = fixtureClaims();
  const token = signJwt(privateKey, { alg: "ES256", typ: "JWT" }, claims);

  const verified = verifyAgentToken(token, { publicKeyPem, issuer: ISSUER, audience: AUDIENCE });
  assert.deepEqual(verified, claims);
});

test("verifyAgentToken: rejects a tampered payload (signature no longer matches)", () => {
  const { publicKeyPem, privateKey } = generateEcKeyPair();
  const token = signJwt(privateKey, { alg: "ES256", typ: "JWT" }, fixtureClaims());
  const [headerB64, , sigB64] = token.split(".");
  const tamperedPayload = base64Url(Buffer.from(JSON.stringify(fixtureClaims({ scopes: ["everything:write"] }))));
  const tampered = `${headerB64}.${tamperedPayload}.${sigB64}`;

  assert.equal(verifyAgentToken(tampered, { publicKeyPem, issuer: ISSUER, audience: AUDIENCE }), null);
});

test("verifyAgentToken: rejects a signature from the WRONG key", () => {
  const a = generateEcKeyPair();
  const b = generateEcKeyPair();
  const token = signJwt(a.privateKey, { alg: "ES256", typ: "JWT" }, fixtureClaims());
  assert.equal(verifyAgentToken(token, { publicKeyPem: b.publicKeyPem, issuer: ISSUER, audience: AUDIENCE }), null);
});

test("verifyAgentToken: rejects any algorithm other than ES256 (algorithm confusion defense)", () => {
  const { publicKeyPem, privateKey } = generateEcKeyPair();
  const token = signJwt(privateKey, { alg: "none", typ: "JWT" }, fixtureClaims());
  assert.equal(verifyAgentToken(token, { publicKeyPem, issuer: ISSUER, audience: AUDIENCE }), null);
});

test("verifyAgentToken: rejects an expired token", () => {
  const { publicKeyPem, privateKey } = generateEcKeyPair();
  const nowS = Math.floor(Date.now() / 1000);
  const token = signJwt(privateKey, { alg: "ES256", typ: "JWT" }, fixtureClaims({ iat: nowS - 7200, exp: nowS - 3600 }));
  assert.equal(verifyAgentToken(token, { publicKeyPem, issuer: ISSUER, audience: AUDIENCE }), null);
});

test("verifyAgentToken: rejects a token issued too far in the future (beyond clock-skew allowance)", () => {
  const { publicKeyPem, privateKey } = generateEcKeyPair();
  const nowS = Math.floor(Date.now() / 1000);
  const token = signJwt(privateKey, { alg: "ES256", typ: "JWT" }, fixtureClaims({ iat: nowS + 3600, exp: nowS + 7200 }));
  assert.equal(verifyAgentToken(token, { publicKeyPem, issuer: ISSUER, audience: AUDIENCE }), null);
});

test("verifyAgentToken: rejects a mismatched issuer or audience", () => {
  const { publicKeyPem, privateKey } = generateEcKeyPair();
  const token = signJwt(privateKey, { alg: "ES256", typ: "JWT" }, fixtureClaims());
  assert.equal(verifyAgentToken(token, { publicKeyPem, issuer: "someone-else", audience: AUDIENCE }), null);
  assert.equal(verifyAgentToken(token, { publicKeyPem, issuer: ISSUER, audience: "someone-else" }), null);
});

test("verifyAgentToken: rejects structurally malformed tokens without throwing", () => {
  const { publicKeyPem } = generateEcKeyPair();
  const opts = { publicKeyPem, issuer: ISSUER, audience: AUDIENCE };
  assert.equal(verifyAgentToken("not-a-jwt", opts), null);
  assert.equal(verifyAgentToken("a.b", opts), null);
  assert.equal(verifyAgentToken("a.b.c.d", opts), null);
  assert.equal(verifyAgentToken("!!!.!!!.!!!", opts), null);
});

test("hasScope: checks membership in the claims' scopes array", () => {
  const claims: AgentTokenClaims = { iss: ISSUER, aud: AUDIENCE, sub: "agent:x", scopes: [BRAIN_RUN_PROPOSE_SCOPE], iat: 0, exp: 0 };
  assert.equal(hasScope(claims, BRAIN_RUN_PROPOSE_SCOPE), true);
  assert.equal(hasScope(claims, "something:else"), false);
});

// --- authenticate() (combined) ------------------------------------------

test("authenticate: null when no Authorization header is present", async () => {
  const result = await authenticate(undefined, {});
  assert.equal(result, null);
});

test("authenticate: a valid agent token yields an agent principal without any network call", async () => {
  const { publicKeyPem, privateKey } = generateEcKeyPair();
  const token = signJwt(privateKey, { alg: "ES256", typ: "JWT" }, fixtureClaims());
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  try {
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as typeof fetch;
    const result = await authenticate(`Bearer ${token}`, {
      agentTokenPublicKeyPem: publicKeyPem,
      agentTokenIssuer: ISSUER,
      agentTokenAudience: AUDIENCE,
    });
    assert.equal(result?.kind, "agent");
    assert.equal(fetchCalled, false, "a valid agent token must never hit the network");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticate: falls back to owner-session verification when agent-token options aren't configured", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify(true), { status: 200 })) as typeof fetch;
    const result = await authenticate("Bearer some-supabase-jwt", {
      supabaseUrl: "https://x.supabase.co",
      supabasePublishableKey: "anon-key",
    });
    assert.equal(result?.kind, "owner");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticate: null when neither credential kind is configured or valid", async () => {
  const result = await authenticate("Bearer garbage", {});
  assert.equal(result, null);
});
