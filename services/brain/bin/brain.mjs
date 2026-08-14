#!/usr/bin/env node
// `brain` CLI (m4-13): the verb/flag/exit-code contract of 07-brain-
// architecture.md section 7.8's CLI table. This file is only argv
// parsing and dispatch -- every verb's actual logic lives in
// src/cli/verbs.ts (pure, store/journal/config-only functions), so the
// exit-code/JSON-shape decisions are unit-testable without spawning a
// subprocess per scenario. The HTTP API is m4-14's.
//
// Global behavior (07 section 7.8): --json makes stdout a single JSON
// document with all human text on stderr; this file never reads stdin or
// prompts interactively for ANY verb, regardless of TTY-ness -- there is
// simply no prompt-reading code path here at all, which is the only way
// to make "no interactive prompts when stdin is not a TTY" unconditionally
// true rather than conditionally correct.
import { loadConfig } from "../src/config.ts";
import { BrainStore } from "../src/store.ts";
import { RunJournal } from "../src/journal.ts";
import {
  runVerb,
  statusVerb,
  tasksVerb,
  approveVerb,
  rejectVerb,
  cancelVerb,
  resumeVerb,
  logsVerb,
  costVerb,
  refreshContextVerb,
  configVerb,
  evalRunVerb,
  evalCaptureVerb,
} from "../src/cli/verbs.ts";
import { emit } from "../src/cli/result.ts";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.ts";
import { codexAdapter, geminiAdapter } from "../src/adapters/stub.ts";

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);
const jsonMode = rest.includes("--json");

function usage() {
  console.error("usage: brain <run|status|tasks|approve|reject|cancel|resume|logs|cost|refresh-context|config|eval|status(--offline)> ...");
  console.error('       brain run "<objective>" [--repo <url>] [--ref <ref>] [--autonomy 0..3] [--harness <id>] [--budget-tokens N] [--dry-run] [--json]');
  console.error("       brain run --contract <path> [--dry-run] [--json]");
  console.error("       brain status [run_id] [--json]");
  console.error("       brain tasks <run_id> [--json]");
  console.error("       brain approve <task_id> [--json]");
  console.error("       brain reject <task_id> [--reason <text>] [--json]");
  console.error("       brain cancel <run_id|task_id> [--json]");
  console.error("       brain resume <run_id> [--json]");
  console.error("       brain logs <run_id> [--follow] [--task <id>]");
  console.error("       brain cost [--since <ts>] [--run <id>] [--json]");
  console.error("       brain refresh-context [--json]");
  console.error("       brain config [get <key> | set <key> <value>] [--json]");
  console.error("       brain eval run [--json]");
  console.error("       brain eval capture <run_id> [--case-id <id>] [--description <text>] [--json]");
  process.exitCode = 2;
}

function flagValue(list, name) {
  const idx = list.indexOf(name);
  if (idx === -1) return undefined;
  const value = list[idx + 1];
  list.splice(idx, value === undefined ? 1 : 2);
  return value;
}

function stripFlag(list, name) {
  const idx = list.indexOf(name);
  if (idx === -1) return false;
  list.splice(idx, 1);
  return true;
}

function positionals(list) {
  return list.filter((a) => !a.startsWith("--"));
}

