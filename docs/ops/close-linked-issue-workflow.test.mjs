// Structural + behavioral assertions over .github/workflows/close-linked-issue.yml.
//
// Issue #267: a PR whose description contains a Closes/Fixes/Resolves
// reference, merged through PR Gate's armed native squash auto-merge, does
// not reliably auto-close the referenced Issue -- 4 of 5 recent PRs in this
// repo's own history needed a manual close, with the Issue's own
// closed_by_pull_requests record correctly naming the merged PR in every
// failing case, ruling out a linkage/detection problem this repo could fix.
// This workflow is the deterministic fallback the Issue's own acceptance
// criteria sanctions: on every commit landing on main, explicitly close
// whatever its originating merged PR's body names, skipping anything
// already closed so it never fights GitHub's own mechanism on the cases
// where that DOES work (#249/#259).
//
// It triggers on push, not pull_request(closed): pr-verify.yml is the ONLY
// workflow this repo permits to trigger on pull_request(_target)
// (docs/ops/pr-verify-workflow.test.mjs's own "pr-verify.yml is the only
// PR-triggered workflow" test enforces this mechanically), because a
// second one adds an uncontrollable PR check row. A structural test below
// pins that this file never adds one back.
//
// The behavioral tests extract the real embedded script and execute it
// against a mocked GitHub API, the same discipline every other workflow
// test file in this directory uses -- a structural grep cannot tell a real
// already-closed guard from one whose check was quietly deleted.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/close-linked-issue.yml");
const workflowYaml = readFileSync(workflowPath, "utf8");

function extractScript(yamlText) {
  const markerIndex = yamlText.indexOf("script: |");
  assert.ok(markerIndex >= 0, "no `script: |` block found");
  const afterMarker = yamlText.slice(markerIndex + "script: |".length);
  const lines = afterMarker.split("\n").slice(1);

  let blockIndent = null;
  const collected = [];
  for (const line of lines) {
    if (line.trim() === "") {
      collected.push(line);
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) break;
    collected.push(line);
  }

  const nonEmpty = collected.filter((line) => line.trim() !== "");
  const commonIndent = Math.min(...nonEmpty.map((line) => line.match(/^ */)[0].length));
  return collected.map((line) => (line.trim() === "" ? "" : line.slice(commonIndent))).join("\n");
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadCloseScript() {
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(workflowYaml));
}

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

test("close-linked-issue.yml triggers on push to main only, never pull_request(_target)", () => {
  const onBlock = workflowYaml.slice(workflowYaml.indexOf("\non:"), workflowYaml.indexOf("\npermissions:"));
  assert.match(onBlock, /push:/);
  assert.match(onBlock, /branches:\s*\[main\]/);
  assert.doesNotMatch(onBlock, /pull_request/);
});

test("close-linked-issue.yml is not counted as a second PR-triggered workflow", () => {
  // Rerun of docs/ops/pr-verify-workflow.test.mjs's own scoped-`on:`-block
  // scan, pinned here too so a regression shows up right next to the file
  // that motivated the push-not-pull_request design in the first place.
  const start = workflowYaml.indexOf("\non:");
  const rest = workflowYaml.slice(start + 1);
  const endMatch = /\n(?=[A-Za-z_-]+:)/.exec(rest.slice(3));
  const onBlock = endMatch ? rest.slice(0, 3 + endMatch.index) : rest;
  assert.doesNotMatch(onBlock, /^\s{2}pull_request(_target)?:/m);
});

test("close-linked-issue.yml never holds a write token beyond issues: write", () => {
  const permissionsMatch = workflowYaml.match(/\npermissions:\n((?:\s{2}.+\n)+)/);
  assert.ok(permissionsMatch, "no top-level permissions block found");
  const block = permissionsMatch[1];
  assert.match(block, /issues:\s*write/);
  assert.doesNotMatch(block, /contents:\s*write/);
  assert.doesNotMatch(block, /pull-requests:\s*write/);
});

test("close-linked-issue.yml's action reference is pinned to a 40-hex SHA with a version comment", () => {
  const pattern = /^\s*uses:\s*(\S+)/gm;
  for (const match of workflowYaml.matchAll(pattern)) {
    const ref = match[1];
    assert.match(ref, /@[0-9a-f]{40}$/, `unpinned action reference: ${ref}`);
    const line = workflowYaml.slice(match.index, workflowYaml.indexOf("\n", match.index));
    assert.match(line, /# v[0-9]/, `missing version comment: ${line.trim()}`);
  }
});

// ---------------------------------------------------------------------------
// Behavioral
// ---------------------------------------------------------------------------

function makeGithub({ associatedPrs = [], issueStates = {}, getThrows = new Set(), updateThrows = new Set() } = {}) {
  const updateCalls = [];
  const getCalls = [];
  const github = {
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: async () => ({ data: associatedPrs }),
      },
      issues: {
        get: async ({ issue_number }) => {
          getCalls.push(issue_number);
          if (getThrows.has(issue_number)) throw new Error(`simulated get failure for #${issue_number}`);
          return { data: { state: issueStates[issue_number] || "open" } };
        },
        update: async (args) => {
          if (updateThrows.has(args.issue_number)) throw new Error(`simulated update failure for #${args.issue_number}`);
          updateCalls.push(args);
        },
      },
    },
  };
  return { github, updateCalls, getCalls };
}

function mergedPr(body, overrides = {}) {
  return { body, merged_at: "2026-08-21T00:00:00Z", ...overrides };
}

