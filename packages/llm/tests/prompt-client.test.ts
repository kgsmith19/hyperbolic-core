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

/** Wraps a handler that only cares about prompt RPCs. Any table path gets an
 * empty response so the request-shape tests fail at their own assertions if
 * the client ever regresses to schema-aware reads. */
function onlyRpc(handler: FetchImpl): FetchImpl {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/rest/v1/rpc/")) return handler(input, init);
    return jsonResponse([]);
  };
}

test("getPrompt(name) with no config uses the cache-source RPC with conditional fields null and the required headers", async (t) => {
  const spy = t.mock.fn(
    onlyRpc(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, new URL(FIXTURE_URL).origin);
      assert.equal(url.pathname, "/rest/v1/rpc/get_prompt_source");
      assert.equal(init?.method, "POST");

      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${FIXTURE_TOKEN}`);
      assert.ok(headers.get("apikey"), "expected an apikey header to be present");
      assert.equal(headers.get("Accept-Profile"), "prompt");
      assert.equal(headers.get("Content-Profile"), "prompt");

      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { p_name: "lifeos/chat/system", p_version: null, p_if_version: null });

      return jsonResponse({ body: "hi", version_no: 4, not_modified: false });
    }),
  );

  const result = await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.getPrompt("lifeos/chat/system");
  });

  const rpcCalls = spy.mock.calls.filter((c) => new URL(String(c.arguments[0])).pathname === "/rest/v1/rpc/get_prompt_source");
  assert.equal(rpcCalls.length, 1);
  assert.equal(result.text, "hi");
  assert.equal(result.version, 4);
  assert.ok(Number.isFinite(Date.parse(result.renderedAt)));
});

test("getPrompt(name, {version, variables, sections, config}) passes every field through under its RPC parameter name", async (t) => {
  const spy = t.mock.fn(
    onlyRpc(async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new URL(String(_input)).pathname, "/rest/v1/rpc/get_prompt");
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
  let sourceCalls = 0;
  let renderRpcCalls = 0;
  const spy = t.mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/rpc/get_prompt") {
      renderRpcCalls += 1;
      return jsonResponse({ text: "x", version_no: 1, rendered_at: "2026-08-13T00:00:00Z" });
    }
    if (url.pathname === "/rest/v1/rpc/get_prompt_source") {
      sourceCalls += 1;
      return jsonResponse({ body: "x", version_no: 1, not_modified: false });
    }
    return jsonResponse([]);
  });

  await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await client.getPrompt("coding/system/kernel-run", { version: 1 });
    assert.equal(sourceCalls, 1);
    assert.equal(renderRpcCalls, 0);
    await client.getPrompt("coding/system/kernel-run", { version: 1, config: "lean" });
    assert.equal(renderRpcCalls, 1, "a config-bearing call must bypass the cache and hit get_prompt");
  });
});

test("options.anonKey overrides the default apikey header", async (t) => {
  const spy = t.mock.fn(
    onlyRpc(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), "custom-anon-key");
      return jsonResponse({ body: "x", version_no: 1, not_modified: false });
    }),
  );

  await withPatchedFetch(spy, async () => {
    const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN, { anonKey: "custom-anon-key" });
    await client.getPrompt("brain/task-contract", { version: 1 });
  });

  const rpcCalls = spy.mock.calls.filter((c) => new URL(String(c.arguments[0])).pathname === "/rest/v1/rpc/get_prompt_source");
  assert.equal(rpcCalls.length, 1);
});

test("maxPinnedEntries rejects non-positive and non-integer capacities at construction", () => {
  for (const maxPinnedEntries of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN, { maxPinnedEntries }),
      RangeError,
      String(maxPinnedEntries),
    );
  }
});

test("latestTtlMs rejects non-positive and non-integer TTLs at construction", () => {
  for (const latestTtlMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN, { latestTtlMs }),
      RangeError,
      String(latestTtlMs),
    );
  }
});

test("expired latest entries send their cached version as p_if_version and accept a no-body not-modified response", async () => {
  const requestBodies: unknown[] = [];
  await withPatchedFetch(
    onlyRpc(async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/rest/v1/rpc/get_prompt_source");
      const body = JSON.parse(String(init?.body));
      requestBodies.push(body);
      return requestBodies.length === 1
        ? jsonResponse({ body: "Hello {{NAME}}", version_no: 7, not_modified: false })
        : jsonResponse({ body: null, version_no: 7, not_modified: true });
    }),
    async () => {
      const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN, { latestTtlMs: 5 });
      assert.equal((await client.getPrompt("latest/conditional", { variables: { NAME: "A" } })).text, "Hello A");
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal((await client.getPrompt("latest/conditional", { variables: { NAME: "B" } })).text, "Hello B");
    },
  );

  assert.deepEqual(requestBodies, [
    { p_name: "latest/conditional", p_version: null, p_if_version: null },
    { p_name: "latest/conditional", p_version: null, p_if_version: 7 },
  ]);
});

test("a trailing slash on supabaseUrl is normalized (no double slash in the request path)", async (t) => {
  const spy = t.mock.fn(
    onlyRpc(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/rest/v1/rpc/get_prompt_source");
      return jsonResponse({ body: "x", version_no: 1, not_modified: false });
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

test("ordinary HTTP 404/422 failures are not misclassified as prompt-domain PT404/PT422 errors", async () => {
  for (const fixture of [
    { status: 404, body: { code: "PGRST202", message: "function is missing" } },
    { status: 422, body: { code: "PGRST102", message: "malformed request body" } },
    { status: 422, body: { code: "PT422", message: "p_values must be a JSON object" } },
  ]) {
    await withPatchedFetch(onlyRpc(async () => jsonResponse(fixture.body, fixture.status)), async () => {
      const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
      await assert.rejects(
        () => client.getPrompt("brain/task-contract", { version: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error instanceof PromptNotFoundError, false);
          assert.equal(error instanceof MissingVariablesError, false);
          assert.match(error.message, new RegExp(String(fixture.status)));
          return true;
        },
      );
    });
  }
});

test("config-backed get_prompt rejects malformed successful payloads", async () => {
  const malformed = [
    null,
    {},
    { text: 1, version_no: 1, rendered_at: "2026-08-13T00:00:00Z" },
    { text: "x", version_no: 0, rendered_at: "2026-08-13T00:00:00Z" },
    { text: "x", version_no: 2, rendered_at: "2026-08-13T00:00:00Z" },
    { text: "x", version_no: 1, rendered_at: "not-a-date" },
  ];

  for (const payload of malformed) {
    await withPatchedFetch(onlyRpc(async () => jsonResponse(payload)), async () => {
      const client = createPromptClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
      await assert.rejects(
        () => client.getPrompt("brain/task-contract", { version: 1, config: "default" }),
        /invalid get_prompt response/,
      );
    });
  }
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
