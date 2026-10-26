// node --test docs/ops/stage63-gate.test.mjs (run from the repo root)
//
// S9 RED characterization (Issue #427): v5 Gate/evidence semantics from
// agent-engineering-standard @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d —
// tools/gate_compliance.py (Stage 57: the read-only Standards Compliance lane
// feeding the single final aggregator), tools/tracker_pipeline_gate.py (T05:
// tracker, pipeline and gate contracts with GitHub YAML as the authoritative
// rendering), tools/completion_receipts.py (T20: MERGED / CLEANED / excluded
// close receipts) and standardctl.owner_label_authorized (the function the
// merge-policy contract requires the PR Gate to mirror exactly).
//
// The oracle is stage63-gate-golden.json, computed by the upstream Python at
// the pinned commit, with all three frozen upstream corpora replayed. The live
// half binds the contracts to hyperbolic-core's own control plane by EXECUTING
// it: pr-verify.yml's PR Gate script decides every exact-success scenario the
// port decides, its owner-label mirror is replayed against upstream, and the
// issue-close sweep is run against the completion-receipt rules. Workflow
// behavior is not changed by this slice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ADOPTION, FROZEN, GAP_SLICES, checkCleanedReceipt, checkDuplicateNoop, checkExclusion, checkGateAggregation,
  checkMembershipRace, checkMergePolicyMetadata, checkMergedReceipt, checkParentGate, checkRenderSync,
  checkRenderingDocsOnly, checkReviewOwnership, checkTrackerClaim, checkTrackerMath, cleanGateRender,
  cleanGateResults, cleanLaneObservation, cleanMergePolicy, cleanRendering, cleanReviewRecord, cleanTrackerClaim,
  evaluateComplianceLane, ownerLabelAuthorized, provenance, validateLaneFinding,
} from "./stage63-adoption-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n?/g, "\n");
const golden = JSON.parse(readFileSync(path.join(here, "stage63-gate-golden.json"), "utf8"));

// --- Frozen contract shape ---------------------------------------------------

test("S9 · gate_compliance contract is frozen: verdicts, rules in check order, rule verdicts, profiles", () => {
  const lane = FROZEN.gate_compliance;
  assert.deepEqual([...lane.VERDICTS], ["PASS", "FAIL"]);
  assert.deepEqual([...lane.RULES], [
    "missing-receipt", "stale-route", "adapter-degraded", "mold-violation", "self-certify", "compact-valid",
    "lane-skipped", "head-moved",
  ]);
  assert.deepEqual(Object.keys(lane).sort(), Object.keys(golden.lane.constants).sort());
  for (const key of Object.keys(golden.lane.constants)) {
    assert.deepEqual(lane[key], golden.lane.constants[key], `gate_compliance.${key} drifted from upstream`);
  }
});

test("S9 · tracker_pipeline_gate contract is frozen: tracker, pipeline and gate vocabularies", () => {
  const tpg = FROZEN.tracker_pipeline_gate;
  assert.deepEqual([...tpg.GATE_CONTRACT], [
    "always-run-aggregator", "exact-success", "exact-head", "summary", "sole-required-check", "owner-bypass-only",
  ]);
  assert.deepEqual([...tpg.EXACT_SUCCESS_ONLY], ["success"]);
  assert.deepEqual(Object.keys(tpg).sort(), Object.keys(golden.tpg.constants).sort());
  for (const key of Object.keys(golden.tpg.constants)) {
    assert.deepEqual(tpg[key], golden.tpg.constants[key], `tracker_pipeline_gate.${key} drifted from upstream`);
  }
});

test("S9 · completion_receipts contract is frozen: five distinct receipt states, MERGED never CLEANED", () => {
  assert.deepEqual([...FROZEN.completion_receipts.RECEIPT_STATES], golden.receipts.constants.RECEIPT_STATES);
  assert.deepEqual([...FROZEN.completion_receipts.RECEIPT_STATES],
    ["MERGED", "CLEANED", "CLEANUP_PENDING", "RECOVERY_REQUIRED", "EXCLUDED"]);
});

