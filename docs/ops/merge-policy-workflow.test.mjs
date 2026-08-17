// Structural + behavioral assertions over .github/workflows/merge-policy.yml.
//
// merge-policy.yml is the ONLY workflow that arms native squash auto-merge.
// It listens on pull_request_target, which fires immediately on every push
// -- well before pr-verify.yml's own "Verify: *" jobs even start -- because
// reacting promptly to draft/hold-label changes needs that immediacy. Left
// unchecked, that same immediacy would let it arm auto-merge (and, if the
// live branch ruleset's required-checks list is ever empty or stale, as
// has already happened once in this repo, actually let GitHub merge)
// against a commit whose real verification hasn't run yet, or has failed.
//
// The behavioral tests below extract the workflow's actual embedded
// github-script body and execute it against a mocked GitHub API surface,
// rather than grepping for expected substrings -- a structural check could
// not tell a real gate from one whose `if (!gateState.ready) return;` had
// been quietly deleted, and that exact regression is the one this file
// exists to catch.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/merge-policy.yml");
const workflow = readFileSync(workflowPath, "utf8");
const prVerifyWorkflow = readFileSync(path.join(root, ".github/workflows/pr-verify.yml"), "utf8");

// Read from the source rather than hardcoding a second copy here -- a
// hardcoded duplicate is exactly the kind of two-places-to-update drift
// that has already caused real incidents in this repo's required-checks
// history (see AGENTS.md's PR Gate section).
function extractRequiredGateNames(yamlText) {
  const start = yamlText.indexOf("const REQUIRED_GATE_NAMES");
  assert.ok(start >= 0, "merge-policy.yml: no REQUIRED_GATE_NAMES constant found");
  const block = yamlText.slice(start, yamlText.indexOf("]", start));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// The script: block is a YAML block scalar, and no YAML library is a
// dependency of this repo's test suite (see the other *-workflow.test.mjs
// files, which grep the raw text for the same reason). It is also the last
// thing in the file, so extraction is just "everything after the marker
// line, dedented by its common leading whitespace" -- no YAML parsing
// needed for this one shape.
function extractScript(yamlText) {
  const markerIndex = yamlText.indexOf("script: |");
  assert.ok(markerIndex >= 0, "merge-policy.yml: no `script: |` block found");
  const body = yamlText.slice(markerIndex + "script: |".length + 1);
  const lines = body.split("\n");
  const indented = lines.filter((line) => line.trim().length > 0);
  const commonIndent = Math.min(...indented.map((line) => line.match(/^ */)[0].length));
  return lines.map((line) => line.slice(commonIndent)).join("\n");
}

function loadReconcileModule() {
  const script = extractScript(workflow);
  const dir = mkdtempSync(path.join(tmpdir(), "merge-policy-script-"));
  const file = path.join(dir, "reconcile.cjs");
  writeFileSync(file, `module.exports = async function (context, github, core) {\n${script}\n};\n`);
  return file;
}

const REQUIRED_GATE_NAMES = extractRequiredGateNames(workflow);

test("workflow structure: privileged, checkout-free, checks:read present for the gate read", () => {
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \["PR Verification"\]/);
  // The whole point of pull_request_target here is a write token without
  // ever touching PR-controlled content -- no checkout, no run: block.
  assert.doesNotMatch(workflow, /uses: actions\/checkout/);
  assert.doesNotMatch(workflow, /\n\s*run: \|/);
  assert.match(workflow, /checks: read/);
  // The workflow-level name and the job-level name are DELIBERATELY
  // different: "Merge Automation" is the outer label shown in the PR
  // checks list ("Merge Automation / Verify: Merge Policy"); if both were
  // "Verify: Merge Policy" the row would read as a confusing doubled
  // label sitting next to "PR Verification / Verify: <gate>" -- which is
  // exactly what prompted this test.
  assert.match(workflow, /^name: "Merge Automation"$/m);
  assert.match(workflow, /name: "Verify: Merge Policy"/);
});

