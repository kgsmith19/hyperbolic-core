// Queue v2 guard in this repo's PR Gate (#445; kgsmith19/agent-engineering-standard#287).
//
// Every PR must close only Issues that sit on the ACTIVE item of the owner's
// execution queue (agent-engineering-standard#277), unless the owner applied
// owner:queue-exempt. The rule lives in std's `tools/work_queue.py guard`;
// this repo only fetches std's three queue modules and runs it, inside the
// required "Repository Standards" lane.
//
// Structural tests pin the step into that lane and the action's contract.
// Behavioral tests extract the action's real bash body and run it against
// stub std CLIs served from a local directory, so a quietly deleted
// `set -e`, a swallowed exit code, or a half-fetched CLI is caught.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/pr-verify.yml"), "utf8").replace(/\r\n/g, "\n");
const actionPath = path.join(root, ".github/actions/verify-queue-guard/action.yml");
const MODULES = ["queue_core.py", "queue_store.py", "work_queue.py"];

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} exists`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function actionText() {
  assert.ok(existsSync(actionPath), "verify-queue-guard action exists");
  return readFileSync(actionPath, "utf8").replace(/\r\n/g, "\n");
}

function runBody() {
  // The composite action's single bash step, verbatim.
  const text = actionText();
  const marker = "      run: |\n";
  const at = text.indexOf(marker);
  assert.ok(at >= 0, "action has a run: | block");
  return text
    .slice(at + marker.length)
    .split("\n")
    .filter((line, i, all) => line.startsWith("        ") || line === "" )
    .map((line) => line.slice(8))
    .join("\n");
}

test("Repository Standards runs the queue guard (required lane, every non-closed PR event)", () => {
  const standards = job("repository-standards");
  const step = standards.split("- name: Standards · Work matches the execution queue")[1];
  assert.ok(step, "guard step present in repository-standards");
  const body = step.split("\n      - name:")[0];
  assert.match(body, /uses: \.\/\.github\/actions\/verify-queue-guard\n/);
  assert.match(body, /github_token: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(body, /continue-on-error/);
  assert.doesNotMatch(body, /\n\s+if:/, "the guard step must not be conditional");
  for (const kind of ["edited", "labeled", "unlabeled", "synchronize", "opened"]) {
    assert.match(workflow.split("\njobs:")[0], new RegExp(`- ${kind}\\n`), `re-runs on ${kind}`);
  }
});

test("verify-queue-guard fetches every std queue module from std main and runs guard --pr-event", () => {
  const text = actionText();
  assert.match(text, /using: composite/);
  assert.match(text, /raw\.githubusercontent\.com\/kgsmith19\/agent-engineering-standard\/main\/tools/);
  for (const module of MODULES) assert.ok(text.includes(module), `fetches ${module}`);
  assert.match(text, /guard --pr-event "\$GITHUB_EVENT_PATH"/);
  assert.match(text, /python3 -I /, "std code runs isolated");
  assert.match(runBody(), /^set -euo pipefail/m);
});

function stubDir(code, modules = MODULES) {
  const dir = mkdtempSync(path.join(tmpdir(), "queue-guard-stub-"));
  for (const module of modules) {
    const body = module === "work_queue.py"
      ? [
          "import os, sys",
          "open(os.environ['STUB_LOG'], 'a').write(' '.join(sys.argv[1:]) + '\\n')",
          "sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))",
          "import queue_core, queue_store",
          `print('guard stub exit ${code}')`,
          `sys.exit(${code})`,
        ].join("\n")
      : "OK = True\n";
    writeFileSync(path.join(dir, module), body + "\n");
  }
  return dir;
}

function runAction(base) {
  const scratch = mkdtempSync(path.join(tmpdir(), "queue-guard-run-"));
  const log = path.join(scratch, "calls.log");
  const event = path.join(scratch, "event.json");
  writeFileSync(event, "{}");
  const result = spawnSync("bash", ["-c", runBody()], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_PATH: event,
      GITHUB_TOKEN: "test-token",
      STANDARD_BASE_URL: `file://${base}`,
      STUB_LOG: log,
      RUNNER_TEMP: scratch,
    },
  });
  return { ...result, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

test("guard verdict passes through: 0 passes the lane, refusal fails it", () => {
  const ok = runAction(stubDir(0));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.calls.length, 1, "std's CLI ran exactly once");
  assert.match(ok.calls[0], /^guard --pr-event .*event\.json$/);
  const refused = runAction(stubDir(1));
  assert.equal(refused.status, 1);
  const malformed = runAction(stubDir(2));
  assert.equal(malformed.status, 2);
});

test("a half-fetched std never runs and fails the lane closed", () => {
  const partial = runAction(stubDir(0, ["queue_core.py", "work_queue.py"]));
  assert.notEqual(partial.status, 0);
  assert.deepEqual(partial.calls, []);
});
