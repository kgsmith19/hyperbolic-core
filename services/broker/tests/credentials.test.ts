import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCredentials } from "../src/credentials.ts";
import type { PolicyDocument } from "../src/policy.ts";

const POLICY: PolicyDocument = {
  "llm-handler": { allowedHosts: [], vaultKeys: ["LLM_KEYS_ANTHROPIC", "LLM_KEYS_OPENAI"], maxUsdPerDay: null },
  brain: { allowedHosts: [], vaultKeys: ["LLM_KEYS_ANTHROPIC"], maxUsdPerDay: null },
};

test("loadCredentials: picks up an env value for every vault key named anywhere in the policy, deduplicated across callers", () => {
  const credentials = loadCredentials(
    { LLM_KEYS_ANTHROPIC: "sk-ant-1", LLM_KEYS_OPENAI: "sk-openai-1" },
    POLICY,
  );
  assert.deepEqual(credentials, { LLM_KEYS_ANTHROPIC: "sk-ant-1", LLM_KEYS_OPENAI: "sk-openai-1" });
});

test("loadCredentials: a vault key declared in the policy but absent from env is simply omitted, not an empty string or a thrown error -- dark until provisioned", () => {
  const credentials = loadCredentials({ LLM_KEYS_ANTHROPIC: "sk-ant-1" }, POLICY);
  assert.deepEqual(credentials, { LLM_KEYS_ANTHROPIC: "sk-ant-1" });
  assert.equal(Object.prototype.hasOwnProperty.call(credentials, "LLM_KEYS_OPENAI"), false);
});

test("loadCredentials: never surfaces an unrelated process env var, even one that happens to match the vault-key naming shape -- only policy-declared names are ever read", () => {
  const credentials = loadCredentials(
    { LLM_KEYS_ANTHROPIC: "sk-ant-1", NODE_ENV: "production", SOME_OTHER_SECRET: "leak-me-not" },
    POLICY,
  );
  assert.deepEqual(credentials, { LLM_KEYS_ANTHROPIC: "sk-ant-1" });
});

test("loadCredentials: an empty policy document yields an empty credential map, never throws", () => {
  const credentials = loadCredentials({ LLM_KEYS_ANTHROPIC: "sk-ant-1" }, {});
  assert.deepEqual(credentials, {});
});
