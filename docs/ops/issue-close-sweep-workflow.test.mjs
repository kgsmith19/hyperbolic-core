// Structural + behavioral assertions over .github/workflows/issue-close-sweep.yml.
//
// This workflow is the DOCUMENTED PRIMARY MECHANISM for closing an Issue
// after a GITHUB_TOKEN-armed auto-merge (Issue #283). pr-verify.yml's "PR
// Gate" job also polls inline for up to 15 seconds after arming auto-merge,
// but that poll structurally cannot observe the merge its own arming call
// just armed -- `pr-gate` is the sole required status check in this repo's
// branch ruleset, so the merge cannot complete until that job's own
// check-run reports done, which requires the poll to finish first (see
// pr-verify.yml's own comment above pollForMergeAfterArming, and PR #280's
// timing evidence). This workflow runs every 15 minutes, independent of any
// pull-request event or any single job's lifecycle, and re-parses
// Closes/Fixes/Resolves #N out of every PR merged in roughly the last 24
// hours, closing the linked Issue itself if it is still open.
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

  assert.match(onBlock, /\r?\n {2}schedule:\r?\n/, "must trigger on schedule:");
  assert.match(onBlock, /cron:\s*"\*\/15 \* \* \* \*"/, "must run every 15 minutes -- the documented primary mechanism's cadence (Issue #283)");
  assert.doesNotMatch(onBlock, /pull_request/, "must never trigger on pull_request or pull_request_target");
});

