#!/usr/bin/env node
// The orchestrator: one task contract in, one ledger record out.
//
//   node kernel/run.mjs <contract.json>
//
// Two distinct failure shapes, deliberately not conflated:
//   refused        — the contract is incomplete or unsafe. No runId, no ledger
//                    entry, nothing spawned. It never became a run.
//   failed-to-start — the contract was fine but the harness would not start.
//                    That IS a run and it gets the full started/finalized pair.
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadContract, validateContract, toolsFor } from "./contract.mjs";
import { resolveAdapter } from "./adapter.mjs";
import { appendStarted, appendFinalized, decisionCounts } from "./ledger.mjs";
import { writeRunFiles, verifySettingsPin, cleanupRun } from "./settings.mjs";
import { envForKeys } from "./credentials.mjs";
import { verifyAll } from "./verifier.mjs";
import { effectiveCeilings, checkpointVerdict, updateAfterRun, readAutonomy } from "./autonomy.mjs";
import { loadKernelPolicy } from "./policy.mjs";

export function newRunId() {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return `r-${t}-${randomBytes(3).toString("hex")}`;
}

// The workspace a run acts in: the first write root, else the first read root.
// writeRoots/readRoots are each optional (contract.mjs validates them only
// when present), so a contract naming neither falls back to cwd.
function workspaceOf(contract) {
  const a = contract.allowedActions; // required by contract.mjs; never absent here
  return (a.writeRoots || [])[0] || (a.readRoots || [])[0] || process.cwd();
}

// What the harness is actually told to do. The contract's own fields, never a
// rewritten or summarized version of them. constraints and acceptanceCriteria
// are both required by contract.mjs, so neither is ever absent here.
function promptFor(contract) {
  return [
    contract.goal,
    "",
    "Constraints:",
    ...contract.constraints.map((c) => `- ${c}`),
    "",
    "This work is accepted only if every one of these holds:",
    ...contract.acceptanceCriteria.map((c) => `- [${c.id}] ${c.ears}`),
    "",
    "Actions outside the task contract are blocked by the kernel guard and logged.",
  ].join("\n");
}