function withStore(config, fn) {
  const store = new BrainStore(config.dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function statusCommand(rest) {
  // --offline: used by brain-ci.yml's Docker build-and-smoke step (10
  // section 1.3), where no daemon process is actually running inside the
  // image being verified -- this proves the CLI binary itself starts and
  // runs cleanly. Kept as its own smoke-check mode distinct from 07
  // section 7.8's own `brain status [run_id]` contract below (a live
  // daemon health probe is `GET /api/brain/health`, m4-14's HTTP API,
  // not this CLI verb -- the table's own "run/task table or JSON" stdout
  // description has nothing to do with process liveness).
  if (rest.includes("--offline")) {
    console.log(JSON.stringify({ status: "ok", mode: "offline", note: "CLI smoke check only, no live daemon contacted" }));
    return 0;
  }
  const watch = stripFlag(rest, "--watch");
  const config = loadConfig();
  const runId = positionals(rest)[0];
  const result = withStore(config, (store) => statusVerb(store, runId));
  emit(result, jsonMode);
  if (watch && result.exitCode === 0) {
    // Poll-and-redraw, no TTY interaction of any kind -- Ctrl-C (SIGINT)
    // ends it, same as `logs --follow`. Real live-update (SSE) is the UI
    // surface's job (m4-15/16); this is the CLI's own honest, simple
    // version of the same idea.
    return new Promise(() => {
      setInterval(() => {
        const next = withStore(config, (store) => statusVerb(store, runId));
        emit(next, jsonMode);
      }, 2000).unref();
    });
  }
  return result.exitCode;
}

function runCommand(rest) {
  const dryRun = stripFlag(rest, "--dry-run");
  const contractPath = flagValue(rest, "--contract");
  const repoUrl = flagValue(rest, "--repo");
  const repoRef = flagValue(rest, "--ref");
  const autonomyRaw = flagValue(rest, "--autonomy");
  const harnessPreferred = flagValue(rest, "--harness");
  const budgetTokensRaw = flagValue(rest, "--budget-tokens");
  const objective = positionals(rest).join(" ").trim() || undefined;

  if (!contractPath && !objective) {
    usage();
    return 2;
  }

  const config = loadConfig();
  return withStore(config, (store) => {
    const journal = new RunJournal(config.dataDir);
    const result = runVerb(store, journal, config, {
      objective,
      contractPath,
      repoUrl,
      repoRef,
      autonomy: autonomyRaw === undefined ? undefined : Number(autonomyRaw),
      harnessPreferred: harnessPreferred ?? undefined,
      budgetTokens: budgetTokensRaw === undefined ? undefined : Number(budgetTokensRaw),
      dryRun,
    });
    emit(result, jsonMode);
    return result.exitCode;
  });
}

function tasksCommand(rest) {
  const runId = positionals(rest)[0];
  if (!runId) {
    usage();
    return 2;
  }
  const config = loadConfig();
  const result = withStore(config, (store) => tasksVerb(store, runId));
  emit(result, jsonMode);
  return result.exitCode;
}

function approveCommand(rest) {
  const taskId = positionals(rest)[0];
  if (!taskId) {
    usage();
    return 2;
  }
  const config = loadConfig();
  const result = withStore(config, (store) => approveVerb(store, new RunJournal(config.dataDir), taskId));
  emit(result, jsonMode);
  return result.exitCode;
}

function rejectCommand(rest) {
  const reason = flagValue(rest, "--reason");
  const taskId = positionals(rest)[0];
  if (!taskId) {
    usage();
    return 2;
  }
  const config = loadConfig();
  const result = withStore(config, (store) => rejectVerb(store, new RunJournal(config.dataDir), taskId, reason));
  emit(result, jsonMode);
  return result.exitCode;
}

function cancelCommand(rest) {
  const id = positionals(rest)[0];
  if (!id) {
    usage();
    return 2;
  }
  const config = loadConfig();
  const result = withStore(config, (store) => cancelVerb(store, new RunJournal(config.dataDir), id));
  emit(result, jsonMode);
  return result.exitCode;
}

function resumeCommand(rest) {
  const runId = positionals(rest)[0];
  if (!runId) {
    usage();
    return 2;
  }
  const config = loadConfig();
  const result = withStore(config, (store) => resumeVerb(store, new RunJournal(config.dataDir), runId));
  emit(result, jsonMode);
  return result.exitCode;
}

async function logsCommand(rest) {
  const follow = stripFlag(rest, "--follow");
  const taskFilter = flagValue(rest, "--task");
  const runId = positionals(rest)[0];
  if (!runId) {
    usage();
    return 2;
  }
  const config = loadConfig();
  const store = new BrainStore(config.dbPath);
  const journal = new RunJournal(config.dataDir);
  try {
    let printed = 0;
    const printNew = () => {
      const result = logsVerb(store, journal, runId, taskFilter);
      if (result.exitCode !== 0) return result.exitCode;
      for (const line of result.lines.slice(printed)) console.log(line);
      printed = result.lines.length;
      return 0;
    };
    const exitCode = printNew();
    if (exitCode !== 0) {
      console.error(`run ${runId} not found`);
      return exitCode;
    }
    if (!follow) return 0;
    // --follow: poll the journal for new lines. No TTY interaction, no
    // prompts -- Ctrl-C (SIGINT) ends it, same as any other tail -f.
    await new Promise(() => {
      setInterval(printNew, 1000).unref();
    });
    return 0;
  } finally {
    store.close();
  }
}

function costCommand(rest) {
  const since = flagValue(rest, "--since");
  const runId = flagValue(rest, "--run");
  const config = loadConfig();
  const result = withStore(config, (store) => costVerb(store, { since, runId }));
  emit(result, jsonMode);
  return result.exitCode;
}

function refreshContextCommand() {
  const config = loadConfig();
  const result = refreshContextVerb(config);
  emit(result, jsonMode);
  return result.exitCode;
}

function evalAdapters(config) {
  return {
    "claude-code": new ClaudeCodeAdapter({
      kernelRunPath: config.kernelRunPath,
      accRoot: config.accRoot,
      accPolicy: config.accPolicy,
      accVault: config.accVault,
    }),
    codex: codexAdapter,
    gemini: geminiAdapter,
  };
}

async function evalCommand(rest) {
  const sub = positionals(rest)[0];
  const config = loadConfig();

  if (sub === "run") {
    const store = new BrainStore(config.dbPath);
    const journal = new RunJournal(config.dataDir);
    try {
      const result = await evalRunVerb(store, journal, { adapters: evalAdapters(config), workspacesRoot: config.workspacesRoot }, config.evalsCasesDir);
      emit(result, jsonMode);
      return result.exitCode;
    } finally {
      store.close();
    }
  }

  if (sub === "capture") {
    const runId = positionals(rest)[1];
    const caseId = flagValue(rest, "--case-id");
    const description = flagValue(rest, "--description");
    if (!runId) {
      usage();
      return 2;
    }
    const result = withStore(config, (store) => evalCaptureVerb(store, config.evalsCasesDir, { runId, caseId, description }));
    emit(result, jsonMode);
    return result.exitCode;
  }

  usage();
  return 2;
}

function configCommand(rest) {
  const positional = positionals(rest);
  const config = loadConfig();
  let result;
  if (positional[0] === "get") {
    result = configVerb(config, { action: "get", key: positional[1] });
  } else if (positional[0] === "set") {
    result = configVerb(config, { action: "set", key: positional[1], value: positional[2] });
  } else {
    result = configVerb(config, {});
  }
  emit(result, jsonMode);
  return result.exitCode;
}

try {
  switch (command) {
    case "status":
      process.exitCode = await statusCommand(rest);
      break;
    case "run":
      process.exitCode = runCommand(rest);
      break;
    case "tasks":
      process.exitCode = tasksCommand(rest);
      break;
    case "approve":
      process.exitCode = approveCommand(rest);
      break;
    case "reject":
      process.exitCode = rejectCommand(rest);
      break;
    case "cancel":
      process.exitCode = cancelCommand(rest);
      break;
    case "resume":
      process.exitCode = resumeCommand(rest);
      break;
    case "logs":
      process.exitCode = await logsCommand(rest);
      break;
    case "cost":
      process.exitCode = costCommand(rest);
      break;
    case "refresh-context":
      process.exitCode = refreshContextCommand();
      break;
    case "config":
      process.exitCode = configCommand(rest);
      break;
    case "eval":
      process.exitCode = await evalCommand(rest);
      break;
    default:
      usage();
  }
} catch (err) {
  console.error(`brain ${command ?? ""}: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
