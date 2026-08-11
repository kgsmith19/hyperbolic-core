import assert from "node:assert/strict";
import test from "node:test";
import { login, USER_A } from "./helpers.mjs";

test("login uses a supplied CI session without another Auth request", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.PROMPT_TEST_TOKEN_A;
  process.env.PROMPT_TEST_TOKEN_A = "fixture-access-token";
  globalThis.fetch = async () => {
    throw new Error("Auth must not be called when a session is supplied");
  };

  try {
    assert.equal(await login(USER_A), "fixture-access-token");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.PROMPT_TEST_TOKEN_A;
    else process.env.PROMPT_TEST_TOKEN_A = originalToken;
  }
});

test("login deduplicates concurrent Auth requests and retries a 429", async () => {
  const originalFetch = globalThis.fetch;
  const user = { email: `rate-limit-${process.pid}@example.test`, password: "unused" };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
    }
    return Response.json({ access_token: "deduplicated-token" });
  };

  try {
    assert.deepEqual(await Promise.all([login(user), login(user)]), ["deduplicated-token", "deduplicated-token"]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
