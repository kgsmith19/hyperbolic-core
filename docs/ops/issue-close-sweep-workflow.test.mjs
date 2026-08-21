// Structural + behavioral assertions over .github/workflows/issue-close-sweep.yml.
//
// This workflow is the rare-case backstop for pr-verify.yml's "PR Gate"
// issue-close fallback (Issue #267, extended by Issue #283's post-arm poll):
// PR Gate polls for a merge inline for up to 2 minutes after arming
// auto-merge, but a merge that completes later than that leaves its linked
// Issue open with nothing left to catch it in that same run, because GitHub
// Actions never fires a new pull_request: closed run for an event caused by
// the job's own default GITHUB_TOKEN. This workflow runs hourly, independent
// of any pull-request event, and re-parses Closes/Fixes/Resolves #N out of
// every PR merged in roughly the last 24 hours, closing the linked Issue
// itself if it is still open.
//
// Two invariants matter here, same reasoning as pr-verify-workflow.test.mjs:
//
//   1. This is schedule-only. It must never add a pull-request check row --
//      a structural test below proves the `on:` block names no pull_request
//      trigger, on top of pr-verify-workflow.test.mjs's own repo-wide
//      "exactly one PR-triggered workflow" assertion.
//   2. It must be idempotent and fault-tolerant: closing an already-closed
//      Issue, or an API failure for one Issue, must never duplicate a
//      close/comment or abort the run for every other PR/Issue in the batch.
//
// The behavioral tests extract the real embedded github-script body and
// execute it against a mocked GitHub API, rather than grepping for expected
// substrings -- the same reasoning pr-verify-workflow.test.mjs documents: a
// structural check cannot tell a real idempotency guard from one that was
// quietly deleted.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/issue-close-sweep.yml");
const workflow = readFileSync(workflowPath, "utf8");

// General "script: |" block extractor, matching pr-verify-workflow.test.mjs's
// own convention: this file has exactly one script block and nothing follows
// it, so taking the first occurrence and slicing to EOF is correct.
function extractScript(yamlText) {
  const markerIndex = yamlText.indexOf("script: |");
  assert.ok(markerIndex >= 0, "issue-close-sweep.yml: no `script: |` block found");
  const body = yamlText.slice(markerIndex + "script: |".length + 1);
  const lines = body.split("\n");
  const indented = lines.filter((line) => line.trim().length > 0);
  const commonIndent = Math.min(...indented.map((line) => line.match(/^ */)[0].length));
  return lines.map((line) => line.slice(commonIndent)).join("\n");
}

// Wrapped as an AsyncFunction body, the same technique
// llm-review-dialogue-workflow.test.mjs uses: actions/github-script executes
// the script as an async function body, so a bare top-level `await` is legal.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadSweepScript() {
  return new AsyncFunction("context", "core", "github", extractScript(workflow));
}

test("issue-close-sweep.yml triggers on schedule only -- no pull_request trigger, adds no PR check row", () => {
  const onBlockStart = workflow.indexOf("\non:");
  assert.ok(onBlockStart >= 0, "no `on:` block found");
  const rest = workflow.slice(onBlockStart + 1);
  const endMatch = /\n(?=[A-Za-z_-]+:)/.exec(rest.slice(3));
  const onBlock = endMatch ? rest.slice(0, 3 + endMatch.index) : rest;

  assert.match(onBlock, /\n {2}schedule:\n/, "must trigger on schedule:");
  assert.match(onBlock, /cron:\s*"0 \* \* \* \*"/, "must run hourly at minute 0");
  assert.doesNotMatch(onBlock, /pull_request/, "must never trigger on pull_request or pull_request_target");
});

test("issue-close-sweep.yml permissions are exactly issues: write and pull-requests: read -- nothing broader", () => {
  const permsStart = workflow.indexOf("\npermissions:");
  assert.ok(permsStart >= 0, "no `permissions:` block found");
  const rest = workflow.slice(permsStart + 1);
  const endMatch = /\n(?=[A-Za-z_-]+:)/.exec(rest.slice(11));
  const permsBlock = endMatch ? rest.slice(0, 11 + endMatch.index) : rest;

  assert.match(permsBlock, /\n {2}issues: write\n/);
  assert.match(permsBlock, /\n {2}pull-requests: read\n/);
  assert.doesNotMatch(permsBlock, /contents:/, "must not grant any contents permission -- this workflow never checks out");
  // Exactly two scoped permissions, nothing else snuck in.
  const grantLines = permsBlock.split("\n").filter((line) => /^ {2}[a-z-]+: \w+/.test(line));
  assert.equal(grantLines.length, 2, `expected exactly 2 permission grants, found: ${grantLines.join(", ")}`);
});