test("S9 · provenance names every Gate/evidence module at the pinned SHA", () => {
  for (const module of ["gate_compliance", "tracker_pipeline_gate", "completion_receipts", "standardctl"]) {
    assert.match(provenance(), new RegExp(`tools/${module}\\.py`));
    assert.match(golden._provenance, new RegExp(`tools/${module}\\.py`));
  }
  assert.match(golden._provenance, /9e50c9c3518e5bed2ba93e194cb157a78ee0278d/);
});

test("S9 · clean builders match upstream and hand out fresh copies", () => {
  const { builders } = golden.tpg;
  assert.deepEqual(cleanLaneObservation(), golden.lane.clean_observation);
  assert.deepEqual(cleanTrackerClaim(), builders.claim);
  assert.deepEqual(cleanGateResults(), builders.gate);
  assert.deepEqual(cleanGateResults({ b: "success" }), builders.gate_custom);
  assert.deepEqual(cleanGateRender(), builders.render);
  assert.deepEqual(cleanReviewRecord(), builders.review);
  assert.deepEqual(cleanReviewRecord({ uncalled: true }), builders.review_uncalled);
  assert.deepEqual(cleanMergePolicy(), builders.policy);
  assert.deepEqual(cleanRendering(), builders.rendering);
  const gate = cleanGateResults();
  gate.jobs.tests = "failure";
  const render = cleanGateRender();
  render.needs.push("x");
  assert.deepEqual([cleanGateResults(), cleanGateRender()], [builders.gate, builders.render], "callers mutate one dimension per test");
});

// --- Differential characterization against the upstream Python ----------------

const replay = (call, expected) => {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected) && "error" in expected) {
    assert.throws(call, (e) => e.name === expected.error);
    return;
  }
  assert.deepEqual(call(), expected);
};

for (const c of golden.lane.evaluate) {
  test(`S9 · evaluateComplianceLane matches upstream evaluate: ${c.label}`, () => {
    replay(() => evaluateComplianceLane(c.observation), c.result);
  });
}
for (const c of golden.lane.validate) {
  test(`S9 · validateLaneFinding matches upstream validate_finding: ${c.label}`, () => {
    replay(() => validateLaneFinding(c.finding), c.result);
  });
}

const tpgChecks = {
  claim: checkTrackerClaim, gate: checkGateAggregation, render: checkRenderSync, review: checkReviewOwnership,
  policy: checkMergePolicyMetadata, rendering: checkRenderingDocsOnly,
};
for (const [section, check] of Object.entries(tpgChecks)) {
  for (const c of golden.tpg[section]) {
    test(`S9 · ${check.name} matches upstream: ${c.label}`, () => replay(() => check(c.record), c.result));
  }
}

const receiptChecks = {
  merged: (c) => checkMergedReceipt(c.record), cleaned: (c) => checkCleanedReceipt(c.record, c.cleanup_receipt),
  exclusion: (c) => checkExclusion(c.record), parent: (c) => checkParentGate(c.record),
  duplicate: (c) => checkDuplicateNoop(c.record, c.replay), race: (c) => checkMembershipRace(c.record),
  tracker: (c) => checkTrackerMath(c.record),
};
for (const [section, check] of Object.entries(receiptChecks)) {
  for (const c of golden.receipts[section]) {
    test(`S9 · completion receipt ${section} check matches upstream: ${c.label}`, () => replay(() => check(c), c.result));
  }
}

for (const c of golden.owner_label) {
  test(`S9 · ownerLabelAuthorized matches upstream owner_label_authorized: ${c.label}`, () => {
    replay(() => ownerLabelAuthorized(c.events, c.label_name, c.owner), c.result);
  });
}

// The golden file is written with sorted keys, so the gate cases are replayed
// with reversed key insertion order: the port must sort jobs, not trust order.
const reversedKeys = (value) => (value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]))
  : value);

test("S9 · checkGateAggregation reports failing jobs in sorted order whatever the input key order", () => {
  for (const c of golden.tpg.gate) replay(() => checkGateAggregation(reversedKeys(c.record)), c.result);
});

