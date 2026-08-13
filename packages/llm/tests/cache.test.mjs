// m4-04: 05-d-prompt-organizer.md section 4's caching strategy, proved with
// a transport spy -- no real network call happens anywhere in this file.
// Plain .mjs (not .ts) because this is the exact filename docs/planning/
// issues/m4-04-feat-llm-prompt-client.md's own verification command names:
// `node --test packages/llm/tests/cache.test.mjs`.
//
// The fake PostgREST server below answers the two RPC endpoints
// packages/llm/src/prompt-client.ts calls against an in-memory "world" of prompts and
// their versions, using the SAME render() this package ships (packages/llm/
// src/prompt-render.ts) to compute what the real SQL RPC would return -- so
// a bug in the client's own merge/substitution logic would show up here too,
// not just a bug in cache bookkeeping. The real-Postgres proof of the
// server-side RPC and the client wired against it lives in
// packages/llm/tests/real-pg.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPromptClient, MissingVariablesError, PromptNotFoundError } from "../src/prompt-client.ts";
import { render } from "../src/prompt-render.ts";

const BASE_URL = "https://fixture-project.supabase.invalid";
const TOKEN = "fixture.session.token";

function makeWorld() {
  return new Map(); // name -> { id, versions: Map<version_no, body> }
}

function seed(world, name, id, bodiesByVersion) {
  world.set(name, { id, active: true, versions: new Map(Object.entries(bodiesByVersion).map(([k, v]) => [Number(k), v])) });
}

function maxVersion(entry) {
  return Math.max(...entry.versions.keys());
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stripPrefix(raw, prefix) {
  return raw && raw.startsWith(prefix) ? raw.slice(prefix.length) : undefined;
}

// Answers the published rendering RPC, the cache-source RPC, and the old raw
// table shapes used only by regression tests that prove the client no longer
// depends on table grants.
async function fakePostgrest(world, callLog, input, init) {
  const url = new URL(String(input));
  callLog.push(url.pathname + url.search);
  const method = init?.method ?? "GET";

  if (method === "POST" && url.pathname === "/rest/v1/rpc/get_prompt") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const entry = world.get(body.p_name);
    if (!entry) return jsonResponse({ code: "PT404", message: "prompt not found" }, 404);

    if (body.p_version === null && !entry.active) return jsonResponse({ code: "PT404", message: "prompt not found" }, 404);
    const versionNo = body.p_version ?? maxVersion(entry);
    const rawBody = entry.versions.get(versionNo);
    if (rawBody === undefined) return jsonResponse({ code: "PT404", message: "prompt version not found" }, 404);

    const result = render(rawBody, body.p_values ?? {}, body.p_sections ?? []);
    if (!result.ok) return jsonResponse({ code: "PT422", message: `missing variables: ${result.missing.join(", ")}` }, 422);

    return jsonResponse({ text: result.text, version_no: versionNo, rendered_at: new Date().toISOString() });
  }

  if (method === "POST" && url.pathname === "/rest/v1/rpc/get_prompt_source") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const entry = world.get(body.p_name);
    if (!entry) return jsonResponse({ code: "PT404", message: "prompt not found" }, 404);
    if (body.p_version === null && !entry.active) return jsonResponse({ code: "PT404", message: "prompt not found" }, 404);

    const versionNo = body.p_version ?? maxVersion(entry);
    const rawBody = entry.versions.get(versionNo);
    if (rawBody === undefined) return jsonResponse({ code: "PT404", message: "prompt version not found" }, 404);
    if (body.p_if_version === versionNo) {
      return jsonResponse({ body: null, version_no: versionNo, not_modified: true });
    }
    return jsonResponse({ body: rawBody, version_no: versionNo, not_modified: false });
  }

  if (method === "GET" && url.pathname === "/rest/v1/prompt") {
    const name = stripPrefix(url.searchParams.get("title"), "eq.");
    const entry = name ? world.get(name) : undefined;
    if (!entry) return jsonResponse([]);
    return jsonResponse([{ id: entry.id, body: entry.versions.get(maxVersion(entry)) }]);
  }

  if (method === "GET" && url.pathname === "/rest/v1/prompt_version") {
    const promptId = stripPrefix(url.searchParams.get("prompt_id"), "eq.");
    const entry = [...world.values()].find((e) => e.id === promptId);
    if (!entry) return jsonResponse([]);
    const versionFilter = stripPrefix(url.searchParams.get("version_no"), "eq.");
    if (versionFilter !== undefined) {
      const body = entry.versions.get(Number(versionFilter));
      return jsonResponse(body !== undefined ? [{ body }] : []);
    }
    // Legacy version-probe shape, retained only so the RPC-only regression
    // test can demonstrate exactly what an old client would try to call.
    return jsonResponse([{ version_no: maxVersion(entry) }]);
  }

  return jsonResponse({ message: `unhandled fake-postgrest route: ${method} ${url.pathname}` }, 404);
}

