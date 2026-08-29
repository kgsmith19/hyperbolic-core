import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(
  root,
  ".github/workflows/auto-merge-deploy-reconcile.yml",
);
const workflowExists = existsSync(workflowPath);
const workflow = workflowExists ? readFileSync(workflowPath, "utf8") : "";
const opsEdgePath = path.join(root, ".github/workflows/ops-edge.yml");
const opsEdge = readFileSync(opsEdgePath, "utf8");
const opsServeApply = readFileSync(
  path.join(root, ".github/workflows/ops-serve-apply.yml"),
  "utf8",
);
const platformSmoke = readFileSync(
  path.join(root, ".github/workflows/platform-smoke.yml"),
  "utf8",
);
const privateOriginVerifierPath = path.join(
  root,
  "docs/ops/verify-private-origin.sh",
);
const privateOriginVerifier = readFileSync(privateOriginVerifierPath, "utf8");

function yamlBlock(source, key, indent) {
  const lines = source.split(/\r?\n/);
  const prefix = `${" ".repeat(indent)}${key}:`;
  const start = lines.findIndex((line) => line.trimEnd() === prefix);
  assert.ok(start >= 0, `${prefix.trim()} block not found`);
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const line = lines[end];
    if (line.trim() === "") continue;
    const lineIndent = line.match(/^ */)[0].length;
    if (lineIndent <= indent) break;
  }
  return lines.slice(start, end).join("\n");
}

function extractGithubScript(yamlText) {
  const marker = "script: |";
  const markerIndex = yamlText.indexOf(marker);
  assert.ok(markerIndex >= 0, "reconciler workflow must contain `script: |`");
  const lines = yamlText.slice(markerIndex + marker.length + 1).split("\n");
  const firstCodeLine = lines.find((line) => line.trim().length > 0);
  assert.ok(firstCodeLine, "reconciler script block must not be empty");
  const commonIndent = firstCodeLine.match(/^ */)[0].length;
  const scriptLines = [];
  for (const line of lines) {
    if (line.trim().length > 0 && line.match(/^ */)[0].length < commonIndent) {
      break;
    }
    scriptLines.push(line.slice(commonIndent));
  }
  return scriptLines.join("\n");
}

function loadReconciler() {
  const script = extractGithubScript(workflow);
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-reconcile-script-"));
  const file = path.join(dir, "reconcile.cjs");
  writeFileSync(
    file,
    `module.exports = async function (context, github, core) {\n${script}\n};\n`,
  );
  return file;
}

const HEAD_SHA = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
const REPO = "kgsmith19/hyperbolic-core";

function baseWorkflowRun(overrides = {}) {
  return {
    id: 9001,
    name: "PR Verification",
    path: ".github/workflows/pr-verify.yml",
    workflow_id: 335930003,
    event: "pull_request",
    conclusion: "success",
    head_sha: HEAD_SHA,
    head_repository: { full_name: REPO, fork: false },
    ...overrides,
  };
}

function basePr(overrides = {}) {
  return {
    number: 42,
    state: "closed",
    merged: true,
    merged_by: { login: "github-actions[bot]", type: "Bot" },
    merge_commit_sha: MERGE_SHA,
    auto_merge: null,
    changed_files: 0,
    head: {
      sha: HEAD_SHA,
      ref: "issue/364-fixture",
      repo: { full_name: REPO, fork: false },
    },
    base: {
      ref: "main",
      repo: { full_name: REPO, fork: false },
    },
    ...overrides,
  };
}

function withChangedFileCount(pr, count) {
  if (Object.hasOwn(pr, "changed_files") && pr.changed_files !== 0) return pr;
  return { ...pr, changed_files: count };
}

