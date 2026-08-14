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

test("all four Shell and Handler A deploy jobs retain the explicit production gate", () => {
  const occurrences = workflow.match(/vars\.DEPLOY_ENABLED == 'true'/g) ?? [];
  assert.equal(occurrences.length, 4);
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
  assert.match(workflow, /migrations=\$\{\{ inputs\.apply_migrations \}\}/);
  assert.doesNotMatch(workflow, /workflow_dispatch[\s\S]{0,500}migrations=true/);
});

test("Shell and Handler A deploy each read only their own dedicated Infisical path", () => {
  const paths = [...workflow.matchAll(/secret-path: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(new Set(paths), new Set(["/platform/shell-deploy/", "/platform/llm-handler/"]));
});

test("Handler A's deploy job uses its own SSH key variable, never Shell's, and vice versa", () => {
  assert.match(workflow, /INFISICAL_LLM_HANDLER_DEPLOY_IDENTITY_ID/);
  const deployShell = workflow.slice(workflow.indexOf("  deploy-shell:"), workflow.indexOf("  build-llm-handler:"));
  const deployLlmHandler = workflow.slice(workflow.indexOf("  deploy-llm-handler:"));
  assert.match(deployShell, /SHELL_DEPLOY_SSH_KEY/);
  assert.doesNotMatch(deployShell, /LLM_HANDLER_SSH_KEY/);
  assert.match(deployLlmHandler, /LLM_HANDLER_SSH_KEY/);
  assert.doesNotMatch(deployLlmHandler, /SHELL_DEPLOY_SSH_KEY/);
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

test("every deploy trigger is classified into a real deploy unit", () => {
  assert.doesNotMatch(workflow, /services\/brain\/\*\*/);
  assert.match(workflow, /docs\/ops\/prune-dist-dirs\.sh/);
  assert.match(workflow, /\.github\/workflows\/deploy\\\.yml/);
});

test("checkout credentials are never persisted in deploy jobs", () => {
  const checkouts = workflow.match(/uses: actions\/checkout@[0-9a-f]{40}/g) ?? [];
  const disabled = workflow.match(/persist-credentials: false/g) ?? [];
  assert.equal(checkouts.length, 5);
  assert.equal(disabled.length, checkouts.length);
});
