// Additive integration point (issue #186, owner-directed scope: "Build code
// only, don't touch live deploy env"): demonstrates that Handler A CAN route
// its Anthropic calls through services/broker via packages/llm's existing
// `OrchestrationOptions.drivers` seam, without changing this service's
// actual default request path at all.
//
// Deliberately NOT called from index.ts, server.ts, config.ts's
// loadConfig(), or llm-routes.ts's own `complete(request, config.llmCredentials, {})`
// call site -- every one of those stays exactly as it was before this
// Issue. `LLM_KEYS_ANTHROPIC` remains this service's own live credential
// until an explicit, separate, owner-directed cutover replaces this
// no-op-by-default wiring with the real thing.

import { anthropicViaBrokerDriver, type Credentials, type LlmDriver, type Provider } from "@hyperbolic/llm";

export interface BrokerDriverConfig {
  /** The broker's own listen address, e.g. "http://127.0.0.1:8300". */
  brokerBaseUrl: string;
  /** services/broker's own caller-auth token for this process (ProxyRequestBody.token). */
  brokerCallerToken: string;
}

/** Reads BROKER_URL / BROKER_CALLER_TOKEN from env; returns undefined (not a
 * thrown error) when either is unset -- this integration point is optional
 * by design, matching every other dark-until-provisioned credential in this
 * service, and its absence must never block Handler A's own startup. */
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