function makeMocks({
  workflowRun = baseWorkflowRun(),
  associatedPr = basePr(),
  associatedPrs = null,
  livePrSequence = null,
  files = [],
  existingReceipt = false,
  compare = {
    status: "ahead",
    merge_base_commit: { sha: MERGE_SHA },
  },
  dispatchErrorFor = null,
} = {}) {
  const normalizedAssociated = withChangedFileCount(associatedPr, files.length);
  const normalizedAssociations = (associatedPrs ?? [normalizedAssociated]).map(
    (pr) => withChangedFileCount(pr, files.length),
  );
  const normalizedLiveSequence = (
    livePrSequence ?? [withChangedFileCount(basePr(), files.length)]
  ).map((pr) => withChangedFileCount(pr, files.length));

  const dispatches = [];
  const outputs = new Map();
  const warnings = [];
  const infos = [];
  let pullGetIndex = 0;

  const github = {
    paginate: async (fn) => {
      if (fn === github.rest.repos.listPullRequestsAssociatedWithCommit) {
        return normalizedAssociations;
      }
      if (fn === github.rest.pulls.listFiles) {
        return files.map((filename) => ({ filename }));
      }
      throw new Error("unexpected paginate target");
    },
    rest: {
      actions: {
        listArtifactsForRepo: async () => ({
          data: {
            artifacts: existingReceipt
              ? [
                  {
                    id: 77,
                    name: `auto-merge-deploy-${MERGE_SHA}`,
                    expired: false,
                  },
                ]
              : [],
          },
        }),
        createWorkflowDispatch: async ({ workflow_id, ref, inputs }) => {
          dispatches.push({ workflow_id, ref, inputs: inputs ?? {} });
          if (workflow_id === dispatchErrorFor) {
            throw new Error(`simulated dispatch failure: ${workflow_id}`);
          }
          return { status: 204 };
        },
      },
      pulls: {
        listFiles: async () => ({
          data: files.map((filename) => ({ filename })),
        }),
        get: async () => {
          const value =
            normalizedLiveSequence[
              Math.min(pullGetIndex, normalizedLiveSequence.length - 1)
            ];
          pullGetIndex += 1;
          return { data: value };
        },
      },
      repos: {
        listPullRequestsAssociatedWithCommit: async () => ({
          data: normalizedAssociations,
        }),
        compareCommitsWithBasehead: async () => ({ data: compare }),
      },
    },
  };

  const core = {
    info(message) {
      infos.push(String(message));
    },
    warning(message) {
      warnings.push(String(message));
    },
    setOutput(name, value) {
      outputs.set(name, String(value));
    },
    setFailed(message) {
      throw new Error(String(message));
    },
  };

  const context = {
    repo: { owner: "kgsmith19", repo: "hyperbolic-core" },
    payload: {
      repository: {
        full_name: REPO,
        default_branch: "main",
        owner: { login: "kgsmith19" },
      },
      workflow_run: workflowRun,
    },
  };

  return { context, github, core, dispatches, outputs, warnings, infos };
}

