import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBearerToken, verifyOwnerSession } from "../src/auth.ts";

type FetchImpl = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("extractBearerToken: absent header resolves null", () => {
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(null), null);
  assert.equal(extractBearerToken(""), null);
});

test("extractBearerToken: malformed shapes resolve null", () => {
  assert.equal(extractBearerToken("Bearer"), null);
  assert.equal(extractBearerToken("Bearer "), null);
  assert.equal(extractBearerToken("Basic dXNlcjpwYXNz"), null);
  assert.equal(extractBearerToken("bearer lowercase-scheme"), null);
  assert.equal(extractBearerToken("Bearer two tokens"), null);
});

test("extractBearerToken: well-formed header extracts the token", () => {
  assert.equal(extractBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
});

test("verifyOwnerSession: RPC returns literal true resolves true", async () => {
  await withPatchedFetch(
    async (input, init) => {
      assert.equal(String(input), "https://proj.supabase.co/rest/v1/rpc/is_platform_owner");
      assert.equal(init?.method, "POST");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.apikey, "anon-key");
      assert.equal(headers.Authorization, "Bearer real-token");
      assert.equal(headers["Content-Profile"], "core");
      return new Response("true", { status: 200, headers: { "content-type": "application/json" } });
    },
    async () => {
      const result = await verifyOwnerSession("https://proj.supabase.co", "anon-key", "real-token");
      assert.equal(result, true);
    }
  );
});

test("verifyOwnerSession: RPC returns literal false resolves false", async () => {
  await withPatchedFetch(
    async () => new Response("false", { status: 200 }),
    async () => {
      const result = await verifyOwnerSession("https://proj.supabase.co", "anon-key", "non-owner-token");
      assert.equal(result, false);
    }
  );
});

test("verifyOwnerSession: non-2xx response fails closed to false", async () => {
  await withPatchedFetch(
    async () => new Response("expired", { status: 401 }),
    async () => {
      const result = await verifyOwnerSession("https://proj.supabase.co", "anon-key", "expired-token");
      assert.equal(result, false);
    }
  );
});

test("verifyOwnerSession: a network error fails closed to false, never throws", async () => {
  await withPatchedFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      const result = await verifyOwnerSession("https://proj.supabase.co", "anon-key", "any-token");
      assert.equal(result, false);
    }
  );
});

test("verifyOwnerSession: a truthy-but-not-literal-true body fails closed to false", async () => {
  await withPatchedFetch(
    async () => new Response('"true"', { status: 200 }),
    async () => {
      const result = await verifyOwnerSession("https://proj.supabase.co", "anon-key", "any-token");
      assert.equal(result, false, "the string \"true\" must not be treated the same as the JSON boolean true");
    }
  );
});

test("verifyOwnerSession: strips trailing slashes from the Supabase URL before building the RPC path", async () => {
  await withPatchedFetch(
    async (input) => {
      assert.equal(String(input), "https://proj.supabase.co/rest/v1/rpc/is_platform_owner");
      return new Response("true", { status: 200 });
    },
    async () => {
      const result = await verifyOwnerSession("https://proj.supabase.co///", "anon-key", "real-token");
      assert.equal(result, true);
    }
  );
});
