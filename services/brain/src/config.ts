// Env var contract for the Brain daemon. Fails fast at process startup
// (ADR-05's deploy-time env-injection convention), matching
// services/llm-handler/src/config.ts's own posture.

export interface BrainConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly dataDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const port = Number(env.BRAIN_PORT ?? "8100");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`services/brain: BRAIN_PORT must be a valid port number, got ${env.BRAIN_PORT}`);
  }
  // /data/brain.db is the production default (07 section 7.6); overridable
  // so tests and a non-container dev run don't touch a real data volume.
  const dataDir = env.BRAIN_DATA_DIR ?? "/data";
  const dbPath = env.BRAIN_DB_PATH ?? `${dataDir.replace(/\/+$/, "")}/brain.db`;
  return { port, dbPath, dataDir };
}
