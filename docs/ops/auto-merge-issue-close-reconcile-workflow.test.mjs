// Behavioral contract for the prompt auto-merge Issue closer (Issue #436).
//
// Native auto-merge is armed with GITHUB_TOKEN, so GitHub suppresses the
// resulting pull_request/push workflow events. A workflow_run consumer is
// therefore the narrow, trusted post-gate boundary: it binds the completed
// PR Verification run to the reviewed commit, waits for the live PR to be
// genuinely merged, and only then closes explicit closing-keyword Issues.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/auto-merge-issue-close-reconcile.yml");
const workflow = readFileSync(workflowPath, "utf8");
const REPO = "kgsmith19/hyperbolic-core";
const HEAD_SHA = "a".repeat(40);

function extractScript(yamlText) {
  const marker = "script: |";
  const markerIndex = yamlText.indexOf(marker);
  assert.ok(markerIndex >= 0, "reconciler workflow must contain one github-script block");
  const lines = yamlText.slice(markerIndex + marker.length + 1).split("\n");
  const firstCodeLine = lines.find((line) => line.trim().length > 0);
  assert.ok(firstCodeLine, "reconciler script must not be empty");
  const indent = firstCodeLine.match(/^ */)[0].length;
  const body = [];
  for (const line of lines) {
    if (line.trim().length > 0 && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadReconciler() {
  // The production interval stays deliberately nonzero; only the test copy
  // avoids sleeping while exercising the same retry branches.
  const script = extractScript(workflow).replace(
    "const POLL_INTERVAL_MS = 5000;",
    "const POLL_INTERVAL_MS = 0;",
  );
  return new AsyncFunction("context", "github", "core", script);
}

function workflowRun(overrides = {}) {
  return {
    id: 9001,
    name: "PR Verification",
    path: ".github/workflows/pr-verify.yml",
    workflow_id: 335930003,
    event: "pull_request",
    conclusion: "success",
    head_sha: HEAD_SHA,
    head_repository: { full_name: REPO, fork: false },
    ...overrides,
  };
}

function pr(overrides = {}) {
  return {
    number: 777,
    state: "closed",
    merged: true,
    merged_by: { login: "github-actions[bot]", type: "Bot" },
    head: { sha: HEAD_SHA, repo: { full_name: REPO, fork: false } },
    base: { ref: "main", repo: { full_name: REPO, fork: false } },
    body: "Closes #436 and fixes #422",
    ...overrides,
  };
}

function makeMocks({ run = workflowRun(), associated = pr(), live = [pr()], states = {} } = {}) {
  const calls = [];
  const warnings = [];
  const closed = [];
  const comments = [];
  let liveIndex = 0;
  const github = {
    paginate: async (method, args) => {
      assert.equal(method, github.rest.repos.listPullRequestsAssociatedWithCommit);
      assert.equal(args.commit_sha, HEAD_SHA);
      return [associated];
    },
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: async () => ({ data: [associated] }),
      },
      pulls: {
        get: async ({ pull_number }) => {
          calls.push(`pulls.get:${pull_number}`);
          return { data: live[Math.min(liveIndex++, live.length - 1)] };
        },
      },
      issues: {
        get: async ({ issue_number }) => ({ data: { state: states[issue_number] || "open" } }),
        update: async ({ issue_number, state, state_reason }) => {
          closed.push({ issue_number, state, state_reason });
          states[issue_number] = state;
        },
        createComment: async ({ issue_number, body }) => comments.push({ issue_number, body }),
      },
    },
  };
  const core = {
    info() {},
    warning(message) { warnings.push(String(message)); },
    setFailed(message) { throw new Error(message); },
    summary: { addHeading() { return this; }, addRaw() { return this; }, async write() {} },
  };
  const context = {
    repo: { owner: "kgsmith19", repo: "hyperbolic-core" },
    payload: { repository: { full_name: REPO, default_branch: "main" }, workflow_run: run },
  };
  return { context, github, core, calls, warnings, closed, comments };
}

test("auto-merge issue closer is workflow_run-only and has no broader permissions", () => {
  assert.match(workflow, /workflow_run:\s*\n\s+workflows: \["PR Verification"\]\s*\n\s+types: \[completed\]/);
  assert.doesNotMatch(workflow, /pull_request(?:_target)?\s*:/);
  const permissions = workflow.match(/permissions:\n([\s\S]*?)\n\nconcurrency:/)?.[1] || "";
  assert.match(permissions, /^  contents: read$/m);
  assert.match(permissions, /^  pull-requests: read$/m);
  assert.match(permissions, /^  issues: write$/m);
  assert.equal(permissions.split("\n").filter((line) => /^  [a-z-]+: /.test(line)).length, 3);
});

test("auto-merge issue closer closes only explicit linked Issues after the live PR is merged", async () => {
  const m = makeMocks({ live: [pr({ state: "open", merged: false }), pr()] });
  await loadReconciler()(m.context, m.github, m.core);
  assert.equal(m.calls.length, 2, "must wait through the unmerged observation");
  assert.deepEqual(m.closed, [
    { issue_number: 436, state: "closed", state_reason: "completed" },
    { issue_number: 422, state: "closed", state_reason: "completed" },
  ]);
  assert.equal(m.comments.length, 2);
  assert.ok(m.comments.every((comment) => comment.body.includes("issue-close-reconcile:v1")));
});

test("auto-merge issue closer never closes before merge settlement", async () => {
  const unmerged = pr({ state: "open", merged: false });
  const m = makeMocks({ live: [unmerged] });
  await loadReconciler()(m.context, m.github, m.core);
  assert.deepEqual(m.closed, []);
  assert.ok(m.warnings.some((message) => /did not settle as merged/i.test(message)));
});

test("auto-merge issue closer is idempotent for already-closed linked Issues", async () => {
  const m = makeMocks({ states: { 436: "closed", 422: "open" } });
  await loadReconciler()(m.context, m.github, m.core);
  assert.deepEqual(m.closed, [{ issue_number: 422, state: "closed", state_reason: "completed" }]);
  assert.deepEqual(m.comments.map((comment) => comment.issue_number), [422]);
});

test("auto-merge issue closer rejects a forged or forked association before mutation", async () => {
  const forged = pr({ head: { sha: HEAD_SHA, repo: { full_name: "attacker/fork", fork: true } } });
  const m = makeMocks({ associated: forged, live: [forged] });
  await assert.rejects(loadReconciler()(m.context, m.github, m.core), /eligible pull request association/i);
  assert.deepEqual(m.closed, []);
});
