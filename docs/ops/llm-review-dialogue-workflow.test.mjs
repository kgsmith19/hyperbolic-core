// Structural + behavioral assertions over the LLM Review dialogue machinery:
// .github/workflows/llm-review-dialogue.yml, .github/workflows/claude-dispatch.yml,
// and the artifact-staging steps in .github/actions/verify-llm-review/action.yml.
//
// Issue #231. This closes the gap AGENTS.md used to name explicitly:
// "Posting findings into the PR discussion itself, with a round counter and
// owner escalation after repeated unresolved rounds ... is tracked
// separately and is not yet implemented." Three invariants make this a
// three-workflow design rather than one, and getting any of them wrong is a
// security bug, not a style issue:
//
//   1. ai-review (pr-verify.yml) executes pull-request-authored code while
//      holding a provider credential, so it must NEVER hold a token that
//      can write to the pull request -- unaffected by it also being a
//      mandatory needs: dependency of PR Gate (#232): "required in
//      substance" says nothing about which job is safe to trust with write
//      access.
//   2. The posting job (llm-review-dialogue.yml) holds pull-requests: write,
//      so it must NEVER check out or execute repository content -- same
//      discipline as pr-verify.yml's own "PR Gate".
//   3. Neither new workflow may add a pull-request check row -- workflow_run
//      and repository_dispatch report none, which is exactly why they were
//      chosen over a new job in pr-verify.yml.
//
// The behavioral tests extract the real embedded scripts and execute them
// against a mocked GitHub API, for the same reason pr-verify-workflow.test.mjs
// does: a structural grep cannot tell a real SHA-mismatch guard from one
// whose `if` was quietly deleted.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The extracted scripts use CommonJS `require("node:fs")` / `require("node:path")`
// (that is what actions/github-script's own sandbox provides), so this ESM
// test file must hand them a real `require` explicitly -- it is not a global here.
const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dialoguePath = path.join(root, ".github/workflows/llm-review-dialogue.yml");
const dispatchPath = path.join(root, ".github/workflows/claude-dispatch.yml");
const reviewActionPath = path.join(root, ".github/actions/verify-llm-review/action.yml");
const dialogueYaml = readFileSync(dialoguePath, "utf8");
const dispatchYaml = readFileSync(dispatchPath, "utf8");
const reviewActionYaml = readFileSync(reviewActionPath, "utf8");

// General "script: |" block extractor. Unlike pr-verify-workflow.test.mjs's
// version, this does not assume the block is the last thing in the file --
// claude-dispatch.yml's script step is followed by a checkout and an action
// step -- so it stops at the first line whose indentation drops below the
// block's own, which is exactly what ends a YAML block scalar.
function extractScript(yamlText, fromIndex = 0) {
  const markerIndex = yamlText.indexOf("script: |", fromIndex);
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

// Wrapped exactly the way actions/github-script actually invokes a script:
// as an AsyncFunction body, so a bare top-level `return` and `await` are both
// legal -- the same technique pr-verify-workflow.test.mjs's
// loadAllGatesModule uses for the All Gates script.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadDialogueScript() {
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(dialogueYaml));
}

function loadDispatchPrCheckScript() {
  const marker = dispatchYaml.indexOf("id: pr");
  assert.ok(marker >= 0, "claude-dispatch.yml: no `id: pr` step found");
  return new AsyncFunction("context", "core", "github", "process", extractScript(dispatchYaml, marker));
}

// The conversation step is the SECOND script: | block in this file (after
// the Issue-body step), so it needs a starting index -- the same reason
// loadDispatchPrCheckScript() above locates its block by a step id first.
function loadConversationScript() {
  const marker = reviewActionYaml.indexOf("Context · Write the pull request's conversation to a file");
  assert.ok(marker >= 0, "verify-llm-review/action.yml: conversation step not found");
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(reviewActionYaml, marker));
}

