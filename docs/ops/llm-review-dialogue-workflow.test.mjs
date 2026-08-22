// Structural + behavioral assertions over the LLM Review dialogue machinery:
// .github/workflows/llm-review-dialogue.yml, .github/workflows/dev-agent-dispatch.yml,
// .github/workflows/llm-review-recheck.yml, and the artifact-staging steps in
// .github/actions/verify-llm-review/action.yml.
//
// Issue #231. This closes the gap AGENTS.md used to name explicitly:
// "Posting findings into the PR discussion itself, with a round counter and
// owner escalation after repeated unresolved rounds ... is tracked
// separately and is not yet implemented." Three invariants make this a
// multi-workflow design rather than one, and getting any of them wrong is a
// security bug, not a style issue:
//
//   1. ai-review (pr-verify.yml) and llm-review-recheck.yml both execute
//      pull-request-authored code while holding a provider credential, so
//      neither may EVER hold a token that can write to the pull request --
//      unaffected by ai-review also being a mandatory needs: dependency of
//      PR Gate (#232): "required in substance" says nothing about which job
//      is safe to trust with write access.
//   2. The posting job (llm-review-dialogue.yml) holds pull-requests: write,
//      so it must NEVER check out or execute repository content -- same
//      discipline as pr-verify.yml's own "PR Gate".
//   3. No new workflow may add a pull-request check row -- workflow_run and
//      repository_dispatch report none, which is exactly why they were
//      chosen over a new job in pr-verify.yml. llm-review-recheck.yml
//      (Issue #262's follow-on slice 8) reuses the same repository_dispatch
//      mechanism dev-agent-dispatch.yml itself uses, for the same reason:
//      a comment posted with GITHUB_TOKEN cannot retrigger a pull_request
//      workflow, and repository_dispatch is one of the two documented
//      exceptions.
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
const dispatchPath = path.join(root, ".github/workflows/dev-agent-dispatch.yml");
const recheckPath = path.join(root, ".github/workflows/llm-review-recheck.yml");
const reviewActionPath = path.join(root, ".github/actions/verify-llm-review/action.yml");
const dialogueYaml = readFileSync(dialoguePath, "utf8");
const dispatchYaml = readFileSync(dispatchPath, "utf8");
const recheckYaml = readFileSync(recheckPath, "utf8");
const reviewActionYaml = readFileSync(reviewActionPath, "utf8");

// General "script: |" block extractor. Unlike pr-verify-workflow.test.mjs's
// version, this does not assume the block is the last thing in the file --
// dev-agent-dispatch.yml's script step is followed by a checkout and an action
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
  // Anchored rather than defaulting to the first `script: |` block in the
  // file: a temporary OIDC-subject debug step (see llm-review-dialogue.yml's
  // own header comment on it) now runs earlier in the job and has a
  // `script: |` block of its own, which a bare fromIndex=0 search would grab
  // instead of the real posting script.
  const marker = dialogueYaml.indexOf("Dialogue · Post findings");
  assert.ok(marker >= 0, "llm-review-dialogue.yml: posting step not found");
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(dialogueYaml, marker));
}

// The preflight step is the FIRST script: | block in dev-agent-dispatch.yml,
// so extractScript's default fromIndex finds it directly.
function loadPreflightScript() {
  const marker = dispatchYaml.indexOf("Preflight · Resolve the dev provider");
  assert.ok(marker >= 0, "dev-agent-dispatch.yml: preflight step not found");
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(dispatchYaml, marker));
}

function loadDispatchPrCheckScript() {
  // Newline-terminated: "id: pr" is also a PREFIX of the earlier preflight
  // step's own "id: preflight", so a bare substring search would now match
  // that step instead (Issue #252's follow-on slice 7 added it ahead of this
  // one) and hand back the wrong script entirely.
  const marker = dispatchYaml.indexOf("id: pr\n");
  assert.ok(marker >= 0, "dev-agent-dispatch.yml: no `id: pr` step found");
  return new AsyncFunction("context", "core", "github", "process", extractScript(dispatchYaml, marker));
}

// dev-agent-dispatch.yml's LAST script: | block (Issue #262's follow-on
// slice 8) -- fires llm-review-recheck for a PR the agent replied to
// without pushing. Located by its own step name, same as every other
// multi-block extractor in this file.
function loadRecheckFireScript() {
  const marker = dispatchYaml.indexOf("Recheck · Fire a recheck if the agent replied without pushing a commit");
  assert.ok(marker >= 0, "dev-agent-dispatch.yml: recheck-fire step not found");
  return new AsyncFunction("context", "core", "github", "process", extractScript(dispatchYaml, marker));
}

// llm-review-recheck.yml's own staleness guard -- the FIRST (and only)
// script: | block in that file, mirroring loadDispatchPrCheckScript()'s
// shape for dev-agent-dispatch.yml's own PR-check step.
function loadRecheckContextScript() {
  const marker = recheckYaml.indexOf("Context · Resolve the pull request, and stop if it moved on");
  assert.ok(marker >= 0, "llm-review-recheck.yml: context step not found");
  return new AsyncFunction("context", "core", "github", "process", extractScript(recheckYaml, marker));
}

// The conversation step is the SECOND script: | block in this file (after
// the Issue-body step), so it needs a starting index -- the same reason
// loadDispatchPrCheckScript() above locates its block by a step id first.
function loadConversationScript() {
  const marker = reviewActionYaml.indexOf("Context · Write the pull request's conversation to a file");
  assert.ok(marker >= 0, "verify-llm-review/action.yml: conversation step not found");
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(reviewActionYaml, marker));
}

