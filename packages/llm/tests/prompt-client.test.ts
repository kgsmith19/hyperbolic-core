// m4-04: request-shape and construction-contract tests for
// packages/llm/src/prompt-client.ts, complementing tests/cache.test.mjs's
// cache-mechanics focus. Same transport-spy idiom as packages/platform-
// client/tests/registry.test.ts (patch globalThis.fetch for the test's
// duration); no real network call happens in this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPromptClient, MissingVariablesError, PromptNotFoundError } from "../src/prompt-client.ts";

const FIXTURE_URL = "https://fixture-project.supabase.invalid";
const FIXTURE_TOKEN = "fixture.session.token";

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** Wraps a handler that only cares about the rpc/get_prompt call: every
 * other path (the best-effort supplementary raw-fetch calls a fresh miss
 * also issues to populate the cache -- see prompt-client.ts's own header
 * comment) is answered with an empty result, harmlessly skipping cache
 * population, so these request-shape tests can assert on the RPC call
 * alone without asserting a specific total call count. */
function onlyRpc(handler: FetchImpl): FetchImpl {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/rpc/get_prompt") return handler(input, init);
    return jsonResponse([]);
  };
}

test("getPrompt(name) with no opts sends p_version/p_config/p_values/p_sections all null, POST, apikey+Authorization+profile headers", async (t) => {
  const spy = t.mock.fn(
    onlyRpc(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, new URL(FIXTURE_URL).origin);
      assert.equal(init?.method, "POST");

      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${FIXTURE_TOKEN}`);
      assert.ok(headers.get("apikey"), "expected an apikey header to be present");
      assert.equal(headers.get("Accept-Profile"), "prompt");
      assert.equal(headers.get("Content-Profile"), "prompt");

      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { p_name: "lifeos/chat/system", p_version: null, p_config: null, p_values: null, p_sections: null });

      return jsonResponse({ text: "hi", version_no: 4, rendered_at: "2026-08-13T00:00:00Z" });
    }),
  );

  const result = await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.getPrompt("lifeos/chat/system");
  });

  const rpcCalls = spy.mock.calls.filter((c) => new URL(String(c.arguments[0])).pathname === "/rest/v1/rpc/get_prompt");
  assert.equal(rpcCalls.length, 1);
  assert.deepEqual(result, { text: "hi", version: 4, renderedAt: "2026-08-13T00:00:00Z" });
});

test("getPrompt(name, {version, variables, sections, config}) passes every field through under its RPC parameter name", async (t) => {
  const spy = t.mock.fn(
    onlyRpc(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        p_name: "brain/task-contract",
        p_version: 3,
        p_config: "lean",
        p_values: { TASK_ID: "T-1" },
        p_sections: ["extra"],
      });
      return jsonResponse({ text: "rendered", version_no: 3, rendered_at: "2026-08-13T00:00:00Z" });
    }),
  );

  await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.getPrompt("brain/task-contract", { version: 3, config: "lean", variables: { TASK_ID: "T-1" }, sections: ["extra"] });
  });

  const rpcCalls = spy.mock.calls.filter((c) => new URL(String(c.arguments[0])).pathname === "/rest/v1/rpc/get_prompt");
  assert.equal(rpcCalls.length, 1);
});

test("a call naming a saved `config` always goes to the network, even when the name@version is already cached", async (t) => {
  let rpcCalls = 0;
  const spy = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/rpc/get_prompt") {
      rpcCalls += 1;
      return jsonResponse({ text: "x", version_no: 1, rendered_at: "2026-08-13T00:00:00Z" });
    }
    return jsonResponse([]); // the best-effort supplementary raw-fetch calls; empty is fine, caching is skipped
  });

  await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await client.getPrompt("coding/system/kernel-run", { version: 1 });
    assert.equal(rpcCalls, 1);
    await client.getPrompt("coding/system/kernel-run", { version: 1, config: "lean" });
    assert.equal(rpcCalls, 2, "a config-bearing call must bypass the cache and hit the RPC again");
  });
});

test("options.anonKey overrides the default apikey header", async (t) => {
  const spy = t.mock.fn(
    onlyRpc(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), "custom-anon-key");
      return jsonResponse({ text: "x", version_no: 1, rendered_at: "2026-08-13T00:00:00Z" });
    }),
  );

  await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN, { anonKey: "custom-anon-key" });
    await client.getPrompt("brain/task-contract", { version: 1 });
  });

  const rpcCalls = spy.mock.calls.filter((c) => new URL(String(c.arguments[0])).pathname === "/rest/v1/rpc/get_prompt");
  assert.equal(rpcCalls.length, 1);
});

test("a trailing slash on supabaseUrl is normalized (no double slash in the request path)", async (t) => {
  const spy = t.mock.fn(
    onlyRpc(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/rest/v1/rpc/get_prompt");
      return jsonResponse({ text: "x", version_no: 1, rendered_at: "2026-08-13T00:00:00Z" });
    }),
  );

  await withPatchedFetch(spy, async () => {
    const client = createPromptClient(`${FIXTURE_URL}/`, async () => FIXTURE_TOKEN);
    await client.getPrompt("brain/task-contract", { version: 1 });
  });
});

test("a non-404/422 non-ok RPC response rejects with a descriptive error naming the status", async (t) => {
  const spy = t.mock.fn(onlyRpc(async () => jsonResponse({ message: "internal error" }, 500)));

  await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await assert.rejects(() => client.getPrompt("brain/task-contract", { version: 1 }), /500/);
  });
});

test("PromptNotFoundError and MissingVariablesError are real Error instances with a distinct name", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse({ code: "PT404", message: "prompt not found" }, 404));

  await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    try {
      await client.getPrompt("does/not-exist");
      assert.fail("expected getPrompt to reject");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err instanceof PromptNotFoundError);
      assert.equal((err as Error).name, "PromptNotFoundError");
    }
  });
});

test("MissingVariablesError.missing is populated straight from the RPC's PT422 message", async (t) => {
  const spy = t.mock.fn(async () => jsonResponse({ code: "PT422", message: "missing variables: A, B" }, 422));

  await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    try {
      await client.getPrompt("gp/needs-var", { version: 1 });
      assert.fail("expected getPrompt to reject");
    } catch (err) {
      assert.ok(err instanceof MissingVariablesError);
      assert.deepEqual((err as MissingVariablesError).missing, ["A", "B"]);
    }
  });
});
