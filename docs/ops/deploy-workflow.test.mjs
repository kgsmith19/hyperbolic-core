import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");

test("deploy discovery covers every manifest-owned migration directory", () => {
  assert.match(workflow, /apps\/toolbelt\/\*\*\/supabase\/migrations\/\*\*/);
  assert.match(workflow, /\^apps\/toolbelt\/\(\.\*\/\)\?supabase\/migrations\//);
});

test("all eight deploy jobs plus the migrations call, the smoke call, and the tag-release job retain the explicit production gate", () => {
  // 8 build/deploy jobs (issue #185 adds build-broker/deploy-broker) +
  // migrate-platform (issue #135) + the post-deploy smoke call (issue
  // #143) + tag-release (issue #189): every prod-touching job carries the
  // gate.
  const occurrences = workflow.match(/vars\.DEPLOY_ENABLED == 'true'/g) ?? [];
  assert.equal(occurrences.length, 11);
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

test("Shell, Handler A, Brain, and the broker deploy each read only their own dedicated Infisical path", () => {
  const paths = [...workflow.matchAll(/secret-path: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    new Set(paths),
    new Set(["/platform/shell-deploy/", "/platform/llm-handler/", "/brain/", "/platform/broker/"]),
  );
  assert.match(workflow, /INFISICAL_SHELL_DEPLOY_IDENTITY_ID/);
  assert.match(workflow, /INFISICAL_LLM_HANDLER_DEPLOY_IDENTITY_ID/);
  assert.match(workflow, /INFISICAL_BRAIN_DEPLOY_IDENTITY_ID/);
  assert.match(workflow, /INFISICAL_BROKER_DEPLOY_IDENTITY_ID/);
});

test("no SSH key material anywhere: keyless Tailscale SSH only (ADR 008, issue #191)", () => {
  // The exact same contract lifeos-deploy-workflow.test.mjs already pins for
  // lifeos-deploy.yml, and platform-smoke-workflow.test.mjs for the broker
  // probe: authentication is the tailnet ACL granting tag:ci SSH to deploy@,
  // never a persisted private key. A quiet reintroduction of any key-load
  // step (or an ssh-agent action, or a written identity file) must fail a
  // gate, not be discovered live.
  assert.doesNotMatch(workflow, /id_ed25519/);
  assert.doesNotMatch(workflow, /SSH_KEY/);
  assert.doesNotMatch(workflow, /webfactory\/ssh-agent/);
  assert.doesNotMatch(workflow, /Load the deploy SSH key/);
  assert.doesNotMatch(workflow, /ssh-add|ssh-agent/);
  assert.doesNotMatch(workflow, /\.ssh\//);
});

test("all four deploy jobs join the tailnet as tag:ci (with a host ping) between the Infisical pull and the first ssh -- lifeos-deploy.yml's keyless shape", () => {
  const jobSlices = {
    "deploy-shell": workflow.slice(workflow.indexOf("  deploy-shell:"), workflow.indexOf("  build-llm-handler:")),
    "deploy-llm-handler": workflow.slice(workflow.indexOf("  deploy-llm-handler:"), workflow.indexOf("  build-brain:")),
    "deploy-brain": workflow.slice(workflow.indexOf("  deploy-brain:"), workflow.indexOf("  build-broker:")),
    "deploy-broker": workflow.slice(workflow.indexOf("  deploy-broker:"), workflow.indexOf("  smoke:")),
  };
  for (const [name, body] of Object.entries(jobSlices)) {
    const infisical = body.indexOf("Infisical/secrets-action");
    const join = body.indexOf("tailscale/github-action");
    const firstSsh = body.search(/\bssh /);
    assert.ok(infisical > -1, `${name}: pulls its Infisical path (tailnet OAuth client lives there)`);
    assert.ok(join > infisical, `${name}: tailnet join must follow the Infisical pull that supplies TS_OAUTH_*`);
    assert.ok(firstSsh > join, `${name}: no ssh use before the tailnet join`);
    assert.match(body, /tags: tag:ci/, `${name}: joins as tag:ci (the ACL's SSH grant subject)`);
    assert.match(body, /ping: \$\{\{ vars\.DEPLOY_HOST \}\}/, `${name}: pings the deploy host before ssh`);
  }
  const joins = workflow.match(/tailscale\/github-action@/g) ?? [];
  assert.equal(joins.length, 4);
});

test("every ssh/scp call keeps the exact client options the keyless pattern uses (BatchMode, ConnectTimeout, accept-new)", () => {
  // Identical string in lifeos-deploy.yml/ops-serve-apply.yml: BatchMode so a
  // missing Tailscale SSH grant fails immediately instead of hanging on a
  // prompt, accept-new because a fresh single-use runner has no known_hosts.
  const optionSets = workflow.match(/ssh_options=\(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new\)/g) ?? [];
  assert.ok(optionSets.length >= 10, `every remote step declares the shared ssh_options (saw ${optionSets.length})`);
  assert.doesNotMatch(workflow, /ssh[^\n]* -i /);
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
  assert.equal(checkouts.length, 10);
  assert.equal(disabled.length, checkouts.length);
});

test("build-brain and deploy-brain each carry the same production-gate and success-dependency shape as build/deploy-llm-handler", () => {
  const buildBrain = workflow.slice(workflow.indexOf("  build-brain:"), workflow.indexOf("  deploy-brain:"));
  const deployBrain = workflow.slice(workflow.indexOf("  deploy-brain:"), workflow.indexOf("  build-broker:"));
  assert.match(buildBrain, /needs\.changes\.outputs\.brain == 'true'/);
  assert.match(buildBrain, /file: services\/brain\/Dockerfile/);
  assert.match(deployBrain, /needs\.build-brain\.result == 'success'/);
  assert.match(deployBrain, /needs\.migrate-platform\.result == 'success' \|\| needs\.migrate-platform\.result == 'skipped'/);
  assert.match(deployBrain, /group: deploy-brain-production/);
  assert.match(deployBrain, /cancel-in-progress: false/);
});

test("build-broker and deploy-broker (issue #185) carry the same production-gate and success-dependency shape as the other units", () => {
  const buildBroker = workflow.slice(workflow.indexOf("  build-broker:"), workflow.indexOf("  deploy-broker:"));
  const deployBroker = workflow.slice(workflow.indexOf("  deploy-broker:"), workflow.indexOf("  smoke:"));
  assert.match(buildBroker, /needs\.changes\.outputs\.broker == 'true'/);
  assert.match(buildBroker, /file: services\/broker\/Dockerfile/);
  assert.match(deployBroker, /needs\.build-broker\.result == 'success'/);
  assert.match(deployBroker, /needs\.migrate-platform\.result == 'success' \|\| needs\.migrate-platform\.result == 'skipped'/);
  assert.match(deployBroker, /group: deploy-broker-production/);
  assert.match(deployBroker, /cancel-in-progress: false/);
  assert.match(deployBroker, /environment: broker-deploy-production/);
});

test("deploy-broker generates broker-policy.json fresh from every discovered manifest before shipping it, never a committed copy", () => {
  const deployBroker = workflow.slice(workflow.indexOf("  deploy-broker:"), workflow.indexOf("  smoke:"));
  assert.match(deployBroker, /node apps\/toolbelt\/scripts\/generate-broker-policy\.mjs --out "\$RUNNER_TEMP\/broker-policy\.json"/);
  assert.match(deployBroker, /scp .* "\$RUNNER_TEMP\/broker-policy\.json" "deploy@\$DEPLOY_HOST:broker\/broker-policy\.json"/);
  assert.doesNotMatch(workflow, /git add .*broker-policy\.json|committed.*broker-policy\.json/);
  // Positive check, not just the absence check above: services/broker/ itself
  // has no tracked broker-policy.json, and its own .gitignore backstops one
  // ever landing there by accident.
  assert.doesNotMatch(readdirSync(path.join(root, "services/broker")).join(","), /broker-policy\.json/);
  const brokerGitignore = readFileSync(path.join(root, "services/broker/.gitignore"), "utf8");
  assert.match(brokerGitignore, /^broker-policy\.json$/m);
});

test("deploy-broker reads only its own dedicated Infisical path and identity, matching every sibling unit's isolation", () => {
  assert.match(workflow, /INFISICAL_BROKER_DEPLOY_IDENTITY_ID/);
  const deployBroker = workflow.slice(workflow.indexOf("  deploy-broker:"), workflow.indexOf("  smoke:"));
  assert.match(deployBroker, /secret-path: "\/platform\/broker\/"/);
  assert.doesNotMatch(deployBroker, /\/platform\/shell-deploy\/|\/platform\/llm-handler\/|secret-path: "\/brain\/"/);
  assert.doesNotMatch(deployBroker, /INFISICAL_SHELL_DEPLOY_IDENTITY_ID|INFISICAL_LLM_HANDLER_DEPLOY_IDENTITY_ID|INFISICAL_BRAIN_DEPLOY_IDENTITY_ID/);
});

test("deploy-broker ships broker-policy.json world-readable (644), never 600 like .env -- the container reads it as a different uid than deploy owns it as", () => {
  // Independent adversarial review finding: broker-policy.json is a bind
  // mount (services/broker/compose.yaml), so it keeps the HOST file's owner
  // (deploy) and mode on the container side too -- the broker process runs
  // as uid 10300 (Dockerfile), not deploy, so a 600 mode would be EACCES
  // and fail `docker compose up --wait` on every deploy. The file holds no
  // secrets (aggregated from committed tool.json files: host allowlists and
  // vault KEY NAMES only), so 644 costs nothing.
  const deployBroker = workflow.slice(workflow.indexOf("  deploy-broker:"), workflow.indexOf("  smoke:"));
  assert.match(deployBroker, /chmod 644 broker-policy\.json/);
  assert.doesNotMatch(deployBroker, /chmod 600 \.env broker-policy\.json/);
  assert.match(deployBroker, /chmod 600 \.env(?! broker-policy)/);
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

test("Phase 0 slice B (issue #187): deploy-llm-handler renders BROKER_URL + BROKER_CALLER_TOKEN into .env, optional and paired", () => {
  // services/llm-handler only activates broker routing when BOTH vars are
  // present (broker-drivers.ts), so the two lines render together, gated on
  // the secret's presence -- the same optional shape as LLM_KEYS_*: an
  // unprovisioned token omits both lines entirely (dark), never renders
  // them empty. BROKER_URL is the shared-network service-name alias, not a
  // secret, hence the literal value.
  const job = workflow.slice(
    workflow.indexOf("  deploy-llm-handler:"),
    workflow.indexOf("  build-brain:"),
  );
  assert.match(
    job,
    /\[ -n "\$\{BROKER_CALLER_TOKEN:-\}" \] && printf 'BROKER_URL=http:\/\/broker:8300\\nBROKER_CALLER_TOKEN=%s\\n' "\$BROKER_CALLER_TOKEN"/,
  );
  // The existing provider keys keep their own optional shape (streaming
  // stays direct in Phase 0, so llm-handler retains its own keys).
  assert.match(job, /\[ -n "\$\{LLM_KEYS_ANTHROPIC:-\}" \] && printf 'LLM_KEYS_ANTHROPIC=%s\\n'/);
});

test("Phase 0 slice B (issue #187): deploy-broker renders the injection secrets optionally, BROKER_IMAGE unconditionally", () => {
  // LLM_KEYS_ANTHROPIC (server-side injection for llm-handler's proxied
  // complete calls) and BROKER_CALLER_TOKEN_LLM_HANDLER (llm-handler's
  // caller-auth token) come from /platform/broker/. Both optional: absent
  // secrets must not fail the deploy -- the broker stays dark until the
  // owner provisions them.
  const job = workflow.slice(workflow.indexOf("  deploy-broker:"), workflow.indexOf("  smoke:"));
  assert.match(job, /printf 'BROKER_IMAGE=%s\\n' "\$IMAGE"/);
  assert.match(
    job,
    /\[ -n "\$\{LLM_KEYS_ANTHROPIC:-\}" \] && printf 'LLM_KEYS_ANTHROPIC=%s\\n' "\$LLM_KEYS_ANTHROPIC"/,
  );
  assert.match(
    job,
    /\[ -n "\$\{BROKER_CALLER_TOKEN_LLM_HANDLER:-\}" \] && printf 'BROKER_CALLER_TOKEN_LLM_HANDLER=%s\\n' "\$BROKER_CALLER_TOKEN_LLM_HANDLER"/,
  );
});

test("Phase 0 slice B (issue #187): both container jobs on the shared network ensure platform-internal exists, idempotently, before compose up", () => {
  // Each job deploys independently (separate compose projects, ADR-05), so
  // BOTH must be able to create the shared --internal network on a host
  // that lacks it; `docker network inspect || docker network create` makes
  // a rerun a no-op instead of an error.
  const ensureCmd =
    "docker network inspect platform-internal >/dev/null 2>&1 || docker network create --internal platform-internal";
  const jobSlices = {
    "deploy-llm-handler": workflow.slice(
      workflow.indexOf("  deploy-llm-handler:"),
      workflow.indexOf("  build-brain:"),
    ),
    "deploy-broker": workflow.slice(workflow.indexOf("  deploy-broker:"), workflow.indexOf("  smoke:")),
  };
  for (const [name, body] of Object.entries(jobSlices)) {
    const ensure = body.indexOf(ensureCmd);
    assert.ok(ensure > -1, `${name}: has the guarded network-create step`);
    const composeUp = body.indexOf("docker compose up -d --wait");
    assert.ok(composeUp > -1 && ensure < composeUp, `${name}: network exists before compose up`);
  }
});

test("Phase 0 slice B (issue #187): llm-handler and broker compose files join platform-internal ADDITIVELY (default kept)", () => {
  // Naming networks explicitly on a service removes Compose's implicit
  // default-network attachment, so each service must name BOTH `default`
  // (its own project bridge -- real egress preserved, nothing cut off yet)
  // AND `platform-internal` (external, shared). Phase 1's flip later just
  // removes `default` from llm-handler's list. `default` must also be
  // declared at top level once a service names it explicitly.
  for (const file of ["services/llm-handler/compose.yaml", "services/broker/compose.yaml"]) {
    const compose = readFileSync(path.join(root, file), "utf8");
    assert.match(compose, /    networks:\n      - default\n      - platform-internal\n/, `${file}: service dual-homed`);
    assert.match(compose, /^networks:\n  default:\n  platform-internal:\n    external: true\n/m, `${file}: top-level declaration`);
  }
  // BROKER_URL=http://broker:8300 resolves via the shared network's
  // service-name alias, so the broker's compose service must be `broker`.
  const brokerCompose = readFileSync(path.join(root, "services/broker/compose.yaml"), "utf8");
  assert.match(brokerCompose, /^services:\n  broker:\n/m);
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
  // nginx's private route table forwards to the daemon (issue #134).
  const buildJob = workflow.slice(
    workflow.indexOf("  build-shell:"),
    workflow.indexOf("  deploy-shell:"),
  );
  assert.match(buildJob, /VITE_BRAIN_API: \$\{\{ vars\.VITE_BRAIN_API \|\| '\/' \}\}/);
});

test("all three container deploys record the running image, then roll back to it on failure", () => {
  // Shell has had activate->verify->rollback since m2-07; the container
  // units had NO rollback (gap G-2): a failed compose up --wait left the
  // broken image live. Each job must record the box's current image BEFORE
  // shipping, and repoint .env back to it under failure() -- degrading
  // gracefully (no rollback attempt) on a first-ever deploy (__none__).
  // issue #185 adds the broker as a third container unit with the same
  // shape.
  for (const [recordName, job, envkey] of [
    ["Handler A", "Handler A", "LLM_HANDLER_IMAGE"],
    ["Brain", "the Brain", "BRAIN_IMAGE"],
    ["broker", "the broker", "BROKER_IMAGE"],
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
  assert.equal(guards.length, 3);
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
  assert.match(tagJob, /BROKER_RESULT: \$\{\{ needs\.deploy-broker\.result \}\}/);
  assert.match(tagJob, /docs\/ops\/tag-release\.sh shell "\$SHELL_RESULT" "\$SHA"/);
  assert.match(tagJob, /docs\/ops\/tag-release\.sh llm-handler "\$LLM_HANDLER_RESULT" "\$SHA"/);
  assert.match(tagJob, /docs\/ops\/tag-release\.sh brain "\$BRAIN_RESULT" "\$SHA"/);
  assert.match(tagJob, /docs\/ops\/tag-release\.sh broker "\$BROKER_RESULT" "\$SHA"/);
  assert.match(tagJob, /SHA: \$\{\{ github\.sha \}\}/);
});

test("tag-release checks out with credentials not persisted, matching every other job in this file", () => {
  const tagJob = workflow.slice(workflow.indexOf("  tag-release:"));
  assert.match(tagJob, /persist-credentials: false/);
});