// ---------------------------------------------------------------------------
// Structural: the token-placement invariant, mechanically enforced the same
// way docs/ops/pr-verify-workflow.test.mjs enforces it for All Gates.
// ---------------------------------------------------------------------------

// Scoped to each file's actual `permissions:` block(s), not the whole file --
// llm-review.yml's own header comment quotes "pull-requests: write" in prose
// to explain why it is deliberately absent, and a whole-file grep would
// wrongly flag that explanation as the grant it is warning against.
function permissionsBlocks(text) {
  const blocks = [];
  const pattern = /\n(\s*)permissions:\n/g;
  for (const match of text.matchAll(pattern)) {
    const indent = match[1].length;
    const start = match.index + match[0].length;
    const lines = text.slice(start).split("\n");
    const collected = [];
    for (const line of lines) {
      if (line.trim() === "") {
        collected.push(line);
        continue;
      }
      const lineIndent = line.match(/^ */)[0].length;
      if (lineIndent <= indent) break;
      collected.push(line);
    }
    blocks.push(collected.join("\n"));
  }
  return blocks;
}

test("ai-review stays read-only: no pull-requests write in any permissions block reachable by it", () => {
  const reviewWorkflow = readFileSync(path.join(root, ".github/workflows/llm-review.yml"), "utf8");
  const prVerify = readFileSync(path.join(root, ".github/workflows/pr-verify.yml"), "utf8");
  const jobStart = prVerify.indexOf("\n  ai-review:");
  const jobEnd = prVerify.indexOf("\n  pr-gate:", jobStart);
  assert.ok(jobStart >= 0, "pr-verify.yml: no ai-review job found");
  assert.ok(jobEnd > jobStart, "pr-verify.yml: no pr-gate job found after ai-review");
  const job = prVerify.slice(jobStart, jobEnd);

  for (const blocks of [permissionsBlocks(reviewActionYaml), permissionsBlocks(reviewWorkflow), permissionsBlocks(job)]) {
    for (const block of blocks) {
      assert.doesNotMatch(block, /pull-requests:\s*write/);
    }
  }
});

test("llm-review-dialogue.yml holds a write token but never checks out or shells over repository content", () => {
  assert.match(dialogueYaml, /pull-requests:\s*write/);
  assert.doesNotMatch(dialogueYaml, /uses: actions\/checkout/);
  assert.doesNotMatch(dialogueYaml, /\n\s+run: \|/, "no multi-line shell over repository content");
});

// Behavior protected: the deferred-Issue-filing code (issues.create,
// search.issuesAndPullRequests) has a real permission grant behind it, not
// an assumption -- AI Review correctly caught on PR #247 that nothing
// asserted this before those calls were added. `issues: write` was already
// present (needed for posting PR comments via the Issues API), so this pins
// that fact rather than requesting anything new.
test("llm-review-dialogue.yml holds issues: write, which issues.create and search.issuesAndPullRequests both require", () => {
  assert.match(dialogueYaml, /issues:\s*write/);
});

test("llm-review-dialogue.yml triggers on workflow_run, not on any PR event, and adds no PR check row", () => {
  const onBlock = dialogueYaml.slice(dialogueYaml.indexOf("\non:"), dialogueYaml.indexOf("\npermissions:"));
  assert.match(onBlock, /workflow_run:/);
  assert.doesNotMatch(onBlock, /pull_request(_target)?:/);
});

test("llm-review-dialogue.yml refuses fork pull requests before doing anything", () => {
  const jobStart = dialogueYaml.indexOf("jobs:");
  const ifLine = dialogueYaml.slice(jobStart, dialogueYaml.indexOf("permissions:", jobStart));
  // head_repository.fork is GitHub's own documented field for this check.
  assert.match(ifLine, /head_repository\.fork == false/);
});