// The Issue-and-PR-body step is the FIRST script: | block in this file, so
// no starting index is needed -- extractScript's default fromIndex finds it.
function loadIssueAndPrBodyScript() {
  const marker = reviewActionYaml.indexOf("Context · Write the linked Issue body and the pull request body to files");
  assert.ok(marker >= 0, "verify-llm-review/action.yml: Issue-and-PR-body step not found");
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

// Issue #272: the reviewer posts under its own App identity when that
// credential is available, and degrades to github.token -- never fails the
// job -- when it is not. Structural, not behavioral: the actual fallback
// logic is covered by the behavioral tests below.
test("llm-review-dialogue.yml mints the reviewer's own App identity from Infisical, with a github.token fallback if it can't", () => {
  assert.match(dialogueYaml, /id-token:\s*write/, "needs id-token: write for the Infisical OIDC exchange");

  const secretsStart = dialogueYaml.indexOf("Infisical/secrets-action");
  assert.ok(secretsStart >= 0, "no Infisical/secrets-action step found");
  const secretsStepStart = dialogueYaml.lastIndexOf("- name:", secretsStart);
  const secretsBlock = dialogueYaml.slice(secretsStepStart, dialogueYaml.indexOf("- name:", secretsStart));
  assert.match(secretsBlock, /continue-on-error:\s*true/, "an unprovisioned reviewer identity must not fail the job");
  assert.match(secretsBlock, /secret-path:\s*"\/review\/"/, "must read the same /review/ path verify-llm-review already reads");

  const tokenStart = dialogueYaml.indexOf("create-github-app-token");
  assert.ok(tokenStart >= 0, "no actions/create-github-app-token step found");
  const tokenStepStart = dialogueYaml.lastIndexOf("- name:", tokenStart);
  const tokenBlock = dialogueYaml.slice(tokenStepStart, dialogueYaml.indexOf("script: |", tokenStart));
  assert.match(tokenBlock, /continue-on-error:\s*true/);
  assert.match(tokenBlock, /app-id:\s*\$\{\{\s*env\.REVIEW_GITHUB_APP_ID\s*\}\}/);
  assert.match(tokenBlock, /private-key:\s*\$\{\{\s*env\.REVIEW_GITHUB_APP_PRIVATE_KEY\s*\}\}/);

  // The posting step's own github-token: input must fall back to github.token
  // rather than leaving the whole step unable to authenticate at all.
  const postingStart = dialogueYaml.indexOf("Dialogue · Post findings");
  const githubTokenLine = dialogueYaml.slice(postingStart, dialogueYaml.indexOf("script: |", postingStart));
  assert.match(githubTokenLine, /github-token:\s*\$\{\{\s*steps\.review-app-token\.outputs\.token\s*\|\|\s*github\.token\s*\}\}/);
});

// The dev agent's own Anthropic credential (model key, distinct from the App
// identity above) is sourced from Infisical's /dev/ path, never a GitHub
// secret -- one credential store per identity, matching the reviewer's own
// model-key pattern (REVIEW_ANTHROPIC_API_KEY lives only in Infisical's
// /review/ path). Defect caught: a future edit that reverts either the
// HAS_ANTHROPIC_* expressions or the /dev/ pull step back to reading a raw
// GitHub secret, silently reintroducing the exact duplicate-credential-copy
// hazard AGENTS.md documents for the platform publishable key.
test("llm-review-dialogue.yml sources the dev agent's Anthropic credential from Infisical, not a GitHub secret", () => {
  const pullStart = dialogueYaml.indexOf("Dialogue · Check whether the dev agent's Anthropic credential is provisioned in Infisical");
  assert.ok(pullStart >= 0, "no dev-agent Infisical presence-check step found");
  const pullStepStart = dialogueYaml.lastIndexOf("- name:", pullStart);
  const pullBlock = dialogueYaml.slice(pullStepStart, dialogueYaml.indexOf("- name:", pullStart));
  assert.match(pullBlock, /continue-on-error:\s*true/, "an unprovisioned dev credential must not fail the posting job");
  assert.match(pullBlock, /secret-path:\s*"\/dev\/"/, "must read the same /dev/ path dev-agent-dispatch.yml's own preflight reads");
  assert.match(pullBlock, /identity-id:\s*\$\{\{\s*vars\.INFISICAL_DEV_IDENTITY_ID\s*\}\}/, "must authenticate as the dev identity, not the reviewer's");

  const postingStart = dialogueYaml.indexOf("Dialogue · Post findings");
  const postingBlock = dialogueYaml.slice(postingStart, dialogueYaml.indexOf("with:", postingStart));
  assert.match(
    postingBlock,
    /HAS_ANTHROPIC_OAUTH:\s*\$\{\{\s*env\.DEV_CLAUDE_CODE_OAUTH_TOKEN\s*!=\s*''\s*\}\}/,
    "HAS_ANTHROPIC_OAUTH must read the Infisical-sourced env var, not secrets.CLAUDE_CODE_OAUTH_TOKEN"
  );
  assert.match(
    postingBlock,
    /HAS_ANTHROPIC_API_KEY:\s*\$\{\{\s*env\.DEV_ANTHROPIC_API_KEY\s*!=\s*''\s*\}\}/,
    "HAS_ANTHROPIC_API_KEY must read the Infisical-sourced env var, not secrets.ANTHROPIC_API_KEY"
  );
  assert.match(
    postingBlock,
    /HAS_DEV_APP_ID:\s*\$\{\{\s*env\.DEV_GITHUB_APP_ID\s*!=\s*''\s*\}\}/,
    "the dialogue preflight must include the dev App ID in its provisioned decision"
  );
  assert.match(
    postingBlock,
    /HAS_DEV_APP_PRIVATE_KEY:\s*\$\{\{\s*env\.DEV_GITHUB_APP_PRIVATE_KEY\s*!=\s*''\s*\}\}/,
    "the dialogue preflight must include the dev App private key in its provisioned decision"
  );
  assert.doesNotMatch(postingBlock, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, "must not fall back to a raw GitHub secret");
  assert.doesNotMatch(postingBlock, /secrets\.ANTHROPIC_API_KEY/, "must not fall back to a raw GitHub secret");

  // Whole-file, not just the sliced blocks above: a stray reference anywhere
  // else in the file (a leftover comment, a second step) would otherwise go
  // undetected -- the block-scoped assertions above prove the WIRING is
  // correct, this proves the OLD path is gone entirely.
  assert.doesNotMatch(dialogueYaml, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, "no reference anywhere in the file");
  assert.doesNotMatch(dialogueYaml, /secrets\.ANTHROPIC_API_KEY/, "no reference anywhere in the file");
});

// Mirrors the test above, for dev-agent-dispatch.yml's own consumption of the
// same Infisical-sourced credential (both the preflight presence-check and
// the actual claude-code-action invocation).
test("dev-agent-dispatch.yml pulls its own Anthropic credential from Infisical's /dev/ path, before preflight runs", () => {
  const pullStart = dispatchYaml.indexOf("Setup · Pull the dev App's credentials from Infisical");
  assert.ok(pullStart >= 0, "no dev App Infisical pull step found");
  const preflightStart = dispatchYaml.indexOf("Preflight · Resolve the dev provider");
  assert.ok(pullStart < preflightStart, "the Infisical pull must run BEFORE preflight, so preflight can see its env vars");

  const pullStepStart = dispatchYaml.lastIndexOf("- name:", pullStart);
  const pullBlock = dispatchYaml.slice(pullStepStart, dispatchYaml.indexOf("- name:", pullStart));
  assert.match(pullBlock, /secret-path:\s*"\/dev\/"/);
  assert.match(pullBlock, /identity-id:\s*\$\{\{\s*vars\.INFISICAL_DEV_IDENTITY_ID\s*\}\}/);

  const preflightBlock = dispatchYaml.slice(preflightStart, dispatchYaml.indexOf("with:", preflightStart));
  assert.match(preflightBlock, /OAUTH:\s*\$\{\{\s*env\.DEV_CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/);
  assert.match(preflightBlock, /API_KEY:\s*\$\{\{\s*env\.DEV_ANTHROPIC_API_KEY\s*\}\}/);
  assert.doesNotMatch(preflightBlock, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, "must not fall back to a raw GitHub secret");
  assert.doesNotMatch(preflightBlock, /secrets\.ANTHROPIC_API_KEY/, "must not fall back to a raw GitHub secret");

  const resolveStart = dispatchYaml.indexOf("Resolve · Hand the findings to the developer agent");
  const resolveBlock = dispatchYaml.slice(resolveStart, dispatchYaml.indexOf("prompt:", resolveStart));
  assert.match(resolveBlock, /claude_code_oauth_token:\s*\$\{\{\s*env\.DEV_CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/);
  assert.match(resolveBlock, /anthropic_api_key:\s*\$\{\{\s*env\.DEV_ANTHROPIC_API_KEY\s*\}\}/);
  assert.match(
    resolveBlock,
    /claude_args:\s*\|[\s\S]*--model\s+\$\{\{\s*steps\.preflight\.outputs\.model\s*\}\}/,
    "the declared dev.model must be passed to Claude Code, not merely printed in a footer"
  );

  // Whole-file, not just the sliced blocks above -- see the sibling test's
  // own comment for why this is the failure-sensitivity gap the block-scoped
  // assertions alone leave open.
  assert.doesNotMatch(dispatchYaml, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, "no reference anywhere in the file");
  assert.doesNotMatch(dispatchYaml, /secrets\.ANTHROPIC_API_KEY/, "no reference anywhere in the file");
});

test("llm-review-dialogue.yml refuses fork pull requests before doing anything", () => {
  const jobStart = dialogueYaml.indexOf("jobs:");
  const ifLine = dialogueYaml.slice(jobStart, dialogueYaml.indexOf("permissions:", jobStart));
  // head_repository.fork is GitHub's own documented field for this check.
  assert.match(ifLine, /head_repository\.fork == false/);
});

test("dev-agent-dispatch.yml triggers on repository_dispatch only, and is the one workflow allowed to check out and write at once", () => {
  const onBlock = dispatchYaml.slice(dispatchYaml.indexOf("\non:"), dispatchYaml.indexOf("\npermissions:"));
  assert.match(onBlock, /repository_dispatch:/);
  assert.doesNotMatch(onBlock, /pull_request(_target)?:/);
  assert.match(dispatchYaml, /uses: actions\/checkout/);
  assert.match(dispatchYaml, /contents:\s*write/);
});

// Issue #290. Structural, not behavioral -- this proves the instruction is
// PRESENT in the prompt handed to the dispatched agent, not that the agent
// actually complies with it. That is real but weaker evidence than the
// behavioral preflight tests above: nothing here can catch a dispatched
// agent ignoring its own instructions. Kept anyway because the instruction
// existing at all is a real, checkable precondition for compliance, and the
// interpolated provider/model expressions are exactly the kind of typo a
// structural assertion does catch.
test("dev-agent-dispatch.yml's prompt instructs the agent to footer every comment with role/provider/model", () => {
  const promptStart = dispatchYaml.indexOf("prompt: |");
  assert.ok(promptStart >= 0, "no prompt: | block found");
  assert.match(dispatchYaml.slice(promptStart), /footer/i);
  assert.match(dispatchYaml.slice(promptStart), /role `dev`/);
  assert.match(dispatchYaml.slice(promptStart), /\$\{\{\s*steps\.preflight\.outputs\.provider\s*\}\}/);
  assert.match(dispatchYaml.slice(promptStart), /\$\{\{\s*steps\.preflight\.outputs\.model\s*\}\}/);
});

// ---------------------------------------------------------------------------
// Structural: llm-review-recheck.yml (Issue #262's follow-on slice 8) --
// same trust shape as ai-review regardless of trigger path: it executes no
// pull-request-authored code while holding write access, because it never
// holds any write access at all.
// ---------------------------------------------------------------------------

test("llm-review-recheck.yml triggers on repository_dispatch(llm-review-recheck) only, never a PR event, and adds no PR check row", () => {
  const onBlock = recheckYaml.slice(recheckYaml.indexOf("\non:"), recheckYaml.indexOf("\npermissions:"));
  assert.match(onBlock, /repository_dispatch:/);
  assert.match(onBlock, /llm-review-recheck/);
  assert.doesNotMatch(onBlock, /pull_request(_target)?:/);
});

test("llm-review-recheck.yml never holds a write token anywhere -- same trust shape as ai-review, regardless of trigger path", () => {
  for (const block of permissionsBlocks(recheckYaml)) {
    assert.doesNotMatch(block, /pull-requests:\s*write/);
    assert.doesNotMatch(block, /contents:\s*write/);
    assert.doesNotMatch(block, /issues:\s*write/);
  }
  assert.match(recheckYaml, /id-token:\s*write/, "needs id-token: write for the Infisical OIDC exchange, same as ai-review");
});

test("llm-review-recheck.yml checks out only the exact dispatched head, and reuses the same verify-llm-review composite action ai-review does", () => {
  assert.match(recheckYaml, /uses: actions\/checkout/);
  assert.match(recheckYaml, /ref: \$\{\{ github\.event\.client_payload\.headSha \}\}/);
  assert.match(recheckYaml, /uses: \.\/\.github\/actions\/verify-llm-review/);
});

// Extracts the `with:` block immediately following a verify-llm-review
// `uses:` line into a plain key -> raw-expression-text map, using the same
// indentation-bounded scan every other block extractor in this file uses.
function extractVerifyLlmReviewInputs(yamlText) {
  const usesIndex = yamlText.indexOf("uses: ./.github/actions/verify-llm-review");
  assert.ok(usesIndex >= 0, "no verify-llm-review invocation found");
  const withIndex = yamlText.indexOf("with:", usesIndex);
  assert.ok(withIndex >= 0 && withIndex - usesIndex < 100, "no with: block immediately after the verify-llm-review uses: line");
  const lines = yamlText.slice(withIndex + "with:".length).split("\n").slice(1);
  const withIndent = lines[0].match(/^ */)[0].length;
  const inputs = {};
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.match(/^ */)[0].length;
    if (indent < withIndent) break;
    const pair = line.trim().match(/^([a-z_]+):\s*(.*)$/);
    if (pair) inputs[pair[1]] = pair[2].trim();
  }
  return inputs;
}

// THE FIX for AI Review's blocking finding on this PR (round 1): acceptance
// criterion 5 (Issue #268) requires the recheck job to invoke
// verify-llm-review "with the same inputs ai-review passes" -- this was true
// by construction but had no test proving it, so a future edit to either
// job's `with:` block could silently drift the two apart with nothing to
// catch it. pr_number/base_sha/head_sha necessarily use DIFFERENT
// expressions in each trigger's own event context (a repository_dispatch
// payload has no `pull_request` object to read from) -- everything else
// must be byte-for-byte identical, since both invocations exist to
// authenticate and configure the exact same reviewer.
test("llm-review-recheck.yml invokes verify-llm-review with the exact same inputs ai-review passes, for every key not inherently trigger-specific", () => {
  const prVerifyYaml = readFileSync(path.join(root, ".github/workflows/pr-verify.yml"), "utf8");
  const aiReviewJobStart = prVerifyYaml.indexOf("\n  ai-review:");
  const aiReviewJobEnd = prVerifyYaml.indexOf("\n  pr-gate:", aiReviewJobStart);
  assert.ok(aiReviewJobStart >= 0 && aiReviewJobEnd > aiReviewJobStart, "pr-verify.yml: could not isolate the ai-review job block");
  const aiReviewInputs = extractVerifyLlmReviewInputs(prVerifyYaml.slice(aiReviewJobStart, aiReviewJobEnd));
  const recheckInputs = extractVerifyLlmReviewInputs(recheckYaml);

  assert.deepEqual(
    Object.keys(recheckInputs).sort(),
    Object.keys(aiReviewInputs).sort(),
    "the two invocations must pass the exact same set of input keys"
  );

  const contextSpecificKeys = new Set(["pr_number", "base_sha", "head_sha"]);
  for (const key of Object.keys(aiReviewInputs)) {
    if (contextSpecificKeys.has(key)) continue;
    assert.equal(recheckInputs[key], aiReviewInputs[key], `input "${key}" must match ai-review's exactly`);
  }
});

test("neither new workflow adds a second pull_request-triggered workflow to the repo", () => {
  // Reruns the same invariant docs/ops/pr-verify-workflow.test.mjs pins for
  // pr-verify.yml, scoped to the files this Issue and its slice 8 follow-on
  // add -- a second pull_request(_target) trigger anywhere defeats the whole
  // point of using workflow_run/repository_dispatch to avoid another check row.
  for (const text of [dialogueYaml, dispatchYaml, recheckYaml]) {
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
    ["dev-agent-dispatch.yml", dispatchYaml],
    ["llm-review-recheck.yml", recheckYaml],
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

function makeGithub({
  pr,
  existingComment = null,
  dispatchThrows = false,
  searchResults = [],
  createIssueThrows = false,
  // Fixture for the default-branch agent-roles.yaml the dialogue script now
  // reads to decide whether the assigned dev provider is the one this
  // repository's dispatcher actually implements (anthropic, today).
  devProvider = "anthropic",
  // Issue #289: the same fixture also backs the review.provider/model
  // footer. Defaults match this repo's actual live agent-roles.yaml
  // assignment (openai/gpt-5-mini is the real pair; "y" here is an
  // arbitrary distinct-from-devProvider placeholder pre-dating #289, kept
  // as the default so no pre-existing test's behavior changes).
  reviewProvider = "openai",
  reviewModel = "y",
}) {
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
        getContent: async () => ({
          data: {
            encoding: "base64",
            content: Buffer.from(
              `dev:\n  provider: ${devProvider}\n  model: x\n\nreview:\n  provider: ${reviewProvider}\n  model: ${reviewModel}\n`,
              "utf8"
            ).toString("base64"),
          },
        }),
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

async function runDialogue(
  fs,
  os,
  path_,
  env,
  { pr, existingComment, dispatchThrows, searchResults, createIssueThrows, devProvider, reviewProvider, reviewModel } = {}
) {
  const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "llm-review-dialogue-test-"));
  makeArtifact(fs, path_, dir, env.__files);
  delete env.__files;
  const { api, calls } = makeGithub({ pr, existingComment, dispatchThrows, searchResults, createIssueThrows, devProvider, reviewProvider, reviewModel });
  const core = makeCore();
  const proc = {
    env: {
      HAS_DEV_APP_ID: "true",
      HAS_DEV_APP_PRIVATE_KEY: "true",
      ...env,
      ARTIFACT_DIR: dir,
    },
  };
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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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

// Issue #289. Behavior protected: the managed comment ends with a footer
// stating role/provider/model, sourced from agent-roles.yaml's review.*
// fields specifically -- not dev.* -- so an implementation that misread the
// wrong half of the file is caught. Distinct provider/model values from
// devProvider (fixed at "anthropic" by BLOCKING_VERDICT's own default)
// make that mix-up impossible to pass accidentally.
test("dialogue: the managed comment ends with a role/provider/model footer sourced from agent-roles.yaml's review fields", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, reviewProvider: "gemini", reviewModel: "gemini-3-pro" });

  const body = calls.createComment[0].body;
  assert.match(body, /_AI Review — role `review` · provider `gemini` · model `gemini-3-pro`_/);
});

// Behavior protected: a PASSING verdict's comment also carries the footer --
// the footer is not conditional on `blocking`, unlike the round/identity
// escalation admonitions.
test("dialogue: a passing verdict's comment also carries the role/provider/model footer", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "d".repeat(40);
  const priorState = { round: 1, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "5",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "success", verdictPresent: true },
      "review-verdict.json": { verdict: "pass", findings: [], discarded: [], summary: "all good" },
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment, reviewProvider: "openai", reviewModel: "gpt-5-mini" });

  const body = calls.updateComment[0].body;
  assert.match(body, /_AI Review — role `review` · provider `openai` · model `gpt-5-mini`_/);
});

test("dialogue: REVIEW_APP_TOKEN_MINTED=true posts findings with no fallback-identity warning", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls, core } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    REVIEW_APP_TOKEN_MINTED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createComment.length, 1, "findings must still post");
  assert.ok(
    !core.warnings.some((w) => w.includes("github-actions[bot]")),
    "a successfully minted identity must not warn about a fallback that didn't happen"
  );
});

