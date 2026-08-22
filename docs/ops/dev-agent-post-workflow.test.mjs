// Real red/green tests for .github/workflows/dev-agent-post.yml -- the
// workflow_dispatch backstop that lets an interactive Claude Code session
// post a PR/Issue comment under the dev App identity instead of its own
// ambient GitHub credential. Issue #292 (Epic #286's slice F).
//
// Same philosophy as the sibling *-workflow.test.mjs files: extract the
// actual embedded scripts and execute them against a mocked GitHub API,
// rather than reimplementing the logic in JS (which could silently drift
// from what CI actually runs), and pin structural invariants (permissions
// shape, action pins, the no-fallback guarantee) with real string
// assertions over the shipped YAML.
//
// Run with: node --test docs/ops/dev-agent-post-workflow.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/dev-agent-post.yml");
const workflow = readFileSync(workflowPath, "utf8");

// Same block extractor as llm-review-dialogue-workflow.test.mjs: stops at
// the first line whose indentation drops below the block's own, which is
// what actually ends a YAML block scalar -- this file has two script: |
// blocks, so the default fromIndex=0 alone would only ever find the first.
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

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadPreflightScript() {
  const marker = workflow.indexOf("Preflight · Resolve the dev provider/model");
  assert.ok(marker >= 0, "dev-agent-post.yml: preflight step not found");
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(workflow, marker));
}

function loadPostScript() {
  const marker = workflow.indexOf("Post · Comment under the dev App identity");
  assert.ok(marker >= 0, "dev-agent-post.yml: post step not found");
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(workflow, marker));
}

// Slices one `- name: <stepName>` step's own YAML block out of the file,
// stopping at the next step (or end of file) -- used for the structural
// permissions/action-pin/no-fallback checks below.
function stepBlock(yamlText, stepName) {
  const idx = yamlText.indexOf(`- name: ${stepName}`);
  assert.ok(idx >= 0, `step "${stepName}" not found`);
  const nextStepIdx = yamlText.indexOf("\n      - name:", idx + 1);
  return yamlText.slice(idx, nextStepIdx > 0 ? nextStepIdx : yamlText.length);
}

// ---------------------------------------------------------------------------
// Structural.
// ---------------------------------------------------------------------------

test("dev-agent-post.yml triggers on workflow_dispatch only, with issue_or_pr_number and body required", () => {
  const onBlock = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /pull_request(_target)?:/);
  assert.doesNotMatch(onBlock, /repository_dispatch:/);
  const inputsBlock = onBlock.slice(onBlock.indexOf("inputs:"));
  assert.match(inputsBlock, /issue_or_pr_number:[\s\S]*?required:\s*true/);
  assert.match(inputsBlock, /body:[\s\S]*?required:\s*true/);
  // comment_id is documented as optional -- required: true here would make
  // "post a new comment" impossible without also passing one.
  assert.match(inputsBlock, /comment_id:[\s\S]*?required:\s*false/);
});

test("dev-agent-post.yml adds no PR/Issue check row and holds no default write permission", () => {
  assert.doesNotMatch(workflow, /\n\son:\s*\n\s*pull_request/);
  const topPermissions = workflow.slice(workflow.indexOf("\npermissions:"), workflow.indexOf("\njobs:"));
  assert.match(topPermissions, /contents:\s*read/);
  assert.doesNotMatch(topPermissions, /pull-requests:\s*write/);
  assert.doesNotMatch(topPermissions, /issues:\s*write/);
});

test("the post job's own GITHUB_TOKEN permissions never include issues/pull-requests write -- posting goes through the minted App token only", () => {
  const jobStart = workflow.indexOf("\n  post:\n");
  assert.ok(jobStart >= 0, "no `post:` job found");
  const permissionsStart = workflow.indexOf("permissions:", jobStart);
  const stepsStart = workflow.indexOf("steps:", permissionsStart);
  const jobPermissions = workflow.slice(permissionsStart, stepsStart);
  assert.match(jobPermissions, /contents:\s*read/);
  assert.match(jobPermissions, /id-token:\s*write/, "needs id-token: write for the Infisical OIDC exchange");
  assert.doesNotMatch(jobPermissions, /issues:\s*write/, "posting must go through the minted dev App token, not this job's own GITHUB_TOKEN");
  assert.doesNotMatch(jobPermissions, /pull-requests:\s*write/);

  const postStepStart = workflow.indexOf("Post · Comment under the dev App identity");
  const scriptStart = workflow.indexOf("script: |", postStepStart);
  const postStepBlock = workflow.slice(postStepStart, scriptStart);
  assert.match(postStepBlock, /github-token:\s*\$\{\{\s*steps\.dev-app-token\.outputs\.token\s*\}\}/);
});