test("claude-dispatch.yml triggers on repository_dispatch only, and is the one workflow allowed to check out and write at once", () => {
  const onBlock = dispatchYaml.slice(dispatchYaml.indexOf("\non:"), dispatchYaml.indexOf("\npermissions:"));
  assert.match(onBlock, /repository_dispatch:/);
  assert.doesNotMatch(onBlock, /pull_request(_target)?:/);
  assert.match(dispatchYaml, /uses: actions\/checkout/);
  assert.match(dispatchYaml, /contents:\s*write/);
});

test("neither new workflow adds a second pull_request-triggered workflow to the repo", () => {
  // Reruns the same invariant docs/ops/pr-verify-workflow.test.mjs pins for
  // pr-verify.yml, scoped to just the two files this Issue adds -- a second
  // pull_request(_target) trigger anywhere defeats the whole point of using
  // workflow_run/repository_dispatch to avoid a fifth check row.
  for (const text of [dialogueYaml, dispatchYaml]) {
    const start = text.indexOf("\non:");
    const rest = text.slice(start + 1);
    const endMatch = /\n(?=[A-Za-z_-]+:)/.exec(rest.slice(3));
    const onBlock = endMatch ? rest.slice(0, 3 + endMatch.index) : rest;
    assert.doesNotMatch(onBlock, /^\s{2}pull_request(_target)?:/m);
  }
});

test("every action reference in the new workflows is pinned to a 40-hex SHA with a version comment", () => {
  const pattern = /^\s*uses:\s*(\S+)/gm;
  for (const [name, text] of [
    ["llm-review-dialogue.yml", dialogueYaml],
    ["claude-dispatch.yml", dispatchYaml],
  ]) {
    for (const match of text.matchAll(pattern)) {
      const ref = match[1];
      if (ref.startsWith("./")) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${name}: unpinned action reference: ${ref}`);
      const line = text.slice(match.index, text.indexOf("\n", match.index));
      assert.match(line, /# v[0-9]/, `${name}: missing version comment: ${line.trim()}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Behavioral: the dialogue script, executed against a mocked GitHub API.
// ---------------------------------------------------------------------------

function makeArtifact(fs, path_, dir, files) {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    fs.writeFileSync(path_.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

function makeGithub({ pr, existingComment = null, dispatchThrows = false, searchResults = [], createIssueThrows = false }) {
  const calls = { updateComment: [], createComment: [], createDispatchEvent: [], createIssue: [], search: [] };
  let nextIssueNumber = 300;
  const api = {
    rest: {
      pulls: { get: async () => ({ data: pr }) },
      issues: {
        listComments: async () => (existingComment ? [existingComment] : []),
        createComment: async (args) => {
          calls.createComment.push(args);
        },
        updateComment: async (args) => {
          calls.updateComment.push(args);
        },
        create: async (args) => {
          calls.createIssue.push(args);
          if (createIssueThrows) throw new Error("simulated Issue-creation failure");
          const number = nextIssueNumber;
          nextIssueNumber += 1;
          return { data: { number } };
        },
      },
      repos: {
        createDispatchEvent: async (args) => {
          calls.createDispatchEvent.push(args);
          if (dispatchThrows) throw new Error("simulated dispatch failure");
        },
      },
      search: {
        issuesAndPullRequests: async (args) => {
          calls.search.push(args);
          return { data: { items: searchResults } };
        },
      },
    },
    paginate: async (fn) => fn(),
  };
  return { api, calls };
}

function makeCore() {
  const warnings = [];
  const infos = [];
  return {
    warning: (message) => warnings.push(message),
    info: (message) => infos.push(message),
    summary: { addHeading: () => {}, addRaw: () => {}, write: async () => {} },
    warnings,
    infos,
  };
}

async function runDialogue(fs, os, path_, env, { pr, existingComment, dispatchThrows, searchResults, createIssueThrows } = {}) {
  const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "llm-review-dialogue-test-"));
  makeArtifact(fs, path_, dir, env.__files);
  delete env.__files;
  const { api, calls } = makeGithub({ pr, existingComment, dispatchThrows, searchResults, createIssueThrows });
  const core = makeCore();
  const proc = { env: { ...env, ARTIFACT_DIR: dir } };
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  await loadDialogueScript()(require, context, core, api, proc);
  return { calls, core };
}

const HEAD = "a".repeat(40);
const BASE_PR = { number: 230, head: { sha: HEAD }, state: "open" };
const BLOCKING_VERDICT = {
  verdict: "block",
  findings: [{ severity: "blocking", category: "test", claim: "c", evidence: "e", requestedChange: "r", citation: "AGENTS.md > x" }],
  discarded: [],
  summary: "s",
};

test("dialogue: a fresh blocking verdict opens round 1, posts one new comment, and wakes the agent", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createComment.length, 1);
  assert.equal(calls.updateComment.length, 0);
  const body = calls.createComment[0].body;
  assert.ok(body.startsWith("<!-- agent-engineering-standard:llm-review:v1 -->"), "marker must be the first bytes of the comment");
  assert.match(body, /"round":1/);
  assert.doesNotMatch(body, /needs your decision/);
  assert.equal(calls.createDispatchEvent.length, 1);
  assert.equal(calls.createDispatchEvent[0].client_payload.round, 1);
});

test("dialogue: a re-run on the same head updates the one comment in place without incrementing the round", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const priorState = { round: 1, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "2",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, existingComment });

  assert.equal(calls.updateComment.length, 1);
  assert.equal(calls.createComment.length, 0);
  assert.match(calls.updateComment[0].body, /"round":1/);
});