test("S9 · port inputs are never mutated", () => {
  const records = [
    ...golden.lane.evaluate.map((c) => [evaluateComplianceLane, c.observation]),
    ...Object.entries(tpgChecks).flatMap(([section, check]) => golden.tpg[section].map((c) => [check, c.record])),
  ];
  for (const [call, input] of records) {
    const snapshot = structuredClone(input);
    try { call(input); } catch { /* upstream raises for some inputs; mutation is what is checked */ }
    assert.deepEqual(input, snapshot, call.name);
  }
});

test("S9 · golden cases exercise every lane rule and both sides of every checker", () => {
  const rules = new Set(golden.lane.evaluate.map((c) => c.result.rule));
  assert.deepEqual([...FROZEN.gate_compliance.RULES].filter((rule) => !rules.has(rule)), []);
  const sides = (cases) => new Set(cases.map((c) => (Array.isArray(c.result) ? c.result.length > 0 : "error")));
  for (const section of Object.keys(tpgChecks)) assert.ok(sides(golden.tpg[section]).has(true) && sides(golden.tpg[section]).has(false), section);
  for (const section of Object.keys(receiptChecks)) {
    assert.ok(sides(golden.receipts[section]).has(true) && sides(golden.receipts[section]).has(false), section);
  }
  assert.ok(golden.owner_label.some((c) => c.result === true) && golden.owner_label.some((c) => c.result === false));
});

// --- The frozen upstream corpora, replayed through the ports ------------------

test("S9 · every frozen gate-compliance corpus entry decides as upstream adjudicated", () => {
  const entries = golden.corpus.lane;
  assert.ok(entries.length >= 8);
  for (const entry of entries) {
    const result = evaluateComplianceLane(entry.observation ?? {});
    assert.deepEqual(result, entry.result, entry.id);
    assert.deepEqual([result.rule, result.verdict], [entry.expected_rule, entry.expected_verdict], entry.id);
  }
  assert.deepEqual(new Set(entries.map((e) => e.expected_rule)), new Set(FROZEN.gate_compliance.RULES));
});

const corpusCheckers = {
  tracker: (e) => checkTrackerClaim(e.record), gate: (e) => checkGateAggregation(e.record),
  render: (e) => checkRenderSync(e.record), review: (e) => checkReviewOwnership(e.record),
  policy: (e) => checkMergePolicyMetadata(e.record), azure: (e) => checkRenderingDocsOnly(e.record),
};
const receiptCorpusCheckers = {
  merged: (e) => checkMergedReceipt(e.record), cleaned: (e) => checkCleanedReceipt(e.record, e.cleanup_receipt ?? null),
  exclusion: (e) => checkExclusion(e.record), parent: (e) => checkParentGate(e.record),
  duplicate: (e) => checkDuplicateNoop(e.record, e.replay ?? {}), race: (e) => checkMembershipRace(e.record),
  tracker: (e) => checkTrackerMath(e.record),
};
for (const [name, checkers, minimum] of [["tracker-pipeline-gate", corpusCheckers, 13], ["completion-receipts", receiptCorpusCheckers, 16]]) {
  test(`S9 · every frozen ${name} corpus entry reproduces its adjudicated fragment`, () => {
    const entries = golden.corpus[name === "tracker-pipeline-gate" ? "rendering" : "receipts"];
    assert.ok(entries.length >= minimum);
    for (const entry of entries) {
      const violations = checkers[entry.target](entry);
      assert.deepEqual(violations, entry.violations, entry.id);
      const fragment = entry.expected_violation_fragment;
      if (fragment) assert.ok(violations.some((v) => v.includes(fragment)), `${entry.id}: ${fragment}`);
      else assert.deepEqual(violations, [], entry.id);
    }
    assert.deepEqual(new Set(entries.map((e) => e.target)), new Set(Object.keys(checkers)), "every target is covered");
  });
}

// --- Characterized upstream defects (tracked upstream; flipped by the bump that picks up the fix) --

