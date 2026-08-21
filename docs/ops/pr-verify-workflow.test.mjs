// Structural + behavioral assertions over .github/workflows/pr-verify.yml.
//
// pr-verify.yml is the ONLY workflow that runs on pull requests, and its
// "PR Gate" job is both the single required status check and the only
// place native squash auto-merge is armed. The architecture: Repository
// Standards verifies the repository, each app lane verifies itself, AI
// Review independently evaluates the change, and PR Gate verifies that
// every one of those lanes succeeded and alone controls merge
// authorization. Several properties have to hold together, and getting any
// of them wrong is a merge-safety bug:
//
//   1. PR Gate must fail unless EVERY lane succeeded -- and "skipped" or
//      "cancelled" must count as failure, not as a pass.
//   2. It must never arm auto-merge when the verdict is not green, when an
//      owner hold is in effect, on a draft, or on a fork.
//   3. The topology itself cannot drift silently: every expected worker
//      must exist, no unexpected worker may sneak in unnoticed, and the
//      fixture below, the YAML `needs:` list, and the runtime
//      `EXPECTED_GATE_JOBS` constant must all name exactly the same set.
//      That triple duplication is a deliberate safety checksum, not a DRY
//      violation -- dynamic YAML generation would remove the very
//      redundancy this file exists to check.
//
// The behavioral tests extract the workflow's actual embedded
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

// The worker lanes PR Gate rolls up, keyed by job id. Every id here must
// appear in the YAML with exactly this display name, must have no needs:
// of its own (repository-standards and the app lanes) or exactly the one
// documented dependency (ai-review on repository-standards), and must be
// named in PR Gate's own needs: list and its runtime EXPECTED_GATE_JOBS.
const EXPECTED_WORKERS = [
  "repository-standards",
  "toolbelt",
  "acc-linux",
  "acc-windows",
  "brain",
  "platform",
  "lifeos",
  "ai-review",
];

const EXPECTED_DISPLAY_NAMES = {
  "repository-standards": "Repository Standards",
  toolbelt: "Toolbelt",
  "acc-linux": "ACC Linux",
  "acc-windows": "ACC Windows",
  brain: "Brain",
  platform: "Platform",
  lifeos: "LifeOS",
  "ai-review": "AI Review",
  "pr-gate": "PR Gate",
};

// The script: block is a YAML block scalar, and no YAML library is a
// dependency of this repo's test suite (see the sibling *-workflow.test.mjs
// files, which read raw text for the same reason). It takes the FIRST
// occurrence and slices to end of file, which is only correct because a
// structural test below independently proves pr-gate is the last job in
// the file and that the string "script: |" appears exactly once.
function extractScript(yamlText) {
  const markerIndex = yamlText.indexOf("script: |");
  assert.ok(markerIndex >= 0, "pr-verify.yml: no `script: |` block found");
  const body = yamlText.slice(markerIndex + "script: |".length + 1);
  const lines = body.split("\n");
  const indented = lines.filter((line) => line.trim().length > 0);
  const commonIndent = Math.min(...indented.map((line) => line.match(/^ */)[0].length));
  return lines.map((line) => line.slice(commonIndent)).join("\n");
}

function loadPrGateModule() {
  const script = extractScript(workflow);
  const dir = mkdtempSync(path.join(tmpdir(), "pr-gate-script-"));
  const file = path.join(dir, "pr-gate.cjs");
  writeFileSync(
    file,
    `module.exports = async function (context, github, core, process) {\n${script}\n};\n`
  );
  return file;
}