async function withFakePostgrest(world, run) {
  const callLog = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => fakePostgrest(world, callLog, input, init);
  try {
    return await run(callLog);
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// PO-5b: pinned entries are cached forever; a repeat request issues zero
// network calls.
// ---------------------------------------------------------------------------

test("pinned entries: a second call at the same name@version issues zero fetches, even with different variables", async () => {
  const world = makeWorld();
  seed(world, "brain/task-contract", "id-1", { 1: "Hello {{NAME}}." });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);

    const first = await client.getPrompt("brain/task-contract", { version: 1, variables: { NAME: "A" } });
    assert.equal(first.text, "Hello A.");
    assert.equal(first.version, 1);
    const callsAfterFirst = callLog.length;
    assert.ok(callsAfterFirst > 0, "the miss must have hit the network at least once");

    const second = await client.getPrompt("brain/task-contract", { version: 1, variables: { NAME: "B" } });
    assert.equal(second.text, "Hello B.", "must re-render locally with the NEW variables, not replay stale cached text");
    assert.equal(callLog.length, callsAfterFirst, "the second pinned call must issue zero additional network calls");
  });
});

test("pinned entries: a third call, still pinned, is also a pure hit (repeat requests plural, not just once)", async () => {
  const world = makeWorld();
  seed(world, "coding/review/simplification", "id-1b", { 3: "Review pass for {{REPO}}." });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);
    await client.getPrompt("coding/review/simplification", { version: 3, variables: { REPO: "x" } });
    const afterFirst = callLog.length;
    await client.getPrompt("coding/review/simplification", { version: 3, variables: { REPO: "y" } });
    await client.getPrompt("coding/review/simplification", { version: 3, variables: { REPO: "z" } });
    assert.equal(callLog.length, afterFirst);
  });
});

test("pinned entries: capacity-bounded LRU actually evicts (a 129th distinct pinned key evicts the 1st)", async () => {
  const world = makeWorld();
  for (let i = 0; i < 129; i++) {
    seed(world, `evict/${i}`, `id-evict-${i}`, { 1: `body ${i}` });
  }
  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN, { maxPinnedEntries: 128 });
    for (let i = 0; i < 129; i++) {
      await client.getPrompt(`evict/${i}`, { version: 1 });
    }
    const callsAfterFill = callLog.length;

    // evict/0 must have been evicted (LRU, capacity 128, 129 distinct keys
    // inserted in order): re-requesting it must hit the network again.
    await client.getPrompt("evict/0", { version: 1 });
    assert.ok(callLog.length > callsAfterFill, "evict/0 should have been evicted and required a re-fetch");

    // evict/128 (the most recently inserted) must still be a pure hit.
    const callsAfterEvict0 = callLog.length;
    await client.getPrompt("evict/128", { version: 1 });
    assert.equal(callLog.length, callsAfterEvict0, "the most recently cached pinned entry must still be a hit");
  });
});

// ---------------------------------------------------------------------------
// name@latest: 60s-class TTL, revalidated atomically by the conditional
// cache-source RPC.
// ---------------------------------------------------------------------------

test("name@latest: TTL expiry with an unchanged version_no reuses the cached body with zero body re-fetch", async () => {
  const world = makeWorld();
  seed(world, "lifeos/chat/system", "id-2", { 1: "Sys prompt v1 {{X}}" });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN, { latestTtlMs: 5 });

    const first = await client.getPrompt("lifeos/chat/system", { variables: { X: "y" } });
    assert.equal(first.text, "Sys prompt v1 y");
    const callsAfterFirst = callLog.length;

    await new Promise((resolve) => setTimeout(resolve, 25)); // cross the TTL boundary

    const second = await client.getPrompt("lifeos/chat/system", { variables: { X: "z" } });
    assert.equal(second.text, "Sys prompt v1 z");

    const revalidationCalls = callLog.slice(callsAfterFirst);
    assert.deepEqual(revalidationCalls, ["/rest/v1/rpc/get_prompt_source"], "one conditional RPC should validate the entry with zero body transfer");

    // The refreshed TTL means an immediate follow-up call is a pure hit too.
    const callsAfterSecond = callLog.length;
    await client.getPrompt("lifeos/chat/system", { variables: { X: "w" } });
    assert.equal(callLog.length, callsAfterSecond, "the revalidated entry's TTL must have been extended");
  });
});

