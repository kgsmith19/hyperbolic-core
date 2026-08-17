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

test("all six deploy jobs plus the migrations call, the smoke call, and the tag-release job retain the explicit production gate", () => {
  // 6 build/deploy jobs + migrate-platform (issue #135) + the post-deploy
  // smoke call (issue #143) + tag-release (issue #189): every prod-touching
  // job carries the gate.
  const occurrences = workflow.match(/vars\.DEPLOY_ENABLED == 'true'/g) ?? [];
  assert.equal(occurrences.length, 9);
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
  assert.equal(checkouts.length, 8);
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

test("Handler A's rendered .env can deliver the LLM provider keys the service reads", () => {
  // services/llm-handler/src/config.ts reads LLM_KEYS_ANTHROPIC / LLM_KEYS_OPENAI /
  // LLM_KEYS_GEMINI from the environment. Before issue #133 the deploy rendered
  // none of them, so production Handler A had no provider credentials at all.
  const job = workflow.slice(
    workflow.indexOf("  deploy-llm-handler:"),
    workflow.indexOf("  build-brain:"),
  );
  assert.match(job, /LLM_KEYS_ANTHROPIC=/);
  assert.match(job, /LLM_KEYS_OPENAI=/);
  assert.match(job, /LLM_KEYS_GEMINI=/);
  // Optional-var shape, not required: an unprovisioned key must be omitted from
  // .env (the daemon treats them as optional), never rendered empty or fatal.
  assert.match(job, /\[ -n "\$\{LLM_KEYS_ANTHROPIC:-\}" \]/);
});

const migrationsWorkflow = readFileSync(
  path.join(root, ".github/workflows/platform-migrations.yml"),
  "utf8",
);

test("production migrations are gated by DEPLOY_ENABLED at both call sites", () => {
  // Before issue #135 a push touching only migration paths mutated the prod
  // schema even with deploys disabled: migrate-platform was gated on ref +
  // changed paths only, and platform-migrations.yml's own jobs had no
  // repository-variable gate at all (its workflow_dispatch was ungated).
  const migrateJob = workflow.slice(
    workflow.indexOf("  migrate-platform:"),
    workflow.indexOf("  build-shell:"),
  );
  assert.match(migrateJob, /vars\.DEPLOY_ENABLED == 'true'/);
  const calledJob = migrationsWorkflow.slice(
    migrationsWorkflow.indexOf("  migrate:"),
    migrationsWorkflow.indexOf("    steps:"),
  );
  assert.match(calledJob, /vars\.DEPLOY_ENABLED == 'true'/);
});

test("the production Shell build bakes a Brain API base that reaches the shared origin", () => {
  // Without VITE_BRAIN_API the bundled client falls back to the BROWSER'S
  // 127.0.0.1:8100 (apps/shell/frontend/src/lib/session.ts), so the deployed
  // Shell could never reach the Brain. '/' means same-origin: the client
  // strips the trailing slash and issues /api/brain/* requests, which the
  // serve route table forwards to the daemon (issue #134).
  const buildJob = workflow.slice(
    workflow.indexOf("  build-shell:"),
    workflow.indexOf("  deploy-shell:"),
  );
  assert.match(buildJob, /VITE_BRAIN_API: \$\{\{ vars\.VITE_BRAIN_API \|\| '\/' \}\}/);
});

test("both container deploys record the running image, then roll back to it on failure", () => {
  // Shell has had activate->verify->rollback since m2-07; the two container
  // units had NO rollback (gap G-2): a failed compose up --wait left the
  // broken image live. Each job must record the box's current image BEFORE
  // shipping, and repoint .env back to it under failure() -- degrading
  // gracefully (no rollback attempt) on a first-ever deploy (__none__).
  for (const [recordName, job, envkey] of [
    ["Handler A", "Handler A", "LLM_HANDLER_IMAGE"],
    ["Brain", "the Brain", "BRAIN_IMAGE"],
  ]) {
    const record = workflow.indexOf(`- name: Record the running ${recordName} image for rollback`);
    const deploy = workflow.indexOf(`- name: Deploy ${job}\n`, record);
    const rollback = workflow.indexOf(`- name: Roll back ${job} to the previous image`, deploy);
    assert.ok(record > -1 && deploy > record && rollback > deploy, `${job}: record -> deploy -> rollback order`);
    const rollbackBlock = workflow.slice(rollback, rollback + 400);
    assert.match(
      rollbackBlock,
      /if: failure\(\) && steps\.previous\.outputs\.image != '' && steps\.previous\.outputs\.image != '__none__'/,
    );
    assert.ok(workflow.includes(`grep -m1 '^${envkey}='`), `${job}: reads ${envkey} from the box .env`);
  }
  // The recorded reference is validated before reuse -- an unexpected value
  // must abort rather than be sed'd into .env.
  const guards = workflow.match(/Refusing to trust an unexpected running-image reference/g) ?? [];
  assert.equal(guards.length, 2);
});

test("tag-release (issue #189): contents: write is scoped to that job alone, nowhere else in the file", () => {
  const writeOccurrences = workflow.match(/contents: write/g) ?? [];
  assert.equal(writeOccurrences.length, 1, "exactly one contents: write in the whole file");
  const tagJob = workflow.slice(workflow.indexOf("  tag-release:"));
  assert.match(tagJob, /contents: write/);
});

test("tag-release only fires once the run's overall smoke verdict succeeded, not merely because a deploy job did", () => {
  const tagJob = workflow.slice(workflow.indexOf("  tag-release:"));
  assert.match(tagJob, /needs\.smoke\.result == 'success'/);
  // Deliberately NOT an OR-of-individual-deploy-results shape (that's the
  // smoke job's own gate, one level up) -- a red smoke must withhold every
  // tag this run, even for a unit whose own deploy job reported success.
  assert.doesNotMatch(tagJob, /needs\.deploy-shell\.result == 'success' \|\|/);
});

test("tag-release calls tag-release.sh once per unit, passing that unit's own deploy result and the exact deployed sha", () => {
  const tagJob = workflow.slice(workflow.indexOf("  tag-release:"));
  assert.match(tagJob, /SHELL_RESULT: \$\{\{ needs\.deploy-shell\.result \}\}/);
  assert.match(tagJob, /LLM_HANDLER_RESULT: \$\{\{ needs\.deploy-llm-handler\.result \}\}/);
  assert.match(tagJob, /BRAIN_RESULT: \$\{\{ needs\.deploy-brain\.result \}\}/);
  assert.match(tagJob, /docs\/ops\/tag-release\.sh shell "\$SHELL_RESULT" "\$SHA"/);
  assert.match(tagJob, /docs\/ops\/tag-release\.sh llm-handler "\$LLM_HANDLER_RESULT" "\$SHA"/);
  assert.match(tagJob, /docs\/ops\/tag-release\.sh brain "\$BRAIN_RESULT" "\$SHA"/);
  assert.match(tagJob, /SHA: \$\{\{ github\.sha \}\}/);
});

test("tag-release checks out with credentials not persisted, matching every other job in this file", () => {
  const tagJob = workflow.slice(workflow.indexOf("  tag-release:"));
  assert.match(tagJob, /persist-credentials: false/);
});