test("dialogue: an unminted reviewer identity (unset, or the App credential failed) still posts findings, with a visible fallback warning", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  // REVIEW_APP_TOKEN_MINTED deliberately omitted -- this is the real shape a
  // run takes when the Infisical pull or the token mint step fails
  // (continue-on-error: true means the job proceeds, but the env var this
  // step reads is simply never set to "true").
  const { calls, core } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createComment.length, 1, "an identity fallback must never stop findings from posting");
  assert.ok(
    core.warnings.some((w) => w.includes("github-actions[bot]")),
    "the fallback must be visible in the run log, not silent"
  );
});

// Issue #288: a separate, independent streak from round/escalated above --
// round only increments on `blocking && !sameHead`, so a cleanly-passing PR
// would never trip a shared counter, which is exactly the case most likely
// to hide a permanently-broken reviewer App credential forever. This streak
// instead counts every consecutive run (blocking or not) that had to fall
// back to github-actions[bot].
test("dialogue: identity-fallback streak escalates at the default threshold (1) with a distinct admonition, separate from round escalation", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  // REVIEW_APP_TOKEN_MINTED omitted -- first-ever fallback, no prior comment.
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "10",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.match(body, /"identityFallbackStreak":1/);
  assert.match(body, /"identityEscalated":true/);
  assert.match(body, /@kgsmith19 — the reviewer's own posting identity has not minted/);
  // The round-escalation admonition must NOT also fire here -- round is only
  // 1 of an ESCALATE_AFTER: 10 threshold, proving the two counters are
  // genuinely independent rather than one leaking into the other.
  assert.doesNotMatch(body, /this needs your decision/);
});

