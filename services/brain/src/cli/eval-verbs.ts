/**
 * `brain eval run` and `brain eval capture <run_id>` (m4-19, 07-brain-
 * architecture.md section 7.11). Same shape as verbs.ts: the exit-code and
 * JSON decisions live here as testable functions, and bin/brain.mjs does
 * only argv parsing.
 *
 * These are separate from verbs.ts because they are the one part of the CLI
 * that needs an adapter registry -- and specifically NOT the production
 * one. See adapters/fixture.ts for why the eval path scripts harness
 * outcomes, and bin/brain.mjs for the single place that wiring happens.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../store.ts";
import { RunJournal } from "../journal.ts";
import type { BrainConfig } from "../config.ts";
import type { AdapterRegistry } from "../router.ts";
import { captureEvalCase, loadEvalCases, runEvalCorpus, type CorpusReport } from "../evals.ts";
import { EXIT_OK, EXIT_ERROR, EXIT_NOT_FOUND, type VerbResult } from "./result.ts";

export interface EvalRunArgs {
  adapters: AdapterRegistry;
  casesDir?: string;
  /** Writes runs, tasks, and eval_case/eval_result rows into the
   * CONFIGURED store instead of a throwaway one. Off by default: a corpus
   * run is a regression check, and re-running the gate should not silently
   * accumulate synthetic runs in an operator's real history (or require a
   * writable /data just to type `brain eval run`). */
  persist?: boolean;
}

function formatReport(report: CorpusReport): string {
  const lines = report.cases.map((c) => {
    const head = `${c.passed ? "PASS" : "FAIL"}  ${c.caseId}  status=${c.status ?? "none"}  ${c.durationMs}ms`;
    return c.passed ? head : [head, ...c.failures.map((f) => `        ${f}`)].join("\n");
  });
  lines.push("", `${report.passed}/${report.total} case(s) passed`);
  return lines.join("\n");
}

/** Exit 0 only when every case passed; exit 1 on any regression (m4-19's
 * own acceptance criterion, and what makes this usable as a CI gate).
 *
 * An EMPTY corpus is deliberately exit 0 with a warning rather than a
 * failure: `brain eval run` has to be wired into brain-ci.yml before the
 * seed cases exist (m6-01 is a separate issue from this harness), and a
 * gate that fails on "no cases yet" would block its own dependency. Once
 * cases exist, deleting them to make the gate pass is a visible diff. */
export async function evalRunVerb(config: BrainConfig, args: EvalRunArgs): Promise<VerbResult> {
  let cases;
  try {
    cases = loadEvalCases(args.casesDir);
  } catch (err) {
    const message = `eval corpus could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
    return { exitCode: EXIT_ERROR, json: { error: message }, humanText: message };
  }

  if (cases.length === 0) {
    const message = "eval corpus is empty: no *.case.json under the cases directory (see services/brain/evals/cases/README.md)";
    return { exitCode: EXIT_OK, json: { total: 0, passed: 0, failed: 0, cases: [] }, humanText: message };
  }

  const scratch = args.persist ? undefined : mkdtempSync(path.join(os.tmpdir(), "brain-eval-"));
  const dbPath = scratch ? path.join(scratch, "eval.db") : config.dbPath;
  const dataDir = scratch ?? config.dataDir;
  const workspacesRoot = scratch ? path.join(scratch, "workspaces") : config.workspacesRoot;

  const store = new BrainStore(dbPath);
  try {
    const report = await runEvalCorpus(cases, {
      store,
      adapters: args.adapters,
      workspacesRoot,
      journal: new RunJournal(dataDir),
    });
    return {
      exitCode: report.failed === 0 ? EXIT_OK : EXIT_ERROR,
      json: report,
      humanText: formatReport(report),
    };
  } finally {
    store.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

export interface EvalCaptureArgs {
  runId: string;
  caseId: string;
  casesDir?: string;
  taskId?: string;
}

export function evalCaptureVerb(store: BrainStore, args: EvalCaptureArgs): VerbResult {
  try {
    const { filePath, spec } = captureEvalCase({
      store,
      runId: args.runId,
      caseId: args.caseId,
      casesDir: args.casesDir,
      taskId: args.taskId,
    });
    const message = [
      `wrote ${filePath}`,
      `expected: status=${spec.expected.status}, ${spec.expected.verdicts.length} verdict(s), ceiling $${spec.expected.max_cost_usd}`,
      "review the expected block before merging: it records what the run DID, not necessarily what it should do",
    ].join("\n");
    return { exitCode: EXIT_OK, json: { file: filePath, case_id: spec.case_id, expected: spec.expected }, humanText: message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notFound = /not found|has no tasks|is not part of run/.test(message);
    return { exitCode: notFound ? EXIT_NOT_FOUND : EXIT_ERROR, json: { error: message }, humanText: message };
  }
}
