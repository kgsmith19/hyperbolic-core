// Structural + behavioral assertions over .github/workflows/pr-verify.yml.
//
// pr-verify.yml is now the ONLY workflow that runs on pull requests, and
// its "Verify: All Gates" job is both the single required status check and
// the only place native squash auto-merge is armed (merge-policy.yml was
// deleted; its behavior moved here). Two properties therefore have to hold
// together, and getting either wrong is a merge-safety bug:
//
//   1. The job must fail unless EVERY verification job succeeded -- and
//      "skipped" or "cancelled" must count as failure, not as a pass.
//   2. It must never arm auto-merge when the verdict is not green, when an
//      owner hold is in effect, on a draft, or on a fork.
//
// The behavioral tests below extract the workflow's actual embedded
// github-script body and execute it against a mocked GitHub API, rather
// than grepping for expected substrings -- a structural check cannot tell a
// real gate from one whose `if (!gatesGreen)` branch was quietly deleted,
// and that is exactly the regression this file exists to catch.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/pr-verify.yml");
const workflow = readFileSync(workflowPath, "utf8");

// The script: block is a YAML block scalar, and no YAML library is a
// dependency of this repo's test suite (see the sibling *-workflow.test.mjs
// files, which read raw text for the same reason). It is the last thing in
// the file, so extraction is "everything after the marker line, dedented by
// its common leading whitespace".
function extractScript(yamlText) {
  const markerIndex = yamlText.indexOf("script: |");
  assert.ok(markerIndex >= 0, "pr-verify.yml: no `script: |` block found");
  const body = yamlText.slice(markerIndex + "script: |".length + 1);
  const lines = body.split("\n");
  const indented = lines.filter((line) => line.trim().length > 0);
  const commonIndent = Math.min(...indented.map((line) => line.match(/^ */)[0].length));
  return lines.map((line) => line.slice(commonIndent)).join("\n");
}

function loadAllGatesModule() {
  const script = extractScript(workflow);
  const dir = mkdtempSync(path.join(tmpdir(), "all-gates-script-"));
  const file = path.join(dir, "all-gates.cjs");
  writeFileSync(
    file,
    `module.exports = async function (context, github, core, process) {\n${script}\n};\n`
  );
  return file;
}

test("pr-verify.yml is the only PR-triggered workflow, and merge-policy.yml is gone", () => {
  // Any second workflow triggering on a pull request adds a check row that
  // cannot be suppressed -- the whole point of absorbing merge-policy.yml
  // was to stop paying for a row that never gated anything.
  const prTriggered = [];
  for (const file of readdirSync(path.join(root, ".github/workflows")).sort()) {
    if (!file.endsWith(".yml")) continue;
    const text = readFileSync(path.join(root, ".github/workflows", file), "utf8");
    // Scan only the `on:` block, so a comment mentioning pull requests
    // elsewhere in the file cannot produce a false positive.
    const start = text.indexOf("\non:");
    if (start < 0) continue;
    const rest = text.slice(start + 1);
    const endMatch = /\n(?=[A-Za-z_-]+:)/.exec(rest.slice(3));
    const onBlock = endMatch ? rest.slice(0, 3 + endMatch.index) : rest;
    if (/^\s{2}pull_request(_target)?:/m.test(onBlock)) prTriggered.push(file);
  }
  assert.deepEqual(
    prTriggered,
    ["pr-verify.yml"],
    `exactly one workflow may trigger on pull requests; found: ${prTriggered.join(", ")}`
  );
});

test("the four rows are the expected jobs, and only All Gates holds a write token", () => {
  for (const name of [
    "Verify: Tests (Linux)",
    "Verify: Tests (Windows)",
    "Verify: LLM Review",
    "Verify: All Gates",
  ]) {
    assert.ok(workflow.includes(`name: "${name}"`), `pr-verify.yml is missing a job named ${name}`);
  }

  const allGates = workflow.slice(workflow.indexOf("  verify-all-gates:"));
  assert.match(allGates, /if: always\(\)/, "All Gates must report even when a dependency failed");
  assert.match(allGates, /needs: \[verify-tests-linux, verify-tests-windows\]/);
  assert.match(allGates, /contents: write/);
  assert.match(allGates, /pull-requests: write/);
  assert.match(allGates, /issues: write/);
  // The privileged job must not check out or shell out over PR content.
  assert.doesNotMatch(allGates, /uses: actions\/checkout/);
  assert.doesNotMatch(allGates, /\n\s+run: \|/);

  // LLM Review must NOT be a dependency of the required gate: it fails
  // closed while unprovisioned, so depending on it would make the one
  // required check permanently red.
  assert.doesNotMatch(
    allGates.slice(0, allGates.indexOf("steps:")),
    /verify-llm-review/,
    "All Gates must not depend on the non-required LLM Review job"
  );

  // Windows must detect changes itself rather than consuming a Linux
  // output, or it serializes behind the ~16-minute Linux job.
  const windows = workflow.slice(
    workflow.indexOf("  verify-tests-windows:"),
    workflow.indexOf("  verify-llm-review:")
  );
  assert.match(windows, /uses: \.\/\.github\/actions\/detect-changes/);
  assert.doesNotMatch(windows, /needs:/, "Windows job must stay parallel with the Linux job");
});