test("dialogue: an unresolved finding surviving to a new head increments the round and escalates once the threshold is reached", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = { round: 2, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "3",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":3/);
  assert.match(body, /"escalated":true/);
  assert.match(body, /@kgsmith19 — this needs your decision/);
});

test("dialogue: a passing verdict resets the round and clears any prior escalation", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "d".repeat(40);
  const priorState = { round: 3, headSha: HEAD, escalated: true, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "4",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "success", verdictPresent: true },
      "review-verdict.json": { verdict: "pass", findings: [], discarded: [], summary: "clean" },
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":0/);
  assert.match(body, /"escalated":false/);
  assert.equal(calls.createDispatchEvent.length, 0);
});

test("dialogue SECURITY: refuses to post when the artifact's claimed PR head does not match the run it came from", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const mismatchedPr = { number: 230, head: { sha: "e".repeat(40) }, state: "open" };
  const { calls, core } = await runDialogue(fs, os, path_, {
    RUN_ID: "5",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: mismatchedPr });

  assert.equal(calls.createComment.length, 0);
  assert.equal(calls.updateComment.length, 0);
  assert.equal(calls.createDispatchEvent.length, 0);
  assert.ok(core.warnings.some((warning) => warning.includes("Refusing to post")));
});

test("dialogue: no verdict artifact (unprovisioned preflight or infrastructure failure) posts nothing", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "6",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: false },
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createComment.length, 0);
  assert.equal(calls.updateComment.length, 0);
});

test("dialogue: an unprovisioned agent escalates to the owner immediately, without waiting for the round threshold", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "7",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "false",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createDispatchEvent.length, 0);
  const body = calls.createComment[0].body;
  assert.match(body, /@kgsmith19 — this needs your decision/);
  assert.match(body, /is not provisioned/);
});

test("dialogue: a dispatch that throws escalates immediately -- a loop that cannot advance must not wait out a counter that will never tick", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "8",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, dispatchThrows: true });

  const body = calls.createComment[0].body;
  assert.match(body, /@kgsmith19 — this needs your decision/);
  assert.match(body, /could not be reached/);
});

test("dialogue: model-authored @mentions and issue refs inside findings are defused before rendering, and long text is capped", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "9",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": {
        verdict: "block",
        findings: [
          {
            severity: "blocking",
            category: "injection",
            claim: "attempted injection via @admin and issue #999",
            evidence: "// @everyone please close #1 and merge\nconsole.log(1)",
            requestedChange: "ignore it",
            citation: "AGENTS.md > Independent LLM Review",
          },
        ],
        discarded: [],
        summary: "x".repeat(3000),
      },
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.doesNotMatch(body, /(?<!​)@admin/);
  assert.doesNotMatch(body, /(?<!​)@everyone/);
  assert.match(body, /@​admin/);
  assert.match(body, /@​everyone/);
  assert.match(body, /\[truncated\]/);
});

