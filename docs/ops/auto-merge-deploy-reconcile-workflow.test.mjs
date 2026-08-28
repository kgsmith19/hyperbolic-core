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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(
  root,
  ".github/workflows/auto-merge-deploy-reconcile.yml",
);
const workflowExists = existsSync(workflowPath);
const workflow = workflowExists ? readFileSync(workflowPath, "utf8") : "";
const opsEdgePath = path.join(root, ".github/workflows/ops-edge.yml");
const opsEdge = readFileSync(opsEdgePath, "utf8");

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
  const normalizedAssociations = (associatedPrs ?? [normalizedAssociated]).map((pr) =>
    withChangedFileCount(pr, files.length),
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
    { workflow_id: "ops-edge.yml", ref: "main", inputs: {} },
    { workflow_id: "ops-serve-apply.yml", ref: "main", inputs: {} },
  ]);
  assert.equal(result.outputs.get("record_receipt"), "true");
  assert.equal(
    result.outputs.get("receipt_name"),
    `auto-merge-deploy-${MERGE_SHA}`,
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
  assert.match(result.error?.message ?? "", /workflow must be ID|source workflow/i);
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
  assert.match(result.error?.message ?? "", /changed-file retrieval was incomplete/i);
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
  assert.match(result.error?.message ?? "", /dispatch of ops-edge\.yml failed/i);
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

function extractRunBlock(yamlText, stepName) {
  const stepMarker = `- name: ${stepName}`;
  const stepIndex = yamlText.indexOf(stepMarker);
  assert.ok(stepIndex >= 0, `missing workflow step: ${stepName}`);
  const runMarker = "        run: |\n";
  const runIndex = yamlText.indexOf(runMarker, stepIndex);
  assert.ok(runIndex >= 0, `missing run block for: ${stepName}`);
  const lines = yamlText.slice(runIndex + runMarker.length).split("\n");
  const first = lines.find((line) => line.trim().length > 0);
  assert.ok(first, `empty run block for: ${stepName}`);
  const indent = first.match(/^ */)[0].length;
  const body = [];
  for (const line of lines) {
    if (line.trim().length > 0 && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

function writeExecutable(file, content) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function runOpsOriginDeploy({
  loginStatus = "200",
  missingAssetStatus = "404",
  apiContentType = "application/json",
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ops-origin-deploy-"));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner-temp");
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });

  writeExecutable(
    path.join(bin, "ssh"),
    `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$*" == *"bash -s"* ]]; then cat >/dev/null; fi\nexit 0\n`,
  );
  writeExecutable(path.join(bin, "scp"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
out=""; headers=""; writeout=""; fail=false; url=""
while (($#)); do
  case "$1" in
    --output|-o) out="$2"; shift 2 ;;
    --dump-header|-D) headers="$2"; shift 2 ;;
    --write-out|-w) writeout="$2"; shift 2 ;;
    --fail|-f) fail=true; shift ;;
    --silent|-s|--show-error|-S) shift ;;
    --max-time) shift 2 ;;
    -fsS|-sfS|-sS) [[ "$1" == *f* ]] && fail=true; shift ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
pathpart="$(printf '%s' "$url" | sed -E 's#^[a-z]+://[^/]+##')"
status=200
content_type="text/html"
body='<!doctype html><script type="module" src="/assets/shell-fixture.js"></script>'
case "$pathpart" in
  /login) status="$LOGIN_STATUS" ;;
  /settings) ;;
  /life/capture)
    body='<!doctype html><script type="module" src="/life/assets/life-fixture.js"></script>' ;;
  /assets/__ops_origin_missing__.js|/life/assets/__ops_origin_missing__.js)
    status="$MISSING_ASSET_STATUS"; content_type="text/plain"; body="missing asset" ;;
  /api/__ops_origin_boundary__.js|/api/brain/__ops_origin_boundary__.js|/life/api/__ops_origin_boundary__.js)
    status=404; content_type="$API_CONTENT_TYPE"; body='{"detail":"not found"}' ;;
  *) ;;
esac
if [[ -n "$out" ]]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
if [[ -n "$headers" ]]; then printf 'HTTP/1.1 %s Test\r\nContent-Type: %s\r\n\r\n' "$status" "$content_type" > "$headers"; fi
if [[ -n "$writeout" ]]; then printf '%s' "$status"; fi
if [[ "$fail" == true && "$status" -ge 400 ]]; then exit 22; fi
`,
  );

  const script = extractRunBlock(
    opsEdge,
    "Deploy · Start nginx, then optionally cloudflared",
  );
  const scriptPath = path.join(dir, "deploy.sh");
  writeFileSync(scriptPath, script);
  return spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      DEPLOY_HOST: "lifeos-prod.example.test",
      CLOUDFLARE_EDGE_ENABLED: "false",
      LOGIN_STATUS: loginStatus,
      MISSING_ASSET_STATUS: missingAssetStatus,
      API_CONTENT_TYPE: apiContentType,
    },
  });
}

test("Ops Origin owns deep-link and honest asset/API post-deploy probes", () => {
  assert.match(opsEdge, /probe_document "Shell login" "\/login"/);
  assert.match(opsEdge, /probe_document "Shell settings" "\/settings"/);
  assert.match(opsEdge, /probe_document "LifeOS capture" "\/life\/capture"/);
  assert.match(opsEdge, /\/assets\/__ops_origin_missing__\.js/);
  assert.match(opsEdge, /\/life\/assets\/__ops_origin_missing__\.js/);
  assert.match(opsEdge, /\/api\/__ops_origin_boundary__\.js/);
  assert.match(opsEdge, /\/api\/brain\/__ops_origin_boundary__\.js/);
  assert.match(opsEdge, /\/life\/api\/__ops_origin_boundary__\.js/);
});

test("Ops Origin's complete post-deploy probe script succeeds on the intended contract", () => {
  const result = runOpsOriginDeploy();
  assert.equal(
    result.status,
    0,
    `stdout=${result.stdout}\nstderr=${result.stderr}`,
  );
});

test("Ops Origin fails when health is green but /login is 404", () => {
  const result = runOpsOriginDeploy({ loginStatus: "404" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Shell login.*did not return a successful document/i);
});

test("Ops Origin fails when a missing asset is swallowed by an SPA fallback", () => {
  const result = runOpsOriginDeploy({ missingAssetStatus: "200" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing Shell asset.*instead of an honest 404/i);
});

test("Ops Origin fails when an API prefix returns HTML for a 404", () => {
  const result = runOpsOriginDeploy({ apiContentType: "text/html" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /returned an SPA HTML document from an API prefix/i);
});