test("every action reference in dev-agent-post.yml is pinned to a 40-hex SHA with a version comment", () => {
  const pattern = /^\s*uses:\s*(\S+)/gm;
  for (const match of workflow.matchAll(pattern)) {
    const ref = match[1];
    if (ref.startsWith("./")) continue;
    assert.match(ref, /@[0-9a-f]{40}$/, `unpinned action reference: ${ref}`);
    const line = workflow.slice(match.index, workflow.indexOf("\n", match.index));
    assert.match(line, /# v[0-9]/, `missing version comment: ${line.trim()}`);
  }
});

// Behavior protected: the whole reason this workflow exists as a SEPARATE
// file from llm-review-dialogue.yml's own (deliberately fallback-tolerant)
// reviewer-identity mint -- a silent fallback here would reproduce the
// exact bug Epic #286 exists to fix. This is documentation-strength on its
// own; the MUTATION CONTROL test below proves the check is failure-sensitive,
// not just currently true.
test("no continue-on-error near the Infisical pull or the App token mint -- no fallback identity by design", () => {
  const pullBlock = stepBlock(workflow, "Setup · Pull the dev App's credentials from Infisical");
  const mintBlock = stepBlock(workflow, "Setup · Mint the dev App's installation token");
  assert.doesNotMatch(pullBlock, /continue-on-error/);
  assert.doesNotMatch(mintBlock, /continue-on-error/);
});

// MUTATION CONTROL for the test above. Behavior protected: the assertion
// machinery itself is capable of catching a continue-on-error regression on
// either step, not merely documenting today's absence. Constructs a
// synthetic mutated copy of the real file (never edits the shipped file)
// and confirms the SAME stepBlock()/doesNotMatch logic used above would
// fail against it -- this is what actually proves the no-fallback guarantee
// is enforced, per Issue #292's own Verification section.
test("MUTATION CONTROL: the continue-on-error absence check is failure-sensitive", () => {
  const infisicalUsesLine = "uses: Infisical/secrets-action@77ab1f4ccd183a543cb5b42435fbd181189f4995 # v1.0.16";
  assert.ok(workflow.includes(infisicalUsesLine), "fixture assumption: the real file must contain this exact line");
  const mutated = workflow.replace(infisicalUsesLine, `continue-on-error: true\n        ${infisicalUsesLine}`);
  assert.notEqual(mutated, workflow, "the replacement must actually have matched something");

  const mutatedPullBlock = stepBlock(mutated, "Setup · Pull the dev App's credentials from Infisical");
  assert.match(mutatedPullBlock, /continue-on-error/, "the check must be ABLE to catch this exact regression");
});

// ---------------------------------------------------------------------------
// Behavioral: preflight.
// ---------------------------------------------------------------------------

function agentRolesFixture(devProvider, devModel = "claude-opus-5") {
  return Buffer.from(`dev:\n  provider: ${devProvider}\n  model: ${devModel}\n\nreview:\n  provider: openai\n  model: gpt-5-mini\n`, "utf8").toString(
    "base64"
  );
}

async function runPreflight({ devProvider = "anthropic", appId = "app-id", appPrivateKey = "app-key", getContentThrows = false, agentRolesRaw = null } = {}) {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  let failure = null;
  const core = {
    setOutput: (k, v) => (outputs[k] = v),
    setFailed: (message) => (failure = message),
    info: () => {},
  };
  const github = {
    rest: {
      repos: {
        getContent: async () => {
          if (getContentThrows) throw new Error("simulated getContent failure");
          return { data: { encoding: "base64", content: agentRolesRaw !== null ? agentRolesRaw : agentRolesFixture(devProvider) } };
        },
      },
    },
  };
  const proc = { env: { APP_ID: appId, APP_PRIVATE_KEY: appPrivateKey } };
  await loadPreflightScript()(require, context, core, github, proc);
  return { outputs, failure };
}

test("preflight: resolves provider and model from agent-roles.yaml when the App identity is present", async () => {
  const { outputs, failure } = await runPreflight({ devProvider: "anthropic" });
  assert.equal(failure, null);
  assert.equal(outputs.provider, "anthropic");
  assert.equal(outputs.model, "claude-opus-5");
});

test("preflight: a missing dev App credential fails closed and names both secrets, citing Issue #292", async () => {
  const { outputs, failure } = await runPreflight({ appId: "", appPrivateKey: "" });
  assert.equal(outputs.provider, "anthropic", "provider must still resolve -- the App-credential check is independent");
  assert.match(failure, /DEV_GITHUB_APP_ID/);
  assert.match(failure, /DEV_GITHUB_APP_PRIVATE_KEY/);
  assert.match(failure, /#292/);
});

test("preflight: one App secret present but not the other still fails closed", async () => {
  const { failure } = await runPreflight({ appId: "app-id", appPrivateKey: "" });
  assert.match(failure, /DEV_GITHUB_APP_ID/);
  assert.match(failure, /DEV_GITHUB_APP_PRIVATE_KEY/);
});

test("preflight: agent-roles.yaml with no parseable dev.provider fails closed rather than guessing", async () => {
  const { failure } = await runPreflight({ agentRolesRaw: Buffer.from("not: a\nrecognizable: shape\n", "utf8").toString("base64") });
  assert.match(failure, /Could not find dev\.provider/);
});

test("preflight: the default branch being unreadable fails closed with the real error", async () => {
  const { failure } = await runPreflight({ getContentThrows: true });
  assert.match(failure, /simulated getContent failure/);
});

// ---------------------------------------------------------------------------
// Behavioral: posting.
// ---------------------------------------------------------------------------

function makeGithub() {
  const calls = { createComment: [], updateComment: [] };
  const api = {
    rest: {
      issues: {
        createComment: async (args) => {
          calls.createComment.push(args);
          return { data: { html_url: "https://github.com/kgsmith19/hyperbolic-core/issues/1#issuecomment-1" } };
        },
        updateComment: async (args) => {
          calls.updateComment.push(args);
        },
      },
    },
  };
  return { api, calls };
}

async function runPost({ issueOrPrNumber = "42", commentId = "", body = "hello", provider = "anthropic", model = "claude-opus-5" } = {}) {
  const { api, calls } = makeGithub();
  const core = { setFailed: (m) => (core.failure = m), info: () => {} };
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const proc = { env: { ISSUE_OR_PR_NUMBER: issueOrPrNumber, COMMENT_ID: commentId, BODY: body, PROVIDER: provider, MODEL: model } };
  await loadPostScript()(require, context, core, api, proc);
  return { calls, failure: core.failure };
}

test("post: creates a new comment with the role/provider/model footer appended", async () => {
  const { calls, failure } = await runPost({ body: "Fixed the thing." });
  assert.equal(failure, undefined);
  assert.equal(calls.createComment.length, 1);
  assert.equal(calls.updateComment.length, 0);
  const { body, issue_number } = calls.createComment[0];
  assert.equal(issue_number, 42);
  assert.match(body, /^Fixed the thing\./);
  assert.match(body, /_Dev Agent — role `dev` · provider `anthropic` · model `claude-opus-5`_$/);
});

test("post: a comment_id updates that comment instead of creating a new one", async () => {
  const { calls } = await runPost({ commentId: "999", body: "Updated reply." });
  assert.equal(calls.createComment.length, 0);
  assert.equal(calls.updateComment.length, 1);
  assert.equal(calls.updateComment[0].comment_id, 999);
  assert.match(calls.updateComment[0].body, /_Dev Agent — role `dev` · provider `anthropic` · model `claude-opus-5`_$/);
});

test("post: the footer states the interpolated provider/model, not a hardcoded value", async () => {
  const { calls } = await runPost({ provider: "openai", model: "gpt-5" });
  assert.match(calls.createComment[0].body, /provider `openai` · model `gpt-5`/);
});

// Behavior protected: pasted PR/Issue content in `body` may itself carry
// forged mention/issue-reference text -- the same fence-marker defusal
// llm-review-dialogue.yml already applies to model-authored content.
test("post: mentions and issue references in the body are defused, matching llm-review-dialogue.yml's neutralize()", async () => {
  const { calls } = await runPost({ body: "cc @kgsmith19 re #128" });
  const body = calls.createComment[0].body;
  assert.doesNotMatch(body, /(?<!@​)@kgsmith19/, "a bare @mention must not survive undefused");
  assert.match(body, /@​kgsmith19/);
  assert.match(body, /#​128/);
});

test("post: a non-numeric or non-positive issue_or_pr_number fails closed without calling the API", async () => {
  const { calls, failure } = await runPost({ issueOrPrNumber: "not-a-number" });
  assert.equal(calls.createComment.length, 0);
  assert.equal(calls.updateComment.length, 0);
  assert.match(failure, /issue_or_pr_number must be a positive integer/);

  const zero = await runPost({ issueOrPrNumber: "0" });
  assert.equal(zero.calls.createComment.length, 0);
  assert.match(zero.failure, /issue_or_pr_number must be a positive integer/);
});