test("issue-close-sweep.yml pins actions/github-script to the exact same version pr-verify.yml uses", () => {
  const prVerify = readFileSync(path.join(root, ".github/workflows/pr-verify.yml"), "utf8");
  const prVerifyPin = prVerify.match(/actions\/github-script@[0-9a-f]{40} # v[0-9.]+/);
  assert.ok(prVerifyPin, "pr-verify.yml: no pinned actions/github-script reference found");
  assert.ok(
    workflow.includes(prVerifyPin[0]),
    `issue-close-sweep.yml must pin actions/github-script to the exact same reference as pr-verify.yml (${prVerifyPin[0]})`
  );
});

test("issue-close-sweep.yml contains exactly one embedded script block", () => {
  const scriptOccurrences = workflow.split("script: |").length - 1;
  assert.equal(scriptOccurrences, 1, "issue-close-sweep.yml must contain exactly one `script: |` block");
});

function makeMocks({ pulls, issuesByNumber = {}, issuesGetErrorFor = [] }) {
  const calls = [];
  const warnings = [];
  const commentsByIssue = new Map();
  const stateByIssue = new Map(Object.entries(issuesByNumber).map(([k, v]) => [Number(k), v.state]));

  const github = {
    rest: {
      pulls: {
        list: async (args) => {
          calls.push("pulls.list");
          assert.equal(args.state, "closed");
          assert.equal(args.sort, "updated");
          assert.equal(args.direction, "desc");
          return { data: pulls };
        },
      },
      issues: {
        get: async ({ issue_number }) => {
          calls.push("issues.get:" + issue_number);
          if (issuesGetErrorFor.includes(issue_number)) {
            throw new Error(`simulated read failure for #${issue_number}`);
          }
          const state = stateByIssue.has(issue_number) ? stateByIssue.get(issue_number) : "open";
          return { data: { number: issue_number, state } };
        },
        update: async ({ issue_number, state, state_reason }) => {
          calls.push(`issues.update:${issue_number}:${state}:${state_reason}`);
          stateByIssue.set(issue_number, state);
        },
        createComment: async ({ issue_number, body }) => {
          calls.push("comment:" + issue_number);
          const list = commentsByIssue.get(issue_number) || [];
          list.push(body);
          commentsByIssue.set(issue_number, list);
        },
      },
    },
  };

  const core = {
    info() {},
    warning(message) {
      warnings.push(message);
    },
    error() {},
    summary: {
      addHeading() {
        return core.summary;
      },
      addRaw(text) {
        core.summary._body = text;
        return core.summary;
      },
      async write() {},
    },
  };

  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };

  return { github, core, context, calls, warnings, commentsByIssue };
}

const run = async (opts) => {
  const m = makeMocks(opts);
  const sweep = loadSweepScript();
  await sweep(m.context, m.core, m.github);
  return m;
};

// A fixed "now" reference so every test in this file computes merged_at
// offsets from the same instant -- both this timestamp and the script's own
// Date.now() call happen within the same test run, well inside the ~24h
// window's tolerance, so this is deterministic in practice.
const NOW = Date.now();
const recentIso = (minutesAgo) => new Date(NOW - minutesAgo * 60 * 1000).toISOString();

test("issue-close-sweep: closes a still-open linked Issue from a recently-merged PR, posting the sweep's marker and wording", async () => {
  const m = await run({
    pulls: [{ number: 501, merged_at: recentIso(10), body: "Closes #900" }],
    issuesByNumber: { 900: { state: "open" } },
  });

  assert.ok(m.calls.includes("issues.get:900"), "must read the linked issue's current state");
  assert.ok(m.calls.includes("issues.update:900:closed:completed"), "must close the still-open linked issue");
  assert.ok(m.calls.includes("comment:900"), "must leave an auditable comment");

  const [commentBody] = m.commentsByIssue.get(900);
  assert.match(
    commentBody,
    /<!-- agent-engineering-standard:issue-close-fallback:v1 -->/,
    "must use the SAME marker pr-verify.yml's fallback uses"
  );
  assert.match(commentBody, /scheduled sweep/i, "must name the scheduled sweep explicitly, distinct from the in-job poll");
  assert.match(commentBody, /#501/, "must cite the merged PR number");
});

test("issue-close-sweep: idempotent -- an already-closed linked Issue is skipped silently, no duplicate close or comment", async () => {
  const m = await run({
    pulls: [{ number: 502, merged_at: recentIso(10), body: "closes #901" }],
    issuesByNumber: { 901: { state: "closed" } },
  });

  assert.ok(m.calls.includes("issues.get:901"), "must still check state before acting");
  assert.ok(!m.calls.some((c) => c.startsWith("issues.update:")), "must not re-close an already-closed issue");
  assert.ok(!m.calls.some((c) => c.startsWith("comment:")), "must not post a duplicate fallback comment");
});

test("issue-close-sweep: a PR body with no closing keyword triggers nothing", async () => {
  const m = await run({
    pulls: [{ number: 503, merged_at: recentIso(10), body: "See #902 for context, but does not close it" }],
  });

  assert.ok(!m.calls.some((c) => c.startsWith("issues.get")), "a non-closing reference must never be looked up");
});

test("issue-close-sweep: a PR merged outside the ~24h window is excluded from consideration", async () => {
  const m = await run({
    pulls: [{ number: 504, merged_at: recentIso(48 * 60), body: "closes #903" }],
    issuesByNumber: { 903: { state: "open" } },
  });

  assert.ok(!m.calls.some((c) => c.startsWith("issues.get")), "a PR merged ~48h ago must be excluded by the window filter");
});

test("issue-close-sweep: an API error for one Issue is logged and does not abort the run for the rest of the batch", async () => {
  const m = await run({
    pulls: [
      { number: 505, merged_at: recentIso(10), body: "closes #904" },
      { number: 506, merged_at: recentIso(5), body: "closes #905" },
    ],
    issuesGetErrorFor: [904],
    issuesByNumber: { 905: { state: "open" } },
  });

  // Reaching this line at all proves the thrown error did not propagate out
  // of the script -- an uncaught rejection would fail this test's own await.
  assert.ok(m.calls.includes("issues.get:904"), "must attempt to read the failing issue");
  assert.ok(
    !m.calls.some((c) => c.startsWith("issues.update:904") || c === "comment:904"),
    "a failed read must never be treated as a successful close"
  );
  assert.ok(
    m.warnings.some((w) => w.includes("904")),
    "the read failure must be logged via core.warning"
  );

  // The second PR in the same batch must still be processed -- the failure
  // above must not have aborted the whole run.
  assert.ok(m.calls.includes("issues.update:905:closed:completed"), "later PRs/Issues in the batch must still be processed");
  assert.ok(m.calls.includes("comment:905"));
});
