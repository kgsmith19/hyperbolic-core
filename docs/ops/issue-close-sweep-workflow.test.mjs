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
// pull-request event or any single job's lifecycle. It keeps a durable cursor
// (hyperbolic-core#396) so catch-up starts at the last processed merge, not a
// fixed 24h window, and closes the linked Issue itself if it is still open.
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

// The durable cursor lives in one marker comment on CURSOR_ISSUE (#453), as a
// fenced JSON block. Tests seed it with cursorComment(...) and read it back
// with readCursor(...) so assertions see the persisted state, not the script's
// internals.
const CURSOR_ISSUE = 453;
const CURSOR_MARKER = "<!-- agent-engineering-standard:issue-close-sweep-cursor:v1 -->";
const cursorComment = (state) => `${CURSOR_MARKER}\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``;
const readCursor = (m) => {
  const body = (m.commentStore.get(CURSOR_ISSUE) || []).find((c) => c.body.includes(CURSOR_MARKER))?.body;
  assert.ok(body, "the cursor comment must exist on the cursor Issue after a run");
  return JSON.parse(body.match(/```json\n([\s\S]*?)\n```/)[1]);
};

function makeMocks({
  pulls,
  issuesByNumber = {},
  issuesGetErrorFor = [],
  updateErrorFor = [],
  eventsErrorFor = [],
  defaultBranch = "main",
  pullsListError = null,
  cursor = undefined,
}) {
  const calls = [];
  const warnings = [];
  const failures = [];
  const commentsByIssue = new Map();
  const commentStore = new Map();
  let nextCommentId = 1;
  const addComment = (issue_number, body) => {
    const list = commentStore.get(issue_number) || [];
    const comment = { id: nextCommentId++, body };
    list.push(comment);
    commentStore.set(issue_number, list);
    return comment;
  };
  if (cursor !== undefined) addComment(CURSOR_ISSUE, cursorComment(cursor));
  // Fixtures default updated_at to merged_at and merge_commit_sha to a stable
  // per-PR value, matching what the real pulls API returns for a PR that has
  // not been touched since it merged.
  const prs = pulls.map((pr) => ({ updated_at: pr.merged_at, merge_commit_sha: `abcdef${pr.number}`, ...pr }));
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
          return { data: prs.slice(start, start + perPage) };
        },
      },
      issues: {
        get: async ({ issue_number }) => {
          calls.push("issues.get:" + issue_number);
          if (issuesGetErrorFor.includes(issue_number)) {
            throw new Error(`simulated read failure for #${issue_number}`);
          }
          const state = stateByIssue.has(issue_number) ? stateByIssue.get(issue_number) : "open";
          const reason = issuesByNumber[issue_number]?.state_reason ?? null;
          return { data: { number: issue_number, state, state_reason: reason } };
        },
        update: async ({ issue_number, state, state_reason }) => {
          calls.push(`issues.update:${issue_number}:${state}:${state_reason}`);
          if (updateErrorFor.includes(issue_number)) {
            throw new Error(`simulated write failure for #${issue_number}`);
          }
          stateByIssue.set(issue_number, state);
        },
        createComment: async ({ issue_number, body }) => {
          if (issue_number === CURSOR_ISSUE) {
            calls.push("cursor:create");
          } else {
            calls.push("comment:" + issue_number);
          }
          const list = commentsByIssue.get(issue_number) || [];
          list.push(body);
          commentsByIssue.set(issue_number, list);
          addComment(issue_number, body);
        },
        // Issue #459: the Issue's timeline events, so the sweep can tell when a
        // human reopened it. Fixtures give `reopenedAt` (ISO) per Issue.
        listEvents: async ({ issue_number, page = 1, per_page = 100 }) => {
          calls.push("events:" + issue_number);
          if (eventsErrorFor.includes(issue_number)) {
            throw new Error(`simulated events failure for #${issue_number}`);
          }
          const at = issuesByNumber[issue_number]?.reopenedAt;
          const all = at ? [{ event: "closed", created_at: "2026-01-01T00:00:00Z" }, { event: "reopened", created_at: at }] : [];
          const start = (page - 1) * per_page;
          return { data: all.slice(start, start + per_page) };
        },
        listComments: async ({ issue_number, page = 1, per_page = 100 }) => {
          const all = commentStore.get(issue_number) || [];
          const start = (page - 1) * per_page;
          return { data: all.slice(start, start + per_page) };
        },
        updateComment: async ({ comment_id, body }) => {
          calls.push("cursor:update");
          for (const list of commentStore.values()) {
            const comment = list.find((c) => c.id === comment_id);
            if (comment) comment.body = body;
          }
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

  return { github, core, context, calls, warnings, failures, commentsByIssue, commentStore };
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

// AC1 (hyperbolic-core#396): the window is no longer a fixed 24h. A PR merged
// before the durable watermark is examined only by the periodic full repair,
// never by the incremental pass. Here the repair is recent, so a PR merged
// 48h ago that sits before the watermark is left alone.
test("issue-close-sweep: an incremental run with a recent full repair does not re-examine a PR merged before the durable watermark", async () => {
  const m = await run({
    pulls: [{ number: 504, merged_at: recentIso(48 * 60), body: "closes #903", base: { ref: "main" } }],
    issuesByNumber: { 903: { state: "open" } },
    cursor: { v: 1, watermark: recentIso(10), lastFullRepairAt: recentIso(60), failed: [], closed: {}, reverted: [], reopened: [] },
  });

  assert.ok(!m.calls.some((c) => c.startsWith("issues.get")), "a PR before the watermark must not be examined between full repairs");
});

// Defect-sensitive: 130 closed PRs (more than one page at per_page: 100),
// most of them old/irrelevant filler, with the one recently-merged,
// closing-keyword PR sitting on page 2. A sweep that reads only page 1
// (github.rest.pulls.list called directly, not paginated) would see 100
// filler PRs, never see this one, and silently miss it.
test("issue-close-sweep: a PR merged within the window is found even when it sits on the second page of closed PRs (pagination)", async () => {
  // The real pulls API sorts by updated desc, so 99 recently-touched
  // non-closing PRs fill page 1 and the closing PR is the first item on page 2.
  // Trailing filler is 30 days old, so the incremental stop criterion
  // (updated_at before the watermark) ends the walk after page 2.
  const recent = Array.from({ length: 99 }, (_, i) => ({
    number: 900 + i + 1, // 901..999, never a Closes target in this fixture
    merged_at: recentIso(1),
    body: "no closing keyword here",
    base: { ref: "main" },
  }));
  const oldFiller = Array.from({ length: 30 }, (_, i) => ({
    number: 1000 + i,
    merged_at: recentIso(60 * 24 * 30),
    body: "no closing keyword here",
    base: { ref: "main" },
  }));
  const pulls = [
    ...recent,
    { number: 507, merged_at: recentIso(10), body: "closes #906", base: { ref: "main" } },
    ...oldFiller,
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

// ---------------------------------------------------------------------------
// hyperbolic-core#396 (Q11): durable cursor, periodic repair, exact-task
// retry, reopen/revert relink, cross-repo scope, no privileged checkout.
// ---------------------------------------------------------------------------

const DAY_MIN = 24 * 60;
const baseCursor = (over = {}) => ({
  v: 1,
  watermark: recentIso(10),
  lastFullRepairAt: recentIso(60),
  failed: [],
  closed: {},
  epoch: "2000-01-01T00:00:00.000Z",
  reverted: [],
  reopened: [],
  ...over,
});

test("issue-close-sweep (AC1): catch-up is driven by the durable watermark, not a fixed 24h window -- a PR merged 2 days ago after a 3-day-old watermark closes its Issue", async () => {
  const m = await run({
    pulls: [{ number: 510, merged_at: recentIso(2 * DAY_MIN), body: "closes #910", base: { ref: "main" } }],
    issuesByNumber: { 910: { state: "open" } },
    cursor: baseCursor({ watermark: recentIso(3 * DAY_MIN) }),
  });

  assert.ok(
    m.calls.includes("issues.update:910:closed:completed"),
    "a PR newer than the durable watermark must be caught up even when it is older than 24h"
  );
});

test("issue-close-sweep (AC2): the cursor advances to the newest processed merge and records the closure, so a repeat run neither re-closes nor re-comments", async () => {
  const pr = { number: 511, merged_at: recentIso(2 * DAY_MIN), body: "closes #911", base: { ref: "main" } };
  const first = await run({
    pulls: [pr],
    issuesByNumber: { 911: { state: "open" } },
    cursor: baseCursor({ watermark: recentIso(3 * DAY_MIN) }),
  });
  const persisted = readCursor(first);
  assert.equal(persisted.watermark, pr.merged_at, "watermark must advance to the newest processed merged_at");
  assert.deepEqual(persisted.closed["911"], { pr: 511, sha: "abcdef511" }, "the closure must be recorded with its PR and merge SHA");

  const second = await run({
    pulls: [pr],
    issuesByNumber: { 911: { state: "closed" } },
    cursor: persisted,
  });
  assert.ok(!second.calls.some((c) => c.startsWith("issues.update:911")), "a repeat run must not re-close the Issue");
  assert.ok(!second.calls.includes("comment:911"), "a repeat run must not duplicate the fallback comment");
});

test("issue-close-sweep (AC2 cursor gap): a stale full repair re-examines a PR before the watermark and closes its still-open Issue", async () => {
  const m = await run({
    pulls: [{ number: 512, merged_at: recentIso(5 * DAY_MIN), body: "closes #912", base: { ref: "main" } }],
    issuesByNumber: { 912: { state: "open" } },
    cursor: baseCursor({ watermark: recentIso(10), lastFullRepairAt: recentIso(2 * DAY_MIN) }),
  });

  assert.ok(m.calls.includes("issues.update:912:closed:completed"), "the periodic full repair must repair an event the incremental cursor missed");
  assert.ok(readCursor(m).lastFullRepairAt >= new Date(NOW).toISOString(), "the full repair time must be recorded");
});

test("issue-close-sweep (AC4): a failed close is recorded in the ledger, retried exactly on the next run, and cleared on success without duplication", async () => {
  const merged513 = recentIso(10);
  const first = await run({
    pulls: [{ number: 513, merged_at: merged513, body: "closes #913", base: { ref: "main" } }],
    issuesByNumber: { 913: { state: "open" } },
    updateErrorFor: [913],
  });
  first.mergedAt513 = merged513;
  assert.deepEqual(
    readCursor(first).failed,
    [{ issue: 913, pr: 513, sha: "abcdef513", merged_at: first.mergedAt513 }],
    "the failed close must be persisted for an exact retry, with the merge time a later reopen check needs"
  );
  assert.deepEqual(first.failures, [], "a per-Issue write failure must stay tolerant, never failing the run");

  const second = await run({
    pulls: [],
    issuesByNumber: { 913: { state: "open" } },
    cursor: readCursor(first),
  });
  assert.equal(second.calls.filter((c) => c === "issues.update:913:closed:completed").length, 1, "the exact failed Issue must be retried once");
  assert.equal(second.calls.filter((c) => c === "comment:913").length, 1, "the retry must post exactly one comment");
  assert.deepEqual(readCursor(second).failed, [], "a successful retry must clear the ledger entry");
});

test("issue-close-sweep (AC3 reopen): an Issue the sweep closed and a human later reopened is never re-closed by repair", async () => {
  const m = await run({
    pulls: [{ number: 514, merged_at: recentIso(5 * DAY_MIN), body: "closes #914", base: { ref: "main" } }],
    issuesByNumber: { 914: { state: "open" } },
    cursor: baseCursor({
      lastFullRepairAt: recentIso(2 * DAY_MIN),
      closed: { 914: { pr: 514, sha: "abcdef514" } },
    }),
  });

  assert.ok(!m.calls.some((c) => c.startsWith("issues.update:914")), "a human-reopened Issue must not be closed again");
  assert.deepEqual(readCursor(m).reopened, [914], "the human reopen must be recorded so later runs keep respecting it");
});

test("issue-close-sweep (AC3 revert relink): a revert PR reopens the Issue the reverted PR closed, and repair never closes it again", async () => {
  const m = await run({
    pulls: [
      { number: 516, merged_at: recentIso(60), body: "This reverts commit abcdef515.", base: { ref: "main" } },
      { number: 515, merged_at: recentIso(2 * DAY_MIN), body: "closes #915", base: { ref: "main" } },
    ],
    issuesByNumber: { 915: { state: "closed" } },
    cursor: baseCursor({
      watermark: recentIso(3 * DAY_MIN),
      lastFullRepairAt: recentIso(2 * DAY_MIN),
      closed: { 915: { pr: 515, sha: "abcdef515" } },
    }),
  });

  assert.ok(m.calls.includes("issues.update:915:open:reopened"), "the reverted PR's Issue must be relinked to open");
  assert.ok(!m.calls.includes("issues.update:915:closed:completed"), "the reverted PR must never close the Issue again");
  assert.deepEqual(readCursor(m).reverted, [915], "the reverted Issue must be recorded so repair skips it");
  assert.deepEqual(readCursor(m).reopened, [], "a revert relink is not a human reopen and must never be recorded as one");
});

// Cross-repo scope (AC5): a closing reference to another repository must
// never be read or written, since this workflow's token is scoped to this
// repository. A reference that names this repository explicitly is treated as
// same-repo, not as cross-repo.
test("issue-close-sweep (AC5 scope): a closing reference to another repository is never read or written; the same repository named explicitly is handled", async () => {
  const m = await run({
    pulls: [
      {
        number: 517,
        merged_at: recentIso(10),
        body: "Closes other-org/other-repo#920 and closes kgsmith19/hyperbolic-core#921",
        base: { ref: "main" },
      },
    ],
    issuesByNumber: { 921: { state: "open" } },
  });

  assert.ok(!m.calls.includes("issues.get:920"), "a cross-repo target must never be read as if it were local");
  assert.ok(!m.calls.some((c) => c === "issues.update:920:closed:completed"), "a cross-repo target must never be closed");
  assert.ok(m.warnings.some((w) => w.includes("other-org/other-repo#920")), "the skipped cross-repo target must be logged");
  assert.ok(m.calls.includes("issues.update:921:closed:completed"), "the explicitly named same repository must be handled");
});

test("issue-close-sweep (bootstrap): with no cursor yet, the first run creates the durable cursor comment", async () => {
  const m = await run({ pulls: [] });

  assert.ok(m.calls.includes("cursor:create"), "the first run must create the cursor comment on the cursor Issue");
  assert.equal(readCursor(m).v, 1, "the created cursor must carry the schema version");
});

test("issue-close-sweep (AC6): the workflow never checks out repository code, so no PR code is ever present while it holds write credentials", () => {
  assert.doesNotMatch(workflow, /actions\/checkout/, "must not check out any code");
  assert.doesNotMatch(workflow, /contents:\s*write/, "must never hold contents write");
});

// ---------------------------------------------------------------------------
// hyperbolic-core#459: a human reopen after ANY close is respected, not only a
// reopen of an Issue the sweep itself closed. Observed: the first durable-cursor
// run replayed PR #452 and re-closed #440 13 minutes after the owner reopened it.
// ---------------------------------------------------------------------------

test("issue-close-sweep (#459): an Issue reopened after its PR merged is never closed, and the reopen is remembered", async () => {
  const m = await run({
    pulls: [{ number: 520, merged_at: recentIso(120), body: "closes #930", base: { ref: "main" } }],
    issuesByNumber: { 930: { state: "open", state_reason: "reopened", reopenedAt: recentIso(30) } },
  });

  assert.ok(m.calls.includes("events:930"), "a reopened Issue's timeline must be read");
  assert.ok(!m.calls.some((c) => c.startsWith("issues.update:930")), "a human reopen after the merge must win");
  assert.ok(!m.calls.includes("comment:930"));
  assert.deepEqual(readCursor(m).reopened, [930], "recorded so later runs skip it without another lookup");
  assert.equal(readCursor(m).closed["930"], undefined, "never recorded as a sweep closure");
});

test("issue-close-sweep (#459): an Issue reopened BEFORE its PR merged is closed normally, because the merge is newer", async () => {
  const m = await run({
    pulls: [{ number: 521, merged_at: recentIso(10), body: "closes #931", base: { ref: "main" } }],
    issuesByNumber: { 931: { state: "open", state_reason: "reopened", reopenedAt: recentIso(120) } },
  });

  assert.ok(m.calls.includes("issues.update:931:closed:completed"), "a merge after the reopen still closes the Issue");
});

test("issue-close-sweep (#459): an Issue that was never reopened needs no timeline lookup", async () => {
  const m = await run({
    pulls: [{ number: 522, merged_at: recentIso(10), body: "closes #932", base: { ref: "main" } }],
    issuesByNumber: { 932: { state: "open" } },
  });

  assert.ok(!m.calls.includes("events:932"), "only a reopened Issue costs an events call");
  assert.ok(m.calls.includes("issues.update:932:closed:completed"));
});

test("issue-close-sweep (#459): a failed timeline read is tolerated: not closed, queued for exact retry, run not failed", async () => {
  const m = await run({
    pulls: [{ number: 523, merged_at: recentIso(10), body: "closes #933", base: { ref: "main" } }],
    issuesByNumber: { 933: { state: "open", state_reason: "reopened", reopenedAt: recentIso(30) } },
    eventsErrorFor: [933],
  });

  assert.ok(!m.calls.some((c) => c.startsWith("issues.update:933")), "an unknown reopen time must never be read as permission to close");
  assert.deepEqual(readCursor(m).failed.map((f) => f.issue), [933]);
  assert.ok(m.warnings.some((w) => w.includes("933")));
  assert.deepEqual(m.failures, []);
});

test("issue-close-sweep (#459): a retry of a reopened Issue with no recorded merge time is not closed", async () => {
  const m = await run({
    pulls: [],
    issuesByNumber: { 934: { state: "open", state_reason: "reopened", reopenedAt: recentIso(30) } },
    cursor: baseCursor({ failed: [{ issue: 934, pr: 524, sha: "abcdef524" }] }),
  });

  assert.ok(!m.calls.some((c) => c.startsWith("issues.update:934")), "a legacy ledger entry without merged_at must fail safe");
  assert.deepEqual(readCursor(m).reopened, [934]);
  assert.deepEqual(readCursor(m).failed, [], "resolved as a human reopen, so it leaves the retry ledger");
});

test("issue-close-sweep (#459): a retry carries its merge time, so a merge newer than the reopen still closes", async () => {
  const m = await run({
    pulls: [],
    issuesByNumber: { 935: { state: "open", state_reason: "reopened", reopenedAt: recentIso(120) } },
    cursor: baseCursor({ failed: [{ issue: 935, pr: 525, sha: "abcdef525", merged_at: recentIso(10) }] }),
  });

  assert.ok(m.calls.includes("issues.update:935:closed:completed"), "the retried close compares the recorded merge time");
  assert.deepEqual(readCursor(m).failed, []);
});
