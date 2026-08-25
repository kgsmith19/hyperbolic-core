// Env var contract for the intake tenant and Handler A's own /v1/* LLM
// routes (m4-05). Fails fast at process startup, not per-request: a missing
// credential should crash the container before it ever binds a port, not
// surface as an intermittent 500 (ADR-05's deploy-time env-injection
// convention, docs/ops/runbook.md).

import type { CredentialsByProvider, Provider } from "@hyperbolic/llm";
import type { HandlerConfig } from "./types.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`services/llm-handler: missing required environment variable ${name}`);
  }
  return value;
}

// 08 section 5's configuration skeleton lists LLM_KEYS_ANTHROPIC,
// LLM_KEYS_OPENAI, LLM_KEYS_GOOGLE, each independently optional here: a
// deploy that has not yet provisioned every provider still starts, and a
// request naming an unconfigured provider fails per-request at
// packages/llm's own getCredentials() ("no credentials supplied for
// provider ...", invalid_request) rather than crashing the whole process.
const LLM_KEY_ENV_VARS: Record<Provider, string> = {
  anthropic: "LLM_KEYS_ANTHROPIC",
  openai: "LLM_KEYS_OPENAI",
  google: "LLM_KEYS_GOOGLE",
};

function loadLlmCredentials(env: NodeJS.ProcessEnv): CredentialsByProvider {
  const credentials: CredentialsByProvider = {};
  for (const [provider, envVar] of Object.entries(LLM_KEY_ENV_VARS) as [Provider, string][]) {
    const apiKey = env[envVar];
    if (apiKey) {
      credentials[provider] = { apiKey };
    }
  }
  return credentials;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HandlerConfig {
  const port = Number(env.LLM_HANDLER_PORT ?? "8200");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`services/llm-handler: LLM_HANDLER_PORT must be a valid port number, got ${env.LLM_HANDLER_PORT}`);
  }
  const maxConcurrencyPerCaller = Number(env.LLM_MAX_CONCURRENCY_PER_CALLER ?? "2");
  if (!Number.isInteger(maxConcurrencyPerCaller) || maxConcurrencyPerCaller <= 0) {
    throw new Error(
      `services/llm-handler: LLM_MAX_CONCURRENCY_PER_CALLER must be a positive integer, got ${env.LLM_MAX_CONCURRENCY_PER_CALLER}`
    );
  }
  return {
    port,
    supabaseUrl: required("SUPABASE_URL"),
    supabasePublishableKey: required("SUPABASE_PUBLISHABLE_KEY"),
    githubIntakePat: required("TOOLBELT_GITHUB_INTAKE_PAT"),
    llmCredentials: loadLlmCredentials(env),
    llmMaxConcurrencyPerCaller: maxConcurrencyPerCaller,
    // SUPABASE_SERVICE_ROLE_KEY is read separately by index.ts and passed
    // through SubmitDeps.serviceRoleKey (intake-submit.ts), never folded
    // into this shared HandlerConfig -- the /v1/* LLM routes added by
    // m4-05 log through core.log_llm_call() on the caller's own bearer
    // token (postgrest.ts/llm-call-log.ts), the same FR-007 RPC convention
    // core.log_run's callers already use, so they never need it either.
  };
}

export function requiredServiceRoleKey(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) {
    throw new Error("services/llm-handler: missing required environment variable SUPABASE_SERVICE_ROLE_KEY");
  }
  return value;
}