test("name@latest: TTL expiry with a changed version_no triggers one full re-fetch and replaces the cache", async () => {
  const world = makeWorld();
  seed(world, "intake/optimize/idea", "id-3", { 1: "v1 body {{X}}" });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN, { latestTtlMs: 5 });

    const first = await client.getPrompt("intake/optimize/idea", { variables: { X: "y" } });
    assert.equal(first.version, 1);
    const callsAfterFirst = callLog.length;

    world.get("intake/optimize/idea").versions.set(2, "v2 body {{X}}"); // a new version lands while warm

    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await client.getPrompt("intake/optimize/idea", { variables: { X: "z" } });
    assert.equal(second.version, 2, "must resolve the NEW latest version, not the stale cached one");
    assert.equal(second.text, "v2 body z");

    const revalidationCalls = callLog.slice(callsAfterFirst);
    assert.deepEqual(revalidationCalls, ["/rest/v1/rpc/get_prompt_source"], "one conditional RPC must return the changed version and body atomically");

    const callsAfterSecond = callLog.length;
    const third = await client.getPrompt("intake/optimize/idea", { variables: { X: "w" } });
    assert.equal(third.text, "v2 body w");
    assert.equal(callLog.length, callsAfterSecond, "the replaced cache entry must itself serve the next call with zero network");
  });
});

test("cacheable misses and revalidations use RPC endpoints only, never prompt table REST reads", async () => {
  const world = makeWorld();
  seed(world, "rpc-only/prompt", "id-rpc-only", { 1: "v1 {{X}}" });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN, { latestTtlMs: 5 });
    await client.getPrompt("rpc-only/prompt", { version: 1, variables: { X: "pinned" } });
    await client.getPrompt("rpc-only/prompt", { variables: { X: "latest" } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await client.getPrompt("rpc-only/prompt", { variables: { X: "revalidated" } });

    assert.ok(callLog.length > 0);
    assert.ok(
      callLog.every((path) => path.startsWith("/rest/v1/rpc/")),
      `cache transport must be RPC-only, got: ${callLog.join(", ")}`,
    );
  });
});

test("name@latest: TTL revalidation refuses an archived prompt even when its version_no is unchanged", async () => {
  const world = makeWorld();
  seed(world, "lifeos/chat/archive-me", "id-archived", { 1: "still {{X}}" });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN, { latestTtlMs: 5 });
    await client.getPrompt("lifeos/chat/archive-me", { variables: { X: "active" } });
    const callsAfterWarm = callLog.length;

    world.get("lifeos/chat/archive-me").active = false;
    await new Promise((resolve) => setTimeout(resolve, 25));

    await assert.rejects(
      () => client.getPrompt("lifeos/chat/archive-me", { variables: { X: "stale" } }),
      PromptNotFoundError,
    );
    assert.deepEqual(callLog.slice(callsAfterWarm), ["/rest/v1/rpc/get_prompt_source"]);
  });
});

