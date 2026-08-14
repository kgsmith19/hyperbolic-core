// Env var contract for the Brain daemon. Fails fast at process startup
// (ADR-05's deploy-time env-injection convention), matching
// services/llm-handler/src/config.ts's own posture.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface BrainConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly dataDir: string;
  /** 07 section 7.4: `/workspaces/<repo>/wt-<task_id>`. */
  readonly workspacesRoot: string;
  /** m4-10: where dispatch spawns the ACC kernel from and what isolated
   * ACC_ROOT/ACC_POLICY/ACC_VAULT it hands the subprocess -- see
   * adapters/claude-code.ts's own doc comment for what each means. */
  readonly kernelRunPath: string;
  readonly accRoot: string;
  readonly accPolicy: string;
  readonly accVault: string;
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
  const workspacesRoot = env.BRAIN_WORKSPACES_ROOT ?? "/workspaces";
  // Default kernelRunPath assumes the monorepo layout is preserved
  // relative to this file (services/brain/src/config.ts ->
  // apps/agentic-command-center/kernel/run.mjs) -- true both in a local
  // dev checkout and in the Docker image, which COPYs
  // apps/agentic-command-center alongside services/brain (see
  // Dockerfile). Overridable for any deployment shape that doesn't match.
  const kernelRunPath = env.BRAIN_KERNEL_RUN_PATH ?? path.resolve(HERE, "..", "..", "..", "apps", "agentic-command-center", "kernel", "run.mjs");
  const accRoot = env.BRAIN_ACC_ROOT ?? `${dataDir.replace(/\/+$/, "")}/acc-root`;
  const accPolicy = env.BRAIN_ACC_POLICY ?? `${accRoot}/policy.json`;
  const accVault = env.BRAIN_ACC_VAULT ?? `${accRoot}/vault.json`;
  return { port, dbPath, dataDir, workspacesRoot, kernelRunPath, accRoot, accPolicy, accVault };
}
