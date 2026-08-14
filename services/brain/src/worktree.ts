/**
 * One git worktree per task (07-brain-architecture.md section 7.4): created
 * before dispatch, removed after result persistence. Concurrent tasks never
 * share a worktree because each one's path is namespaced by task_id, and
 * MAX_CONCURRENT_DISPATCH (scheduler.ts) caps how many can exist at once
 * regardless.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface WorktreeExecFn {
  (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>;
}

const defaultExec: WorktreeExecFn = (args, cwd) => execFileAsync("git", args, { cwd });

/** Two tasks against the SAME repo dispatched concurrently (N=2 cap,
 * scheduler.ts) both reach createWorktree() at once; without serializing
 * the bare-mirror clone/fetch step, both see `!existsSync(bare)`
 * simultaneously and race `git clone --bare` into the identical path,
 * and the loser fails outright. A directory-based lock (`mkdir` is atomic
 * even across processes on the same filesystem) makes that one step
 * exclusive; the `git worktree add` calls after it are safe to run
 * concurrently on their own -- git already serializes those internally
 * per bare repo. */
async function withRepoLock<T>(bare: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${bare}.lock`;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** `<workspacesRoot>/<repoDirName>/wt-<taskId>` -- repoDirName is derived
 * from the repo URL's last path segment (minus a trailing .git), matching
 * 07 section 7.4's own example path shape (`/workspaces/<repo>/wt-<task_id>`). */
export function worktreePath(workspacesRoot: string, repoUrl: string, taskId: string): string {
  const last = repoUrl.replace(/\/+$/, "").split("/").pop() ?? "repo";
  const repoDirName = last.replace(/\.git$/, "") || "repo";
  return path.join(workspacesRoot, repoDirName, `wt-${taskId}`);
}

/** The bare (non-worktree) clone every task's worktree is added from --
 * one per repo, shared across tasks, itself never written to directly by a
 * harness (worktrees are). Created with `git clone --bare` on first use. */
export function bareRepoPath(workspacesRoot: string, repoUrl: string): string {
  const last = repoUrl.replace(/\/+$/, "").split("/").pop() ?? "repo";
  const repoDirName = last.replace(/\.git$/, "") || "repo";
  return path.join(workspacesRoot, `${repoDirName}.git`);
}

export interface CreateWorktreeParams {
  workspacesRoot: string;
  repoUrl: string;
  repoRef: string;
  taskId: string;
  exec?: WorktreeExecFn;
}

/** Ensures the bare mirror clone exists (cloning/fetching as needed), then
 * adds a worktree at a fresh branch checked out from repoRef. Idempotent
 * per-repo setup, never idempotent per-task (a worktree path is only ever
 * created once per task_id; a second call for the same task_id is a bug
 * upstream, not something this function silently tolerates). */
export async function createWorktree(params: CreateWorktreeParams): Promise<string> {
  const exec = params.exec ?? defaultExec;
  const bare = bareRepoPath(params.workspacesRoot, params.repoUrl);
  const wtPath = worktreePath(params.workspacesRoot, params.repoUrl, params.taskId);

  // The Dockerfile pre-creates /workspaces (config.ts's own default) as a
  // VOLUME for the real production container, but nothing guarantees it
  // exists for every caller -- a bare CI runner in particular has no such
  // directory. store.ts/journal.ts already mkdirSync their own directory
  // before first use for exactly this reason; withRepoLock's own
  // mkdirSync(lockDir) below needs workspacesRoot itself to already exist
  // (a non-recursive mkdir fails on a missing parent), so this has to run
  // first, not be left to whichever caller happens to remember it.
  mkdirSync(params.workspacesRoot, { recursive: true });

  await withRepoLock(bare, async () => {
    if (!existsSync(bare)) {
      await exec(["clone", "--bare", params.repoUrl, bare], params.workspacesRoot);
    } else {
      await exec(["fetch", "origin", "+refs/heads/*:refs/heads/*"], bare);
    }
  });

  if (existsSync(wtPath)) {
    throw new Error(`worktree: ${wtPath} already exists -- refusing to reuse a task's worktree path`);
  }

  // A detached-HEAD checkout at repoRef, not a new branch: the harness's own
  // deliverable.branch (brain/<task_id>) is created by the harness/kernel's
  // git operations inside the worktree, not by worktree setup itself, which
  // only needs to hand over a clean tree at the right starting point.
  await exec(["worktree", "add", "--detach", wtPath, params.repoRef], bare);
  return wtPath;
}

export interface RemoveWorktreeParams {
  workspacesRoot: string;
  repoUrl: string;
  taskId: string;
  exec?: WorktreeExecFn;
  force?: boolean;
}

/** Removed after result persistence (07 section 7.4) -- callers are
 * responsible for calling this only once the task's result row is durably
 * written, never before. `force: true` is used for a worktree the harness
 * may have left with uncommitted changes (a failed/cancelled task) --
 * removal must still succeed so a task's worktree never leaks disk space
 * across runs. */
export async function removeWorktree(params: RemoveWorktreeParams): Promise<void> {
  const exec = params.exec ?? defaultExec;
  const bare = bareRepoPath(params.workspacesRoot, params.repoUrl);
  const wtPath = worktreePath(params.workspacesRoot, params.repoUrl, params.taskId);
  if (!existsSync(wtPath)) return;
  try {
    const args = ["worktree", "remove"];
    if (params.force) args.push("--force");
    args.push(wtPath);
    await exec(args, bare);
  } finally {
    // git worktree remove already deletes the directory on success; this
    // is a defensive backstop for the case it left something behind (e.g.
    // a bare repo that doesn't recognize the worktree, per a corrupted
    // .git/worktrees registration) -- never leaving a stray directory
    // under workspacesRoot is more important than a clean git state here.
    if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
  }
}
