/**
 * claude-code adapter (07-brain-architecture.md section 7.4: "ships
 * complete"). Spawns the ACC kernel as a subprocess -- `node
 * <kernelRunPath> <contract.json>` -- never invokes `claude` directly; the
 * kernel owns everything about talking to the harness (settings, guards,
 * budget supervision, verification). This module's only job is: map
 * brain.task.v1 -> the kernel's own contract shape (kernel-contract.ts),
 * spawn, capture the one JSON line the kernel prints to stdout on exit,
 * and hand it back as a HarnessSession for result-mapper.ts to interpret.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AdapterInvocation, HarnessAdapter, HarnessSession, ProbeResult } from "./types.ts";
import { mapTaskContractToKernelContract } from "../kernel-contract.ts";
import type { TaskContractV1 } from "../contracts.ts";

const execFileAsync = promisify(execFile);

export interface ClaudeCodeAdapterConfig {
  /** Absolute path to apps/agentic-command-center/backend/kernel/run.mjs. */
  kernelRunPath: string;
  /** ACC_ROOT: an isolated tree for the Brain's own ledger/kernel-runs
   * scratch state (07 section 7.6's telemetry mirror is separate; this is
   * purely ACC's own runner/ledger directory, kept out of any live ACC
   * checkout the operator uses interactively). */
  accRoot: string;
  /** ACC_POLICY: a policy.json the Brain controls, with kernel.harness set
   * to "claude-code" -- the kernel itself has no per-invocation harness
   * override; harness selection is entirely this file's value. */
  accPolicy: string;
  /** ACC_VAULT: a vault.json holding the Brain's own dedicated, isolated
   * Anthropic key under ANTHROPIC_API_KEY (ADR-05) plus any other
   * constraints.vault_keys names a task's contract lists. */
  accVault: string;
}

/** kernel/adapters/claude-code.mjs's own identity() check, reimplemented
 * here rather than imported: apps/agentic-command-center is a sibling app
 * spawned as a subprocess tree, not an npm dependency of services/brain
 * (ADR-05/07 section 7.3's isolation boundary), so this file never
 * statically imports kernel code -- only spawns it. */
async function probeClaudeCli(): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 15_000, encoding: "utf8" });
    const match = stdout.match(/\d+\.\d+\.\d+/);
    return match ? { ok: true, version: match[0] } : { ok: false, version: "" };
  } catch {
    return { ok: false, version: "" };
  }
}

interface KernelRunResult {
  runId: string | null;
  outcome: "accepted" | "rejected" | "aborted-by-budget" | "failed-to-start" | "refused";
  errors?: string[];
  error?: string;
  harness?: unknown;
  criteria?: unknown;
  tokens?: number;
  decisions?: unknown;
  wallClockMs?: number;
  dimension?: string;
}

function parseKernelStdout(stdout: string): KernelRunResult {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) throw new Error("claude-code adapter: kernel produced no stdout to parse");
  return JSON.parse(lastLine) as KernelRunResult;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code" as const;
  #config: ClaudeCodeAdapterConfig;
  #inFlight = new Map<string, ChildProcess>();

  constructor(config: ClaudeCodeAdapterConfig) {
    this.#config = config;
  }

  async probe(): Promise<ProbeResult> {
    return probeClaudeCli();
  }

  async start(inv: AdapterInvocation): Promise<HarnessSession> {
    const contract = JSON.parse(readFileSync(inv.contractPath, "utf8")) as TaskContractV1;
    return this.#runKernel(inv, contract);
  }

  /** kernel/run.mjs's CLI mints a fresh session (runId) on every
   * invocation and has no subprocess-level resume path (only its
   * in-process sendStep() does, which this file cannot reach without
   * importing kernel code -- see this file's header comment on why it
   * doesn't). Honestly refusing rather than silently starting a fresh,
   * unrelated session under the old sessionId. */
  async resume(): Promise<HarnessSession> {
    throw new Error(
      "claude-code adapter: session resume is not supported yet -- the ACC kernel's subprocess CLI (kernel/run.mjs) always starts a fresh run, it has no --resume path; only its in-process sendStep() API does, which this adapter does not call"
    );
  }

  async cancel(sessionId: string, deadlineMs: number): Promise<void> {
    const child = this.#inFlight.get(sessionId);
    if (!child || child.pid === undefined) return;
    // Same discipline as runner/runner.mjs's killTree (07 section 7.3):
    // SIGTERM the whole process group first (the child is spawned
    // detached, so it is its own group leader), then SIGKILL if it hasn't
    // exited by the deadline.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
        resolve();
      }, deadlineMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async #runKernel(inv: AdapterInvocation, contract: TaskContractV1): Promise<HarnessSession> {
    const kernelContract = mapTaskContractToKernelContract(contract, inv.worktreePath, inv.invocationId);
    const stagingDir = mkdtempSync(path.join(os.tmpdir(), "brain-kernel-contract-"));
    const contractFile = path.join(stagingDir, "contract.json");
    writeFileSync(contractFile, JSON.stringify(kernelContract, null, 2));

    const sessionId = randomUUID();
    try {
      const { stdout, stderr, outcomeExitCode } = await this.#spawnKernel(contractFile, sessionId, inv);
      let parsed: KernelRunResult;
      try {
        parsed = parseKernelStdout(stdout);
      } catch (err) {
        // The kernel exited but printed nothing parseable -- from the
        // Brain's point of view this is exactly as unaccounted-for as the
        // harness child never checking in: 07 section 7.4's `orphaned`
        // classification.
        return {
          sessionId,
          outcome: "orphaned",
          raw: { error: err instanceof Error ? err.message : String(err), stdout, stderr, exitCode: outcomeExitCode },
        };
      }
      return { sessionId: parsed.runId ?? sessionId, outcome: parsed.outcome, raw: parsed };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
      this.#inFlight.delete(sessionId);
    }
  }

  #spawnKernel(
    contractFile: string,
    sessionId: string,
    inv: AdapterInvocation
  ): Promise<{ stdout: string; stderr: string; outcomeExitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.#config.kernelRunPath, contractFile], {
        detached: true,
        env: {
          ...process.env,
          ACC_ROOT: this.#config.accRoot,
          ACC_POLICY: this.#config.accPolicy,
          ACC_VAULT: this.#config.accVault,
          // 07 section 7.9: "run_id -> task_id -> invocation_id propagate
          // into kernel env" -- the kernel process itself doesn't read
          // these today (it mints its own runId, kernel/run.mjs's own
          // header comment), but any subprocess-of-the-subprocess the
          // harness spawns (or a future kernel-side log line) can pick
          // them up from its own environment without a code change on
          // this side of the boundary.
          BRAIN_RUN_ID: inv.runId,
          BRAIN_TASK_ID: inv.taskId,
          BRAIN_INVOCATION_ID: inv.invocationId,
        },
      });
      this.#inFlight.set(sessionId, child);

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        // spawn itself failed (ENOENT, etc): a transport-class failure per
        // 07 section 7.4's own taxonomy (never a logic failure -- the
        // harness never ran at all).
        reject(new Error(`claude-code adapter: failed to spawn kernel: ${err.message}`));
      });
      child.on("exit", (code) => {
        resolve({ stdout, stderr, outcomeExitCode: code });
      });
    });
  }
}