test("dialogue: a second consecutive identity fallback updates the streak in place, without a duplicate comment", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const priorState = {
    round: 1,
    headSha: HEAD,
    escalated: false,
    identityFallbackStreak: 1,
    identityEscalated: true,
    verdict: "block",
  };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  // Same head as the prior run -- REVIEW_APP_TOKEN_MINTED still omitted.
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "2",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "10",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, existingComment });

  assert.equal(calls.updateComment.length, 1);
  assert.equal(calls.createComment.length, 0, "the same managed comment must be updated, never a second one");
  assert.match(calls.updateComment[0].body, /"identityFallbackStreak":2/);
  assert.match(calls.updateComment[0].body, /"identityEscalated":true/);
});

test("dialogue: a successful mint resets the identity-fallback streak and clears the escalation, removing the admonition", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = {
    round: 1,
    headSha: HEAD,
    escalated: false,
    identityFallbackStreak: 3,
    identityEscalated: true,
    verdict: "block",
  };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "3",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    ESCALATE_AFTER: "10",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    REVIEW_APP_TOKEN_MINTED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"identityFallbackStreak":0/);
  assert.match(body, /"identityEscalated":false/);
  assert.doesNotMatch(body, /posting identity has not minted/);
});

// Mutation-sensitive: proves the two admonition blocks are built
// independently, so one being rendered can never accidentally suppress or
// overwrite the other -- the failure mode a shared `if` (or a single `return`
// early) would produce.
test("dialogue: round-escalation and identity-escalation admonitions can both render in the same comment without clobbering", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = {
    round: 2,
    headSha: HEAD,
    escalated: false,
    identityFallbackStreak: 0,
    identityEscalated: false,
    verdict: "block",
  };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  // REVIEW_APP_TOKEN_MINTED omitted -- this run both crosses ESCALATE_AFTER
  // (round 2 -> 3, threshold 3) AND fails to mint the reviewer identity
  // (default identity threshold 1), so both escalations must fire together.
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "4",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":3/);
  assert.match(body, /"escalated":true/);
  assert.match(body, /"identityFallbackStreak":1/);
  assert.match(body, /"identityEscalated":true/);
  assert.match(body, /this needs your decision/);
  assert.match(body, /posting identity has not minted/);
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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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

// Behavior protected (Issue #284, owner directive): with ESCALATE_AFTER
// unset, the workflow's own DEFAULT_ESCALATE_AFTER applies -- which must now
// be 10, not 9 (itself raised from 3 by #281). This is the true
// defect-sensitive half: it fails against the pre-#284 default, where round
// 9 (>= 9) would already have escalated. Paired with the positive control
// below (round 10 does escalate) so this proves the exact boundary, not just
// "somewhere higher than 9".
test("dialogue: with ESCALATE_AFTER unset, round 9 does NOT yet escalate -- the default is 10, not 9", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = { round: 8, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "9",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":9/);
  assert.match(body, /"escalated":false/);
  assert.doesNotMatch(body, /@kgsmith19 — this needs your decision/);
});

// POSITIVE CONTROL for the default itself: round 10 with ESCALATE_AFTER
// unset does escalate, pinning the exact new default value rather than just
// "greater than 9".
test("dialogue: with ESCALATE_AFTER unset, round 10 escalates -- confirming the new default value", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = { round: 9, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "10",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":10/);
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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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
    HAS_ANTHROPIC_OAUTH: "false",
    HAS_ANTHROPIC_API_KEY: "false",
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

test("dialogue: a model credential without both dev App credentials never dispatches a fixer", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "7-app-missing",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "false",
    HAS_DEV_APP_ID: "true",
    HAS_DEV_APP_PRIVATE_KEY: "false",
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

// Behavior protected: dev-agent-dispatch.yml only implements dev.provider
// "anthropic" today (Issue #252's slice 7). Firing the dispatch anyway when
// agent-roles.yaml names something else would just wake a job whose own
// preflight fails immediately -- worse than not firing it, since it burns a
// dispatch and still needs the owner. This must escalate the same way an
// unprovisioned credential does, even though the anthropic credentials ARE
// present here: the assigned provider is what governs, not what happens to
// be configured.
test("dialogue: dev.provider naming an unimplemented vendor escalates immediately, even with anthropic credentials present", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "9",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, devProvider: "openai" });

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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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
// Behavioral: dev-agent-dispatch.yml's preflight -- resolves dev.provider
// from the DEFAULT branch's agent-roles.yaml and confirms that provider's
// credential is provisioned, before ever checking out a pull request.
// ---------------------------------------------------------------------------

function agentRolesFixture(devProvider) {
  return Buffer.from(`dev:\n  provider: ${devProvider}\n  model: x\n\nreview:\n  provider: openai\n  model: y\n`, "utf8").toString("base64");
}

async function runPreflightScript({
  devProvider = "anthropic",
  oauth = "",
  apiKey = "",
  // Default to present: the App-credential check is independent of, and
  // runs before, the model-credential check exercised by most of these
  // tests -- defaulting them truthy keeps every pre-existing test exercising
  // only the model-credential path unaffected by that addition.
  appId = "app-id-value",
  appPrivateKey = "app-private-key-value",
  getContentThrows = false,
  agentRolesRaw = null,
} = {}) {
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
  const proc = { env: { OAUTH: oauth, API_KEY: apiKey, APP_ID: appId, APP_PRIVATE_KEY: appPrivateKey } };
  await loadPreflightScript()(require, context, core, github, proc);
  return { outputs, failure };
}

// POSITIVE CONTROL. Behavior protected: the common, currently-live case --
// dev.provider is anthropic and a credential exists -- resolves cleanly.
test("preflight: dev.provider=anthropic with a credential present resolves without failing", async () => {
  const { outputs, failure } = await runPreflightScript({ devProvider: "anthropic", oauth: "token-value" });
  assert.equal(failure, null);
  assert.equal(outputs.provider, "anthropic");
});

// Behavior protected: dev.provider=anthropic but NEITHER credential secret
// is set fails closed, naming exactly which two secrets would satisfy it --
// the same fail-loud contract the pre-generalization preflight had.
test("preflight: dev.provider=anthropic with no credential fails closed and names both accepted secrets", async () => {
  const { outputs, failure } = await runPreflightScript({ devProvider: "anthropic", oauth: "", apiKey: "" });
  assert.equal(outputs.provider, "anthropic");
  assert.match(failure, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(failure, /ANTHROPIC_API_KEY/);
});

// Issue #290. Behavior protected: a missing dev App credential (the
// posting/push identity, distinct from the model credential above) used to
// fail opaquely inside the vendored actions/create-github-app-token step
// instead of naming the exact secret to provision -- fails closed here with
// a named message instead, before that step ever runs. Regression-sensitive:
// mutating the new `if (!process.env.APP_ID || !process.env.APP_PRIVATE_KEY)`
// check away restores the old opaque-failure behavior and this test catches it.
test("preflight: dev.provider=anthropic with a model credential but no dev App credential fails closed and names both App secrets", async () => {
  const { outputs, failure } = await runPreflightScript({
    devProvider: "anthropic",
    oauth: "token-value",
    appId: "",
    appPrivateKey: "",
  });
  assert.equal(outputs.provider, "anthropic");
  assert.match(failure, /DEV_GITHUB_APP_ID/);
  assert.match(failure, /DEV_GITHUB_APP_PRIVATE_KEY/);
});

test("preflight: one dev App secret present but not the other still fails closed", async () => {
  const { failure } = await runPreflightScript({
    devProvider: "anthropic",
    oauth: "token-value",
    appId: "app-id-value",
    appPrivateKey: "",
  });
  assert.match(failure, /DEV_GITHUB_APP_ID/);
  assert.match(failure, /DEV_GITHUB_APP_PRIVATE_KEY/);
});

// Issue #290. Behavior protected: preflight's `model` output resolves from
// agent-roles.yaml's dev.model, the same source and the same way `provider`
// already does -- the footer instruction in the prompt below depends on it.
test("preflight: dev.provider=anthropic resolves a sibling model output from agent-roles.yaml", async () => {
  const { outputs, failure } = await runPreflightScript({ devProvider: "anthropic", oauth: "token-value" });
  assert.equal(failure, null);
  assert.equal(outputs.provider, "anthropic");
  assert.equal(outputs.model, "x", "agentRolesFixture() sets dev.model: x");
});

// THE CORE NEW BEHAVIOR (Issue #252's slice 7). Behavior protected: an
// unimplemented provider fails closed with a reason naming the provider,
// rather than either guessing at an unverified action/SDK shape or silently
// falling back to anthropic. Defect caught: a generalization that only LOOKS
// provider-aware but still runs the anthropic branch regardless of what
// agent-roles.yaml actually says.
test("preflight: dev.provider=openai fails closed without ever checking a credential", async () => {
  const { outputs, failure } = await runPreflightScript({ devProvider: "openai", oauth: "token-value", apiKey: "key-value" });
  assert.equal(outputs.provider, "openai");
  assert.match(failure, /dev\.provider="openai"/);
  assert.match(failure, /only implements "anthropic"/);
});

test("preflight: dev.provider=antigravity fails closed the same way as openai", async () => {
  const { failure } = await runPreflightScript({ devProvider: "antigravity" });
  assert.match(failure, /dev\.provider="antigravity"/);
});

// Behavior protected: a agent-roles.yaml this script cannot find a
// dev.provider line in fails closed rather than defaulting to anthropic --
// defaulting would silently run the wrong (or right, by luck) branch instead
// of surfacing that the file's shape changed underneath this parser.
test("preflight: agent-roles.yaml with no parseable dev.provider fails closed rather than guessing", async () => {
  const { failure } = await runPreflightScript({ agentRolesRaw: Buffer.from("not: a\nrecognizable: shape\n", "utf8").toString("base64") });
  assert.match(failure, /Could not find dev\.provider/);
});

// Behavior protected: the default branch being unreadable (API error, rare
// but real) fails closed with the actual error, not a silent fallback.
test("preflight: agent-roles.yaml unreadable from the default branch fails closed with the real error", async () => {
  const { failure } = await runPreflightScript({ getContentThrows: true });
  assert.match(failure, /simulated getContent failure/);
});

// ---------------------------------------------------------------------------
// Behavioral: dev-agent-dispatch.yml's staleness guard.
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
// Behavioral: dev-agent-dispatch.yml's last step -- firing llm-review-recheck
// when the agent replied without pushing a commit (Issue #262's follow-on
// slice 8).
// ---------------------------------------------------------------------------

// THE CORE NEW BEHAVIOR. Behavior protected: an unchanged head (the agent
// only commented -- a rebuttal or an out-of-scope proposal) fires the
// recheck dispatch with the PR's own current head. Defect caught: never
// firing at all, which would leave a comment-only reply invisible to AI
// Review forever, since pull_request:synchronize only fires on an actual push.
test("recheck-fire: dispatches llm-review-recheck when the PR head is unchanged", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const core = { info: () => {}, warning: () => {} };
  const calls = [];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: HEAD } } }) },
      repos: { createDispatchEvent: async (args) => calls.push(args) },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckFireScript()(context, core, github, proc);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event_type, "llm-review-recheck");
  assert.deepEqual(calls[0].client_payload, { prNumber: 230, headSha: HEAD });
});