export async function runTask(contractPath, { adapter, afterStage, tickMs = 60000 } = {}) {
  const contract = loadContract(contractPath);
  const { ok, errors } = validateContract(contract);
  if (!ok) {
    for (const e of errors) console.error(`kernel: ${e}`);
    return { runId: null, outcome: "refused", errors };
  }

  const runId = newRunId();
  const startedAt = Date.now();
  const guardhookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "guardhook.mjs");
  const staged = writeRunFiles(contract, { runId, guardhookPath });

  appendStarted({
    runId, startedAt: new Date(startedAt).toISOString(),
    contract, settingsSha256: staged.sha256,
  });

  const finalize = (extra) => {
    const entry = {
      runId, finishedAt: new Date().toISOString(), wallClockMs: Date.now() - startedAt,
      decisions: decisionCounts(runId), ...extra,
    };
    appendFinalized(entry);
    cleanupRun(runId);
    return { runId, errors: [], ...entry };
  };
  const failClosed = (message, harness = null) => {
    console.error(`kernel: ${message}`);
    return finalize({ outcome: "failed-to-start", harness, error: message, criteria: [], tokens: 0 });
  };

  // OI-019: resolveAdapter() used to run BEFORE runId/staged/appendStarted
  // even existed, with no try/catch — an unavailable harness (e.g. a
  // policy.json kernel.harness typo naming an adapter module that doesn't
  // exist) crashed runTask's own promise with no ledger entry at all, not
  // even the "failed-to-start... IS a run and it gets the full started/
  // finalized pair" this file's own header promises for every other
  // post-contract failure. Moved below the scaffolding and wrapped in the
  // same failClosed() identity() already uses just below — resolving the
  // adapter and asking its identity are both "can this harness even start,"
  // and both now get identical fail-closed treatment.
  let harnessAdapter;
  try {
    harnessAdapter = adapter || (await resolveAdapter());
  } catch (e) {
    return failClosed(e.message);
  }

  let harness;
  try {
    harness = harnessAdapter.identity();
  } catch (e) {
    return failClosed(e.message);
  }

  // Test seam: lets a test mutate the staging directory between the pin and
  // the launch, which is the only way to prove the pre-launch integrity check
  // actually blocks a tampered file rather than a mocked one.
  if (afterStage) afterStage(staged.dir);

  const integrity = verifySettingsPin(staged.dir);
  if (!integrity.ok) {
    return failClosed(`settings integrity check failed before launch (expected ${integrity.expected}, got ${integrity.actual})`, harness);
  }

  let credentials;
  try {
    credentials = envForKeys(contract.allowedActions?.vaultKeys || []);
  } catch (e) {
    return failClosed(e.message, harness);
  }

  let handle;
  try {
    handle = await harnessAdapter.startTask({
      runId,
      prompt: promptFor(contract),
      settingsPath: staged.settingsPath,
      contractPath: staged.contractPath,
      sessionId: randomUUID(),
      tools: toolsFor(contract),
      cwd: workspaceOf(contract),
      ttlMs: (contract.budget?.wallClockMin ?? 60) * 60 * 1000,
      env: { ...credentials, ACC_KERNEL_DIR: staged.dir },
    });
  } catch (e) {
    return failClosed(e.message, harness);
  }

  // Supervised wait: re-evaluate the run against its ceilings on every tick,
  // never trusting the harness to police itself. A breach stops the harness
  // and the run finalizes as aborted-by-budget with the dimension that broke.
  const policy = loadKernelPolicy();
  const ceilings = effectiveCeilings(contract, policy, readAutonomy());
  const ticksPerCheckpoint = Math.max(1, Math.round((policy.checkpointMin * 60000) / tickMs));

  let breach = null;
  let ticks = 0;
  let attemptsAtLastCheckpoint = 0;
  const timer = setInterval(() => {
    ticks += 1;
    let verdict;
    try {
      const checkpointDue = ticks % ticksPerCheckpoint === 0;
      verdict = checkpointVerdict({
        elapsedMs: Date.now() - startedAt,
        ceilings,
        tokens: harnessAdapter.readState(handle.events || []).tokens,
        attemptsNow: decisionCounts(runId).total,
        attemptsAtLastCheckpoint,
        checkpointDue,
      });
      if (checkpointDue) attemptsAtLastCheckpoint = decisionCounts(runId).total;
    } catch (e) {
      // OI-019: a timer callback is not inside runTask's own try/catch — an
      // adapter (or anything else in this block) throwing here is a real
      // uncaughtException that kills the WHOLE kernel process, orphaning the
      // harness child with no ledger entry at all. The adapter interface
      // (kernel/adapter.mjs) only checks shape, never behavior, and this file
      // already refuses to trust the harness to police its own budget — a
      // tick that cannot even be evaluated gets the same fail-closed
      // treatment as a genuine breach, not a crash.
      verdict = { stop: true, dimension: "supervisor-fault", reason: e.message };
    }
    if (verdict.stop && !breach) {
      breach = verdict;
      clearInterval(timer);
      Promise.resolve(harnessAdapter.stopTask(handle)).catch(() => {});
    }
  }, tickMs);
  // Deliberately left ref'd: this interval is the ONLY mechanism that
  // detects a budget breach. Unref'ing it let Node end the process/promise
  // wait before the timer fired again whenever nothing else held the event
  // loop open (a fully-mocked adapter's `handle.done`, in particular) --
  // observed as CI-only failures on Node 22 (kernel/run.test.mjs AC-B1/AC-B2:
  // "Promise resolution is still pending but the event loop has already
  // resolved"), never locally on Node 24. `clearInterval` already runs the
  // instant `handle.done` resolves (see the `finally` below), so staying
  // ref'd costs nothing at CLI-exit time -- it only keeps the process alive
  // for exactly as long as supervision is actually in progress.

  try {
    await handle.done;
  } finally {
    clearInterval(timer);
  }

  // The harness has already exited by the time either finalize path below
  // runs, so a readState() fault here cannot hide an ongoing budget breach
  // the way it could mid-loop (hence the tick above fails the run closed
  // instead) — falling back to 0 loses at most a stale token count on a run
  // that is finishing regardless, never masks a live runaway (OI-019).
  const safeTokens = () => {
    try { return harnessAdapter.readState(handle.events || []).tokens; }
    catch { return 0; }
  };

  if (breach) {
    const aborted = finalize({
      outcome: "aborted-by-budget", dimension: breach.dimension, error: breach.reason,
      harness, criteria: [], tokens: safeTokens(),
    });
    updateAfterRun(policy);
    return aborted;
  }

  // Only now, with the harness process gone, does the kernel form its own
  // opinion — from the filesystem, never from what the harness said (AC-V3).
  const tokens = safeTokens();
  const { criteria, accepted } = await verifyAll(contract, { cwd: workspaceOf(contract) });

  const outcome = finalize({
    outcome: accepted ? "accepted" : "rejected",
    harness, criteria, tokens,
  });
  updateAfterRun(policy);
  return outcome;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node kernel/run.mjs <contract.json>");
    process.exit(2);
  }
  const result = await runTask(file);
  console.log(JSON.stringify(result));
  process.exit(result.outcome === "accepted" ? 0 : 2);
}