test("S9 · upstream defect is pinned: compact-valid PASSes before lane-skipped and head-moved are checked", () => {
  const clean = cleanLaneObservation();
  const moved = "b".repeat(40);
  for (const [label, observation] of [
    ["R1, lane absent", { ...clean, risk: "R1", lane_present: false }],
    ["R0, head moved", { ...clean, risk: "R0", live_head: moved }],
    ["risk absent, lane absent", (({ risk, ...rest }) => ({ ...rest, lane_present: false }))(clean)],
  ]) {
    const result = evaluateComplianceLane(observation);
    assert.deepEqual([result.verdict, result.rule], ["PASS", "compact-valid"],
      `${label}: fails open today ("the lane never silently absents" holds only for R2/R3)`);
  }
  assert.deepEqual(evaluateComplianceLane({ ...clean, lane_present: false }).rule, "lane-skipped", "R2 fails closed");
  assert.deepEqual(evaluateComplianceLane({ ...clean, live_head: moved }).rule, "head-moved", "R2 fails closed");
});

test("S9 · upstream defect is pinned: a gate record without tested_sha skips the exact-head rule", () => {
  const { tested_sha: _tested, ...unproven } = cleanGateResults();
  assert.deepEqual(checkGateAggregation({ ...unproven, head_sha: "new" }), [],
    "exact-SHA-equals-head is not proven, yet the gate passes");
  assert.match(checkGateAggregation({ ...cleanGateResults(), tested_sha: "old", head_sha: "new" })[0], /stale tested SHA/);
});

test("S9 · upstream defect is pinned: MERGED accepts any PR state with a merge commit", () => {
  // GitHub fills merge_commit_sha with the test-merge commit for open and for
  // closed-unmerged pull requests, so "PR state + merge commit" is not remote
  // merge truth unless the state is checked.
  for (const pr_state of ["closed", "open"]) {
    assert.deepEqual(checkMergedReceipt({ pr_state, merge_commit: "abc" }), [], `${pr_state}: fails open today`);
  }
});

test("S9 · upstream defect is pinned: an exclusion check misses GitHub's not_planned close reason", () => {
  assert.deepEqual(checkExclusion({ close_reason: "not_planned", counted_delivered: true }), [],
    "GitHub's state_reason spelling is counted delivered today");
  assert.equal(checkExclusion({ close_reason: "not-planned", counted_delivered: true }).length, 1);
});

// --- hyperbolic-core's live control plane, executed ---------------------------

const workflow = read(".github/workflows/pr-verify.yml");
const parsedWorkflow = parseYaml(workflow);
const extractScript = (yamlText) => {
  const marker = yamlText.indexOf("script: |");
  assert.ok(marker >= 0, "no `script: |` block found");
  const lines = yamlText.slice(marker + "script: |".length + 1).split("\n");
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length));
  return lines.map((line) => line.slice(indent)).join("\n");
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const gateScript = extractScript(workflow);
const expectedGateJobs = () => {
  const match = /const EXPECTED_GATE_JOBS = \[([^\]]+)\]/.exec(gateScript);
  assert.ok(match, "the PR Gate script must define EXPECTED_GATE_JOBS");
  return JSON.parse(`[${match[1]}]`);
};