test("name@latest: an update between requests cannot pair one RPC version with another body", async () => {
  let currentVersion = 1;
  const callLog = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    callLog.push(url.pathname);

    if (url.pathname === "/rest/v1/rpc/get_prompt_source") {
      const snapshotVersion = currentVersion;
      const response = jsonResponse({
        body: `v${snapshotVersion} body {{X}}`,
        version_no: snapshotVersion,
        not_modified: false,
      });
      currentVersion = 2;
      return response;
    }
    if (url.pathname === "/rest/v1/rpc/get_prompt") {
      const snapshotVersion = currentVersion;
      const request = JSON.parse(String(init?.body ?? "{}"));
      const response = jsonResponse({
        text: `v${snapshotVersion} body ${request.p_values.X}`,
        version_no: snapshotVersion,
        rendered_at: new Date().toISOString(),
      });
      currentVersion = 2;
      return response;
    }
    if (url.pathname === "/rest/v1/prompt") {
      return jsonResponse([{ id: "id-race", body: `v${currentVersion} body {{X}}` }]);
    }
    if (url.pathname === "/rest/v1/prompt_version") {
      return jsonResponse([{ version_no: currentVersion }]);
    }
    return jsonResponse({ message: "unexpected route" }, 404);
  };

  try {
    const client = createPromptClient(BASE_URL, async () => TOKEN);
    const first = await client.getPrompt("race/latest", { variables: { X: "a" } });
    const second = await client.getPrompt("race/latest", { variables: { X: "b" } });

    assert.deepEqual({ text: first.text, version: first.version }, { text: "v1 body a", version: 1 });
    assert.deepEqual({ text: second.text, version: second.version }, { text: "v1 body b", version: 1 });
    assert.deepEqual(callLog, ["/rest/v1/rpc/get_prompt_source"], "the atomic source response must be the only network call");
  } finally {
    globalThis.fetch = original;
  }
});

test("name@latest: concurrent expired reads share one revalidation so completion order cannot regress the cache", async () => {
  let conditionalCalls = 0;
  const pending = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/rest/v1/rpc/get_prompt_source");
    const request = JSON.parse(String(init?.body ?? "{}"));
    if (request.p_if_version === null) {
      return jsonResponse({ body: "v1 {{X}}", version_no: 1, not_modified: false });
    }
    conditionalCalls += 1;
    return new Promise((resolve) => pending.push(resolve));
  };

  try {
    const client = createPromptClient(BASE_URL, async () => TOKEN, { latestTtlMs: 5 });
    await client.getPrompt("race/concurrent-latest", { variables: { X: "warm" } });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const first = client.getPrompt("race/concurrent-latest", { variables: { X: "first" } });
    await new Promise((resolve) => setImmediate(resolve));
    const second = client.getPrompt("race/concurrent-latest", { variables: { X: "second" } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(conditionalCalls, 1, "same-name revalidations must be single-flight");
    pending[0](jsonResponse({ body: "v2 {{X}}", version_no: 2, not_modified: false }));

    assert.deepEqual(
      await Promise.all([first, second]).then((results) => results.map(({ text, version }) => ({ text, version }))),
      [
        { text: "v2 first", version: 2 },
        { text: "v2 second", version: 2 },
      ],
    );

    const cached = await client.getPrompt("race/concurrent-latest", { variables: { X: "cached" } });
    assert.deepEqual({ text: cached.text, version: cached.version }, { text: "v2 cached", version: 2 });
    assert.equal(conditionalCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("cache-source malformed 2xx payloads are rejected and never cached", async () => {
  for (const malformed of [
    null,
    {},
    { body: "x", version_no: "1", not_modified: false },
    { body: "x", version_no: 0, not_modified: false },
    { body: null, version_no: 1, not_modified: false },
    { body: "x", version_no: 1, not_modified: true },
    { body: "wrong version", version_no: 2, not_modified: false },
  ]) {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(malformed)
        : jsonResponse({ body: "valid", version_no: 1, not_modified: false });
    };
    try {
      const client = createPromptClient(BASE_URL, async () => TOKEN);
      await assert.rejects(() => client.getPrompt("malformed/source", { version: 1 }), /invalid get_prompt_source response/);
      assert.equal((await client.getPrompt("malformed/source", { version: 1 })).text, "valid");
      assert.equal(calls, 2, "a malformed response must not populate the pinned cache");
    } finally {
      globalThis.fetch = original;
    }
  }
});

// ---------------------------------------------------------------------------
// Cache hit latency: under 5ms p95 (PO-5's own unit-test budget, section 4's
// latency table).
// ---------------------------------------------------------------------------

test("cache hit: p95 latency across repeat pinned calls is under 5ms", async () => {
  const world = makeWorld();
  seed(world, "coding/system/kernel-run", "id-4", {
    1: "Body {{X}} <!--OPTIONAL:extra-->extra {{Y}}<!--/OPTIONAL:extra-->",
  });

  await withFakePostgrest(world, async () => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);
    await client.getPrompt("coding/system/kernel-run", { version: 1, variables: { X: "a" } }); // populate the cache

    const samples = [];
    const N = 300;
    for (let i = 0; i < N; i++) {
      const start = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await client.getPrompt("coding/system/kernel-run", { version: 1, variables: { X: String(i) } });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(N * 0.95)];
    assert.ok(p95 < 5, `p95 cache-hit latency was ${p95.toFixed(3)}ms, expected under 5ms`);
  });
});

// ---------------------------------------------------------------------------
// RPC error mapping: PT404 -> PromptNotFoundError, PT422 -> MissingVariablesError.
// ---------------------------------------------------------------------------

test("unknown prompt name maps the RPC's PT404 to PromptNotFoundError", async () => {
  const world = makeWorld();
  await withFakePostgrest(world, async () => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);
    await assert.rejects(() => client.getPrompt("does/not-exist"), PromptNotFoundError);
  });
});

