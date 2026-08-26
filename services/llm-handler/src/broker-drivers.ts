// Broker-routing integration point for Handler A's Anthropic calls, built
// additively under issue #186 ("Build code only, don't touch live deploy
// env") and wired into /api/v1/complete's call site by issue #187 Phase 0
// (the owner-approved broker cutover, 2026-08-26). The wiring is still dark
// until BROKER_URL/BROKER_CALLER_TOKEN are provisioned: loadConfig()
// carries loadBrokerDriverConfig()'s result as HandlerConfig.broker, and
// llm-routes.ts's handleComplete uses the merged drivers/credentials below
// only when that config is present -- byte-identical behavior when absent.
// /api/v1/stream stays on the direct driver unconditionally (the broker
// buffers whole responses; the broker driver's stream() throws by design).
// `LLM_KEYS_ANTHROPIC` remains this service's own live credential for that
// streaming path -- Phase 0 is a routing proof, not a custody transfer.

import { anthropicViaBrokerDriver, geminiDriver, openaiDriver, type Credentials, type CredentialsByProvider, type LlmDriver, type Provider } from "@hyperbolic/llm";

export interface BrokerDriverConfig {
  /** The broker's own listen address, e.g. "http://127.0.0.1:8300". */
  brokerBaseUrl: string;
  /** services/broker's own caller-auth token for this process (ProxyRequestBody.token). */
  brokerCallerToken: string;
}

/** Reads BROKER_URL / BROKER_CALLER_TOKEN from env; returns undefined (not a
 * thrown error) when either is unset -- this integration point is optional
 * by design, matching every other dark-until-provisioned credential in this
 * service, and its absence must never block Handler A's own startup.
 *
 * Naming asymmetry, deliberate: this caller reads the UNSUFFIXED
 * `BROKER_CALLER_TOKEN` from its own environment (`/platform/llm-handler/`
 * in Infisical), while the broker reads the same secret VALUE as
 * `BROKER_CALLER_TOKEN_LLM_HANDLER` from ITS environment
 * (`/platform/broker/` -- services/broker/src/caller-tokens.ts derives that
 * name from the envelope's `caller`). ADR-05 gives the two identities no
 * shared secret path, so the one token value is provisioned twice, once
 * under each path, under those two different names. */
export function loadBrokerDriverConfig(env: NodeJS.ProcessEnv = process.env): BrokerDriverConfig | undefined {
  const brokerBaseUrl = env.BROKER_URL;
  const brokerCallerToken = env.BROKER_CALLER_TOKEN;
  if (!brokerBaseUrl || !brokerCallerToken) {
    return undefined;
  }
  return { brokerBaseUrl, brokerCallerToken };
}

/** The Credentials value to pass as this call's `anthropic` entry when using
 * the broker-routed driver -- see anthropic-via-broker.ts's own header for
 * why `apiKey` here is the broker's caller-auth token, not a provider key. */
export function brokerCredentials(config: BrokerDriverConfig): Credentials {
  return { apiKey: config.brokerCallerToken, baseUrl: config.brokerBaseUrl };
}

/** An OrchestrationOptions.drivers value with ONLY `anthropic` replaced by
 * the broker-routed driver -- openai/google are left absent so a caller
 * merges this with its own full registry (or complete()'s own defaults)
 * rather than this module silently deciding those providers' routing too. */
export function brokerRoutedDrivers(): Partial<Record<Provider, LlmDriver>> {
  return { anthropic: anthropicViaBrokerDriver };
}

/** The full driver registry for a broker-routed complete() call (issue #187
 * Phase 0). complete()'s `options.drivers` REPLACES its internal default
 * registry outright (DEFAULT_DRIVERS is not exported and never merged), so
 * passing brokerRoutedDrivers() alone would silently drop openai/google
 * routing entirely. Only anthropic has a broker driver today; the other two
 * providers keep the exact direct driver objects packages/llm exports. */
export function brokerMergedDrivers(): Partial<Record<Provider, LlmDriver>> {
  return { anthropic: anthropicViaBrokerDriver, openai: openaiDriver, google: geminiDriver };
}

/** The credentials for a broker-routed complete() call: openai/google keep
 * their real keys (their calls stay direct), while anthropic's slot carries
 * the broker caller token + broker base URL that anthropicViaBrokerDriver
 * expects (see brokerCredentials above). Non-mutating -- the caller's
 * direct-credentials object stays usable for the streaming path. */
export function brokerMergedCredentials(llmCredentials: CredentialsByProvider, config: BrokerDriverConfig): CredentialsByProvider {
  return { ...llmCredentials, anthropic: brokerCredentials(config) };
}
