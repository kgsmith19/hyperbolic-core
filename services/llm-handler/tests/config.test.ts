// Env-var contract tests for src/config.ts (issue #337).
//
// The provider enum standardized on `google` (#307/#308), but the deploy
// pipeline (deploy.yml's deploy-llm-handler job) renders the credential as
// LLM_KEYS_GEMINI -- the name Infisical's /platform/llm-handler/ path
// stores and docs/ops/deploy-workflow.test.mjs asserts. These tests pin
// that config.ts reads exactly that deploy-rendered name, so provider
// `google` actually receives its credential in production; a rename on
// either side of the contract turns this suite red instead of silently
// stranding the key.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.ts";

const BASE_REQUIRED_ENV = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "anon-key",
  TOOLBELT_GITHUB_INTAKE_PAT: "ghp_fixture",
};

/** loadConfig(env) reads its optional keys from the passed env, but its
 * required() helper reads process.env directly (pre-existing behavior) --
 * so the three startup-required vars are temporarily placed on
 * process.env here, and restored after. Same shape as
 * broker-drivers.test.ts's helper. */
function withRequiredProcessEnv<T>(run: () => T): T {
  const saved = new Map(Object.entries(BASE_REQUIRED_ENV).map(([key]) => [key, process.env[key]] as const));
  Object.assign(process.env, BASE_REQUIRED_ENV);
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadConfig: provider google reads LLM_KEYS_GEMINI -- the exact name deploy.yml renders and Infisical stores (issue #337)", () => {
  const config = withRequiredProcessEnv(() =>
    loadConfig({ ...BASE_REQUIRED_ENV, LLM_KEYS_GEMINI: "gemini-key-from-deploy" }),
  );
  assert.deepEqual(config.llmCredentials.google, { apiKey: "gemini-key-from-deploy" });
});

test("loadConfig: LLM_KEYS_GOOGLE is not read -- the pre-#337 name must stay dead, not become a second alias", () => {
  const config = withRequiredProcessEnv(() =>
    loadConfig({ ...BASE_REQUIRED_ENV, LLM_KEYS_GOOGLE: "stale-name-never-rendered-by-deploy" }),
  );
  assert.equal(config.llmCredentials.google, undefined);
});

test("loadConfig: anthropic and openai env-var names are unchanged, and each provider stays independently optional", () => {
  const config = withRequiredProcessEnv(() =>
    loadConfig({
      ...BASE_REQUIRED_ENV,
      LLM_KEYS_ANTHROPIC: "anthropic-key",
      LLM_KEYS_OPENAI: "openai-key",
    }),
  );
  assert.deepEqual(config.llmCredentials, {
    anthropic: { apiKey: "anthropic-key" },
    openai: { apiKey: "openai-key" },
  });
});
