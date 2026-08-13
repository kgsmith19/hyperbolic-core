// Env var contract for the intake tenant. Fails fast at process startup,
// not per-request: a missing credential should crash the container before
// it ever binds a port, not surface as an intermittent 500 (ADR-05's
// deploy-time env-injection convention, docs/ops/runbook.md).

import type { HandlerConfig } from "./types.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`services/llm-handler: missing required environment variable ${name}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HandlerConfig {
  const port = Number(env.LLM_HANDLER_PORT ?? "8200");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`services/llm-handler: LLM_HANDLER_PORT must be a valid port number, got ${env.LLM_HANDLER_PORT}`);
  }
  return {
    port,
    supabaseUrl: required("SUPABASE_URL"),
    supabasePublishableKey: required("SUPABASE_PUBLISHABLE_KEY"),
    githubIntakePat: required("TOOLBELT_GITHUB_INTAKE_PAT"),
    // SUPABASE_SERVICE_ROLE_KEY is read separately by index.ts and passed
    // through SubmitDeps.serviceRoleKey (intake-submit.ts), never folded
    // into this shared HandlerConfig -- it must never be near a code path a
    // future /v1/* LLM route (m4-05) could reach, which never needs it.
  } as HandlerConfig;
}

export function requiredServiceRoleKey(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) {
    throw new Error("services/llm-handler: missing required environment variable SUPABASE_SERVICE_ROLE_KEY");
  }
  return value;
}