// Behavior protected: a head that moved during the dispatcher's own run (the
// agent pushed a commit) skips the recheck entirely -- pull_request:synchronize
// already retriggered AI Review on the real pr-verify.yml path, so firing a
// second, redundant recheck against a now-stale head would be pure waste.
test("recheck-fire: does not dispatch when the PR head has moved -- the agent's own push already retriggers AI Review", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const infos = [];
  const core = { info: (message) => infos.push(message), warning: () => {} };
  const calls = [];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: "moved".padEnd(40, "0") } } }) },
      repos: { createDispatchEvent: async (args) => calls.push(args) },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckFireScript()(context, core, github, proc);

  assert.equal(calls.length, 0);
  assert.ok(infos.some((message) => message.includes("Not firing a recheck")));
});

// Behavior protected: a dispatch failure warns rather than throwing --
// this step runs after the agent's own reply already posted, so a transient
// dispatch-API failure must not fail the whole job and hide that the reply
// itself succeeded.
test("recheck-fire: a dispatch failure warns instead of throwing", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const warnings = [];
  const core = { info: () => {}, warning: (message) => warnings.push(message) };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: HEAD } } }) },
      repos: {
        createDispatchEvent: async () => {
          throw new Error("simulated dispatch failure");
        },
      },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckFireScript()(context, core, github, proc);

  assert.match(warnings[0], /simulated dispatch failure/);
});

