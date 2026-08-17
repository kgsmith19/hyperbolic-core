// Env var contract for the broker skeleton (issue #185). Fails fast at
// process startup, not per-request: an invalid port or an unreadable/invalid
// policy file should crash the container before it ever binds a port
// (ADR-05's deploy-time env-injection convention, matching
// services/llm-handler/src/config.ts's own "fails fast" rule).

export interface BrokerConfig {
  port: number;
  policyPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const port = Number(env.BROKER_PORT ?? "8300");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`services/broker: BROKER_PORT must be a valid port number, got ${env.BROKER_PORT}`);
  }
  // Defaults to a path relative to the process's own working directory
  // (the box runs the container with WORKDIR /app, so this resolves to
  // /app/broker-policy.json in production) -- overridable for tests and for
  // an eventual deploy step that ships the generated policy to a different
  // path.
  const policyPath = env.BROKER_POLICY_PATH ?? "broker-policy.json";
  return { port, policyPath };
}