// The live PR Gate script, run against a fixed same-repo, non-draft PR with no
// labels: the verdict is whether it fails the job, and whether it arms a merge.
async function liveGate(gateResults) {
  let failed = null;
  let armed = false;
  const github = {
    paginate: async () => [],
    rest: {
      pulls: {
        get: async () => ({ data: { number: 42, node_id: "PR_x", draft: false, mergeable_state: "unstable", labels: [], body: "",
          head: { sha: "dead", ref: "f", repo: { full_name: "kgsmith19/hyperbolic-core" } },
          base: { sha: "cafe", ref: "main", repo: { full_name: "kgsmith19/hyperbolic-core" } } } }),
        updateBranch: async () => ({}),
      },
      issues: {
        get: async (a) => ({ data: { number: a.issue_number, state: "open", body: "" } }),
        listEventsForTimeline: async () => ({ data: [] }), listComments: async () => ({ data: [] }),
        createComment: async () => {}, updateComment: async () => {}, removeLabel: async () => {},
      },
      repos: { getContent: async () => { throw new Error("no agent-roles.yaml in this harness"); } },
    },
    graphql: async (query) => {
      if (/enablePullRequestAutoMerge/.test(query)) armed = true;
      return {};
    },
  };
  const core = {
    info() {}, warning() {}, error() {}, setFailed(message) { failed = message; },
    summary: { addHeading() { return core.summary; }, addRaw() { return core.summary; }, async write() {} },
  };
  const context = {
    repo: { owner: "kgsmith19", repo: "hyperbolic-core" },
    payload: { pull_request: { number: 42 }, repository: { owner: { login: "kgsmith19" }, default_branch: "main" } },
  };
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => { fn(); return 0; };
  try {
    await new AsyncFunction("context", "github", "core", "process", gateScript)(
      context, github, core, { env: { GATE_RESULTS: JSON.stringify(gateResults) } });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  return { passed: failed === null, armed };
}

test("S9 · the PR Gate's needs: and EXPECTED_GATE_JOBS render in sync, with no stub lane", () => {
  const gateJob = parsedWorkflow.jobs["pr-gate"];
  const record = { needs: gateJob.needs, expected_jobs: expectedGateJobs(), stubs: [] };
  assert.deepEqual(checkRenderSync(record), []);
  for (const job of gateJob.needs) {
    const steps = parsedWorkflow.jobs[job]?.steps ?? [];
    assert.ok(steps.length > 0, `${job} is a real lane with steps, never an empty-success stub`);
  }
  assert.deepEqual(checkRenderSync({ ...record, needs: gateJob.needs.slice(1) }).length, 1, "dropping one side is drift");
});

test("S9 · the live PR Gate decides every exact-success scenario exactly as the port does", async () => {
  const jobs = expectedGateJobs();
  const success = Object.fromEntries(jobs.map((job) => [job, { result: "success" }]));
  const scenarios = [["all success", success, Object.fromEntries(jobs.map((job) => [job, "success"]))]];
  for (const job of jobs) {
    for (const conclusion of [...FROZEN.tracker_pipeline_gate.NON_SUCCESS_CONCLUSIONS, null, "missing"]) {
      const live = { ...success };
      const port = Object.fromEntries(jobs.map((j) => [j, "success"]));
      if (conclusion === "missing") {
        delete live[job];
        port[job] = null;
      } else {
        live[job] = { result: conclusion };
        port[job] = conclusion;
      }
      scenarios.push([`${job} ${conclusion}`, live, port]);
    }
  }
  assert.equal(scenarios.length, 1 + jobs.length * 6);
  for (const [label, live, portJobs] of scenarios) {
    const verdict = await liveGate(live);
    const violations = checkGateAggregation({ jobs: portJobs, tested_sha: "dead", head_sha: "dead", summary: true });
    assert.equal(verdict.passed, violations.length === 0, `${label}: live gate and port disagree`);
    assert.equal(verdict.armed, verdict.passed, `${label}: auto-merge arms exactly when the gate passes`);
  }
});

test("S9 · the PR Gate is the always-run aggregator, the sole required check, and binds the exact head", () => {
  assert.equal(parsedWorkflow.jobs["pr-gate"].if, "always()", "the aggregator always runs, even after a lane fails");
  const project = parseYaml(read("project.yaml"));
  const required = project.ci.workflows.filter((entry) => entry.required === true).map((entry) => entry.gate);
  assert.deepEqual(required, [parsedWorkflow.jobs["pr-gate"].name], "PR Gate is the one required check");
  assert.match(gateScript, /expectedHeadOid/, "auto-merge is armed against the exact tested head");
  assert.equal(parsedWorkflow.on.pull_request.paths, undefined, "no paths filter: the gate always reports");
});

test("S9 · the AI Review invocation satisfies review ownership: non-empty separated inputs, no paths filter", () => {
  const step = parsedWorkflow.jobs["ai-review"].steps.find((s) => s.uses === "./.github/actions/verify-llm-review");
  assert.ok(step, "ai-review calls the verify-llm-review action");
  const record = {
    called: true,
    builder_provider_family: step.with.review_builder_provider,
    reviewer_provider_family: step.with.review_provider,
    reviewer_model: step.with.review_model,
    paths_filter: parsedWorkflow.on.pull_request.paths ?? null,
  };
  assert.deepEqual(checkReviewOwnership(record), []);
  assert.notEqual(record.builder_provider_family, record.reviewer_provider_family,
    "builder and reviewer resolve from different variables; the runtime separation check is pinned by S8");
});

const ownerLabelMirror = () => {
  const start = gateScript.indexOf("function ownerLabelAuthorized(");
  assert.ok(start >= 0, "the PR Gate script defines its owner_label_authorized mirror");
  const end = gateScript.indexOf("\n}\n", start);
  return new Function(`${gateScript.slice(start, end + 2)}\nreturn ownerLabelAuthorized;`)();
};

test("S9 · the PR Gate's owner-label mirror agrees with upstream on every GitHub-shaped timeline", () => {
  const mirror = ownerLabelMirror();
  const github = golden.owner_label.filter((c) => c.shape === "github");
  assert.ok(github.length >= 15);
  for (const c of github) assert.equal(mirror(c.events, c.label_name, c.owner), c.result, c.label);
});

test("S9 · disclosed delta: the mirror diverges only where JS and Python truthiness differ, which GitHub never sends", () => {
  const mirror = ownerLabelMirror();
  const diverging = golden.owner_label.filter((c) => c.shape === "malformed" && mirror(c.events, c.label_name, c.owner) !== c.result);
  assert.deepEqual(diverging.map((c) => c.label), [
    "label-name-empty-list-falls-back", "label-name-empty-mapping-falls-back", "actor-login-empty-list-falls-back",
  ], "an empty list or mapping is truthy in JS and falsy in Python; every other malformed shape agrees");
  for (const c of diverging) assert.equal(mirror(c.events, c.label_name, c.owner), false, `${c.label}: the mirror fails closed`);
});

test("S9 · disclosed delta: the PR Gate is metadata-only merge policy with an exact mirror, but it IS the required check", () => {
  const gateJob = parsedWorkflow.jobs["pr-gate"];
  const kinds = gateJob.steps.map((step) => {
    if (step.run !== undefined) return "shell";
    if (/^actions\/checkout@/.test(step.uses ?? "")) return "checkout";
    if (/^actions\/download-artifact@/.test(step.uses ?? "")) return "download-artifact";
    return step.uses.split("@")[0];
  });
  const mirror = ownerLabelMirror();
  const exact = golden.owner_label.filter((c) => c.shape === "github")
    .every((c) => mirror(c.events, c.label_name, c.owner) === c.result);
  const record = { steps: kinds, mirror_equivalent: exact, required: true };
  assert.deepEqual(checkMergePolicyMetadata(record), [
    "merge policy must never be a required check: the final aggregator gate is the sole required check",
  ], "hyperbolic-core fuses the rollup and merge orchestration in its one required job (pr-verify.yml, owner design); the delta stays visible");
  assert.deepEqual(checkMergePolicyMetadata({ ...record, required: false }), [], "everything else in the merge-policy contract holds");
});

test("S9 · GitHub YAML is the only CI rendering: no second live tracker, pipeline or gate", () => {
  for (const other of ["azure-pipelines.yml", ".gitlab-ci.yml", "Jenkinsfile", ".circleci/config.yml", "bitbucket-pipelines.yml"]) {
    assert.ok(!existsSync(path.join(root, other)), `${other} would be a second live rendering`);
  }
  assert.equal(FROZEN.tracker_pipeline_gate.AUTHORITATIVE_RENDERING, "github-yaml");
  assert.deepEqual(checkRenderingDocsOnly({ harness: "github-yaml", kind: "live", live_yaml: true }), []);
});

test("S9 · AGENTS.md's claim is the atomic one-writer claim the tracker contract names", () => {
  const agents = read("AGENTS.md").replace(/\s+/g, " ");
  assert.match(agents, /Create the remote branch via the GitHub ref-creation API \(atomic claim\)\. "Reference already exists" is a failed claim\./);
  assert.deepEqual(checkTrackerClaim({ writers: ["builder"], slice: "issue-427" }), []);
  assert.match(checkTrackerClaim({ writers: ["builder", "second-builder"], slice: "issue-427" })[0], /exactly one writer/);
});

// The live issue-close sweep, run against an in-memory tracker.
const sweepScript = extractScript(read(".github/workflows/issue-close-sweep.yml"));
async function liveSweep(pulls, states) {
  const updates = [];
  const github = {
    paginate: async (method, args) => (await method({ ...args, page: 1 })).data,
    rest: {
      repos: { get: async () => ({ data: { default_branch: "main" } }) },
      pulls: { list: async () => ({ data: pulls }) },
      issues: {
        get: async ({ issue_number: number }) => ({ data: { number, state: states.get(number) ?? "open" } }),
        update: async ({ issue_number: number, state, state_reason: reason }) => {
          updates.push([number, state, reason]);
          states.set(number, state);
        },
        createComment: async () => {},
      },
    },
  };
  const core = {
    info() {}, warning() {}, error() {}, setFailed(message) { throw new Error(message); },
    summary: { addHeading() { return core.summary; }, addRaw() { return core.summary; }, async write() {} },
  };
  await new AsyncFunction("context", "core", "github", sweepScript)(
    { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } }, core, github);
  return updates;
}