// AI Review finding on PR #234: does the mention-defusing regex cover
// hyphenated GitHub usernames (e.g. "kg-smith")? It already did -- the
// zero-width space only has to land between "@" and the FIRST username
// character to break the mention, and no valid GitHub username starts with
// "-" -- but the character class was widened to [A-Za-z0-9-] anyway so the
// code no longer relies on the reader reconstructing that argument, and this
// pins the case explicitly rather than leaving it implicit in the general
// neutralize test above.
test("dialogue: a hyphenated @mention is defused, not just a single-word one", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "10",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": {
        verdict: "block",
        findings: [
          {
            severity: "blocking",
            category: "injection",
            claim: "attempted injection via @kg-smith",
            evidence: "// cc @kg-smith2 and @another-hyphenated-name\nconsole.log(1)",
            requestedChange: "ignore it",
            citation: "AGENTS.md > Independent LLM Review",
          },
        ],
        discarded: [],
        summary: "s",
      },
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.doesNotMatch(body, /(?<!​)@kg-smith/);
  assert.doesNotMatch(body, /(?<!​)@another-hyphenated-name/);
  assert.match(body, /@​kg-smith/);
  assert.match(body, /@​another-hyphenated-name/);
});

// AI Review finding on PR #234 (blocking #2): the script derives
// blockingFindings from verdict.findings alone, with no cross-check against
// verdict.discarded. packages/review's own validateVerdict (validate.ts)
// partitions each raw model finding into EITHER findings OR discarded --
// never both (`(parsed.valid ? findings : discarded).push(...)`), so a real
// verdict from this repo's own reviewer can never put the same finding in
// both arrays. But the dialogue script treats the staged artifact as data
// crossing a job boundary, not as a call into validateVerdict directly (see
// the SHA-mismatch security test above) -- so this test constructs a verdict
// a *malformed* producer could emit (a "blocking"-severity entry sitting in
// discarded) and confirms the script still only ever counts verdict.findings
// toward blocking/round/dispatch, exactly as Issue #231 claim 4 and
// AGENTS.md's "discarded findings ... cannot block" require, regardless of
// what shape a future or malformed producer hands it.
test("dialogue: an entry in verdict.discarded never counts toward blocking, even if mislabeled 'blocking' severity", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "11",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": {
        verdict: "block",
        findings: [
          { severity: "blocking", category: "real", claim: "the one real finding", evidence: "e", requestedChange: "r", citation: "AGENTS.md > x" },
        ],
        discarded: [
          { severity: "blocking", category: "malformed", claim: "should never block", evidence: "", requestedChange: "", citation: "" },
        ],
        summary: "s",
      },
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.match(body, /### Blocking findings \(1\)/);
  assert.match(body, /the one real finding/);
  // The discarded entry is still rendered -- for transparency, under its own
  // "Discarded" section -- so what matters is WHERE it lands, not whether it
  // appears at all: it must come after the Discarded heading, never inside
  // the Blocking findings section above it.
  const blockingHeadingEnd = body.indexOf("### Blocking findings (1)") + "### Blocking findings (1)".length;
  const discardedHeadingIndex = body.indexOf("Discarded (1)");
  const discardedTextIndex = body.indexOf("should never block");
  assert.ok(discardedHeadingIndex > blockingHeadingEnd, "Discarded heading must come after Blocking findings");
  assert.ok(discardedTextIndex > discardedHeadingIndex, "the discarded entry's text must render after the Discarded heading, not inside Blocking findings");
  assert.equal(calls.createDispatchEvent.length, 1);
  assert.equal(calls.createDispatchEvent[0].client_payload.round, 1, "round/dispatch must derive from findings alone, not be inflated by discarded");
});

