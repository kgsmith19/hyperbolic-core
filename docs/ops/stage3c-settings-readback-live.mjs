#!/usr/bin/env node
// docs/ops/stage3c-settings-readback-live.mjs
//
// Stage 3c (#387) live read-back: read the live `main` ruleset through the
// GitHub API and assert it matches the owner-approved squash-only,
// exact-head, one-Gate policy. Read-only — it performs no writes.
//
// Usage (any of):
//   gh auth login
//   GITHUB_TOKEN=<token> node docs/ops/stage3c-settings-readback-live.mjs
//   READBACK_OWNER=kgsmith19 READBACK_REPO=hyperbolic-core \
//     READBACK_RULESET_ID=20904976 node docs/ops/stage3c-settings-readback-live.mjs
//
// Exit 0 = zero drift; exit 1 = drift (prints the exact findings).

import { execFileSync } from "node:child_process";
import { APPROVED, drift, snapshotFromRuleset } from "./stage3c-settings-readback-lib.mjs";

const OWNER = process.env.READBACK_OWNER ?? "kgsmith19";
const REPO = process.env.READBACK_REPO ?? "hyperbolic-core";
const RULESET_ID = process.env.READBACK_RULESET_ID ?? "20904976";

function ghApi(path) {
  const env = { ...process.env };
  if (env.GITHUB_TOKEN && !env.GH_TOKEN) env.GH_TOKEN = env.GITHUB_TOKEN;
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", env }));
}

const ruleset = ghApi(`repos/${OWNER}/${REPO}/rulesets/${RULESET_ID}`);
const snapshot = snapshotFromRuleset(ruleset);
const findings = drift(snapshot);

console.log(`Live read-back: ${OWNER}/${REPO} ruleset ${RULESET_ID} "${ruleset.name}"`);
console.log(`snapshot : ${JSON.stringify(snapshot)}`);
console.log(`approved : ${JSON.stringify(APPROVED)}`);

if (findings.length > 0) {
  console.error(`DRIFT DETECTED: ${findings.join(", ")}`);
  process.exit(1);
}
console.log("Read-back clean: zero drift.");
