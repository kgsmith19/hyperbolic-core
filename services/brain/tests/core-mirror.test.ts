// mirrorRunToCore's own RPC call (core.log_run, FR-007's RPC-not-raw-
// insert convention) against a mocked global fetch -- no live Supabase
// project touched. Asserts the request shape (endpoint, headers, body
// param names) matches the migration's own function signature
// (20260814170000_core_log_run_cost_fields.sql) and the fail-soft
// contract (never throws; returns false on any failure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorRunToCore } from "../src/core-mirror.ts";
import type { Cost, Run } from "../src/types.ts";

const RUN: Run = { id: "run-1", objective: "ship it", autonomy: 2, status: "completed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:05:00.000Z" };

function cost(overrides: Partial<Cost>): Cost {
  return { id: "c1", taskId: "task-1", invocationId: "inv-1", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, usdEstimate: 0, recordedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

test("mirrorRunToCore: undefined config -> skipped, never calls fetch, returns false", async (t) => {
  let called = false;
  t.mock.method(globalThis, "fetch", async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  const ok = await mirrorRunToCore(undefined, RUN, [], 1000);
  assert.equal(ok, false);
  assert.equal(called, false);
});

test("mirrorRunToCore: calls core.log_run via PostgREST RPC with summed token/usd totals and the run id as p_ref", async (t) => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify("00000000-0000-0000-0000-000000000000"), { status: 200 });
  });

  const costs = [cost({ id: "c1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, usdEstimate: 0.5 }), cost({ id: "c2", inputTokens: 20, outputTokens: 0, cacheReadTokens: 0, usdEstimate: 0.1 })];
  const ok = await mirrorRunToCore({ supabaseUrl: "https://example.invalid", supabaseServiceRoleKey: "srk-test" }, RUN, costs, 300_000);

  assert.equal(ok, true);
  assert.equal(capturedUrl, "https://example.invalid/rest/v1/rpc/log_run");
  const headers = capturedInit!.headers as Record<string, string>;
  assert.equal(headers.apikey, "srk-test");
  assert.equal(headers.Authorization, "Bearer srk-test");
  assert.equal(headers["Content-Profile"], "core");

  const body = JSON.parse(capturedInit!.body as string);
  assert.equal(body.p_app_id, "brain");
  assert.equal(body.p_ref, "run-1");
  assert.equal(body.p_wall_clock_ms, 300_000);
  assert.equal(body.p_input_tokens, 120);
  assert.equal(body.p_output_tokens, 50);
  assert.equal(body.p_cache_read_tokens, 10);
  assert.equal(body.p_usd, 0.6);
});

test("mirrorRunToCore: a non-2xx RPC response is a failure, never thrown -- returns false", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));
  const ok = await mirrorRunToCore({ supabaseUrl: "https://example.invalid", supabaseServiceRoleKey: "srk-test" }, RUN, [], 0);
  assert.equal(ok, false);
});

test("mirrorRunToCore: a network error is a failure, never thrown -- returns false", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNREFUSED");
  });
  const ok = await mirrorRunToCore({ supabaseUrl: "https://example.invalid", supabaseServiceRoleKey: "srk-test" }, RUN, [], 0);
  assert.equal(ok, false);
});