// ---------------------------------------------------------------------------
// Behavioral: llm-review-recheck.yml's own staleness guard -- the mirror
// image of dev-agent-dispatch.yml's PR-check step, run a second time inside
// the recheck job itself since the PR could have moved again in the gap
// between the firing step above and this job actually starting.
// ---------------------------------------------------------------------------

test("recheck context: a PR that moved past the dispatched head stands down", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  const core = { setOutput: (key, value) => (outputs[key] = value), info: () => {} };
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { number: 230, head: { sha: "moved".padEnd(40, "0") }, state: "open", base: { sha: "b".repeat(40) } } }),
      },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckContextScript()(context, core, github, proc);

  assert.equal(outputs.stale, "true");
  assert.equal(outputs.base_sha, undefined);
});

test("recheck context: a closed PR at the right head still stands down -- there is nothing left to recheck", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  const core = { setOutput: (key, value) => (outputs[key] = value), info: () => {} };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { number: 230, head: { sha: HEAD }, state: "closed", base: { sha: "b".repeat(40) } } }) },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckContextScript()(context, core, github, proc);

  assert.equal(outputs.stale, "true");
});

test("recheck context: a still-current, still-open PR proceeds and exposes the base sha for verify-llm-review", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  const core = { setOutput: (key, value) => (outputs[key] = value), info: () => {} };
  const baseSha = "b".repeat(40);
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { number: 230, head: { sha: HEAD }, state: "open", base: { sha: baseSha } } }) },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckContextScript()(context, core, github, proc);

  assert.equal(outputs.stale, "false");
  assert.equal(outputs.base_sha, baseSha);
});