test("pr-verify.yml is the only PR-triggered workflow", () => {
  // Any second workflow triggering on a pull request adds a check row that
  // cannot be suppressed.
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

test("the topology matches EXPECTED_WORKERS exactly: no missing worker, no unexpected one", () => {
  // Every job id in the YAML `jobs:` block, in file order. Job ids are
  // 2-space indented immediately under `jobs:`, e.g. "  toolbelt:".
  const jobsBlock = workflow.slice(workflow.indexOf("\njobs:\n"));
  const jobIds = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);

  assert.deepEqual(
    jobIds,
    [...EXPECTED_WORKERS, "pr-gate"],
    "pr-verify.yml's job ids have drifted from the expected topology (missing, renamed, reordered, or an unexpected extra job)"
  );

  // Terminal-job invariant: extractScript takes the first `script: |` and
  // slices to EOF, so pr-gate -- the only job with a script: block -- must
  // be last, or a job appended after it would silently vanish from what
  // the behavioral tests exercise.
  assert.equal(jobIds[jobIds.length - 1], "pr-gate", "pr-gate must be the last job in the file");

  // Every job's display name is double-quoted at exactly 4-space indent --
  // the convention every other assertion in this file relies on to find job
  // names without also matching step names (which sit deeper).
  for (const id of jobIds) {
    assert.ok(
      workflow.includes(`\n    name: "${EXPECTED_DISPLAY_NAMES[id]}"\n`),
      `job "${id}" must have the exact display name "${EXPECTED_DISPLAY_NAMES[id]}" at 4-space indent`
    );
  }

  // Exactly one embedded script: no second github-script body can exist
  // without corrupting extractScript's "first occurrence to EOF" reach.
  const scriptOccurrences = workflow.split("script: |").length - 1;
  assert.equal(scriptOccurrences, 1, "pr-verify.yml must contain exactly one `script: |` block");
});

test("dependency shape: only ai-review and pr-gate declare needs:, and each names exactly what it should", () => {
  function jobSlice(id, nextId) {
    const start = workflow.indexOf(`\n  ${id}:\n`);
    assert.ok(start >= 0, `job "${id}" not found`);
    const end = nextId ? workflow.indexOf(`\n  ${nextId}:\n`) : workflow.length;
    return workflow.slice(start, end);
  }

  const allIds = [...EXPECTED_WORKERS, "pr-gate"];

  // repository-standards and every app lane (everything except ai-review
  // and pr-gate) must have no needs: of their own -- they start at T=0,
  // fully parallel, so a lane cannot accidentally wait on a sibling.
  for (const id of EXPECTED_WORKERS) {
    if (id === "ai-review") continue;
    const idx = allIds.indexOf(id);
    const slice = jobSlice(id, allIds[idx + 1]);
    assert.doesNotMatch(slice, /\n {4}needs:/, `job "${id}" must not declare needs: -- it runs from T=0`);
  }

  // ACC's two rows are independent of each other specifically (not just
  // "no needs: at all" in general, which the loop above already covers).
  const accLinux = jobSlice("acc-linux", "acc-windows");
  const accWindows = jobSlice("acc-windows", "brain");
  assert.doesNotMatch(accLinux, /needs:/, "ACC Linux must not depend on ACC Windows");
  assert.doesNotMatch(accWindows, /needs:/, "ACC Windows must not depend on ACC Linux");

  // AI Review depends on Repository Standards, and ONLY Repository
  // Standards: the leaked-secret scan must finish before diff content
  // reaches an external model, but waiting on the app suites too would
  // serialize the pipeline for no security benefit.
  const aiReview = jobSlice("ai-review", "pr-gate");
  assert.match(aiReview, /\n {4}needs: \[repository-standards\]\n/, "ai-review must need exactly [repository-standards]");

  // PR Gate needs every worker, in the documented set.
  const prGate = jobSlice("pr-gate", null);
  const needsMatch = prGate.match(/needs: \[([^\]]+)\]/);
  assert.ok(needsMatch, "pr-gate must declare a needs: list");
  const needs = needsMatch[1].split(",").map((s) => s.trim());
  assert.deepEqual(
    needs.slice().sort(),
    EXPECTED_WORKERS.slice().sort(),
    "pr-gate's needs: must name exactly the EXPECTED_WORKERS set"
  );
});

