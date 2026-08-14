// Env var contract for the Brain daemon. Fails fast at process startup
// (ADR-05's deploy-time env-injection convention), matching
// services/llm-handler/src/config.ts's own posture.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOverrides } from "./config-overrides.ts";

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
  /** m4-12 (07 section 7.7's always-approve list). Empty = unconfigured =
   * no repo restriction (autonomy.ts's own documented default -- a
   * deploy that wants this enforced sets it explicitly). */
  readonly repoAllowlist: string[];
  /** Per-run dollar ceiling; any task whose run has already accrued more
   * than this always requires approval regardless of autonomy level. 07
   * doesn't specify a numeric default, so this is a judgment call --
   * documented, overridable. */
  readonly perRunUsdCeiling: number;
  readonly approvalTtlMs: number;
  /** m4-13's `brain refresh-context`: the hyperbolic-core checkout to
   * index (07 section 7.6 -- this is about the Brain's OWN home repo's
   * guidance chain, not an arbitrary task's target repo). Default assumes
   * the monorepo layout relative to this file, same reasoning as
   * kernelRunPath. */
  readonly repoRoot: string;
  /** m4-14's HTTP API auth (ADR-03). Optional/undefined rather than
   * required() (services/llm-handler's own posture): every CLI verb
   * (m4-13) operates on the store directly and has never needed
   * Supabase, so making these required at daemon/CLI startup would
   * break that whole surface for no reason. The API server's own job is
   * refusing every /api/brain/* route with 401 when these aren't
   * configured, not crashing the process. */
  readonly supabaseUrl?: string;
  readonly supabasePublishableKey?: string;
  /** Scoped agent token verification (ADR-03's "scoped agent token"
   * option) -- also optional; a deploy that hasn't provisioned agent
   * tokens yet (true for V1 until m4-20 mints one from LifeOS) simply
   * never has an agent-token credential accepted, owner-session auth
   * still works. */
  readonly agentTokenPublicKeyPem?: string;
  readonly agentTokenIssuer?: string;
  readonly agentTokenAudience?: string;
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

  // m4-13's `brain config set`: env var > persisted override > built-in
  // default. Read after dataDir is known (that's where the override file
  // lives), before it, so an override can't ever affect where itself is
  // stored.
  const overrides = readOverrides(dataDir);

  const repoAllowlist = (env.BRAIN_REPO_ALLOWLIST ?? overrides.BRAIN_REPO_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const perRunUsdCeiling = Number(env.BRAIN_PER_RUN_USD_CEILING ?? overrides.BRAIN_PER_RUN_USD_CEILING ?? "5");
  if (!Number.isFinite(perRunUsdCeiling) || perRunUsdCeiling <= 0) {
    throw new Error(`services/brain: BRAIN_PER_RUN_USD_CEILING must be a positive number, got ${env.BRAIN_PER_RUN_USD_CEILING}`);
  }

  const approvalTtlDays = Number(env.BRAIN_APPROVAL_TTL_DAYS ?? overrides.BRAIN_APPROVAL_TTL_DAYS ?? "7");
  if (!Number.isFinite(approvalTtlDays) || approvalTtlDays <= 0) {
    throw new Error(`services/brain: BRAIN_APPROVAL_TTL_DAYS must be a positive number, got ${env.BRAIN_APPROVAL_TTL_DAYS}`);
  }
  const approvalTtlMs = approvalTtlDays * 24 * 60 * 60 * 1000;

  const repoRoot = env.BRAIN_REPO_ROOT ?? path.resolve(HERE, "..", "..", "..");

  // A PEM key with literal "\n" escapes (the common env-var convention for
  // multi-line secrets, since real newlines are awkward to set in most
  // deploy tooling) is unescaped back to real newlines here; a PEM
  // already containing real newlines (e.g. from a mounted file's
  // contents) passes through unchanged.
  const agentTokenPublicKeyPem = env.BRAIN_AGENT_TOKEN_PUBLIC_KEY?.replace(/\\n/g, "\n");
  const agentTokenIssuer = env.BRAIN_AGENT_TOKEN_ISSUER;
  const agentTokenAudience = env.BRAIN_AGENT_TOKEN_AUDIENCE;

  return {
    port,
    dbPath,
    dataDir,
    workspacesRoot,
    kernelRunPath,
    accRoot,
    accPolicy,
    accVault,
    repoAllowlist,
    perRunUsdCeiling,
    approvalTtlMs,
    repoRoot,
    supabaseUrl: env.SUPABASE_URL,
    supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    agentTokenPublicKeyPem,
    agentTokenIssuer,
    agentTokenAudience,
  };
}