test("an unknown pinned version_no also maps to PromptNotFoundError", async () => {
  const world = makeWorld();
  seed(world, "gp/pin-target", "id-pt", { 1: "no vars here" });
  await withFakePostgrest(world, async () => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);
    await assert.rejects(() => client.getPrompt("gp/pin-target", { version: 999 }), PromptNotFoundError);
  });
});

test("missing template variables map the RPC's PT422 to MissingVariablesError, naming every missing name", async () => {
  const world = makeWorld();
  seed(world, "research/deep-dive", "id-5", { 1: "{{A}} and {{B}}" });

  await withFakePostgrest(world, async () => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);
    await assert.rejects(
      () => client.getPrompt("research/deep-dive", { version: 1, variables: { A: "x" } }),
      (err) => {
        assert.ok(err instanceof MissingVariablesError);
        assert.deepEqual(err.missing, ["B"]);
        return true;
      },
    );
  });
});

test("a cache-hit local render that is missing a variable also throws MissingVariablesError, without touching the network", async () => {
  const world = makeWorld();
  seed(world, "ops/runbooks/deploy-verify", "id-mv", { 1: "{{A}} and {{B}}" });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);
    await client.getPrompt("ops/runbooks/deploy-verify", { version: 1, variables: { A: "x", B: "y" } }); // populate
    const callsAfterFirst = callLog.length;

    await assert.rejects(
      () => client.getPrompt("ops/runbooks/deploy-verify", { version: 1, variables: { A: "x" } }),
      (err) => {
        assert.ok(err instanceof MissingVariablesError);
        assert.deepEqual(err.missing, ["B"]);
        return true;
      },
    );
    assert.equal(callLog.length, callsAfterFirst, "a local-render failure must not have touched the network");
  });
});

// ---------------------------------------------------------------------------
// invalidate(name): the name@latest tier only; pinned entries never invalidate.
// ---------------------------------------------------------------------------

test("invalidate(name) clears only the name@latest tier; a pinned entry for the same name survives it", async () => {
  const world = makeWorld();
  seed(world, "ops/runbooks/deploy-verify", "id-6", { 1: "v1 {{X}}", 2: "v2 {{X}}" });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);
    await client.getPrompt("ops/runbooks/deploy-verify", { version: 1, variables: { X: "a" } }); // pinned
    await client.getPrompt("ops/runbooks/deploy-verify", { variables: { X: "a" } }); // latest
    const callsBeforeInvalidate = callLog.length;

    client.invalidate("ops/runbooks/deploy-verify");

    await client.getPrompt("ops/runbooks/deploy-verify", { version: 1, variables: { X: "b" } }); // still pinned
    assert.equal(callLog.length, callsBeforeInvalidate, "invalidate() must not touch the pinned tier");

    await client.getPrompt("ops/runbooks/deploy-verify", { variables: { X: "b" } }); // latest: must re-fetch
    assert.ok(callLog.length > callsBeforeInvalidate, "the latest tier must have been invalidated and re-fetched");
  });
});