test("PR Gate: fail-closed shape, write permissions confined to this one job, no PR-authored execution", () => {
  const prGate = workflow.slice(workflow.indexOf("\n  pr-gate:\n"));

  assert.match(prGate, /if: always\(\)/, "PR Gate must report even when a dependency failed");

  // EXPECTED_GATE_JOBS is what makes an empty needs payload fail closed
  // rather than pass vacuously, so it only works while it names the same
  // jobs needs: does. Deleting a lane from BOTH is the one direction no
  // runtime check can catch -- the payload would then be legitimately
  // complete and legitimately green over a shrunken set. This ties the two
  // lists together so that deletion has to be deliberate.
  const expectedGateJobsMatch = prGate.match(/const EXPECTED_GATE_JOBS = \[([^\]]+)\]/);
  assert.ok(expectedGateJobsMatch, "pr-gate script must define EXPECTED_GATE_JOBS");
  const runtimeExpected = expectedGateJobsMatch[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  assert.deepEqual(
    runtimeExpected.slice().sort(),
    EXPECTED_WORKERS.slice().sort(),
    "the runtime EXPECTED_GATE_JOBS constant must name exactly the EXPECTED_WORKERS set"
  );

  // Write permissions belong to pr-gate alone. Count occurrences across the
  // WHOLE workflow, not just within the pr-gate slice, so a write grant
  // accidentally added to a worker lane is caught even though this
  // assertion is anchored on pr-gate's own content.
  for (const perm of ["contents: write", "pull-requests: write", "issues: write"]) {
    const occurrences = workflow.split(perm).length - 1;
    assert.equal(occurrences, 1, `"${perm}" must appear exactly once in the whole workflow (on pr-gate only)`);
    assert.ok(prGate.includes(perm), `pr-gate must declare "${perm}"`);
  }

  // The privileged job must not check out or shell out over PR content.
  assert.doesNotMatch(prGate, /uses: actions\/checkout/);
  assert.doesNotMatch(prGate, /\n\s+run: \|/);
});

test("every doc that names a lane agrees with pr-verify.yml's actual job names", () => {
  // Doc drift is not cosmetic here: a required-checks list that disagreed
  // with the workflow is what stranded PRs #118, #120 and #160. This pins
  // the agreement so the next rename cannot land half-applied.
  const jobNames = Object.values(EXPECTED_DISPLAY_NAMES).sort();

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
    ["PR Gate"],
    "exactly one gate may be required, and it must be the rollup"
  );

  // bootstrap-github.sh writes the ruleset; it must ask for that same one.
  const bootstrap = readFileSync(path.join(root, "docs/ops/bootstrap-github.sh"), "utf8");
  const contexts = [...bootstrap.matchAll(/"context":\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    contexts,
    ["PR Gate"],
    "bootstrap-github.sh's required-status-checks list disagrees with project.yaml"
  );

  // Prose docs must at least name every lane, so a renamed job cannot leave
  // a doc silently describing a check that no longer exists.
  for (const file of ["AGENTS.md", "README.md"]) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const name of jobNames) {
      assert.ok(text.includes(`\`${name}\``), `${file} never mentions ${name}`);
    }
  }
});

