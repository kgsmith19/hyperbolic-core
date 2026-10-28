// Structural and behavioral assertions over .github/workflows/ops-broker-canary.yml
// (hyperbolic-core#478). The canary sends one minimal Anthropic Messages request through
// the production broker and fails unless the broker answers 200 with a message and writes
// exactly one audit line. Its safety is its SHAPE: a fixed envelope identical to the one
// packages/llm/src/drivers/anthropic-via-broker.ts builds, max_tokens 1, the same pinned
// actions and identity as ops-broker-soak-report.yml, and no step that can echo a secret.
// The behavioral half runs the real run: script with stub ssh, curl and docker on PATH. The
// ssh stub runs the remote command locally, so the curl and docker stubs see exactly what the
// box would. Nothing touches the network, the broker, Anthropic, or Infisical.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/ops-broker-canary.yml");
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";
const soakReport = readFileSync(path.join(root, ".github/workflows/ops-broker-soak-report.yml"), "utf8");

/** Non-comment lines only, so a comment that mentions a verb cannot trip a rule. */
const code = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

const TOKEN = "broker-caller-token-FAKE-7f3a9c51";
const KEY = "sk-ant-api03-FAKE-KEY-41d2e0b8";
const RESPONSE_SENTINEL = "RESPONSE-BODY-SENTINEL-c0ffee";
const DEPLOY_HOST = "box.example.ts.net";

/** The top-level `on:` block's own keys, read from the first line under `on:`. */
function triggerKeys() {
  const start = workflow.indexOf("\non:\n");
  assert.ok(start > -1, "no top-level on: block");
  const rest = workflow.slice(start + "\non:\n".length);
  const end = rest.search(/\n(?=[A-Za-z_-]+:)/);
  const block = end > -1 ? rest.slice(0, end) : rest;
  return [...block.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]);
}

/** The `run:` script of one named step, dedented to column zero. */
function stepRun(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start > -1, `step "${name}" not found`);
  const runAt = workflow.indexOf("        run: |\n", start);
  assert.ok(runAt > -1, `step "${name}" has no run: script`);
  const bodyStart = runAt + "        run: |\n".length;
  const next = workflow.indexOf("\n      - ", bodyStart);
  const body = workflow.slice(bodyStart, next > -1 ? next : undefined);
  return body
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

const MAIN_STEP = "Send one synthetic broker call and assert it";

// --- trigger, identity, and environment ---

test("the workflow file exists", () => {
  assert.ok(workflow !== "", `${path.relative(root, workflowPath)} is missing`);
});

test("the workflow is named Ops Broker Canary", () => {
  assert.match(workflow, /^name: Ops Broker Canary$/m);
});

test("triggers are exactly a daily schedule and a bare workflow_dispatch (no inputs)", () => {
  assert.deepEqual(triggerKeys(), ["schedule", "workflow_dispatch"]);
  assert.match(workflow, /\n {2}schedule:\n {4}- cron: "23 11 \* \* \*"/);
  assert.doesNotMatch(workflow, /\n {2}workflow_dispatch:\n {4}inputs:/);
});

test("the cron is distinct from every other cron in .github/workflows", () => {
  const dir = path.join(root, ".github/workflows");
  const ours = "23 11 * * *";
  const others = readdirSync(dir)
    .filter((file) => file.endsWith(".yml") && file !== "ops-broker-canary.yml")
    .flatMap((file) => [...readFileSync(path.join(dir, file), "utf8").matchAll(/cron: ["']([^"']+)["']/g)].map((m) => [file, m[1]]));
  assert.ok(others.length > 0, "found no other cron schedules to compare against");
  for (const [file, cron] of others) {
    assert.notEqual(cron, ours, `${file} already runs on the cron ${ours}`);
  }
});

