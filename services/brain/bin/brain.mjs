#!/usr/bin/env node
// Minimal `brain` CLI (m4-08's own pulled-forward slice of m4-13's full
// scope, same "skeleton now, harden later" precedent m3-06/m4-05 already
// established for services/llm-handler): just enough of `brain status` to
// satisfy m4-08's own acceptance criterion ("<start command> && brain
// status; echo $? prints 0"), plus m4-09's own `brain run --dry-run`
// acceptance criterion. The rest of the CLI verb surface (approve, real
// non-dry-run dispatch, ...) is m4-13's job.
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { BrainStore } from "../src/store.ts";
import { submitRun, submitContract } from "../src/run-service.ts";

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.error("usage: brain status [--offline]");
  console.error('       brain run --dry-run "<objective>" [--repo-url <url>] [--repo-ref <ref>]');
  console.error("       brain run --dry-run --contract <path-to-brain.task.v1.json>");
  process.exitCode = 2;
}

function flagValue(rest, name) {
  const idx = rest.indexOf(name);
  if (idx === -1) return undefined;
  const value = rest[idx + 1];
  rest.splice(idx, value === undefined ? 1 : 2);
  return value;
}

async function statusCommand(rest) {
  // --offline: used by brain-ci.yml's Docker build-and-smoke step (10
  // section 1.3), where no daemon process is actually running inside the
  // image being verified -- this proves the CLI binary itself starts and
  // runs cleanly, without requiring a live /healthz to contact.
  if (rest.includes("--offline")) {
    console.log(JSON.stringify({ status: "ok", mode: "offline", note: "CLI smoke check only, no live daemon contacted" }));
    return 0;
  }
  const config = loadConfig();
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/healthz`);
    const body = await res.json();
    console.log(JSON.stringify(body));
    return res.ok ? 0 : 1;
  } catch (err) {
    console.error(`brain status: could not reach the daemon on port ${config.port}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// m4-09's own acceptance criteria only exercise --dry-run end to end (plan,
// schema-validate, journal, print, exit 0/2); real dispatch needs a
// submission path into the live daemon's scheduler, which is m4-10/m4-13's
// job. Refusing a non-dry-run invocation here, loudly, is more honest than
// silently only ever dry-running.
async function runCommand(rest) {
  const dryRunIdx = rest.indexOf("--dry-run");
  if (dryRunIdx === -1) {
    console.error("brain run: real dispatch is not implemented yet (lands with m4-10/m4-13); pass --dry-run");
    return 2;
  }
  rest.splice(dryRunIdx, 1);

  const contractPath = flagValue(rest, "--contract");
  const repoUrl = flagValue(rest, "--repo-url") ?? "https://github.com/kgsmith19/hyperbolic-core";
  const repoRef = flagValue(rest, "--repo-ref") ?? "main";

  let contract;
  let objective;
  if (contractPath) {
    try {
      contract = JSON.parse(readFileSync(contractPath, "utf8"));
    } catch (err) {
      console.error(`brain run: could not read --contract ${contractPath}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  } else {
    objective = rest.filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!objective) {
      usage();
      return 2;
    }
  }

  const config = loadConfig();
  const store = new BrainStore(config.dbPath);
  try {
    const result = contract
      ? submitContract(store, contract)
      : submitRun(store, { objective, repo: { url: repoUrl, ref: repoRef } });

    if (!result.ok) {
      console.error("brain run: contract failed schema validation:");
      for (const error of result.errors) console.error(`  ${error}`);
      return 2;
    }
    console.log(JSON.stringify(result.contracts, null, 2));
    return 0;
  } finally {
    store.close();
  }
}

switch (command) {
  case "status":
    process.exitCode = await statusCommand(args.slice(1));
    break;
  case "run":
    process.exitCode = await runCommand(args.slice(1));
    break;
  default:
    usage();
}
