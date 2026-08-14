import { test } from "node:test";
import assert from "node:assert/strict";
import { selectInitialAdapter, selectFallbackAdapter, type AdapterRegistry } from "../src/router.ts";
import type { HarnessAdapter, HarnessId, HarnessSession, ProbeResult } from "../src/adapters/types.ts";
import type { TaskContractV1 } from "../src/contracts.ts";

function fakeAdapter(id: HarnessId, ok: boolean): HarnessAdapter {
  return {
    id,
    async probe(): Promise<ProbeResult> {
      return { ok, version: ok ? "1.0.0" : "" };
    },
    async start(): Promise<HarnessSession> {
      return { sessionId: "s", outcome: "accepted", raw: {} };
    },
    async resume(): Promise<HarnessSession> {
      return { sessionId: "s", outcome: "accepted", raw: {} };
    },
    async cancel(): Promise<void> {},
  };
}

function fixtureContract(overrides: Partial<TaskContractV1> = {}): TaskContractV1 {
  return {
    task_id: "t1",
    run_id: "r1",
    title: "x",
    repo: { url: "https://example.invalid/repo", ref: "main" },
    harness: { preferred: null, fallback: [] },
    autonomy: 2,
    prompt: { objective: "x", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: [], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "none" },
    acceptance: [],
    deliverable: { type: "commit", branch: "brain/t1", push: false, draft_pr: false },
    ...overrides,
  };
}

test("selectInitialAdapter: no preferred harness -> claude-code", async () => {
  const adapters: AdapterRegistry = { "claude-code": fakeAdapter("claude-code", true) };
  const adapter = await selectInitialAdapter(fixtureContract({ harness: { preferred: null, fallback: [] } }), adapters);
  assert.equal(adapter.id, "claude-code");
});

test("selectInitialAdapter: preferred harness used when its probe passes", async () => {
  const adapters: AdapterRegistry = { "claude-code": fakeAdapter("claude-code", true), codex: fakeAdapter("codex", true) };
  const adapter = await selectInitialAdapter(fixtureContract({ harness: { preferred: "codex", fallback: [] } }), adapters);
  assert.equal(adapter.id, "codex");
});

test("selectInitialAdapter: preferred harness whose probe fails falls back to claude-code, not to fallback[]", async () => {
  const adapters: AdapterRegistry = { "claude-code": fakeAdapter("claude-code", true), codex: fakeAdapter("codex", false) };
  const adapter = await selectInitialAdapter(fixtureContract({ harness: { preferred: "codex", fallback: ["gemini"] } }), adapters);
  assert.equal(adapter.id, "claude-code");
});

test("selectInitialAdapter: preferred harness not registered at all falls back to claude-code", async () => {
  const adapters: AdapterRegistry = { "claude-code": fakeAdapter("claude-code", true) };
  const adapter = await selectInitialAdapter(fixtureContract({ harness: { preferred: "gemini", fallback: [] } }), adapters);
  assert.equal(adapter.id, "claude-code");
});

test("selectInitialAdapter: throws if claude-code itself isn't registered (a real deploy bug, not a routing decision)", async () => {
  await assert.rejects(() => selectInitialAdapter(fixtureContract(), {}));
});

test("selectFallbackAdapter: returns the first fallback whose probe passes", async () => {
  const adapters: AdapterRegistry = { codex: fakeAdapter("codex", false), gemini: fakeAdapter("gemini", true) };
  const fallback = await selectFallbackAdapter(fixtureContract({ harness: { preferred: null, fallback: ["codex", "gemini"] } }), adapters, "claude-code");
  assert.equal(fallback?.id, "gemini");
});

test("selectFallbackAdapter: excludes the already-selected harness even if listed in fallback[]", async () => {
  const adapters: AdapterRegistry = { "claude-code": fakeAdapter("claude-code", true) };
  const fallback = await selectFallbackAdapter(fixtureContract({ harness: { preferred: null, fallback: ["claude-code"] } }), adapters, "claude-code");
  assert.equal(fallback, null);
});

test("selectFallbackAdapter: returns null when no fallback is viable", async () => {
  const adapters: AdapterRegistry = { codex: fakeAdapter("codex", false), gemini: fakeAdapter("gemini", false) };
  const fallback = await selectFallbackAdapter(fixtureContract({ harness: { preferred: null, fallback: ["codex", "gemini"] } }), adapters, "claude-code");
  assert.equal(fallback, null);
});

test("selectFallbackAdapter: empty fallback list returns null", async () => {
  const fallback = await selectFallbackAdapter(fixtureContract({ harness: { preferred: null, fallback: [] } }), {}, "claude-code");
  assert.equal(fallback, null);
});