test("every doc that names a gate agrees with pr-verify.yml's actual job names", () => {
  // Doc drift is not cosmetic here: a required-checks list that disagreed
  // with the workflow is what stranded PRs #118, #120 and #160. This pins
  // the agreement so the next rename cannot land half-applied.
  const jobNames = [...workflow.matchAll(/^\s{4}name: "(Verify: [^"]+)"$/gm)].map((m) => m[1]).sort();
  assert.ok(jobNames.length >= 4, `expected the four Verify: jobs, found ${jobNames.length}`);

  // project.yaml: each ci.workflows entry carries exactly one gate: and one
  // required:, in that order, so zipping them pairs correctly.
  const projectYaml = readFileSync(path.join(root, "project.yaml"), "utf8");
  const gates = [...projectYaml.matchAll(/^\s+gate: "([^"]+)"$/gm)].map((m) => m[1]);
  const requireds = [...projectYaml.matchAll(/^\s+required: (true|false)/gm)].map((m) => m[1] === "true");
  assert.equal(gates.length, requireds.length, "project.yaml: every gate: needs exactly one required:");

  assert.deepEqual(
    [...gates].sort(),
    jobNames,
    "project.yaml's gate list and pr-verify.yml's job names have drifted apart"
  );

  const requiredGates = gates.filter((_, i) => requireds[i]);
  assert.deepEqual(
    requiredGates,
    ["Verify: All Gates"],
    "exactly one gate may be required, and it must be the rollup"
  );

  // bootstrap-github.sh writes the ruleset; it must ask for that same one.
  const bootstrap = readFileSync(path.join(root, "docs/ops/bootstrap-github.sh"), "utf8");
  const contexts = [...bootstrap.matchAll(/"context":\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    contexts,
    ["Verify: All Gates"],
    "bootstrap-github.sh's required-status-checks list disagrees with project.yaml"
  );

  // Prose docs must at least name every gate, so a renamed job cannot leave
  // a doc silently describing a check that no longer exists.
  for (const file of ["AGENTS.md", "README.md"]) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const name of jobNames) {
      assert.ok(text.includes(`\`${name}\``), `${file} never mentions ${name}`);
    }
  }
});