test("exactly one job, in the broker-deploy-production environment that the soak report already uses", () => {
  const jobIds = [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(jobIds, ["broker-canary"]);
  const environments = workflow.match(/^\s*environment:.*$/gm) ?? [];
  assert.deepEqual(environments.map((line) => line.trim()), ["environment: broker-deploy-production"]);
});

test("permissions are contents read at the top level, and contents read plus id-token write on the job", () => {
  const blocks = [...workflow.matchAll(/^( *)permissions:\n((?:\1 {2}[a-z-]+: [a-z]+\n)+)/gm)].map(
    ([, indent, body]) => ({ indent, pairs: [...body.matchAll(/([a-z-]+): ([a-z]+)/g)].map((m) => `${m[1]}:${m[2]}`) }),
  );
  assert.equal(blocks.length, 2, "expected exactly a top-level and a job-level permissions block");
  const [topLevel, job] = blocks;
  assert.equal(topLevel.indent, "", "first permissions block must be top level");
  assert.deepEqual(topLevel.pairs, ["contents:read"]);
  assert.equal(job.indent, "    ", "second permissions block must be job level");
  assert.deepEqual(job.pairs, ["contents:read", "id-token:write"]);
  assert.doesNotMatch(code, /\b(packages|pull-requests|issues|actions|checks|statuses|deployments|contents): write\b/);
});

test("concurrency: one group, cancel-in-progress false, and a timeout of about ten minutes", () => {
  assert.match(workflow, /\n {4}concurrency:\n {6}group: ops-broker-canary\n {6}cancel-in-progress: false\n/);
  assert.match(workflow, /\n {4}timeout-minutes: 10\n/);
});

test("the only repository variables consumed are the broker deploy identity, the Infisical project, and the deploy host", () => {
  const vars = new Set([...code.matchAll(/vars\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...vars].sort(), ["DEPLOY_HOST", "INFISICAL_BROKER_DEPLOY_IDENTITY_ID", "INFISICAL_PROJECT_SLUG"]);
});

// --- pinned actions and the Infisical read, identical to the soak report ---

test("every uses: is a full SHA and is the exact pin ops-broker-soak-report.yml already uses", () => {
  const refs = [...workflow.matchAll(/uses: ([^\s#]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(refs.map((ref) => ref.split("@")[0]))].sort(),
    ["Infisical/secrets-action", "actions/checkout", "tailscale/github-action"],
  );
  for (const ref of refs) {
    assert.match(ref, /@[0-9a-f]{40}\b/, `${ref} is not pinned to a full SHA`);
    assert.ok(soakReport.includes(`uses: ${ref}`), `${ref} is not the pin ops-broker-soak-report.yml uses`);
  }
});

test("the Infisical step reads /platform/broker/ through the same broker deploy identity as the soak report", () => {
  assert.match(workflow, /method: oidc/);
  assert.match(workflow, /identity-id: \$\{\{ vars\.INFISICAL_BROKER_DEPLOY_IDENTITY_ID \}\}/);
  assert.match(workflow, /project-slug: \$\{\{ vars\.INFISICAL_PROJECT_SLUG \}\}/);
  assert.match(workflow, /env-slug: prod/);
  assert.match(workflow, /secret-path: "\/platform\/broker\/"/);
  assert.match(workflow, /domain: https:\/\/app\.infisical\.com/);
});

test("the tailnet join tags the runner tag:ci and pings the deploy host", () => {
  assert.match(workflow, /tags: tag:ci/);
  assert.match(workflow, /ping: \$\{\{ vars\.DEPLOY_HOST \}\}/);
});

test("secrets reach run: scripts only through env or the Infisical export, never as an inline ${{ secrets.* }}", () => {
  assert.ok(workflow !== "", "workflow missing: a negative pin over an empty file proves nothing");
  assert.doesNotMatch(code, /\$\{\{\s*secrets\./);
});

// --- the envelope and the request, pinned to anthropic-via-broker.ts ---

test("the main step's env pins the canary model to claude-haiku-5-5", () => {
  assert.match(workflow, /\n {10}CANARY_MODEL: claude-haiku-5-5\n/);
});

test("max_tokens is exactly 1: the smallest request the provider accepts", () => {
  const script = stepRun(MAIN_STEP);
  const values = [...script.matchAll(/max_tokens: ([0-9]+)/g)].map((m) => m[1]);
  assert.deepEqual(values, ["1"], "the request must set max_tokens to 1, and only to 1");
});

test("the envelope carries the exact fields anthropic-via-broker.ts sends", () => {
  const script = stepRun(MAIN_STEP);
  for (const fragment of [
    'caller: "llm-handler"',
    "token: env.BROKER_CALLER_TOKEN_LLM_HANDLER",
    'targetHost: "api.anthropic.com"',
    'protocol: "https"',
    'method: "POST"',
    'path: "/v1/messages"',
    '"anthropic-version": "2023-06-01"',
    '"content-type": "application/json"',
    'credential: "LLM_KEYS_ANTHROPIC"',
    'credentialHeader: "x-api-key"',
    "stream: false",
    'messages: [{ role: "user", content: "ping" }]',
  ]) {
    assert.ok(script.includes(fragment), `envelope is missing ${fragment}`);
  }
});

test("the request is posted to the broker's loopback /proxy on the box, with the JSON read from stdin", () => {
  const script = stepRun(MAIN_STEP);
  assert.ok(script.includes("http://127.0.0.1:8300/proxy"), "the call must go to the broker's /proxy on loopback");
  assert.ok(script.includes("--data-binary @-"), "the envelope must arrive on stdin, never on the remote argv");
});

// --- the audit line, the status check, and secret hygiene ---

test("the audit line is counted with docker logs --since on the broker container", () => {
  const script = stepRun(MAIN_STEP);
  assert.match(script, /docker logs --timestamps --since \$started broker-broker-1/);
  assert.match(script, /grep -c broker_proxy_request/);
});

test("ssh uses the same options as the soak report and platform-smoke", () => {
  assert.ok(
    stepRun(MAIN_STEP).includes("ssh_options=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)"),
  );
});

test("no set -x, xtrace, or bash -x anywhere: a trace would print the token and the key", () => {
  assert.ok(workflow !== "", "workflow missing: a negative pin over an empty file proves nothing");
  assert.doesNotMatch(code, /\bset\s+-[a-zA-Z]*x\b|xtrace|\bbash\s+-x\b/);
});

test("no echo or printf mentions the caller token or the Anthropic credential name", () => {
  for (const line of code.split("\n")) {
    if (!/\b(echo|printf)\b/.test(line)) continue;
    assert.doesNotMatch(line, /BROKER_CALLER_TOKEN_LLM_HANDLER|LLM_KEYS_ANTHROPIC/, `secret echoed or printed: ${line.trim()}`);
  }
});

// --- behavioral: run the real main step under stubs, record what it sends ---

const SSH_STUB = `#!/bin/sh
printf '%s\\n' "ssh $*" >> "$STUB_LOG"
for last do :; done
exec bash -c "$last"
`;

const CURL_STUB = `#!/bin/sh
printf '%s\\n' "curl $*" >> "$STUB_LOG"
cat > "$STUB_DIR/curl-body.json"
printf '%s\\n%s' "$STUB_RESPONSE" "$STUB_HTTP_CODE"
`;

const DOCKER_STUB = `#!/bin/sh
printf '%s\\n' "docker $*" >> "$STUB_LOG"
i=0
while [ "$i" -lt "$STUB_AUDIT_LINES" ]; do
  printf '%s\\n' '2026-10-28T11:23:05.000000000Z {"event":"broker_proxy_request","caller":"llm-handler","targetHost":"api.anthropic.com"}'
  i=$((i + 1))
done
`;

/** Run the main step's real run: script with stub ssh, curl and docker first on PATH. */
function runMainStep({ httpCode, response, auditLines }) {
  const dir = mkdtempSync(path.join(tmpdir(), "broker-canary-"));
  try {
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    for (const [name, body] of [["ssh", SSH_STUB], ["curl", CURL_STUB], ["docker", DOCKER_STUB]]) {
      writeFileSync(path.join(bin, name), body, { mode: 0o755 });
    }
    const scriptPath = path.join(dir, "main-step.sh");
    writeFileSync(scriptPath, stepRun(MAIN_STEP));
    const logPath = path.join(dir, "argv.log");
    const model = /\n {10}CANARY_MODEL: (\S+)\n/.exec(workflow)?.[1];
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
        HOME: dir,
        DEPLOY_HOST,
        CANARY_MODEL: model,
        BROKER_CALLER_TOKEN_LLM_HANDLER: TOKEN,
        LLM_KEYS_ANTHROPIC: KEY,
        STUB_LOG: logPath,
        STUB_DIR: dir,
        STUB_HTTP_CODE: String(httpCode),
        STUB_RESPONSE: response,
        STUB_AUDIT_LINES: String(auditLines),
      },
    });
    const argv = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const sent = existsSync(path.join(dir, "curl-body.json")) ? JSON.parse(readFileSync(path.join(dir, "curl-body.json"), "utf8")) : null;
    return { ...result, argv, sent };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertNoSecretLeak(run) {
  assert.ok(!run.argv.includes(TOKEN), "the caller token appeared in a stub's argv");
  assert.ok(!run.argv.includes(KEY), "the Anthropic key appeared in a stub's argv");
  assert.ok(!`${run.stdout}${run.stderr}`.includes(TOKEN), "the caller token was printed");
  assert.ok(!`${run.stdout}${run.stderr}`.includes(KEY), "the Anthropic key was printed");
  assert.ok(!`${run.stdout}${run.stderr}`.includes(RESPONSE_SENTINEL), "the response body was printed");
}

const OK_MESSAGE = `{"id":"msg_01","type":"message","role":"assistant","content":[{"type":"text","text":"${RESPONSE_SENTINEL}"}]}`;

test("behavior: 200 with a message and exactly one audit line exits 0, sends the exact envelope, and leaks nothing", () => {
  const run = runMainStep({ httpCode: 200, response: OK_MESSAGE, auditLines: 1 });
  assert.equal(run.status, 0, `expected exit 0, got ${run.status}: ${run.stderr}`);
  assert.match(run.stdout, /canary: HTTP 200, 1 audit line/);
  assert.equal(run.sent.caller, "llm-handler");
  assert.equal(run.sent.token, TOKEN);
  assert.equal(run.sent.credential, "LLM_KEYS_ANTHROPIC");
  assert.equal(run.sent.path, "/v1/messages");
  const upstream = JSON.parse(run.sent.body);
  assert.equal(upstream.max_tokens, 1);
  assert.equal(upstream.model, "claude-haiku-5-5");
  assert.equal(upstream.stream, false);
  assertNoSecretLeak(run);
});

test("behavior: an HTTP 500 from the broker fails the canary", () => {
  const run = runMainStep({ httpCode: 500, response: `{"error":"upstream"}${RESPONSE_SENTINEL}`, auditLines: 1 });
  assert.notEqual(run.status, 0, "an HTTP 500 must not pass");
  assert.match(run.stderr, /HTTP 500/);
  assertNoSecretLeak(run);
});

test("behavior: a 200 whose body is not a message fails the canary", () => {
  const run = runMainStep({ httpCode: 200, response: `{"type":"error","error":"${RESPONSE_SENTINEL}"}`, auditLines: 1 });
  assert.notEqual(run.status, 0, "a 200 that is not type message must not pass");
  assertNoSecretLeak(run);
});

test("behavior: a 200 with zero new audit lines fails the canary", () => {
  const run = runMainStep({ httpCode: 200, response: OK_MESSAGE, auditLines: 0 });
  assert.notEqual(run.status, 0, "a call the broker did not audit must not pass");
  assert.match(run.stderr, /0 audit lines/);
  assertNoSecretLeak(run);
});

test("behavior: the audit window starts on the box's own clock, read over ssh before the call, so runner/box clock skew cannot hide or add lines", () => {
  const run = runMainStep({ httpCode: 200, response: OK_MESSAGE, auditLines: 1 });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.argv.split("\n").filter(Boolean);
  const dateCall = lines.findIndex((l) => /^ssh .*deploy@\S+ date -u \+%Y-%m-%dT%H:%M:%SZ$/.test(l));
  const curlCall = lines.findIndex((l) => l.startsWith("curl "));
  const logsCall = lines.findIndex((l) => l.startsWith("docker logs"));
  assert.ok(dateCall > -1, `no ssh call reads the box clock:\n${run.argv}`);
  assert.ok(dateCall < curlCall && curlCall < logsCall, "order must be: box clock, then the call, then the audit count");
});