test("getAccessToken rejecting (no session) reaches zero network calls, fail-closed", async () => {
  const world = makeWorld();
  seed(world, "brain/task-contract", "id-7", { 1: "no vars" });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => {
      throw new Error("no active session");
    });
    await assert.rejects(() => client.getPrompt("brain/task-contract", { version: 1 }));
    assert.equal(callLog.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Gaps found by an independent mutation sweep during review of m4-04. Each
// test below corresponds to a mutant that survived the suite as originally
// written -- i.e. a property the implementation genuinely has, that nothing
// was actually holding it to.
// ---------------------------------------------------------------------------

test("pinned entries: the cached body comes from prompt_version, NOT the live prompt.body, so a pin survives a later edit", async () => {
  // The source RPC receives p_version and must return that historical body,
  // not the latest live body. This protects the property that makes pinning
  // useful: later edits cannot alter a cached name@version result.
  const world = makeWorld();
  seed(world, "brain/task-contract", "id-pin", { 1: "v1 body {{X}}.", 2: "v2 body {{X}}." });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);

    const pinned = await client.getPrompt("brain/task-contract", { version: 1, variables: { X: "a" } });
    assert.equal(pinned.text, "v1 body a.", "the pinned call must render version 1's body");
    const afterMiss = callLog.length;

    // Second pinned call is a pure cache hit, so its text can only come from
    // the atomic source response cached on the miss.
    const again = await client.getPrompt("brain/task-contract", { version: 1, variables: { X: "b" } });
    assert.equal(callLog.length, afterMiss, "must be a pure cache hit");
    assert.equal(again.text, "v1 body b.", "the cached pinned body must be version 1's, never the live version 2 body");
  });
});

test("pinned entries: the LRU promotes on read, so a repeatedly-used entry is not the one evicted", async () => {
  // Mutation finding: removing the delete/re-set promotion from Lru.get()
  // (degrading the cache to plain FIFO) survived the suite. The existing
  // eviction test only proved that *something* is evicted at capacity, never
  // that recency is what decides which.
  const world = makeWorld();
  for (let i = 0; i < 129; i++) seed(world, `lru/${i}`, `id-lru-${i}`, { 1: `body ${i}` });

  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN, { maxPinnedEntries: 128 });

    for (let i = 0; i < 128; i++) await client.getPrompt(`lru/${i}`, { version: 1 });

    // Re-read the OLDEST entry, making it most-recently-used. Under a real
    // LRU it now survives the next eviction; under FIFO it is still first out.
    await client.getPrompt("lru/0", { version: 1 });
    const afterTouch = callLog.length;

    // Insert a 129th distinct key, forcing exactly one eviction.
    await client.getPrompt("lru/128", { version: 1 });

    const beforeProbe = callLog.length;
    await client.getPrompt("lru/0", { version: 1 });
    assert.equal(callLog.length, beforeProbe, "lru/0 was just used, so it must have survived eviction (LRU, not FIFO)");
    assert.ok(afterTouch > 0);
  });
});

test("a call naming a saved config is never served from cache: config values resolve server-side", async () => {
  // Mutation finding: dropping the `opts.config === undefined` guard from the
  // cache-hit branches survived. Serving a config-bearing call from the
  // locally-cached template would silently ignore the saved configuration's
  // values/sections entirely -- the cache is keyed name@version_no /
  // name@latest with no config dimension, so a cached entry cannot represent
  // one.
  const world = makeWorld();
  seed(world, "planning/spec/issue-outcome", "id-cfg", { 1: "Spec for {{TOPIC}}." });

  // Both tiers are exercised deliberately: the guard exists separately in
  // getPinned() and getLatest(), so a test covering only one leaves the
  // other's guard unheld (exactly how the first version of this test missed
  // the latest-tier mutant -- it passed `version: 1`, which only ever routes
  // through getPinned).
  await withFakePostgrest(world, async (callLog) => {
    const client = createPromptClient(BASE_URL, async () => TOKEN);

    // --- pinned tier ---
    await client.getPrompt("planning/spec/issue-outcome", { version: 1, variables: { TOPIC: "a" } });
    const afterPinnedWarm = callLog.length;
    await client.getPrompt("planning/spec/issue-outcome", { version: 1, config: "some-config", variables: { TOPIC: "b" } });
    const pinnedRpc = callLog.slice(afterPinnedWarm).filter((u) => u === "/rest/v1/rpc/get_prompt");
    assert.equal(pinnedRpc.length, 1, "a config-bearing PINNED call must reach rpc/get_prompt, not be served locally");

    // --- latest tier (no `version`) ---
    await client.getPrompt("planning/spec/issue-outcome", { variables: { TOPIC: "c" } });
    const afterLatestWarm = callLog.length;
    await client.getPrompt("planning/spec/issue-outcome", { config: "some-config", variables: { TOPIC: "d" } });
    const latestRpc = callLog.slice(afterLatestWarm).filter((u) => u === "/rest/v1/rpc/get_prompt");
    assert.equal(latestRpc.length, 1, "a config-bearing LATEST call must reach rpc/get_prompt, not be served locally");
  });
});