test("PR Gate arms auto-merge only on a green verdict, and never past a hold, draft, fork, or an empty needs payload", async () => {
  const modulePath = loadPrGateModule();
  const prGate = (await import(`file://${modulePath}`)).default;

  function makeMocks({
    gates,
    // Set to bypass JSON.stringify(gates) and hand the script a literal
    // GATE_RESULTS -- or `null` to unset the variable entirely. Only the
    // fail-closed cases at the bottom need it.
    rawGateResults,
    // Message GitHub's enablePullRequestAutoMerge mutation should reject with.
    armError = null,
    draft = false,
    labels = [],
    timeline = [],
    mergeable_state = "unstable",
    sameRepo = true,
    // Issue #274: per-issue-number { state, body } for the checklist-gate
    // check. Defaults every referenced issue (the fixture PR body links #7)
    // to open with no checklist at all, so every pre-existing test in this
    // file exercises the REAL checklist path (a lookup that finds nothing to
    // block on) rather than relying on that check's own fail-open handling
    // for an undefined mock method.
    issueChecklists = {},
    prBody = "closes #7",
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
              body: prBody,
            },
          }),
          updateBranch: async () => ({}),
        },
        issues: {
          get: async (a) => {
            calls.push("issues.get:" + a.issue_number);
            const fixture = issueChecklists[a.issue_number] || { state: "open", body: "" };
            return { data: { number: a.issue_number, ...fixture } };
          },
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
        if (/enablePullRequestAutoMerge/.test(q)) {
          calls.push("ARM-ATTEMPTED");
          if (armError) throw new Error(armError);
          return void calls.push("ARM") || {};
        }
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
    const proc = {
      env:
        rawGateResults === undefined
          ? { GATE_RESULTS: JSON.stringify(gates) }
          : rawGateResults === null
            ? {}
            : { GATE_RESULTS: rawGateResults },
    };
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
    await prGate(m.context, m.github, m.core, m.proc);
    return m;
  };

  function allSuccess(overrides = {}) {
    const results = {};
    for (const id of EXPECTED_WORKERS) results[id] = { result: "success" };
    return { ...results, ...overrides };
  }

  const GREEN = allSuccess();
  const RED = allSuccess({ toolbelt: { result: "failure" } });
  // Repository Standards failing is the realistic path to ai-review coming
  // back "skipped" (GitHub skips a job whose own needs: failed) -- this is
  // the exact case the header comment documents as the intended behavior.
  const SKIPPED = allSuccess({ "repository-standards": { result: "failure" }, "ai-review": { result: "skipped" } });

  let m = await run({ gates: GREEN });
  assert.ok(m.calls.includes("ARM"), "green verdict must arm auto-merge");
  assert.equal(m.failed, null, "green verdict must not fail the job");
  assert.equal(
    m.calls.filter((c) => c.startsWith("comment:")).length,
    2,
    "Work State must be posted on both the PR and its linked Issue"
  );

  m = await run({ gates: RED });
  assert.ok(!m.calls.includes("ARM"), "must not arm when a lane failed");
  assert.match(m.failed || "", /did not succeed/, "a failed lane must fail this job");

  // A job that silently stops reporting (or was skipped because its own
  // dependency failed) must turn the gate red, not green.
  m = await run({ gates: SKIPPED });
  assert.ok(!m.calls.includes("ARM"), "must not arm when a lane was skipped");
  assert.notEqual(m.failed, null, "a skipped lane must fail this job, not count as a pass");

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

  // ---- an "unstable" arm-refusal is tolerated, not treated as fatal ------
  //
  // GitHub refuses the arming mutation outright on an unstable PR (some
  // non-required check is red) rather than arming and waiting -- observed
  // verbatim on PR #219. With every lane in this workflow already inside
  // pr-gate's own needs:, this workflow's own rows cannot cause "unstable"
  // any more; a red third-party check or a stale sibling run still can.
  // Either way it must not fail the run and must not be reported as an
  // unexpected error.
  m = await run({ gates: GREEN, armError: "Pull request Pull request is in unstable status" });
  assert.ok(m.calls.includes("ARM-ATTEMPTED"), "a green verdict must still attempt to arm");
  assert.equal(m.failed, null, "an unstable-refusal is not a verification failure");
  assert.match(
    m.core.summary._b || "",
    /unstable/i,
    "the summary must say the PR was unstable, not report an unexpected error"
  );
  assert.doesNotMatch(
    m.core.summary._b || "",
    /unexpected error/i,
    "an unstable-refusal must not be labelled an unexpected error"
  );

  // ---- Issue #274: incomplete linked-Issue checklists block, visibly -----
  //
  // Unlike hold/draft/fork above (which skip arming without failing the
  // check), an incomplete checklist must fail THIS job outright -- the
  // owner asked to see it as a reason for failure, not a silent arm-skip.

  m = await run({ gates: GREEN, issueChecklists: { 7: { state: "open", body: "- [ ] one\n- [x] two" } } });
  assert.ok(!m.calls.includes("ARM"), "an open Issue with an unchecked item must not arm");
  assert.notEqual(m.failed, null, "an incomplete checklist must fail PR Gate, not just skip arming");
  assert.match(m.failed || "", /checklist incomplete on #7/);

  m = await run({ gates: GREEN, issueChecklists: { 7: { state: "closed", body: "- [ ] one" } } });
  assert.ok(m.calls.includes("ARM"), "a CLOSED Issue is exempt regardless of unchecked items -- covers superseded/not-planned work");
  assert.equal(m.failed, null);

  m = await run({
    gates: GREEN,
    prBody: "Closes #7\nFixes #9",
    issueChecklists: {
      7: { state: "open", body: "- [x] done" },
      9: { state: "open", body: "- [ ] not done" },
    },
  });
  assert.ok(!m.calls.includes("ARM"), "ALL linked Issues must be complete -- one incomplete Issue among several still blocks");
  assert.match(m.failed || "", /#9/, "the failure must name which Issue is incomplete");
  assert.doesNotMatch(m.failed || "", /#7/, "a complete Issue must not be named as a blocker");

  const checklistOverride = [
    { event: "labeled", label: { name: "owner:allow-incomplete-issue" }, actor: { login: "kgsmith19" } },
  ];
  m = await run({
    gates: GREEN,
    labels: [{ name: "owner:allow-incomplete-issue" }],
    timeline: checklistOverride,
    issueChecklists: { 7: { state: "open", body: "- [ ] one" } },
  });
  assert.ok(m.calls.includes("ARM"), "an owner-authorized override label must un-block an incomplete checklist");
  assert.equal(m.failed, null);

  const forgedChecklistOverride = [
    { event: "labeled", label: { name: "owner:allow-incomplete-issue" }, actor: { login: "not-the-owner" } },
  ];
  m = await run({
    gates: GREEN,
    labels: [{ name: "owner:allow-incomplete-issue" }],
    timeline: forgedChecklistOverride,
    issueChecklists: { 7: { state: "open", body: "- [ ] one" } },
  });
  assert.ok(
    m.calls.includes("removeLabel:owner:allow-incomplete-issue"),
    "an override label without owner provenance must be removed"
  );
  assert.ok(!m.calls.includes("ARM"), "a forged override must not un-block an incomplete checklist");

  m = await run({ gates: GREEN, issueChecklists: { 7: { state: "open", body: "no checklist here at all" } } });
  assert.ok(m.calls.includes("ARM"), "an Issue with no checklist items is not incomplete -- nothing to check");
  assert.equal(m.failed, null);

  // ---- fail CLOSED when the needs payload says nothing ------------------
  //
  // The dangerous shape is not a red gate, it is NO gate. A "did anything
  // fail?" test over an empty object is vacuously true, so before this was
  // guarded, GATE_RESULTS="{}" made this job report SUCCESS and arm a merge
  // having verified precisely nothing -- which is the exact failure class
  // the whole required-check design exists to prevent. Each case below was
  // observed arming auto-merge in the unguarded form.
  //
  // These are not hypothetical inputs: an edited-away needs: list, a
  // renamed job id, or a truncated expression all produce one of them.
  for (const [label, opts] of [
    ["an empty needs object", { rawGateResults: "{}" }],
    ["GATE_RESULTS unset entirely", { rawGateResults: null }],
    ["a malformed GATE_RESULTS payload", { rawGateResults: "{not json" }],
    ["a gate whose result is null", { gates: allSuccess({ toolbelt: { result: null } }) }],
    [
      "a renamed job id that no longer matches",
      { gates: (() => { const g = allSuccess(); delete g.toolbelt; g["toolbelt-renamed"] = { result: "success" }; return g; })() },
    ],
  ]) {
    m = await run(opts);
    assert.ok(!m.calls.includes("ARM"), `${label} must never arm auto-merge`);
    assert.notEqual(m.failed, null, `${label} must fail this job, not pass vacuously`);
  }
});
