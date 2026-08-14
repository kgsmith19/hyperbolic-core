/**
 * The Brain's own independently-executed acceptance verification
 * (07-brain-architecture.md section 7.5's "completed" definition, BR-2:
 * "verification is never delegated to the harness that did the work").
 * Runs each acceptance[].verify command in the task's worktree AFTER the
 * harness has exited, timing each one out at its own timeout_s.
 *
 * This is a BACKSTOP, not a duplicate of the ACC kernel's own
 * verifyAll() (kernel/verifier.mjs): the kernel already runs the exact
 * same criteria independently of the harness (it reads the filesystem
 * directly, never the harness's own self-report) immediately after the
 * harness exits, which already satisfies BR-2's principle for the
 * claude-code path -- dispatch.ts trusts that report when it exists
 * (non-empty) rather than re-running the same commands a second time for
 * no reason. This module exists for two things the kernel's own verifier
 * does NOT do: (1) a fallback for any adapter that reports no
 * verification of its own (a future non-kernel harness, or a claude-code
 * run whose own criteria came back empty for some other reason), so
 * verification is never silently skipped; (2) the "worktree clean or
 * committed" check (condition 2 of the completed definition), which
 * nothing else in this codebase checks at all.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { TaskContractV1 } from "./contracts.ts";
import type { ResultContractV1 } from "./contracts.ts";
import { resolveVerifyCwd } from "./kernel-contract.ts";

export type Verdict = ResultContractV1["verdicts"][number];

interface CommandResult {
  exit: number;
  output: string;
  timedOut: boolean;
}

function runCommand(command: string, cwd: string, timeoutS: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { cwd, shell: true, detached: true });
    } catch (err) {
      resolve({ exit: -1, output: `spawn error: ${err instanceof Error ? err.message : String(err)}`, timedOut: false });
      return;
    }

    let output = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, Math.max(1, timeoutS) * 1000);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exit: -1, output: `spawn error: ${err.message}`, timedOut: false });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exit: code ?? -1, output, timedOut });
    });
  });
}

/** Runs every brain.task.v1 acceptance[].verify command for real, in the
 * worktree, honoring each one's own timeout_s. An empty acceptance array
 * (m4-09's skeleton planner default) gets the same trivial "worktree
 * still exists" placeholder kernel-contract.ts synthesizes for the
 * kernel's own non-empty requirement -- kept consistent between the two
 * so the Brain's own opinion never contradicts the kernel's for the
 * identical no-criteria case. */
export async function runVerification(contract: TaskContractV1, worktreePath: string): Promise<Verdict[]> {
  if (contract.acceptance.length === 0) {
    const pass = existsSync(worktreePath);
    return [{ id: "AC-worktree-exists", pass, exit: pass ? 0 : 1, output_tail: worktreePath }];
  }

  const verdicts: Verdict[] = [];
  for (const criterion of contract.acceptance) {
    const cwd = resolveVerifyCwd(worktreePath, criterion.verify.cwd);
    const { exit, output, timedOut } = await runCommand(criterion.verify.command, cwd, criterion.verify.timeout_s);
    const pass = !timedOut && exit === criterion.verify.expect_exit;
    const tailPrefix = timedOut ? `TIMEOUT after ${criterion.verify.timeout_s}s -- process killed\n` : "";
    verdicts.push({ id: criterion.id, pass, exit, output_tail: `${tailPrefix}${output}`.slice(-2000) });
  }
  return verdicts;
}

/** Condition 2 of 07 section 7.5's completed definition: "the worktree is
 * clean or committed per deliverable". A dirty (uncommitted-changes)
 * worktree fails this regardless of how the acceptance criteria came
 * out -- the deliverable itself was never actually finished. */
export async function isWorktreeCleanOrCommitted(worktreePath: string): Promise<boolean> {
  const { exit, output, timedOut } = await runCommand("git status --porcelain", worktreePath, 30);
  return exit === 0 && !timedOut && output.trim().length === 0;
}
