import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ops-edge.yml", "utf8").replaceAll("\r\n", "\n");

function jobBlock(name, nextName) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start + 1) : workflow.length;
  assert.notEqual(end, -1, `missing ${nextName} job after ${name}`);
  return workflow.slice(start, end);
}

test("push-triggered Ops Origin converges a legacy Serve topology", () => {
  const applyServe = jobBlock("apply-serve", "smoke");

  assert.match(
    applyServe,
    /if:\s*needs\.deploy\.result == 'success' && needs\.deploy\.outputs\.serve_state == 'legacy' && \(github\.event_name == 'push' \|\| inputs\.apply_serve_after_origin == true\)/,
    "apply-serve must run for a legacy topology after a push to main while preserving the explicit workflow-dispatch opt-in",
  );
  assert.match(applyServe, /uses:\s*\.\/\.github\/workflows\/ops-serve-apply\.yml/);
});

test("an already-converged gateway skips Serve mutation and proceeds to smoke", () => {
  const smoke = jobBlock("smoke");
  assert.match(
    smoke,
    /if:\s*needs\.deploy\.result == 'success' && needs\.deploy\.outputs\.serve_state == 'gateway'/,
  );
});