async function execute(options = {}) {
  const modulePath = loadReconciler();
  const reconcile = (await import(pathToFileURL(modulePath))).default;
  const mocks = makeMocks(options);
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => {
    fn();
    return 0;
  };
  try {
    await reconcile(mocks.context, mocks.github, mocks.core);
    return { ...mocks, error: null };
  } catch (error) {
    return { ...mocks, error };
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

test("the reconciler has a narrow trusted default-branch workflow_run boundary", () => {
  assert.equal(
    workflowExists,
    true,
    ".github/workflows/auto-merge-deploy-reconcile.yml must exist",
  );
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \["PR Verification"\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /EXPECTED_WORKFLOW_ID = 335930003/);
  assert.match(workflow, /listPullRequestsAssociatedWithCommit/);
  assert.doesNotMatch(workflow, /listWorkflowRunPullRequests/);
  assert.doesNotMatch(workflow, /uses: actions\/checkout/);
  assert.doesNotMatch(
    workflow,
    /DEV_GITHUB_APP|REVIEW_GITHUB_APP|GH_PAT|PERSONAL_ACCESS_TOKEN/,
  );
});

test("bot auto-merge dispatches exact existing workflows with exact unit inputs", async () => {
  if (!workflowExists) return;
  const files = [
    "apps/shell/frontend/src/App.tsx",
    "services/brain/src/server.ts",
    "apps/toolbelt/prompt-organizer/supabase/migrations/202608280001.sql",
    "apps/lifeos/backend/app/main.py",
    "apps/lifeos/frontend/src/App.tsx",
    "docs/ops/edge-origin/private_spa_locations.conf",
    "docs/ops/tailscale-serve-apply.sh",
  ];
  const live = basePr({ changed_files: files.length });
  const result = await execute({ files, livePrSequence: [live] });
  assert.equal(result.error, null);
  assert.deepEqual(result.dispatches, [
    {
      workflow_id: "deploy.yml",
      ref: "main",
      inputs: {
        deploy_shell: "true",
        deploy_llm_handler: "false",
        deploy_brain: "true",
        deploy_broker: "false",
        apply_migrations: "true",
      },
    },
    {
      workflow_id: "lifeos-deploy.yml",
      ref: "main",
      inputs: { deploy_backend: "true", deploy_ui: "true" },
    },
    {
      workflow_id: "ops-edge.yml",
      ref: "main",
      inputs: { apply_serve_after_origin: true },
    },
  ]);
  assert.equal(result.outputs.get("record_receipt"), "true");
  assert.equal(
    result.outputs.get("receipt_name"),
    `auto-merge-deploy-${MERGE_SHA}`,
  );
});

test("shared origin and Serve scripts dispatch one ordered composed workflow", async () => {
  if (!workflowExists) return;
  for (const filename of [
    "docs/ops/verify-private-origin.sh",
    "docs/ops/tailscale-serve-apply.sh",
  ]) {
    const result = await execute({
      files: [filename],
      livePrSequence: [basePr({ changed_files: 1 })],
    });
    assert.equal(result.error, null, `${filename}: ${result.error?.message}`);
    assert.deepEqual(result.dispatches, [
      {
        workflow_id: "ops-edge.yml",
        ref: "main",
        inputs: { apply_serve_after_origin: true },
      },
    ]);
  }
});

test("edge-only and Serve-only changes keep their exact direct workflow mappings", async () => {
  if (!workflowExists) return;
  const cases = [
    {
      filename: "docs/ops/edge-origin/nginx.conf",
      expected: [{ workflow_id: "ops-edge.yml", ref: "main", inputs: {} }],
    },
    {
      filename: ".github/workflows/ops-serve-apply.yml",
      expected: [
        { workflow_id: "ops-serve-apply.yml", ref: "main", inputs: {} },
      ],
    },
  ];
  for (const { filename, expected } of cases) {
    const result = await execute({
      files: [filename],
      livePrSequence: [basePr({ changed_files: 1 })],
    });
    assert.equal(result.error, null, `${filename}: ${result.error?.message}`);
    assert.deepEqual(result.dispatches, expected, filename);
  }
});

test("only Ops Origin dispatch exposes the default-false composition flag to operators", () => {
  const edgePush = yamlBlock(opsEdge, "push", 2);
  const edgeDispatch = yamlBlock(opsEdge, "workflow_dispatch", 2);
  assert.doesNotMatch(edgePush, /apply_serve_after_origin/);
  assert.match(
    edgeDispatch,
    /apply_serve_after_origin:\n\s+description: [^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/,
  );

  const serveCall = yamlBlock(opsServeApply, "workflow_call", 2);
  const serveDispatch = yamlBlock(opsServeApply, "workflow_dispatch", 2);
  assert.match(
    serveCall,
    /origin_parent_run_id:\n\s+description: [^\n]+\n\s+required: true\n\s+type: string/,
  );
  assert.doesNotMatch(serveDispatch, /inputs:|origin_parent_run_id/);
});

test("Ops Origin orders legacy Serve convergence after deploy while gateway state keeps the existing smoke path", () => {
  const applyServe = yamlBlock(opsEdge, "apply-serve", 2);
  assert.match(applyServe, /needs: deploy/);
  assert.match(
    applyServe,
    /if:\s*needs\.deploy\.result == 'success' && needs\.deploy\.outputs\.serve_state == 'legacy' && \(github\.event_name == 'push' \|\| inputs\.apply_serve_after_origin == true\)/,
  );
  assert.match(
    applyServe,
    /uses: \.\/\.github\/workflows\/ops-serve-apply\.yml/,
  );
  assert.match(applyServe, /origin_parent_run_id: \$\{\{ github\.run_id \}\}/);

  const gatewaySmoke = yamlBlock(opsEdge, "smoke", 2);
  assert.match(gatewaySmoke, /needs: deploy/);
  assert.match(
    gatewaySmoke,
    /if: needs\.deploy\.result == 'success' && needs\.deploy\.outputs\.serve_state == 'gateway'/,
  );
  assert.match(
    gatewaySmoke,
    /uses: \.\/\.github\/workflows\/platform-smoke\.yml/,
  );
  assert.doesNotMatch(gatewaySmoke, /ops-serve-apply|apply_serve_after_origin/);
});

test("the composed call preserves the Serve environment and least-privilege OIDC boundary", () => {
  const servePermissions = yamlBlock(opsServeApply, "permissions", 0);
  const serveApply = yamlBlock(opsServeApply, "apply", 2);
  assert.equal(servePermissions.trimEnd(), "permissions:\n  contents: read");
  assert.match(serveApply, /environment: ops-serve-apply-production/);
  assert.match(
    serveApply,
    /permissions:\n\s+contents: read\n\s+id-token: write/,
  );

  const applyServe = yamlBlock(opsEdge, "apply-serve", 2);
  assert.match(
    applyServe,
    /permissions:\n\s+contents: read\n\s+id-token: write/,
  );
});

test("commit association selects the exact same-repository default-branch PR", async () => {
  if (!workflowExists) return;
  const unrelated = basePr({
    number: 99,
    head: {
      sha: "c".repeat(40),
      ref: "issue/unrelated",
      repo: { full_name: REPO, fork: false },
    },
  });
  const result = await execute({
    associatedPrs: [unrelated, basePr()],
    files: ["docs/ops/edge-origin/nginx.conf"],
    livePrSequence: [basePr({ changed_files: 1 })],
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.dispatches, [
    { workflow_id: "ops-edge.yml", ref: "main", inputs: {} },
  ]);
});

test("ambiguous exact commit associations fail before deployment dispatch", async () => {
  if (!workflowExists) return;
  const result = await execute({
    associatedPrs: [basePr(), basePr({ number: 77 })],
  });
  assert.match(result.error?.message ?? "", /exactly one.*associated/i);
  assert.deepEqual(result.dispatches, []);
});

test("an owner/manual merge stays on existing push deploys", async () => {
  if (!workflowExists) return;
  const ownerPr = basePr({ merged_by: { login: "kgsmith19", type: "User" } });
  const result = await execute({
    associatedPr: ownerPr,
    livePrSequence: [ownerPr],
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.dispatches, []);
  assert.equal(result.outputs.get("record_receipt"), "false");
});

test("fork provenance fails before any deployment dispatch", async () => {
  if (!workflowExists) return;
  const forkPr = basePr({
    head: {
      sha: HEAD_SHA,
      ref: "fork",
      repo: { full_name: "other/fork", fork: true },
    },
  });
  const result = await execute({
    associatedPr: forkPr,
    livePrSequence: [forkPr],
  });
  assert.match(result.error?.message ?? "", /same-repository|associated/i);
  assert.deepEqual(result.dispatches, []);
});

test("a stale reviewed head fails before any deployment dispatch", async () => {
  if (!workflowExists) return;
  const stalePr = basePr({
    head: {
      sha: "c".repeat(40),
      ref: "issue/stale",
      repo: { full_name: REPO, fork: false },
    },
  });
  const result = await execute({ associatedPr: stalePr });
  assert.match(result.error?.message ?? "", /exactly one.*associated|head/i);
  assert.deepEqual(result.dispatches, []);
});

test("a different workflow ID fails before deployment dispatch", async () => {
  if (!workflowExists) return;
  const result = await execute({
    workflowRun: baseWorkflowRun({ workflow_id: 999999999 }),
  });
  assert.match(
    result.error?.message ?? "",
    /workflow must be ID|source workflow/i,
  );
  assert.deepEqual(result.dispatches, []);
});

test("a wrong source workflow name/path fails before deployment dispatch", async () => {
  if (!workflowExists) return;
  const result = await execute({
    workflowRun: baseWorkflowRun({
      name: "Platform Smoke",
      path: ".github/workflows/platform-smoke.yml",
    }),
  });
  assert.match(result.error?.message ?? "", /PR Verification|source workflow/i);
  assert.deepEqual(result.dispatches, []);
});

test("a failed PR Verification run is a visible no-op", async () => {
  if (!workflowExists) return;
  const result = await execute({
    workflowRun: baseWorkflowRun({ conclusion: "failure" }),
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.dispatches, []);
  assert.equal(result.outputs.get("record_receipt"), "false");
});

test("a closed-unmerged PR fails visibly and dispatches nothing", async () => {
  if (!workflowExists) return;
  const unmerged = basePr({
    state: "closed",
    merged: false,
    merged_by: null,
    merge_commit_sha: null,
  });
  const result = await execute({
    associatedPr: unmerged,
    livePrSequence: [unmerged],
  });
  assert.match(result.error?.message ?? "", /closed but unmerged/i);
  assert.deepEqual(result.dispatches, []);
});

test("an open PR without auto-merge armed is left untouched", async () => {
  if (!workflowExists) return;
  const open = basePr({
    state: "open",
    merged: false,
    merged_by: null,
    merge_commit_sha: null,
    auto_merge: null,
  });
  const result = await execute({ associatedPr: open, livePrSequence: [open] });
  assert.equal(result.error, null);
  assert.deepEqual(result.dispatches, []);
  assert.equal(result.outputs.get("record_receipt"), "false");
});

test("the reconciler tolerates transient open state before auto-merge propagation", async () => {
  if (!workflowExists) return;
  const transient = basePr({
    state: "open",
    merged: false,
    merged_by: null,
    merge_commit_sha: null,
    auto_merge: null,
    changed_files: 1,
  });
  const merged = basePr({ changed_files: 1 });
  const result = await execute({
    associatedPr: transient,
    livePrSequence: [transient, merged],
    files: ["docs/ops/edge-origin/nginx.conf"],
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.dispatches, [
    { workflow_id: "ops-edge.yml", ref: "main", inputs: {} },
  ]);
});

test("the separate reconciler can observe an armed auto-merge after PR Gate exits", async () => {
  if (!workflowExists) return;
  const armed = basePr({
    state: "open",
    merged: false,
    merged_by: null,
    merge_commit_sha: null,
    auto_merge: { enabled_by: { login: "github-actions[bot]" } },
    changed_files: 1,
  });
  const merged = basePr({ changed_files: 1 });
  const result = await execute({
    associatedPr: armed,
    livePrSequence: [armed, merged],
    files: ["docs/ops/edge-origin/nginx.conf"],
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.dispatches, [
    { workflow_id: "ops-edge.yml", ref: "main", inputs: {} },
  ]);
});

test("a merge SHA outside the live default-branch ancestry fails closed", async () => {
  if (!workflowExists) return;
  const result = await execute({
    compare: {
      status: "diverged",
      merge_base_commit: { sha: "d".repeat(40) },
    },
    files: ["docs/ops/edge-origin/nginx.conf"],
    livePrSequence: [basePr({ changed_files: 1 })],
  });
  assert.match(result.error?.message ?? "", /ancestor.*default branch/i);
  assert.deepEqual(result.dispatches, []);
});

test("an existing per-merge receipt suppresses duplicate dispatch", async () => {
  if (!workflowExists) return;
  const result = await execute({
    existingReceipt: true,
    files: ["docs/ops/edge-origin/nginx.conf"],
    livePrSequence: [basePr({ changed_files: 1 })],
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.dispatches, []);
  assert.equal(result.outputs.get("record_receipt"), "false");
});

test("an incomplete changed-file listing fails before classification", async () => {
  if (!workflowExists) return;
  const result = await execute({
    files: ["docs/ops/edge-origin/nginx.conf"],
    livePrSequence: [basePr({ changed_files: 2 })],
  });
  assert.match(
    result.error?.message ?? "",
    /changed-file retrieval was incomplete/i,
  );
  assert.deepEqual(result.dispatches, []);
});

test("a production path without an explicit deployment owner fails visibly", async () => {
  if (!workflowExists) return;
  const result = await execute({
    files: [".github/workflows/platform-migrations.yml"],
    livePrSequence: [basePr({ changed_files: 1 })],
  });
  assert.match(result.error?.message ?? "", /unmapped production path/i);
  assert.deepEqual(result.dispatches, []);
});

test("a dispatch API failure fails reconciliation and emits no success receipt", async () => {
  if (!workflowExists) return;
  const result = await execute({
    files: ["docs/ops/edge-origin/nginx.conf"],
    livePrSequence: [basePr({ changed_files: 1 })],
    dispatchErrorFor: "ops-edge.yml",
  });
  assert.match(
    result.error?.message ?? "",
    /dispatch of ops-edge\.yml failed/i,
  );
  assert.equal(result.outputs.get("record_receipt"), undefined);
});

test("a non-production auto-merge records a durable no-op receipt", async () => {
  if (!workflowExists) return;
  const result = await execute({
    files: ["README.md"],
    livePrSequence: [basePr({ changed_files: 1 })],
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.dispatches, []);
  assert.equal(result.outputs.get("record_receipt"), "true");
  const receipt = JSON.parse(result.outputs.get("receipt"));
  assert.deepEqual(receipt.dispatched, []);
  assert.deepEqual(receipt.changedFiles, ["README.md"]);
});

function writeExecutable(file, content) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function runPrivateOriginVerifier({
  loginStatus = "200",
  shellDocument = '<!doctype html><script type="module" src="/assets/shell-fixture.js"></script>',
  apiContentType = "application/json",
  apiStatus = "ok",
  missingAssetStatus = "404",
  apiBoundaryContentType = "application/json",
} = {}) {
  const dir = mkdtempSync(
    path.join(tmpdir(), "private-origin-verifier-integration-"),
  );
  const bin = path.join(dir, "bin");
  const verifierTemp = path.join(dir, "verifier-temp");
  mkdirSync(bin, { recursive: true });
  mkdirSync(verifierTemp, { recursive: true });
  writeExecutable(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
out=""; url=""
while (($#)); do
  case "$1" in
    --output|-o) out="$2"; shift 2 ;;
    --write-out|-w) shift 2 ;;
    --silent|-s|--show-error|-S) shift ;;
    --max-time) shift 2 ;;
    -fsS|-sfS|-sS) shift ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
pathpart="$(printf '%s' "$url" | sed -E 's#^[a-z]+://[^/]+##')"
status=200
content_type="text/html"
body="$SHELL_DOCUMENT"
case "$pathpart" in
  /login) status="$LOGIN_STATUS" ;;
  /settings) ;;
  /life/capture)
    body='<!doctype html><script type="module" src="/life/assets/life-fixture.js"></script>' ;;
  /assets/__ops_origin_missing__.js|/life/assets/__ops_origin_missing__.js)
    status="$MISSING_ASSET_STATUS"; content_type="text/plain"; body="missing asset" ;;
  /api/__ops_origin_boundary__.js|/api/brain/__ops_origin_boundary__.js|/life/api/__ops_origin_boundary__.js)
    status=404; content_type="$API_BOUNDARY_CONTENT_TYPE"; body='{"detail":"not found"}' ;;
  /%2Fapi/%2e%2e/settings|//api/../settings|/./assets/../settings|/%2Flife/api/%2e%2e/capture|//life/api/../capture|/./life/assets/../capture|/%2F%61pi/%2e%2e/settings|//assets/../settings|/./%2E/%61ssets/%2e%2E/settings|/%2Flife/%61pi/%2e%2e/capture|//%6Cife/assets/../capture|/./life/%2E/%61pi/%2e%2e/capture|/%2E/%6cife/%2F%61ssets/%2e%2E/capture|/foo/../api/../settings|/%66oo/%2e%2e/%61pi/%2e%2e/settings|//foo/../api/../settings|/%2Ffoo/%2e%2e/api/%2e%2e/settings|/life/foo/../assets/../capture|/life/%66oo/%2e%2e/%61ssets/%2e%2e/capture|/alpha/beta/../../api/v1/../../settings|/life/one/two/../../assets/v1/../../capture|/api/%2e%2e%2Fsettings|/api/%2F%2e%2e%2Fsettings|/assets/%2e%2e%2Fsettings|/assets//%2e%2e/settings|/life/api/%2e%2e%2Fcapture|/life/api//%2e%2e/capture|/life/assets/%2e%2e%2Fcapture|/life/assets/%2F%2E%2e%2fcapture|/%41pi/%2e%2e/settings|/%41%50%49/%2e%2e/settings|/%61%50i/%2e%2e/settings|/%41ssets/../settings|/%41%53%53%45%54%53/%2e%2e/settings|/%61%53s%65%54%73/%2e%2e/settings|/life/%41ssets/../capture|/life/%41%73%53e%54%73/%2e%2e/capture)
    status=404; content_type="text/plain"; body="reserved namespace traversal rejected" ;;
  /api/healthz|/api/brain/health|/life/api/healthz)
    content_type="$API_CONTENT_TYPE"; body="{\\"status\\":\\"$API_STATUS\\"}" ;;
  *) ;;
esac
printf '%s' "$body" > "$out"
printf '%s\n%s' "$status" "$content_type"
`,
  );
  return spawnSync(process.env.BASH_PATH ?? "bash", [privateOriginVerifierPath], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      TMPDIR: verifierTemp,
      LOGIN_STATUS: loginStatus,
      SHELL_DOCUMENT: shellDocument,
      API_CONTENT_TYPE: apiContentType,
      API_STATUS: apiStatus,
      MISSING_ASSET_STATUS: missingAssetStatus,
      API_BOUNDARY_CONTENT_TYPE: apiBoundaryContentType,
    },
  });
}

function assertOriginVerificationTransaction(source) {
  const rollbackArmed = source.indexOf("trap restore_previous EXIT");
  const verifier = source.indexOf(
    '"$stage_dir/verify-private-origin.sh" http://127.0.0.1:8080',
  );
  const classifier = source.indexOf(
    '"$stage_dir/tailscale-serve-apply.sh" --classify-status',
    verifier,
  );
  const rollbackDisarmed = source.indexOf("activation_started=false", verifier);
  assert.ok(rollbackArmed > -1 && verifier > rollbackArmed);
  assert.ok(
    classifier > verifier,
    "Serve classification must follow content proof",
  );
  assert.ok(
    rollbackDisarmed > classifier,
    "origin rollback must remain armed through verification and classification",
  );
}

test("Ops Origin stages shared verification before migration-aware Serve classification", () => {
  assert.match(
    opsEdge,
    /scp [^\n]*docs\/ops\/verify-private-origin\.sh [^\n]*docs\/ops\/tailscale-serve-apply\.sh/,
  );
  assertOriginVerificationTransaction(opsEdge);
  assert.doesNotMatch(
    opsEdge,
    /probe_document|__ops_origin_(?:missing|boundary)__/,
  );
  for (const mutant of [
    opsEdge.replace(
      '"$stage_dir/verify-private-origin.sh" http://127.0.0.1:8080',
      ":",
    ),
    opsEdge.replace(
      '"$stage_dir/tailscale-serve-apply.sh" --classify-status',
      'activation_started=false\n          "$stage_dir/tailscale-serve-apply.sh" --classify-status',
    ),
  ]) {
    assert.throws(() => assertOriginVerificationTransaction(mutant));
  }
});

test("legacy migration composes Serve Apply while steady-state gateway keeps Origin smoke", () => {
  assert.match(
    opsEdge,
    /outputs:\s+serve_state: \$\{\{ steps\.activate\.outputs\.serve_state \}\}/,
  );
  assert.match(opsEdge, /case "\$serve_state" in\s+gateway\|legacy\)/);
  assert.match(
    opsEdge,
    /if: needs\.deploy\.result == 'success' && needs\.deploy\.outputs\.serve_state == 'gateway'\s+uses: \.\/\.github\/workflows\/platform-smoke\.yml/,
  );
  assert.match(
    opsServeApply,
    /if: needs\.apply\.result == 'success'\s+uses: \.\/\.github\/workflows\/platform-smoke\.yml/,
  );
  assert.match(opsEdge, /group: ops-origin-serve-production/);
  assert.match(
    opsServeApply,
    /group: \$\{\{ inputs\.origin_parent_run_id != '' && format\('ops-origin-serve-child-\{0\}', inputs\.origin_parent_run_id\) \|\| 'ops-origin-serve-production' \}\}/,
  );
  for (const source of [opsEdge, opsServeApply]) {
    assert.match(source, /cancel-in-progress: false/);
    assert.match(source, /queue: max/);
  }
});

test("shared verifiers cover documents and exact API health, with private negative controls", () => {
  for (const invocation of [
    'verify_document "Shell login" "/login" "Shell" "$shell_marker"',
    'verify_document "Shell settings" "/settings" "Shell" "$shell_marker"',
    'verify_document "Shell uppercase-byte query route" "/settings?return=/%41pi/../x" "Shell" "$shell_marker"',
    'verify_document "LifeOS capture" "/life/capture" "LifeOS" "$life_marker"',
    'verify_not_found "Missing Shell asset" "/assets/__ops_origin_missing__.js" "false"',
    'verify_not_found "Missing LifeOS asset" "/life/assets/__ops_origin_missing__.js" "false"',
    'verify_not_found "Handler API boundary" "/api/__ops_origin_boundary__.js" "true"',
    'verify_not_found "Brain API boundary" "/api/brain/__ops_origin_boundary__.js" "true"',
    'verify_not_found "LifeOS API boundary" "/life/api/__ops_origin_boundary__.js" "true"',
    'verify_not_found "Root API encoded-separator exact traversal" "/%2Fapi/%2e%2e/settings" "true"',
    'verify_not_found "Root API duplicate-separator traversal" "//api/../settings" "true"',
    'verify_not_found "Root asset dot-prefix traversal" "/./assets/../settings" "true"',
    'verify_not_found "LifeOS API encoded-separator exact traversal" "/%2Flife/api/%2e%2e/capture" "true"',
    'verify_not_found "LifeOS API duplicate-separator traversal" "//life/api/../capture" "true"',
    'verify_not_found "LifeOS asset dot-prefix traversal" "/./life/assets/../capture" "true"',
    'verify_not_found "Root API encoded-separator prefix traversal" "/%2F%61pi/%2e%2e/settings" "true"',
    'verify_not_found "Root asset literal-separator prefix traversal" "//assets/../settings" "true"',
    'verify_not_found "Root asset dot-component prefix traversal" "/./%2E/%61ssets/%2e%2E/settings" "true"',
    'verify_not_found "LifeOS API encoded-separator prefix traversal" "/%2Flife/%61pi/%2e%2e/capture" "true"',
    'verify_not_found "LifeOS asset literal-separator prefix traversal" "//%6Cife/assets/../capture" "true"',
    'verify_not_found "LifeOS API dot-component prefix traversal" "/./life/%2E/%61pi/%2e%2e/capture" "true"',
    'verify_not_found "LifeOS asset mixed normalization prefix traversal" "/%2E/%6cife/%2F%61ssets/%2e%2E/capture" "true"',
    'verify_not_found "Root API cancelled-prefix traversal" "/foo/../api/../settings" "true"',
    'verify_not_found "Root API encoded cancelled-prefix traversal" "/%66oo/%2e%2e/%61pi/%2e%2e/settings" "true"',
    'verify_not_found "Root API duplicate-separator cancelled-prefix traversal" "//foo/../api/../settings" "true"',
    'verify_not_found "Root API encoded-separator cancelled-prefix traversal" "/%2Ffoo/%2e%2e/api/%2e%2e/settings" "true"',
    'verify_not_found "LifeOS asset cancelled-prefix traversal" "/life/foo/../assets/../capture" "true"',
    'verify_not_found "LifeOS asset encoded cancelled-prefix traversal" "/life/%66oo/%2e%2e/%61ssets/%2e%2e/capture" "true"',
    'verify_not_found "Root API nested cancelled-prefix traversal" "/alpha/beta/../../api/v1/../../settings" "true"',
    'verify_not_found "LifeOS asset nested cancelled-prefix traversal" "/life/one/two/../../assets/v1/../../capture" "true"',
    'verify_not_found "Root API traversal" "/api/%2e%2e%2Fsettings" "true"',
    'verify_not_found "Root API adjacent-separator traversal" "/api/%2F%2e%2e%2Fsettings" "true"',
    'verify_not_found "Root asset traversal" "/assets/%2e%2e%2Fsettings" "true"',
    'verify_not_found "Root asset adjacent-separator traversal" "/assets//%2e%2e/settings" "true"',
    'verify_not_found "LifeOS API traversal" "/life/api/%2e%2e%2Fcapture" "true"',
    'verify_not_found "LifeOS API adjacent-separator traversal" "/life/api//%2e%2e/capture" "true"',
    'verify_not_found "LifeOS asset traversal" "/life/assets/%2e%2e%2Fcapture" "true"',
    'verify_not_found "LifeOS asset adjacent-separator traversal" "/life/assets/%2F%2E%2e%2fcapture" "true"',
    'verify_not_found "Root API uppercase-A encoded traversal" "/%41pi/%2e%2e/settings" "true"',
    'verify_not_found "Root API fully uppercase-byte traversal" "/%41%50%49/%2e%2e/settings" "true"',
    'verify_not_found "Root API mixed encoded-byte traversal" "/%61%50i/%2e%2e/settings" "true"',
    'verify_not_found "Root asset uppercase-A encoded traversal" "/%41ssets/../settings" "true"',
    'verify_not_found "Root asset fully uppercase-byte traversal" "/%41%53%53%45%54%53/%2e%2e/settings" "true"',
    'verify_not_found "Root asset mixed encoded-byte traversal" "/%61%53s%65%54%73/%2e%2e/settings" "true"',
    'verify_not_found "LifeOS asset uppercase-A encoded traversal" "/life/%41ssets/../capture" "true"',
    'verify_not_found "LifeOS asset mixed encoded-byte traversal" "/life/%41%73%53e%54%73/%2e%2e/capture" "true"',
    'verify_json_status "Handler API health" "/api/healthz"',
    'verify_json_status "Brain API health" "/api/brain/health"',
    'verify_json_status "LifeOS API health" "/life/api/healthz"',
  ]) {
    assert.ok(
      privateOriginVerifier.includes(invocation),
      `missing private probe: ${invocation}`,
    );
  }
  assert.match(privateOriginVerifier, /shell_marker='src="\/assets\//);
  assert.match(privateOriginVerifier, /life_marker='src="\/life\/assets\//);
  assert.match(privateOriginVerifier, /body\.get\("status"\) != "ok"/);

  for (const invocation of [
    `probe "Shell login deep link" "/login" 'src="/assets/[A-Za-z0-9_.-]+\\.js"'`,
    `probe "Shell settings deep link" "/settings" 'src="/assets/[A-Za-z0-9_.-]+\\.js"'`,
    `probe "LifeOS capture deep link" "/life/capture" '/life/assets/[A-Za-z0-9_.-]+\\.js'`,
    'probe_json_health "Handler A" "/api/healthz"',
    'probe_json_health "Brain" "/api/brain/health"',
    'probe_json_health "LifeOS API" "/life/api/healthz"',
  ]) {
    assert.ok(
      platformSmoke.includes(invocation),
      `missing tailnet probe: ${invocation}`,
    );
  }
});

test("the shared private-origin verifier succeeds on the composed content contract", () => {
  const result = runPrivateOriginVerifier();
  assert.equal(
    result.status,
    0,
    `stdout=${result.stdout}\nstderr=${result.stderr}`,
  );
});

test("the shared verifier fails when health is green but /login is 404", () => {
  const result = runPrivateOriginVerifier({ loginStatus: "404" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Shell login must return HTTP 200/i);
});

test("the shared verifier fails when a Shell document has no Shell asset marker", () => {
  const result = runPrivateOriginVerifier({
    shellDocument:
      '<!doctype html><script src="/life/assets/wrong.js"></script>',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Shell login did not return the Shell bundle/i);
});

test("the shared verifier fails when an API returns HTML or a non-ok status", () => {
  const htmlResult = runPrivateOriginVerifier({ apiContentType: "text/html" });
  assert.notEqual(htmlResult.status, 0);
  assert.match(htmlResult.stderr, /must return application\/json/i);

  const degradedResult = runPrivateOriginVerifier({ apiStatus: "degraded" });
  assert.notEqual(degradedResult.status, 0);
  assert.match(degradedResult.stderr, /status=ok/i);
});

test("the shared verifier rejects an SPA fallback for a missing asset", () => {
  const result = runPrivateOriginVerifier({ missingAssetStatus: "200" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing Shell asset must return HTTP 404/i);
});

test("the shared verifier rejects HTML from an API boundary probe", () => {
  const result = runPrivateOriginVerifier({
    apiBoundaryContentType: "text/html",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Handler API boundary must not return text\/html/i,
  );
});