test("S9 · the issue-close sweep records MERGED only on remote merge truth, stricter than the pinned oracle", async () => {
  const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const merged = { number: 501, merged_at: recent, merge_commit_sha: "abc", state: "closed", body: "Closes #900", base: { ref: "main" } };
  const unmerged = { number: 502, merged_at: null, merge_commit_sha: "def", state: "closed", body: "Closes #901", base: { ref: "main" } };
  const updates = await liveSweep([merged, unmerged], new Map());
  assert.deepEqual(updates, [[900, "closed", "completed"]], "only the merged PR closes its Issue, as completed");
  assert.deepEqual(checkMergedReceipt({ pr_state: "merged", merge_commit: merged.merge_commit_sha }), []);
  assert.deepEqual(checkMergedReceipt({ pr_state: unmerged.state, merge_commit: unmerged.merge_commit_sha }), [],
    "the oracle would accept the unmerged PR (pinned defect above); the live sweep keys on merged_at");
});

test("S9 · the issue-close sweep replays as an idempotent no-op", async () => {
  const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const pulls = [{ number: 503, merged_at: recent, merge_commit_sha: "abc", body: "Fixes #902", base: { ref: "main" } }];
  const states = new Map();
  const first = await liveSweep(pulls, states);
  const second = await liveSweep(pulls, states);
  assert.equal(first.length, 1);
  assert.deepEqual(checkDuplicateNoop({ count_delta: first.length }, { count_delta: second.length, second_effect: second.length > 0 }), []);
  assert.equal(checkDuplicateNoop({}, { count_delta: 1, second_effect: true }).length, 2, "a re-close on replay would be caught");
});

test("S9 · Gate/evidence rows are grounded", () => {
  const rows = Object.keys(ADOPTION).filter((key) => key.startsWith("gate:") || key.startsWith("evidence:"));
  assert.deepEqual(rows.sort(), [
    "evidence:close-receipts", "gate:aggregator-contract", "gate:compliance-lane", "gate:merge-policy-delta",
  ], "S9 contributes exactly four Gate/evidence rows");
  assert.deepEqual(ADOPTION["gate:aggregator-contract"], { mechanism: ".github/workflows/pr-verify.yml", gap: null });
  assert.deepEqual(ADOPTION["evidence:close-receipts"], { mechanism: ".github/workflows/issue-close-sweep.yml", gap: null });
  for (const key of rows) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null, `${key} must be mechanism XOR gap`);
    if (entry.mechanism !== null) assert.ok(existsSync(path.join(root, entry.mechanism)), `${key}: ${entry.mechanism}`);
    else assert.ok(GAP_SLICES.includes(entry.gap));
  }
});
