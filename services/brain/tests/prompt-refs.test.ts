import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePromptOrgRefs } from "../src/prompt-refs.ts";
import type { PromptClient, RenderedPrompt } from "@hyperbolic/llm";

function fakePromptClient(versionsByName: Record<string, number>): { client: PromptClient; calls: string[] } {
  const calls: string[] = [];
  const client: PromptClient = {
    async getPrompt(name): Promise<RenderedPrompt> {
      calls.push(name);
      const version = versionsByName[name];
      if (version === undefined) throw new Error(`no fixture version for ${name}`);
      return { text: `rendered ${name}`, version, renderedAt: "2026-01-01T00:00:00.000Z" };
    },
    invalidate() {},
  };
  return { client, calls };
}

test("resolvePromptOrgRefs: a ref already pinned to a numeric version passes through with no getPrompt call", async () => {
  const { client, calls } = fakePromptClient({});
  const resolved = await resolvePromptOrgRefs(client, ["idea-optimizer@3"]);
  assert.deepEqual(resolved, ["idea-optimizer@3"]);
  assert.deepEqual(calls, []);
});

test("resolvePromptOrgRefs: a bare name is resolved to name@<version> via getPrompt", async () => {
  const { client, calls } = fakePromptClient({ "idea-optimizer": 7 });
  const resolved = await resolvePromptOrgRefs(client, ["idea-optimizer"]);
  assert.deepEqual(resolved, ["idea-optimizer@7"]);
  assert.deepEqual(calls, ["idea-optimizer"]);
});

test("resolvePromptOrgRefs: an explicit @latest is resolved and rewritten to the pinned version", async () => {
  const { client, calls } = fakePromptClient({ "idea-optimizer": 9 });
  const resolved = await resolvePromptOrgRefs(client, ["idea-optimizer@latest"]);
  assert.deepEqual(resolved, ["idea-optimizer@9"]);
  assert.deepEqual(calls, ["idea-optimizer"]);
});

test("resolvePromptOrgRefs: resolves multiple refs, preserving order, mixing pinned and unpinned", async () => {
  const { client } = fakePromptClient({ a: 1, c: 3 });
  const resolved = await resolvePromptOrgRefs(client, ["a", "b@2", "c@latest"]);
  assert.deepEqual(resolved, ["a@1", "b@2", "c@3"]);
});

test("resolvePromptOrgRefs: empty input never calls getPrompt", async () => {
  const { client, calls } = fakePromptClient({});
  const resolved = await resolvePromptOrgRefs(client, []);
  assert.deepEqual(resolved, []);
  assert.deepEqual(calls, []);
});
