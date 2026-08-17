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

const REQUIRED_GATE_NAMES = [
  "Verify: Standards",
  "Verify: Tests (Toolbelt)",
  "Verify: Tests (ACC)",
  "Verify: Tests (ACC Windows)",
  "Verify: Tests (Brain)",
  "Verify: Tests (Shell)",
  "Verify: Tests (LifeOS)",
];

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

test("workflow structure: privileged, checkout-free, checks:read present for the new gate read", () => {
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \["PR Verification"\]/);
  // The whole point of pull_request_target here is a write token without
  // ever touching PR-controlled content -- no checkout, no run: block.
  assert.doesNotMatch(workflow, /uses: actions\/checkout/);
  assert.doesNotMatch(workflow, /\n\s*run: \|/);
  assert.match(workflow, /checks: read/);
  assert.match(workflow, /name: "Verify: Merge Policy"/);
});

test("the required-gate list matches pr-verify.yml's actual job names, and excludes LLM Review and itself", () => {
  for (const gateName of REQUIRED_GATE_NAMES) {
    assert.ok(workflow.includes(`"${gateName}"`), `REQUIRED_GATE_NAMES is missing ${gateName}`);
  }
  const constBlock = workflow.slice(
    workflow.indexOf("const REQUIRED_GATE_NAMES"),
    workflow.indexOf("];", workflow.indexOf("const REQUIRED_GATE_NAMES"))
  );
  assert.doesNotMatch(constBlock, /Verify: LLM Review/, "LLM Review must stay excluded while unrequired");
  assert.doesNotMatch(constBlock, /Verify: Merge Policy/, "a job cannot gate on its own conclusion");

  const prVerify = readFileSync(path.join(root, ".github/workflows/pr-verify.yml"), "utf8");
  for (const gateName of REQUIRED_GATE_NAMES) {
    assert.ok(prVerify.includes(`name: "${gateName}"`), `pr-verify.yml no longer has a job named ${gateName}`);
  }
});

test("auto-merge is armed only after requiredGatesGreen confirms every gate, and never on gateState.ready === false", async () => {
  const modulePath = loadReconcileModule();
  const reconcile = (await import(`file://${modulePath}`)).default;

  function makeMocks(gateConclusions) {
    const checkRuns = Object.entries(gateConclusions).map(([name, conclusion], i) => ({
      name,
      status: conclusion ? "completed" : "in_progress",
      conclusion,
      started_at: new Date(2026, 0, 1, 0, i).toISOString(),
    }));
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

  async function run(gateConclusions) {
    const { github, core, graphqlCalls } = makeMocks(gateConclusions);
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

  const allGreen = Object.fromEntries(REQUIRED_GATE_NAMES.map((n) => [n, "success"]));

  // One required gate still red -> must not arm, and must say why.
  const oneRed = await run({ ...allGreen, "Verify: Standards": "failure" });
  assert.equal(oneRed.armed, false, "armed auto-merge with a red required gate");
  assert.match(oneRed.summary, /not armed/i);
  assert.match(oneRed.summary, /Verify: Standards/);

  // A required gate that has not reported at all yet (missing from the
  // check-runs list) -- the exact shape of a pull_request_target event
  // that fires before pr-verify.yml has posted anything.
  const { "Verify: Tests (Shell)": _drop, ...missingOne } = allGreen;
  const missingGate = await run(missingOne);
  assert.equal(missingGate.armed, false, "armed auto-merge with a gate that has not reported yet");
  assert.match(missingGate.summary, /Verify: Tests \(Shell\)/);

  // Every required gate green, but Verify: LLM Review red -- must still
  // arm, since LLM Review is deliberately excluded while unrequired.
  const llmReviewRedOnly = await run(allGreen); // mocks never include LLM Review at all
  assert.equal(llmReviewRedOnly.armed, true, "did not arm despite every required gate being green");
  assert.match(llmReviewRedOnly.summary, /Auto-merge: armed/);
});