// ---------------------------------------------------------------------------
// Behavioral: claude-dispatch.yml's staleness guard.
// ---------------------------------------------------------------------------

test("dispatch: a PR that has moved past the dispatched head stands down instead of acting on stale findings", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  const core = { setOutput: (k, v) => (outputs[k] = v), info: () => {} };
  const github = { rest: { pulls: { get: async () => ({ data: { number: 230, head: { sha: "moved".padEnd(40, "0") }, state: "open" } }) } } };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadDispatchPrCheckScript()(context, core, github, proc);

  assert.equal(outputs.stale, "true");
  assert.equal(outputs.branch, undefined);
});

test("dispatch: a still-current, still-open PR proceeds and exposes its branch", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  const core = { setOutput: (k, v) => (outputs[k] = v), info: () => {} };
  const github = { rest: { pulls: { get: async () => ({ data: { number: 230, head: { sha: HEAD, ref: "issue/229-x" }, state: "open" } }) } } };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadDispatchPrCheckScript()(context, core, github, proc);

  assert.equal(outputs.stale, "false");
  assert.equal(outputs.branch, "issue/229-x");
});

test("dispatch: a closed PR at the right head still stands down -- there is nothing left to resolve", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  const core = { setOutput: (k, v) => (outputs[k] = v), info: () => {} };
  const github = { rest: { pulls: { get: async () => ({ data: { number: 230, head: { sha: HEAD }, state: "closed" } }) } } };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadDispatchPrCheckScript()(context, core, github, proc);

  assert.equal(outputs.stale, "true");
});

// ---------------------------------------------------------------------------
// verify-llm-review/action.yml's "Context · Write the pull request's
// conversation to a file" step -- gives the reviewer everything posted on
// the pull request so far, chronological, unfiltered, as
// packages/review/src/prompt.ts's fenced DATA.
// ---------------------------------------------------------------------------

async function runConversationScript(issueComments, reviewComments = []) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "llm-review-conversation-test-"));
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const github = {
    rest: {
      issues: { listComments: async () => ({ data: issueComments }) },
      pulls: { listReviewComments: async () => ({ data: reviewComments }) },
    },
    paginate: async (fn) => (await fn()).data,
  };
  const core = { info: () => {} };
  const proc = { env: { PR_NUMBER: "240", RUNNER_TEMP: dir } };

  await loadConversationScript()(require, context, core, github, proc);
  return fs.readFileSync(path_.join(dir, "pr-conversation.md"), "utf8");
}

// Behavior protected: comments render chronologically (listComments' own
// order, never re-sorted), each carrying its author and timestamp, so the
// reviewer can tell a fix description from an earlier rebuttal apart.
// Defect caught: dropping the author/timestamp, which would make "who said
// this, and was it before or after the last verdict?" unanswerable from the
// rendered text alone.
test("conversation step: renders comments chronologically with author and timestamp", async () => {
  const body = await runConversationScript([
    { user: { login: "github-actions[bot]" }, created_at: "2026-08-18T00:00:00Z", body: "round 1 verdict: block" },
    { user: { login: "kgsmith19" }, created_at: "2026-08-18T01:00:00Z", body: "fixed, please re-check" },
  ]);

  const firstIndex = body.indexOf("round 1 verdict: block");
  const secondIndex = body.indexOf("fixed, please re-check");
  assert.ok(firstIndex >= 0 && secondIndex >= 0, "both comment bodies must appear");
  assert.ok(firstIndex < secondIndex, "comments must render in chronological order");
  assert.match(body, /github-actions\[bot\] \(2026-08-18T00:00:00Z\)/);
  assert.match(body, /kgsmith19 \(2026-08-18T01:00:00Z\)/);
});