// ---------------------------------------------------------------------------
// verify-llm-review/action.yml's "Context · Write the linked Issue body and
// the pull request body to files" step -- Issue #251. Before this, the PR's
// own body was only ever a fallback that got unconditionally overwritten the
// moment an Issue number resolved (effectively always, since
// verify-pr-description requires a Closes/Fixes/Resolves reference on every
// PR), so the reviewer never actually saw a PR's own Verification section,
// oracle-change disclosure, or scope reasoning in normal operation. These
// tests pin the fix: both files exist, independently, every time.
// ---------------------------------------------------------------------------

async function runIssueAndPrBodyScript({ prNumber = 240, headRef = "some-branch", prBody = "", issue = null, issueThrows = false } = {}) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "llm-review-issue-pr-body-test-"));
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { head: { ref: headRef }, body: prBody } }) },
      issues: {
        get: async () => {
          if (issueThrows) throw new Error("simulated API failure");
          return { data: issue ?? { title: "(missing fixture issue)", body: "" } };
        },
      },
    },
  };
  const core = { info: () => {}, warning: () => {} };
  const proc = { env: { PR_NUMBER: String(prNumber), RUNNER_TEMP: dir } };

  await loadIssueAndPrBodyScript()(require, context, core, github, proc);

  return {
    issueBody: fs.readFileSync(path_.join(dir, "issue-body.md"), "utf8"),
    prBody: fs.readFileSync(path_.join(dir, "pr-body.md"), "utf8"),
  };
}