test("All Gates arms auto-merge only on a green verdict, and never past a hold, draft, or fork", async () => {
  const modulePath = loadAllGatesModule();
  const allGates = (await import(`file://${modulePath}`)).default;

  function makeMocks({
    gates,
    draft = false,
    labels = [],
    timeline = [],
    mergeable_state = "unstable",
    sameRepo = true,
  }) {
    const calls = [];
    const commentsByIssue = new Map();
    const github = {
      paginate: async function (fn, args) {
        if (fn === github.rest.issues.listEventsForTimeline) return timeline;
        if (fn === github.rest.issues.listComments) {
          return commentsByIssue.get(args.issue_number) || [];
        }
        return [];
      },
      rest: {
        pulls: {
          get: async () => ({
            data: {
              number: 42,
              node_id: "PR_x",
              title: "Test PR",
              draft,
              mergeable_state,
              labels,
              head: { sha: "dead", ref: "f", repo: { full_name: "kgsmith19/hyperbolic-core" } },
              base: {
                sha: "cafe",
                ref: "main",
                repo: { full_name: sameRepo ? "kgsmith19/hyperbolic-core" : "other/fork" },
              },
              body: "closes #7",
            },
          }),
          updateBranch: async () => ({}),
        },
        issues: {
          listEventsForTimeline: async () => ({ data: timeline }),
          listComments: async (a) => ({ data: commentsByIssue.get(a && a.issue_number) || [] }),
          createComment: async (a) => {
            calls.push("comment:" + a.issue_number);
            const list = commentsByIssue.get(a.issue_number) || [];
            list.push({ id: list.length + 1, body: a.body });
            commentsByIssue.set(a.issue_number, list);
          },
          updateComment: async () => calls.push("updateComment"),
          removeLabel: async (a) => calls.push("removeLabel:" + a.name),
        },
      },
      graphql: async (q) => {
        if (/enablePullRequestAutoMerge/.test(q)) return void calls.push("ARM") || {};
        if (/disablePullRequestAutoMerge/.test(q)) return void calls.push("DISARM") || {};
        if (/markPullRequestReadyForReview/.test(q)) return void calls.push("UNDRAFT") || {};
        throw new Error("unexpected graphql mutation in test");
      },
    };
    let failed = null;
    const core = {
      info() {},
      warning() {},
      error() {},
      setFailed(m) {
        failed = m;
      },
      summary: {
        addHeading() {
          return core.summary;
        },
        addRaw(t) {
          core.summary._b = t;
          return core.summary;
        },
        async write() {},
      },
    };
    const context = {
      repo: { owner: "kgsmith19", repo: "hyperbolic-core" },
      payload: {
        pull_request: { number: 42 },
        repository: { owner: { login: "kgsmith19" }, default_branch: "main" },
      },
    };
    const proc = { env: { GATE_RESULTS: JSON.stringify(gates) } };
    return {
      github,
      core,
      context,
      proc,
      calls,
      get failed() {
        return failed;
      },
    };
  }

  const run = async (opts) => {
    const m = makeMocks(opts);
    await allGates(m.context, m.github, m.core, m.proc);
    return m;
  };

  const GREEN = {
    "verify-tests-linux": { result: "success" },
    "verify-tests-windows": { result: "success" },
  };
  const RED = {
    "verify-tests-linux": { result: "failure" },
    "verify-tests-windows": { result: "success" },
  };
  const SKIPPED = {
    "verify-tests-linux": { result: "skipped" },
    "verify-tests-windows": { result: "success" },
  };

  let m = await run({ gates: GREEN });
  assert.ok(m.calls.includes("ARM"), "green verdict must arm auto-merge");
  assert.equal(m.failed, null, "green verdict must not fail the job");
  assert.equal(
    m.calls.filter((c) => c.startsWith("comment:")).length,
    2,
    "Work State must be posted on both the PR and its linked Issue"
  );

  m = await run({ gates: RED });
  assert.ok(!m.calls.includes("ARM"), "must not arm when a gate failed");
  assert.match(m.failed || "", /did not succeed/, "a failed gate must fail this job");

  // A job that silently stops reporting must turn the gate red, not green.
  m = await run({ gates: SKIPPED });
  assert.ok(!m.calls.includes("ARM"), "must not arm when a gate was skipped");
  assert.notEqual(m.failed, null, "a skipped gate must fail this job, not count as a pass");

  const heldByOwner = [
    { event: "labeled", label: { name: "owner:hold-merge" }, actor: { login: "kgsmith19" } },
  ];
  m = await run({ gates: GREEN, labels: [{ name: "owner:hold-merge" }], timeline: heldByOwner });
  assert.ok(m.calls.includes("DISARM"), "an authorized hold must disable auto-merge");
  assert.ok(!m.calls.includes("ARM"), "an authorized hold must prevent arming");
  assert.equal(m.failed, null, "a hold is not a verification failure");

  const forgedHold = [
    { event: "labeled", label: { name: "owner:hold-merge" }, actor: { login: "not-the-owner" } },
  ];
  m = await run({ gates: GREEN, labels: [{ name: "owner:hold-merge" }], timeline: forgedHold });
  assert.ok(
    m.calls.includes("removeLabel:owner:hold-merge"),
    "a hold label without owner provenance must be removed"
  );
  assert.ok(m.calls.includes("ARM"), "a forged hold must not stop a green PR from arming");

  m = await run({ gates: GREEN, sameRepo: false });
  assert.ok(!m.calls.includes("ARM"), "fork pull requests must never be armed");

  m = await run({ gates: GREEN, draft: true });
  assert.ok(m.calls.includes("UNDRAFT"), "an unauthorized draft must be cleared");
  assert.ok(m.calls.includes("ARM"), "a cleared draft must then arm");
});