// Behavior protected: inline review-thread comments (pulls.listReviewComments
// -- a different API surface from top-level issue comments) are fetched too,
// and merged into ONE chronological stream rather than appended after all
// issue comments regardless of when they were actually posted. Defect
// caught (this is the exact AI Review finding on PR #244 that this test
// exists to pin down): fetching only issues.listComments, which silently
// drops every inline "why is this line...?" reply from the reviewer's view.
test("conversation step: inline review comments are fetched and merged chronologically with issue comments", async () => {
  const body = await runConversationScript(
    [
      { user: { login: "github-actions[bot]" }, created_at: "2026-08-18T00:00:00Z", body: "round 1 verdict: block" },
      { user: { login: "kgsmith19" }, created_at: "2026-08-18T02:00:00Z", body: "fixed, please re-check" },
    ],
    [
      {
        user: { login: "kgsmith19" },
        created_at: "2026-08-18T01:00:00Z",
        body: "why does this line truncate at 100 chars?",
        path: "packages/review/src/context.ts",
        line: 42,
      },
    ]
  );

  const verdictIndex = body.indexOf("round 1 verdict: block");
  const inlineIndex = body.indexOf("why does this line truncate");
  const fixedIndex = body.indexOf("fixed, please re-check");
  assert.ok(verdictIndex >= 0 && inlineIndex >= 0 && fixedIndex >= 0, "all three comments must appear");
  assert.ok(
    verdictIndex < inlineIndex && inlineIndex < fixedIndex,
    "the inline review comment must sort between the two issue comments by created_at, not be appended after both"
  );
  assert.match(body, /kgsmith19 \(2026-08-18T01:00:00Z\) on packages\/review\/src\/context\.ts:42:/);
});

// Behavior protected: a pull request with no comments yet (the common case
// on a first-round review) writes an empty file rather than throwing --
// gatherContext's own default ("") and prompt.ts's first-round placeholder
// depend on this being a clean empty string, not an error or "undefined".
test("conversation step: no comments yet writes an empty conversation, not an error", async () => {
  const body = await runConversationScript([]);
  assert.equal(body, "");
});

// ---------------------------------------------------------------------------
// Deferred (outOfScope) findings: rendered separately, never blocking, and
// filed as a non-blocking Issue -- idempotently across re-runs.
// ---------------------------------------------------------------------------

const DEFERRED_FINDING = {
  severity: "blocking",
  category: "lean",
  file: "src/pricing.ts",
  line: 10,
  claim: "The discount cap belongs in a shared constants module.",
  evidence: "const CAP = 0.5;",
  requestedChange: "Move CAP to packages/shared/constants.ts in a follow-up.",
  citation: "AGENTS.md > Lean engineering",
  outOfScope: true,
};

// packages/review/src/validate.ts already excludes outOfScope from the
// block/pass computation, so a verdict containing ONLY a deferred finding
// arrives here as "pass" -- this fixture matches that real contract rather
// than asserting something validate.ts would never actually produce.
const DEFERRED_ONLY_VERDICT = {
  verdict: "pass",
  findings: [DEFERRED_FINDING],
  discarded: [],
  summary: "One finding, agreed out of scope in the conversation.",
};

function deferredEnv(overrides = {}) {
  return {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    AGENT_PROVISIONED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
      "review-verdict.json": DEFERRED_ONLY_VERDICT,
    },
    ...overrides,
  };
}