test("REQUIRED_GATE_NAMES is exactly the one Verify: All Gates rollup, and pr-verify.yml has that job", () => {
  assert.deepEqual(
    REQUIRED_GATE_NAMES,
    ["Verify: All Gates"],
    "the whole point of the rollup job is that this workflow only ever needs to track one name"
  );

  const gatesJob = prVerifyWorkflow.slice(
    prVerifyWorkflow.indexOf("verify-all-gates:"),
    prVerifyWorkflow.indexOf("verify-llm-review:")
  );
  assert.match(gatesJob, /name: "Verify: All Gates"/);
  assert.match(gatesJob, /if: always\(\)/, "must report even when a needs: job failed, or this row is never present to require");
  for (const jobId of [
    "verify-standards",
    "verify-tests-toolbelt",
    "verify-tests-acc",
    "verify-tests-acc-windows",
    "verify-tests-brain",
    "verify-tests-shell",
    "verify-tests-lifeos",
  ]) {
    assert.match(gatesJob, new RegExp(`- ${jobId}\\b`), `Verify: All Gates does not depend on ${jobId}`);
  }
  // Verify: LLM Review must inherit the gate through the rollup, not
  // re-list the six test jobs a second time -- two lists of the same
  // seven names is the drift risk this whole rollup exists to remove.
  const llmReviewJob = prVerifyWorkflow.slice(prVerifyWorkflow.indexOf("verify-llm-review:"));
  assert.match(llmReviewJob.split("\n").slice(0, 3).join("\n"), /needs: \[verify-all-gates\]/);
});

test("auto-merge is armed only after requiredGatesGreen confirms the rollup, and never on gateState.ready === false", async () => {
  const modulePath = loadReconcileModule();
  const reconcile = (await import(`file://${modulePath}`)).default;
  const [gateName] = REQUIRED_GATE_NAMES;

  function makeMocks(checkRuns) {
    const graphqlCalls = [];
    const github = {
      paginate: async (fn) => {
        if (fn === github.rest.checks.listForRef) return checkRuns;
        return [];
      },
      rest: {
        checks: { listForRef: async () => ({ data: checkRuns }) },
        pulls: {
          get: async () => ({
            data: {
              number: 42,
              node_id: "PR_kwid",
              title: "Test PR",
              draft: false,
              mergeable_state: "unstable",
              head: { sha: "deadbeef", ref: "feature/x", repo: { full_name: "kgsmith19/hyperbolic-core" } },
              base: { sha: "cafebabe", ref: "main", repo: { full_name: "kgsmith19/hyperbolic-core" } },
              labels: [],
              body: "closes #999",
            },
          }),
          updateBranch: async () => ({}),
        },
        issues: {
          listEventsForTimeline: async () => ({ data: [] }),
          listComments: async () => ({ data: [] }),
          createComment: async () => ({}),
          updateComment: async () => ({}),
          removeLabel: async () => ({}),
        },
        actions: { listWorkflowRunArtifacts: async () => ({ data: { artifacts: [] } }) },
        repos: { listPullRequestsAssociatedWithCommit: async () => ({ data: [] }) },
      },
      graphql: async (query, vars) => {
        graphqlCalls.push(query);
        if (/enablePullRequestAutoMerge/.test(query)) return { pullRequest: { id: vars.id } };
        if (/markPullRequestReadyForReview|disablePullRequestAutoMerge/.test(query)) return { pullRequest: { id: vars.id } };
        throw new Error(`unexpected graphql mutation in test: ${query.slice(0, 40)}`);
      },
    };
    const core = {
      info: () => {},
      warning: () => {},
      error: () => {},
      summary: {
        addHeading() { return core.summary; },
        addRaw(text) { core.summary._body = text; return core.summary; },
        async write() {},
      },
    };
    return { github, core, graphqlCalls };
  }

  async function run(checkRuns) {
    const { github, core, graphqlCalls } = makeMocks(checkRuns);
    const context = {
      eventName: "pull_request_target",
      repo: { owner: "kgsmith19", repo: "hyperbolic-core" },
      payload: {
        pull_request: { number: 42 },
        repository: { owner: { login: "kgsmith19" }, default_branch: "main" },
      },
    };
    await reconcile(context, github, core);
    return {
      armed: graphqlCalls.some((q) => /enablePullRequestAutoMerge/.test(q)),
      summary: core.summary._body || "",
    };
  }

  // The rollup itself failed -> must not arm, and must say why.
  const red = await run([{ name: gateName, status: "completed", conclusion: "failure", started_at: new Date().toISOString() }]);
  assert.equal(red.armed, false, "armed auto-merge with a red Verify: All Gates");
  assert.match(red.summary, /not armed/i);
  assert.match(red.summary, new RegExp(gateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // The rollup has not reported at all yet (missing from the check-runs
  // list) -- the exact shape of a pull_request_target event that fires
  // before pr-verify.yml has posted anything.
  const missing = await run([]);
  assert.equal(missing.armed, false, "armed auto-merge when Verify: All Gates has not reported yet");

  // The rollup succeeded -> arm, regardless of Verify: LLM Review (never
  // even queried here, since it is deliberately excluded from the list).
  const green = await run([{ name: gateName, status: "completed", conclusion: "success", started_at: new Date().toISOString() }]);
  assert.equal(green.armed, true, "did not arm despite Verify: All Gates succeeding");
  assert.match(green.summary, /Auto-merge: armed/);
});
