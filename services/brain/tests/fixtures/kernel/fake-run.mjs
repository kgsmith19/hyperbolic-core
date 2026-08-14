#!/usr/bin/env node
// A fake stand-in for apps/agentic-command-center/kernel/run.mjs's own CLI
// contract (`node kernel/run.mjs <contract.json>`, one JSON line to
// stdout, exit 0 iff outcome === "accepted", else 2) -- used by
// claude-code-adapter.test.ts to prove the adapter's spawn/parse mechanics
// work against a REAL subprocess without needing a real `claude` binary or
// a fully provisioned ACC checkout. The scenario is picked by a marker
// embedded in the mapped kernel contract's own `goal` field (which is
// exactly contract.prompt.objective from the originating brain.task.v1
// contract, per kernel-contract.ts's mapping) rather than an env var, so
// concurrent test cases never interfere with each other's spawn env.
import fs from "node:fs";

const contractPath = process.argv[2];
if (!contractPath) {
  console.error("usage: node fake-run.mjs <contract.json>");
  process.exit(2);
}
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const goal = contract.goal ?? "";
const runId = "r-fake-" + Date.now();

function print(result) {
  console.log(JSON.stringify(result));
}

if (goal.includes("FAKE_OUTCOME=accepted")) {
  print({ runId, outcome: "accepted", errors: [], harness: { name: "claude-code", version: "1.0.0" }, criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 1234 });
  process.exit(0);
} else if (goal.includes("FAKE_OUTCOME=rejected")) {
  print({ runId, outcome: "rejected", errors: [], harness: { name: "claude-code", version: "1.0.0" }, criteria: [{ id: "AC-1", method: "command", status: "fail", detail: "exit 1" }], tokens: 500 });
  process.exit(2);
} else if (goal.includes("FAKE_OUTCOME=failed-to-start-transport")) {
  print({ runId, outcome: "failed-to-start", error: "429 rate limited", harness: null, criteria: [], tokens: 0 });
  process.exit(2);
} else if (goal.includes("FAKE_OUTCOME=failed-to-start-logic")) {
  print({ runId, outcome: "failed-to-start", error: "settings integrity check failed before launch", harness: null, criteria: [], tokens: 0 });
  process.exit(2);
} else if (goal.includes("FAKE_OUTCOME=echo-ids")) {
  // m4-17: stands in for "the kernel's own ledger entry carries the join
  // key" -- a real kernel/ledger.mjs appendStarted/appendFinalized stores
  // this whole contract (including _brainMeta) verbatim, so echoing it
  // back here proves the SAME data a real ledger read would see, without
  // this test needing to import or fake ledger.mjs itself. Also echoes
  // the env vars the adapter is meant to propagate (07 section 7.9:
  // "run_id -> task_id -> invocation_id propagate into kernel env").
  print({
    runId,
    outcome: "accepted",
    errors: [],
    harness: { name: "claude-code", version: "1.0.0" },
    criteria: [],
    tokens: 0,
    _brainMetaSeen: contract._brainMeta,
    envSeen: { runId: process.env.BRAIN_RUN_ID, taskId: process.env.BRAIN_TASK_ID, invocationId: process.env.BRAIN_INVOCATION_ID },
    // m4-18's own environment-audit verification bullet: what this
    // process actually received for credentials is a PATH (ACC_VAULT),
    // never a resolved secret value -- envForKeys (kernel/credentials.mjs)
    // is the one place that ever turns a vault key NAME into a value, and
    // it runs later, inside the real kernel's own startTask() call, which
    // this fixture stands in for rather than re-implements.
    accVaultSeen: process.env.ACC_VAULT ?? null,
  });
  process.exit(0);
} else if (goal.includes("FAKE_OUTCOME=noop")) {
  // Prints nothing parseable -- simulates the kernel process dying or
  // otherwise never producing its one expected JSON line.
  process.exit(1);
} else {
  // Default: same as accepted, so a fixture contract with no marker still
  // exercises the golden path.
  print({ runId, outcome: "accepted", errors: [], harness: { name: "claude-code", version: "1.0.0" }, criteria: [], tokens: 0 });
  process.exit(0);
}