async function runClose(opts = {}) {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" }, sha: "a".repeat(40) };
  const infos = [];
  const warnings = [];
  const core = { info: (m) => infos.push(m), warning: (m) => warnings.push(m) };
  const { github, updateCalls, getCalls } = makeGithub(opts);
  const proc = { env: {} };
  await loadCloseScript()(require, context, core, github, proc);
  return { updateCalls, getCalls, infos, warnings };
}

// THE CORE NEW BEHAVIOR (Issue #267). Behavior protected: a commit whose
// associated merged PR names "Closes #N" explicitly closes that Issue,
// exactly the deterministic fallback GitHub's own auto-close should have
// done but, per this repo's own observed history, often doesn't.
test("closes the Issue named by a Closes reference in the commit's merged PR body", async () => {
  const { updateCalls } = await runClose({ associatedPrs: [mergedPr("Fixes a bug.\n\nCloses #268\n")] });
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0], {
    owner: "kgsmith19",
    repo: "hyperbolic-core",
    issue_number: 268,
    state: "closed",
    state_reason: "completed",
  });
});

// Behavior protected: Fixes and Resolves are recognized too, matching
// verify-pr-description's own convention exactly rather than a narrower
// Closes-only pattern -- and more than one reference closes every one of
// them, deduplicated.
test("recognizes Fixes and Resolves too, in any case, and closes every distinct Issue named", async () => {
  const { updateCalls } = await runClose({ associatedPrs: [mergedPr("FIXES #10 and also resolves #11. Also closes #10 again.")] });
  assert.equal(updateCalls.length, 2);
  const closedNumbers = updateCalls.map((call) => call.issue_number).sort((a, b) => a - b);
  assert.deepEqual(closedNumbers, [10, 11]);
});

// Behavior protected: a commit with no associated MERGED pull request (a
// direct push, or an associated PR that is still open/closed-unmerged) is
// a clean no-op -- this must never treat an unmerged PR's body as a
// closing instruction.
test("does nothing when no associated pull request is merged", async () => {
  const { updateCalls, getCalls, infos } = await runClose({
    associatedPrs: [{ body: "Closes #99", merged_at: null }],
  });
  assert.equal(updateCalls.length, 0);
  assert.equal(getCalls.length, 0);
  assert.ok(infos.some((message) => message.includes("no merged pull request")));
});

// NEGATIVE CONTROL. Behavior protected: an Issue already closed (GitHub's
// own mechanism worked, or someone closed it by hand) is left alone -- this
// workflow must cover for the platform gap, never fight a correct outcome
// or generate a redundant API call against an Issue nothing is wrong with.
test("skips an Issue that is already closed, without calling update", async () => {
  const { updateCalls, infos } = await runClose({
    associatedPrs: [mergedPr("Closes #249")],
    issueStates: { 249: "closed" },
  });
  assert.equal(updateCalls.length, 0);
  assert.ok(infos.some((message) => message.includes("already closed")));
});

// Behavior protected: no closing reference at all in any associated merged
// PR is a normal, silent no-op.
test("does nothing when the merged PR body has no Closes/Fixes/Resolves reference", async () => {
  const { updateCalls, getCalls } = await runClose({ associatedPrs: [mergedPr("Just a quick fix, no issue reference.")] });
  assert.equal(updateCalls.length, 0);
  assert.equal(getCalls.length, 0);
});

// Behavior protected: a null/missing PR body (never actually happens once
// verify-pr-description is enforced, but this script has no such
// precondition of its own) does not throw.
test("a merged pull request with no body at all does not throw", async () => {
  const { updateCalls } = await runClose({ associatedPrs: [mergedPr(null)] });
  assert.equal(updateCalls.length, 0);
});

// Behavior protected: a failure closing one referenced Issue (API error,
// deleted Issue, permissions) warns and continues to the next one, rather
// than throwing and leaving every later reference unprocessed. The commit
// is already on main by the time this runs -- this is best-effort
// bookkeeping, not a gate, and must never fail the job.
test("a failure on one referenced Issue warns and still processes the rest", async () => {
  const { updateCalls, warnings } = await runClose({
    associatedPrs: [mergedPr("Closes #1 and closes #2")],
    updateThrows: new Set([1]),
  });
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].issue_number, 2);
  assert.ok(warnings.some((message) => message.includes("#1") && message.includes("simulated update failure")));
});

// Behavior protected: a failure just reading one referenced Issue (e.g. it
// was deleted, or is in a repo this token can't see) is caught the same
// way an update failure is -- it must not abort processing the rest.
test("a failure reading one referenced Issue warns and still processes the rest", async () => {
  const { updateCalls, warnings } = await runClose({
    associatedPrs: [mergedPr("Closes #1 and closes #2")],
    getThrows: new Set([1]),
  });
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].issue_number, 2);
  assert.ok(warnings.some((message) => message.includes("#1") && message.includes("simulated get failure")));
});

// Behavior protected: more than one merged PR can be associated with the
// same commit in principle (GitHub returns every PR whose head reached
// this commit) -- references from every merged one are honored, not just
// the first.
test("merges references from every merged pull request associated with the commit", async () => {
  const { updateCalls } = await runClose({
    associatedPrs: [mergedPr("Closes #1"), mergedPr("Closes #2"), { body: "Closes #3", merged_at: null }],
  });
  const closedNumbers = updateCalls.map((call) => call.issue_number).sort((a, b) => a - b);
  assert.deepEqual(closedNumbers, [1, 2]);
});