test("issue-close-sweep.yml permissions are exactly issues: write and pull-requests: read -- nothing broader", () => {
  const permsStart = workflow.indexOf("\npermissions:");
  assert.ok(permsStart >= 0, "no `permissions:` block found");
  const rest = workflow.slice(permsStart + 1);
  const endMatch = /\n(?=[A-Za-z_-]+:)/.exec(rest.slice(11));
  const permsBlock = endMatch ? rest.slice(0, 11 + endMatch.index) : rest;

  assert.match(permsBlock, /\r?\n {2}issues: write\r?\n/);
  assert.match(permsBlock, /\r?\n {2}pull-requests: read\r?\n/);
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

function makeMocks({
  pulls,
  issuesByNumber = {},
  issuesGetErrorFor = [],
  defaultBranch = "main",
  pullsListError = null,
}) {
  const calls = [];
  const warnings = [];
  const failures = [];
  const commentsByIssue = new Map();
  const stateByIssue = new Map(Object.entries(issuesByNumber).map(([k, v]) => [Number(k), v.state]));

  const github = {
    // Real Octokit's github.paginate(method, args) drives `method` across
    // every page and concatenates .data -- mirrored here (not stubbed to a
    // single call) so a test can prove the real script's pagination call
    // actually walks multiple pages instead of trusting page 1 alone.
    paginate: async (method, args) => {
      const perPage = args.per_page || 30;
      let page = 1;
      let all = [];
      while (true) {
        const { data } = await method({ ...args, page });
        all = all.concat(data);
        if (data.length < perPage) break;
        page += 1;
      }
      return all;
    },
    rest: {
      repos: {
        get: async (args) => {
          calls.push("repos.get");
          assert.equal(args.owner, "kgsmith19");
          assert.equal(args.repo, "hyperbolic-core");
          return { data: { default_branch: defaultBranch } };
        },
      },
      pulls: {
        list: async (args) => {
          calls.push("pulls.list");
          assert.equal(args.state, "closed");
          assert.equal(args.sort, "updated");
          assert.equal(args.direction, "desc");
          if (pullsListError) throw pullsListError;
          // Real per_page/page semantics, so a fixture with more than one
          // page's worth of PRs proves github.paginate below actually
          // fetches every page rather than trusting a single response.
          const perPage = args.per_page || 30;
          const page = args.page || 1;
          const start = (page - 1) * perPage;
          return { data: pulls.slice(start, start + perPage) };
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
    setFailed(message) {
      failures.push(message);
    },
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

  return { github, core, context, calls, warnings, failures, commentsByIssue };
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
    pulls: [{ number: 501, merged_at: recentIso(10), body: "Closes #900", base: { ref: "main" } }],
    issuesByNumber: { 900: { state: "open" } },
  });

  assert.ok(m.calls.includes("repos.get"), "must read the repository's default branch to determine eligibility");
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
    pulls: [{ number: 502, merged_at: recentIso(10), body: "closes #901", base: { ref: "main" } }],
    issuesByNumber: { 901: { state: "closed" } },
  });

  assert.ok(m.calls.includes("issues.get:901"), "must still check state before acting");
  assert.ok(!m.calls.some((c) => c.startsWith("issues.update:")), "must not re-close an already-closed issue");
  assert.ok(!m.calls.some((c) => c.startsWith("comment:")), "must not post a duplicate fallback comment");
});

test("issue-close-sweep: a PR body with no closing keyword triggers nothing", async () => {
  const m = await run({
    pulls: [{ number: 503, merged_at: recentIso(10), body: "See #902 for context, but does not close it", base: { ref: "main" } }],
  });

  assert.ok(!m.calls.some((c) => c.startsWith("issues.get")), "a non-closing reference must never be looked up");
});

test("issue-close-sweep: a PR merged outside the ~24h window is excluded from consideration", async () => {
  const m = await run({
    pulls: [{ number: 504, merged_at: recentIso(48 * 60), body: "closes #903", base: { ref: "main" } }],
    issuesByNumber: { 903: { state: "open" } },
  });

  assert.ok(!m.calls.some((c) => c.startsWith("issues.get")), "a PR merged ~48h ago must be excluded by the window filter");
});

// Defect-sensitive: 130 closed PRs (more than one page at per_page: 100),
// most of them old/irrelevant filler, with the one recently-merged,
// closing-keyword PR sitting on page 2. A sweep that reads only page 1
// (github.rest.pulls.list called directly, not paginated) would see 100
// filler PRs, never see this one, and silently miss it.
test("issue-close-sweep: a PR merged within the window is found even when it sits on the second page of closed PRs (pagination)", async () => {
  const filler = Array.from({ length: 129 }, (_, i) => ({
    number: 1000 + i,
    merged_at: recentIso(60 * 24 * 30), // 30 days ago, well outside the window
    body: "no closing keyword here",
    base: { ref: "main" },
  }));
  const pulls = [
    ...filler.slice(0, 99),
    { number: 507, merged_at: recentIso(10), body: "closes #906", base: { ref: "main" } },
    ...filler.slice(99),
  ];
  assert.equal(pulls.length, 130, "fixture must exceed one page (per_page: 100)");

  const m = await run({
    pulls,
    issuesByNumber: { 906: { state: "open" } },
  });

  assert.ok(m.calls.filter((c) => c === "pulls.list").length >= 2, "must have fetched more than one page");
  assert.ok(m.calls.includes("issues.update:906:closed:completed"), "the page-2 PR's linked Issue must still be closed");
});

test("issue-close-sweep: an API error for one Issue is logged and does not abort the run for the rest of the batch", async () => {
  const m = await run({
    pulls: [
      { number: 505, merged_at: recentIso(10), body: "closes #904", base: { ref: "main" } },
      { number: 506, merged_at: recentIso(5), body: "closes #905", base: { ref: "main" } },
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

  // A per-Issue read failure is exactly the kind of tolerated, expected
  // condition (a deleted Issue, a transient blip) that must never fail the
  // whole scheduled run -- only a real orchestration failure should (see the
  // dedicated setFailed test below). This is the outer/inner tolerance
  // boundary Issue #283's final review drew: the inner per-Issue catch stays
  // tolerant, only the outer catch escalates.
  assert.deepEqual(m.failures, [], "a single bad Issue inside the loop must never call core.setFailed");
});

// Issue #283 final review, finding 2: the sweep must not be broader than
// both GitHub's native `Closes #N` linkage and the in-job fallback it
// backstops -- handleIssueCloseFallback in pr-verify.yml only acts when
// `sameRepo && pr.base.ref === defaultBranch`. Before the fix, this filter
// did not exist at all, so a PR merged into a non-default base branch with
// `Closes #N` in its body would have its linked Issue closed by the sweep
// even though neither GitHub's native linkage nor PR Gate's own fallback
// would ever have closed it for that PR.
test("issue-close-sweep: a PR merged into a non-default base branch is excluded, even with a closing keyword in its body", async () => {
  const m = await run({
    pulls: [{ number: 507, merged_at: recentIso(10), body: "Closes #906", base: { ref: "release/1.0" } }],
    issuesByNumber: { 906: { state: "open" } },
    defaultBranch: "main",
  });

  assert.ok(m.calls.includes("repos.get"), "must read the repository's default branch to determine eligibility");
  assert.ok(
    !m.calls.some((c) => c.startsWith("issues.get")),
    "a PR merged into a non-default base branch must never be considered eligible, matching pr-verify.yml's own " +
      "eligibility check (sameRepo && pr.base.ref === defaultBranch)"
  );
  assert.deepEqual(m.failures, [], "an ineligible PR is a normal, expected outcome -- it must never fail the run");
});

test("issue-close-sweep: a PR merged into the actual default branch is still eligible when the default branch is not literally \"main\"", async () => {
  const m = await run({
    pulls: [{ number: 508, merged_at: recentIso(10), body: "closes #907", base: { ref: "trunk" } }],
    issuesByNumber: { 907: { state: "open" } },
    defaultBranch: "trunk",
  });

  assert.ok(
    m.calls.includes("issues.update:907:closed:completed"),
    "eligibility must compare against the repository's REAL default branch, not a hardcoded 'main'"
  );
});

// Issue #283 final review, finding 3: the outer catch previously called only
// core.error, so if pulls.list (or repos.get) throws -- a permission change,
// an API outage, a future edit that breaks the script -- the sweep run
// reported green while doing nothing. Nothing else watches this workflow (no
// PR check row), so a silently-green broken sweep would go unnoticed
// indefinitely. This test fails against the pre-fix code (core.error alone
// never calls core.setFailed) and passes once the outer catch also calls
// core.setFailed.
test("issue-close-sweep: an orchestration failure (pulls.list throwing) fails the scheduled run via core.setFailed, not just core.error", async () => {
  const m = await run({
    pulls: [],
    pullsListError: new Error("simulated API outage"),
  });

  assert.ok(m.calls.includes("pulls.list"), "must have attempted the call that failed");
  assert.equal(m.failures.length, 1, "a real orchestration failure must call core.setFailed exactly once");
  assert.match(
    m.failures[0],
    /simulated API outage/,
    "the setFailed message must carry the underlying error, for a diagnosable failed-run log"
  );
});
