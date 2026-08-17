import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSpend, loadBudgetConfig, logBrokerCall } from "../src/budget.ts";

const CONFIG = { supabaseUrl: "http://127.0.0.1:9999", serviceRoleKey: "test-service-role-key" };

async function withPatchedFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("loadBudgetConfig: undefined when either env var is missing -- never throws, the feature is simply not live yet", () => {
  assert.equal(loadBudgetConfig({}), undefined);
  assert.equal(loadBudgetConfig({ SUPABASE_URL: "http://x" }), undefined);
  assert.equal(loadBudgetConfig({ SUPABASE_SERVICE_ROLE_KEY: "k" }), undefined);
});

test("loadBudgetConfig: both present yields a real config", () => {
  const config = loadBudgetConfig({ SUPABASE_URL: "http://127.0.0.1:9999", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert.deepEqual(config, { supabaseUrl: "http://127.0.0.1:9999", serviceRoleKey: "k" });
});

test("checkSpend: posts to <supabaseUrl>/rest/v1/rpc/broker_call_spend_today with the service-role key as both apikey and bearer, Content-Profile core, and p_caller", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  await withPatchedFetch(
    (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response("12.5", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    async () => {
      const result = await checkSpend(CONFIG, "llm-handler", 20, 5);
      assert.equal(result.spentTodayUsd, 12.5);
      assert.equal(result.maxUsdPerDay, 20);
      assert.equal(result.wouldExceedBudget, false); // 12.5 + 5 = 17.5, under 20
    },
  );
  assert.equal(capturedUrl, "http://127.0.0.1:9999/rest/v1/rpc/broker_call_spend_today");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.apikey, "test-service-role-key");
  assert.equal(headers.Authorization, "Bearer test-service-role-key");
  assert.equal(headers["Content-Profile"], "core");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { p_caller: "llm-handler" });
});

test("checkSpend: wouldExceedBudget is true only when spentTodayUsd + estimatedCostUsd exceeds maxUsdPerDay, exactly at the boundary is NOT exceeded", async () => {
  await withPatchedFetch(
    (async () => new Response("15", { status: 200 })) as typeof fetch,
    async () => {
      // 15 + 5 = 20, exactly at the cap -- must not be flagged as exceeding.
      const atBoundary = await checkSpend(CONFIG, "llm-handler", 20, 5);
      assert.equal(atBoundary.wouldExceedBudget, false);
    },
  );
  await withPatchedFetch(
    (async () => new Response("15", { status: 200 })) as typeof fetch,
    async () => {
      // 15 + 5.01 = 20.01, one cent over -- must be flagged.
      const overBoundary = await checkSpend(CONFIG, "llm-handler", 20, 5.01);
      assert.equal(overBoundary.wouldExceedBudget, true);
    },
  );
});

test("checkSpend: maxUsdPerDay: null (no cap) never exceeds, regardless of spend", async () => {
  await withPatchedFetch(
    (async () => new Response("999999", { status: 200 })) as typeof fetch,
    async () => {
      const result = await checkSpend(CONFIG, "llm-handler", null, 1);
      assert.equal(result.wouldExceedBudget, false);
      assert.equal(result.maxUsdPerDay, null);
    },
  );
});

test("checkSpend: a failed HTTP status never throws -- spentTodayUsd is null (unknown), wouldExceedBudget stays false", async () => {
  await withPatchedFetch(
    (async () => new Response("error", { status: 500 })) as typeof fetch,
    async () => {
      const result = await checkSpend(CONFIG, "llm-handler", 20, 5);
      assert.equal(result.spentTodayUsd, null);
      assert.equal(result.wouldExceedBudget, false);
    },
  );
});

test("checkSpend: a network-level fetch failure never throws -- degrades to the same unknown state", async () => {
  await withPatchedFetch(
    (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    async () => {
      const result = await checkSpend(CONFIG, "llm-handler", 20, 5);
      assert.equal(result.spentTodayUsd, null);
      assert.equal(result.wouldExceedBudget, false);
    },
  );
});

test("checkSpend: a non-JSON/malformed response body never throws -- degrades to unknown", async () => {
  await withPatchedFetch(
    (async () => new Response("not a number", { status: 200 })) as typeof fetch,
    async () => {
      const result = await checkSpend(CONFIG, "llm-handler", 20, 5);
      assert.equal(result.spentTodayUsd, null);
    },
  );
});

test("logBrokerCall: posts to <supabaseUrl>/rest/v1/rpc/log_broker_call with p_caller/p_target_host/p_cost_usd, returns true on success", async () => {
  let capturedBody: unknown;
  const ok = await withPatchedFetch(
    (async (_input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify("00000000-0000-0000-0000-000000000000"), { status: 200 });
    }) as typeof fetch,
    () => logBrokerCall(CONFIG, "llm-handler", "api.anthropic.com", 0.0123),
  );
  assert.equal(ok, true);
  assert.deepEqual(capturedBody, { p_caller: "llm-handler", p_target_host: "api.anthropic.com", p_cost_usd: 0.0123 });
});

test("logBrokerCall: never throws on a failed status or a network error -- returns false", async () => {
  const failedStatus = await withPatchedFetch(
    (async () => new Response("error", { status: 403 })) as typeof fetch,
    () => logBrokerCall(CONFIG, "llm-handler", "api.anthropic.com", 1),
  );
  assert.equal(failedStatus, false);

  const networkError = await withPatchedFetch(
    (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    () => logBrokerCall(CONFIG, "llm-handler", "api.anthropic.com", 1),
  );
  assert.equal(networkError, false);
});
