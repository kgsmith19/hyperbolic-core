// Cloud-ops freeze (hyperbolic-core#499). By owner decision (2026-10-29) the
// platform moves to local-only, so no workflow may reach Hetzner, Tailscale or
// Supabase on its own while that migration lands on main: a push deploy would
// ship half-migrated code to the live VPS. Each listed workflow's jobs must
// all hang off one read-flags.yml call, gated on cloud_ops_enabled.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = "needs.flags.outputs.cloud_ops_enabled == 'true'";

// Every workflow that reaches the cloud from a push, schedule or workflow_run.
export const FROZEN = [
  "auto-merge-deploy-reconcile.yml",
  "deploy.yml",
  "lifeos-backup.yml",
  "lifeos-deploy.yml",
  "ops-broker-canary.yml",
  "ops-edge.yml",
  "ops-restore-drill.yml",
  "platform-backup.yml",
];

/** Names of the jobs the flag gate fails to hold off: none, when the freeze holds. */
export function ungatedJobs(workflowText) {
  const jobs = parse(workflowText).jobs ?? {};
  if (jobs.flags?.uses !== "./.github/workflows/read-flags.yml") return ["flags"];
  const needsOf = (job) => [].concat(jobs[job].needs ?? []);
  const gated = new Map([["flags", false]]);
  const isGated = (job) => {
    if (gated.has(job)) return gated.get(job);
    gated.set(job, false); // a cycle is never gated
    const needs = needsOf(job);
    const own = needs.includes("flags") && String(jobs[job].if ?? "").includes(GATE);
    // A job downstream of a gated job is held off only without always(), or when it
    // also requires an upstream result that a skipped job never produces.
    const condition = String(jobs[job].if ?? "");
    const inherited = needs.some((n) => n !== "flags" && isGated(n)) &&
      (!/always\(\)|!cancelled\(\)/.test(condition) || /needs\.[\w-]+\.(outputs\.[\w-]+ == 'true'|result == 'success')/.test(condition));
    gated.set(job, own || inherited);
    return own || inherited;
  };
  return Object.keys(jobs).filter((job) => job !== "flags" && !isGated(job));
}

test("every cloud workflow is held off by cloud_ops_enabled, job by job (#499)", () => {
  for (const file of FROZEN) {
    const text = readFileSync(path.join(root, ".github/workflows", file), "utf8");
    assert.deepEqual(ungatedJobs(text), [], `${file}: jobs not behind the cloud_ops_enabled gate`);
  }
});

test("ungatedJobs rejects a missing flags call, a root job without the gate, and an always() escape", () => {
  const ok = `jobs:
  flags:
    uses: ./.github/workflows/read-flags.yml
  a:
    needs: flags
    if: ${GATE}
  b:
    needs: a
  c:
    needs: [a, b]
    if: always() && needs.b.result == 'success'
`;
  assert.deepEqual(ungatedJobs(ok), []);
  assert.deepEqual(ungatedJobs(ok.replace("read-flags.yml", "other.yml")), ["flags"]);
  assert.deepEqual(ungatedJobs(ok.replace(`if: ${GATE}`, "if: true")), ["a", "b", "c"]);
  assert.deepEqual(ungatedJobs(`${ok}  d:\n    runs-on: ubuntu-latest\n`), ["d"]);
  assert.deepEqual(ungatedJobs(`${ok}  e:\n    needs: a\n    if: always()\n`), ["e"]);
});
