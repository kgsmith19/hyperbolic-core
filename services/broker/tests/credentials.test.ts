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

// Round-2 independent review's finding: a bare `env[name]` reads through
// the prototype chain, so a vault key literally named e.g. "constructor"
// resolved to a function inherited from Object.prototype (truthy) and got
// injected into a real outgoing header as its string coercion. Real vault
// keys are conventionally uppercase (tool.schema.json's own naming
// constraint), but nothing in validatePolicyEntry (packages/broker-
// contract/contract.mjs) actually enforces that shape on broker-policy.json
// itself -- this is defense-in-depth against a malformed or manually-edited
// policy document reaching the broker with a lowercase/dunder vaultKeys
// entry, not a scenario the normal manifest-generation pipeline produces.
test("loadCredentials: a vault key name that collides with an inherited Object.prototype property never resolves to that inherited value -- only a real own env value counts", () => {
  const policyNamingProtoKeys: PolicyDocument = {
    "llm-handler": { allowedHosts: [], vaultKeys: ["constructor", "toString", "hasOwnProperty"], maxUsdPerDay: null },
  };
  const credentials = loadCredentials({}, policyNamingProtoKeys);
  assert.deepEqual(credentials, {});
  assert.equal(Object.prototype.hasOwnProperty.call(credentials, "constructor"), false);
});

test("loadCredentials: a genuinely-provisioned own env value for a colliding name is still picked up correctly", () => {
  const policyNamingProtoKeys: PolicyDocument = {
    "llm-handler": { allowedHosts: [], vaultKeys: ["constructor"], maxUsdPerDay: null },
  };
  const credentials = loadCredentials({ constructor: "sk-real-value" }, policyNamingProtoKeys);
  assert.deepEqual(credentials, { constructor: "sk-real-value" });
});