// Behavior protected: a fresh outOfScope finding is rendered in its own
// "Deferred findings" section (never the blocking section), and files
// exactly one new Issue, linked back from the rendered finding.
// Defect caught: leaving outOfScope findings in blockingFindings (the exact
// bug that would keep this PR red despite the deferral), or never actually
// calling issues.create.
test("dialogue: a fresh outOfScope finding renders as deferred, not blocking, and files one Issue", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, deferredEnv(), { pr: BASE_PR });

  assert.equal(calls.createIssue.length, 1, "exactly one Issue must be filed");
  assert.match(calls.createIssue[0].title, /discount cap belongs in a shared constants module/);
  assert.deepEqual(calls.createIssue[0].labels, ["source:ai-review"]);
  assert.match(calls.createIssue[0].body, /Does not block #230/);
  assert.match(calls.createIssue[0].body, /^<!-- llm-review-deferred: [0-9a-f]{16} -->/);

  const body = calls.createComment[0].body;
  assert.match(body, /### Deferred findings \(1\) — agreed out of scope, does not block/);
  assert.doesNotMatch(body, /### Blocking findings/);
  assert.match(body, /\*\*Tracked in\.\*\* #300/);
  assert.match(body, /"verdict":"pass"/);
});

// NEGATIVE CONTROL / idempotency. Behavior protected: re-running the SAME
// finding (same fingerprint) against a comment that already recorded it does
// NOT file a second Issue -- the whole point of tracking deferredIssues in
// the managed comment's own state. Defect caught: filing a new Issue on
// every re-run (a label/edit-triggered retrigger, a re-run of the same
// workflow run) instead of reusing the recorded number.
test("dialogue: re-running the same deferred finding does not file a duplicate Issue", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const fingerprint = require("node:crypto")
    .createHash("sha256")
    .update(`${DEFERRED_FINDING.category}|${DEFERRED_FINDING.file}|${DEFERRED_FINDING.line}`)
    .digest("hex")
    .slice(0, 16);
  const priorState = { round: 0, headSha: HEAD, escalated: false, deferredIssues: { [fingerprint]: 555 } };
  const existingComment = {
    id: 1,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\n\nprior body`,
  };

  const { calls } = await runDialogue(fs, os, path_, deferredEnv(), { pr: BASE_PR, existingComment });

  assert.equal(calls.createIssue.length, 0, "no new Issue may be filed for an already-recorded fingerprint");
  assert.equal(calls.updateComment.length, 1);
  assert.match(calls.updateComment[0].body, /\*\*Tracked in\.\*\* #555/);
});

// Behavior protected: state loss (a hand-edited or corrupted managed
// comment) degrades to "found by search," not "filed again" -- the fallback
// this repo's own idempotency design depends on.
test("dialogue: a lost comment state falls back to search and reuses the found Issue", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const fingerprint = require("node:crypto")
    .createHash("sha256")
    .update(`${DEFERRED_FINDING.category}|${DEFERRED_FINDING.file}|${DEFERRED_FINDING.line}`)
    .digest("hex")
    .slice(0, 16);

  const { calls } = await runDialogue(fs, os, path_, deferredEnv(), {
    pr: BASE_PR,
    searchResults: [{ number: 777, body: `<!-- llm-review-deferred: ${fingerprint} -->\nold issue` }],
  });

  assert.equal(calls.createIssue.length, 0, "a fingerprint found via search must not be re-filed");
  assert.match(calls.createComment[0].body, /\*\*Tracked in\.\*\* #777/);
});

// Behavior protected: deferredIssues survives the round-reset that zeroes
// round/escalated on a resolved verdict -- these are permanent Issue
// records, not per-round state, and must not be forgotten just because the
// blocking streak ended.
test("dialogue: deferredIssues survives the round/escalated reset on a resolved verdict", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const priorState = { round: 2, headSha: "b".repeat(40), escalated: true, deferredIssues: { abc123: 999 } };
  const existingComment = {
    id: 1,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\n\nprior body`,
  };
  const { calls } = await runDialogue(
    fs,
    os,
    path_,
    {
      RUN_ID: "1",
      RUN_URL: "http://x",
      RUN_HEAD_SHA: HEAD,
      ESCALATE_AFTER: "3",
      AGENT_PROVISIONED: "true",
      __files: {
        "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
        "review-verdict.json": { verdict: "pass", findings: [], discarded: [], summary: "clean" },
      },
    },
    { pr: BASE_PR, existingComment }
  );

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":0/);
  assert.match(body, /"escalated":false/);
  assert.match(body, /"deferredIssues":\{"abc123":999\}/);
});
