// Real `git` subprocess calls against a local throwaway repo (no network) --
// matching this issue's own verification bullet: "Worktree lifecycle
// integration test (two concurrent fixture tasks; distinct paths; both
// removed)".
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bareRepoPath, createWorktree, removeWorktree, worktreePath } from "../src/worktree.ts";

function initSourceRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-worktree-src-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  run(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "initial"]);
  return dir;
}

function tmpWorkspacesRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-workspaces-"));
}

test("worktreePath/bareRepoPath: namespaced by repo dir name and task id, .git suffix stripped", () => {
  const wp = worktreePath("/workspaces", "https://github.com/kgsmith19/hyperbolic-core.git", "task-1");
  assert.equal(wp, "/workspaces/hyperbolic-core/wt-task-1");
  const bare = bareRepoPath("/workspaces", "https://github.com/kgsmith19/hyperbolic-core.git");
  assert.equal(bare, "/workspaces/hyperbolic-core.git");
});

test("createWorktree: clones a bare mirror on first use and adds a worktree at repoRef", async () => {
  const repo = initSourceRepo();
  const workspacesRoot = tmpWorkspacesRoot();
  const wtPath = await createWorktree({ workspacesRoot, repoUrl: repo, repoRef: "main", taskId: "t1" });
  assert.equal(wtPath, worktreePath(workspacesRoot, repo, "t1"));
  assert.ok(fs.existsSync(path.join(wtPath, "README.md")));
  assert.ok(fs.existsSync(bareRepoPath(workspacesRoot, repo)), "the bare mirror clone must exist");
});

test("createWorktree: creates workspacesRoot itself when it does not yet exist (m6-01: a bare CI runner has no pre-created /workspaces, unlike the Dockerfile's own VOLUME)", async () => {
  const repo = initSourceRepo();
  const workspacesRoot = path.join(tmpWorkspacesRoot(), "not-yet-created", "nested");
  assert.equal(fs.existsSync(workspacesRoot), false);

  const wtPath = await createWorktree({ workspacesRoot, repoUrl: repo, repoRef: "main", taskId: "t1" });

  assert.ok(fs.existsSync(wtPath));
});

test("createWorktree: two concurrent tasks against the same repo get distinct worktree paths, neither shares state", async () => {
  const repo = initSourceRepo();
  const workspacesRoot = tmpWorkspacesRoot();

  const [wtA, wtB] = await Promise.all([
    createWorktree({ workspacesRoot, repoUrl: repo, repoRef: "main", taskId: "task-a" }),
    createWorktree({ workspacesRoot, repoUrl: repo, repoRef: "main", taskId: "task-b" }),
  ]);

  assert.notEqual(wtA, wtB);
  assert.ok(fs.existsSync(wtA));
  assert.ok(fs.existsSync(wtB));

  fs.writeFileSync(path.join(wtA, "only-in-a.txt"), "x");
  assert.equal(fs.existsSync(path.join(wtB, "only-in-a.txt")), false, "concurrent tasks must never share a worktree");

  await Promise.all([
    // task-a's worktree has an untracked file from the isolation check
    // above -- force is required the same way a failed/cancelled task's
    // worktree would need it (removeWorktree's own doc comment).
    removeWorktree({ workspacesRoot, repoUrl: repo, taskId: "task-a", force: true }),
    removeWorktree({ workspacesRoot, repoUrl: repo, taskId: "task-b" }),
  ]);
  assert.equal(fs.existsSync(wtA), false, "task-a's worktree must be removed");
  assert.equal(fs.existsSync(wtB), false, "task-b's worktree must be removed");
});

test("createWorktree: refuses to reuse an already-existing task worktree path", async () => {
  const repo = initSourceRepo();
  const workspacesRoot = tmpWorkspacesRoot();
  await createWorktree({ workspacesRoot, repoUrl: repo, repoRef: "main", taskId: "dup" });
  await assert.rejects(() => createWorktree({ workspacesRoot, repoUrl: repo, repoRef: "main", taskId: "dup" }));
});

test("removeWorktree: a never-created worktree is a silent no-op, not an error", async () => {
  const repo = initSourceRepo();
  const workspacesRoot = tmpWorkspacesRoot();
  // Removal is called on every task teardown, including tasks that never got
  // far enough to create one, so absence must not be an error.
  await assert.doesNotReject(() => removeWorktree({ workspacesRoot, repoUrl: repo, taskId: "never-existed" }));
});

test("removeWorktree: force removes even a worktree with uncommitted changes", async () => {
  const repo = initSourceRepo();
  const workspacesRoot = tmpWorkspacesRoot();
  const wtPath = await createWorktree({ workspacesRoot, repoUrl: repo, repoRef: "main", taskId: "dirty" });
  fs.writeFileSync(path.join(wtPath, "README.md"), "modified, uncommitted\n");
  await removeWorktree({ workspacesRoot, repoUrl: repo, taskId: "dirty", force: true });
  assert.equal(fs.existsSync(wtPath), false);
});
