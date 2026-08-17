import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");

test("deploy discovery covers every manifest-owned migration directory", () => {
  assert.match(workflow, /apps\/toolbelt\/\*\*\/supabase\/migrations\/\*\*/);
  assert.match(workflow, /\^apps\/toolbelt\/\(\.\*\/\)\?supabase\/migrations\//);
});

test("all six Shell, Handler A, and Brain deploy jobs retain the explicit production gate", () => {
  const occurrences = workflow.match(/vars\.DEPLOY_ENABLED == 'true'/g) ?? [];
  assert.equal(occurrences.length, 6);
});

test("production migrations cannot be dispatched from a feature ref", () => {
  const migrationJob = workflow.slice(
    workflow.indexOf("  migrate-platform:"),
    workflow.indexOf("  build-shell:"),
  );
  assert.match(migrationJob, /github\.ref == 'refs\/heads\/main'/);
  assert.match(migrationJob, /secrets: inherit/);
});

test("manual deploy requires an explicit migration choice instead of coupling deploy to a DB write", () => {
  assert.match(workflow, /apply_migrations:[\s\S]+type: boolean[\s\S]+default: false/);
  assert.match(workflow, /deploy_shell:[\s\S]+type: boolean[\s\S]+default: true/);
  assert.match(workflow, /deploy_brain:[\s\S]+type: boolean[\s\S]+default: true/);
  assert.match(workflow, /migrations=\$\{\{ inputs\.apply_migrations \}\}/);
  assert.doesNotMatch(workflow, /workflow_dispatch[\s\S]{0,500}migrations=true/);
});

test("Shell, Handler A, and Brain deploy each read only their own dedicated Infisical path", () => {
  const paths = [...workflow.matchAll(/secret-path: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(new Set(paths), new Set(["/platform/shell-deploy/", "/platform/llm-handler/", "/brain/"]));
});

test("Handler A's and the Brain's deploy jobs each use their own SSH key variable, never another unit's", () => {
  assert.match(workflow, /INFISICAL_LLM_HANDLER_DEPLOY_IDENTITY_ID/);
  assert.match(workflow, /INFISICAL_BRAIN_DEPLOY_IDENTITY_ID/);
  const deployShell = workflow.slice(workflow.indexOf("  deploy-shell:"), workflow.indexOf("  build-llm-handler:"));
  const deployLlmHandler = workflow.slice(workflow.indexOf("  deploy-llm-handler:"), workflow.indexOf("  build-brain:"));
  const deployBrain = workflow.slice(workflow.indexOf("  deploy-brain:"));
  const sshKeyVars = ["SHELL_DEPLOY_SSH_KEY", "LLM_HANDLER_SSH_KEY", "BRAIN_DEPLOY_SSH_KEY"];
  const jobs = { deployShell, deployLlmHandler, deployBrain };
  const owners = { SHELL_DEPLOY_SSH_KEY: "deployShell", LLM_HANDLER_SSH_KEY: "deployLlmHandler", BRAIN_DEPLOY_SSH_KEY: "deployBrain" };
  for (const [jobName, body] of Object.entries(jobs)) {
    for (const sshKeyVar of sshKeyVars) {
      if (owners[sshKeyVar] === jobName) {
        assert.match(body, new RegExp(sshKeyVar), `${jobName} must reference its own ${sshKeyVar}`);
      } else {
        assert.doesNotMatch(body, new RegExp(sshKeyVar), `${jobName} must never reference ${sshKeyVar}`);
      }
    }
  }
});

test("release health is proven before pruning and failures have a rollback path", () => {
  const activate = workflow.indexOf("name: Activate staged release");
  const verify = workflow.indexOf("name: Verify live release");
  const rollback = workflow.indexOf("name: Roll back an unhealthy release");
  const prune = workflow.indexOf("name: Prune superseded releases");
  assert.ok(activate >= 0 && activate < verify && verify < rollback && rollback < prune);
  assert.match(workflow, /failure\(\) && steps\.activate\.outputs\.previous != ''/);
  assert.doesNotMatch(workflow, /curl[^\n]*\|[^\n]*grep/);
});

test("same-commit retries stage a distinct release instead of reusing stale bytes", () => {
  assert.match(
    workflow,
    /RELEASE: dist-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.doesNotMatch(workflow, /if \[ -d [^\n]*target/);
  assert.match(workflow, /test ! -e [^\n]*target/);
});

test("every deploy trigger is classified into a real deploy unit, including the Brain", () => {
  assert.match(workflow, /services\/brain\/\*\*/);
  assert.match(workflow, /docs\/ops\/prune-dist-dirs\.sh/);
  assert.match(workflow, /docs\/ops\/prune-docker-images\.sh/);
  assert.match(workflow, /\.github\/workflows\/deploy\\\.yml/);
  const changesJob = workflow.slice(workflow.indexOf("  changes:"), workflow.indexOf("  migrate-platform:"));
  assert.match(changesJob, /brain=true/);
  assert.match(changesJob, /brain=false/);
  assert.match(changesJob, /brain=\$\{\{ inputs\.deploy_brain \}\}/);
});

test("a services/brain-only change classifies as the brain unit alone, not Shell or Handler A", () => {
  const shellLine = workflow.match(/if grep -Eq '([^']+)'[^\n]*\n\s*echo "shell=true"/)?.[1];
  const llmLine = workflow.match(/if grep -Eq '([^']+)'[^\n]*\n\s*echo "llm_handler=true"/)?.[1];
  const brainLine = workflow.match(/if grep -Eq '([^']+)'[^\n]*\n\s*echo "brain=true"/)?.[1];
  assert.ok(brainLine, "brain classification regex must be present");
  assert.match(brainLine, /services\/brain\//);
  assert.doesNotMatch(brainLine, /apps\/shell\//);
  assert.doesNotMatch(brainLine, /services\/llm-handler\//);
  assert.ok(shellLine, "shell classification regex must be present");
  assert.doesNotMatch(shellLine, /services\/brain\//);
  assert.ok(llmLine, "llm_handler classification regex must be present");
  assert.doesNotMatch(llmLine, /services\/brain\//);
});

test("checkout credentials are never persisted in deploy jobs", () => {
  const checkouts = workflow.match(/uses: actions\/checkout@[0-9a-f]{40}/g) ?? [];
  const disabled = workflow.match(/persist-credentials: false/g) ?? [];
  assert.equal(checkouts.length, 7);
  assert.equal(disabled.length, checkouts.length);
});

test("build-brain and deploy-brain each carry the same production-gate and success-dependency shape as build/deploy-llm-handler", () => {
  const buildBrain = workflow.slice(workflow.indexOf("  build-brain:"), workflow.indexOf("  deploy-brain:"));
  const deployBrain = workflow.slice(workflow.indexOf("  deploy-brain:"));
  assert.match(buildBrain, /needs\.changes\.outputs\.brain == 'true'/);
  assert.match(buildBrain, /file: services\/brain\/Dockerfile/);
  assert.match(deployBrain, /needs\.build-brain\.result == 'success'/);
  assert.match(deployBrain, /needs\.migrate-platform\.result == 'success' \|\| needs\.migrate-platform\.result == 'skipped'/);
  assert.match(deployBrain, /group: deploy-brain-production/);
  assert.match(deployBrain, /cancel-in-progress: false/);
});

test("the Brain's rendered .env uses the env names the daemon actually reads", () => {
  // services/brain/src/config.ts reads BRAIN_LIFEOS_API_URL / BRAIN_LIFEOS_AGENT_TOKEN.
  // Any other rendered name is silently discarded by the daemon, so the deploy
  // must pass these exact names through from Infisical (/brain/) to .env.
  assert.match(workflow, /BRAIN_LIFEOS_API_URL=/);
  assert.match(workflow, /BRAIN_LIFEOS_AGENT_TOKEN=/);
  assert.doesNotMatch(workflow, /\bLIFEOS_API_BASE_URL\b/);
  assert.doesNotMatch(workflow, /\bLIFEOS_AGENT_TOKEN\b/);
});