// THE EXACT BUG (Issue #251). Behavior protected: when an Issue resolves
// (the normal case), the reviewer still gets the PR's own body -- not just
// the Issue's. Defect caught: the old code path, where resolving an Issue
// unconditionally overwrote the one `body` variable that the PR body was
// ever assigned to, making it structurally invisible in exactly this case.
test("Issue-and-PR-body step: the PR body is captured alongside a resolved Issue body, not overwritten by it", async () => {
  const { issueBody, prBody } = await runIssueAndPrBodyScript({
    headRef: "issue/42-configurable-rate",
    prBody: "## Verification\nRan the full suite locally, all green.",
    issue: { title: "Make the discount rate configurable", body: "Acceptance criterion 1: ..." },
  });

  assert.match(issueBody, /Issue #42: Make the discount rate configurable/);
  assert.match(issueBody, /Acceptance criterion 1/);
  assert.match(prBody, /Ran the full suite locally, all green/);
  assert.ok(!issueBody.includes("Ran the full suite locally"), "the PR body must not leak into the Issue body file");
});

// Behavior protected: the Issue number resolves from the branch name first,
// via this standard's own issue/<n>-<slug> convention.
test("Issue-and-PR-body step: the Issue number resolves from the branch name", async () => {
  const { issueBody } = await runIssueAndPrBodyScript({
    headRef: "issue/251-pr-body-invisible",
    issue: { title: "AI Review never sees the PR body", body: "..." },
  });
  assert.match(issueBody, /Issue #251:/);
});

// Behavior protected: when no Issue can be identified, the Issue-body file
// says so plainly, and the PR body is still written -- it is no longer
// pressed into service as a fallback substitute for the missing Issue body.
test("Issue-and-PR-body step: no linked Issue still writes the PR's own body, unmixed with a fallback notice", async () => {
  const { issueBody, prBody } = await runIssueAndPrBodyScript({
    headRef: "some-unrelated-branch-name",
    prBody: "Just a quick fix.",
  });

  assert.match(issueBody, /no linked Issue could be identified/);
  assert.equal(prBody, "Just a quick fix.");
  assert.ok(!issueBody.includes("Just a quick fix"), "the PR body must not be folded into the Issue-body placeholder");
});

// Behavior protected: a PR with no description at all writes an explicit
// placeholder rather than an empty file, so "no description" and "review
// error" cannot be confused downstream.
test("Issue-and-PR-body step: a pull request with no body writes an explicit placeholder", async () => {
  const { prBody } = await runIssueAndPrBodyScript({ prBody: null });
  assert.match(prBody, /this pull request has no description/);
});

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
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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

// Issue #289. Behavior protected: the deferred-finding Issue body ALSO ends
// with the role/provider/model footer, independently of the managed PR
// comment's own footer -- both call sites build this string, so a fix to
// one alone (or a copy-paste that reads dev.* here by mistake) is caught.
test("dialogue: the deferred-finding Issue body also carries the role/provider/model footer", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, deferredEnv(), {
    pr: BASE_PR,
    reviewProvider: "anthropic",
    reviewModel: "claude-opus-5",
  });

  assert.match(
    calls.createIssue[0].body,
    /_AI Review — role `review` · provider `anthropic` · model `claude-opus-5`_$/,
    "footer must be the last thing in the deferred Issue's body"
  );
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
      HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
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
