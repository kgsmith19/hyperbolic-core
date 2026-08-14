#!/usr/bin/env node
// Minimal `brain` CLI (m4-08's own pulled-forward slice of m4-13's full
// scope, same "skeleton now, harden later" precedent m3-06/m4-05 already
// established for services/llm-handler): just enough of `brain status` to
// satisfy this issue's own acceptance criterion ("<start command> && brain
// status; echo $? prints 0"). The rest of the CLI verb surface (run,
// approve, ...) is m4-13's job.
import { loadConfig } from "../src/config.ts";

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.error("usage: brain status [--offline]");
  process.exitCode = 2;
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

switch (command) {
  case "status":
    process.exitCode = await statusCommand(args.slice(1));
    break;
  default:
    usage();
}
