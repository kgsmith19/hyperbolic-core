#!/usr/bin/env node
// PROOF TIER: drives the kernel through a REAL Claude Code process.
//
// The fast tier (node --test kernel/*.test.mjs) proves every piece in
// isolation with a fake adapter. This proves the promise those pieces add up
// to: the generated settings actually load, --tools actually restricts the
// tool set, the guardhook actually fires inside a real harness process, a
// denied write is actually denied, and the ledger record of all that is real
// — none of which a fake adapter can prove.
//
// It is NOT hermetic and it SPENDS TOKENS. Run deliberately:
//   node kernel/kernel.e2e.mjs
//
// ISOLATION, and its deliberate limit: ACC_ROOT/ACC_POLICY/ACC_VAULT are
// sandboxed per scenario, so live ledger/policy/vault state is untouched.
// ACC_LANE_DIR is deliberately NOT sandboxed — a real run takes a real
// machine-wide launch-lane slot and queues behind any other automated
// launch, which is intended (kernel/adapters/claude-code.mjs:AC-A4).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRuns, readDecisions } from "./ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const RUN = path.join(HERE, "run.mjs");

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-e2e-"));
  const root = path.join(base, "acc");
  fs.mkdirSync(root, { recursive: true });
  // kernel/ledger.mjs's own readers (used below) re-read ACC_ROOT on every
  // call, so pointing THIS process at the sandbox is enough to reuse them
  // instead of re-parsing the JSONL ledger by hand.
  process.env.ACC_ROOT = root;
  const policyPath = path.join(base, "policy.json");
  fs.copyFileSync(path.join(REPO, "policy.json"), policyPath);
  const vaultPath = path.join(base, "vault.json");
  fs.writeFileSync(vaultPath, "{}");
  const workDir = path.join(base, "work");
  const decoyDir = path.join(base, "decoy");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(decoyDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "target.txt"), "before");
  return { base, root, policyPath, vaultPath, workDir, decoyDir };
}

// Same contract both scenarios; only writeRoots differs — that IS the deny
// proof.
function contractFor(sb, writeRoots) {
  const target = path.join(sb.workDir, "target.txt");
  return {
    goal: `Replace the word "before" with the word "after" in the file at ${target}, then stop.`,
    constraints: ["make only the one substitution described in the goal"],
    allowedActions: {
      readRoots: [sb.workDir], writeRoots,
      bashPatterns: [], networkHosts: [], vaultKeys: [], subagents: [],
    },
    budget: { wallClockMin: 5, toolCalls: 30, tokens: 100000 },
    acceptanceCriteria: [{
      id: "AC1", ears: "THE SYSTEM SHALL replace before with after in target.txt.",
      verify: { method: "file_contains", path: target, pattern: "after" },
    }],
    rollbackPlan: "overwrite target.txt with the literal text 'before'",
  };
}

function runKernel(sb, contract) {
  const contractPath = path.join(sb.base, `contract-${Date.now()}.json`);
  fs.writeFileSync(contractPath, JSON.stringify(contract));
  const env = { ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath, ACC_VAULT: sb.vaultPath };
  try {
    return JSON.parse(execFileSync("node", [RUN, contractPath], { encoding: "utf8", env, windowsHide: true, timeout: 10 * 60 * 1000 }));
  } catch (e) {
    return JSON.parse(e.stdout || "{}");
  }
}

const listSafe = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

const results = [];
function report(n, name, pass, evidence) {
  results.push({ n, name, pass });
  console.log(`\nSCENARIO ${n} ${pass ? "PASS" : "FAIL"} - ${name}`);
  console.log(String(evidence || "(no evidence captured)").split("\n").map((l) => "    " + l).join("\n"));
}

// ---------------------------------------------------------------- scenario 1
// The whole lifecycle in one run: the settings actually load, --tools actually
// grants Edit, the guardhook allows the in-scope write, the harness makes the
// edit, and the kernel's OWN post-exit verification (not the harness's say-so)
// finds it and accepts the run.
async function scenario1() {
  const sb = sandbox();
  try {
    const r = runKernel(sb, contractFor(sb, [sb.workDir]));
    const rows = readRuns();
    const started = rows.filter((x) => x.event === "run_started" && x.runId === r.runId);
    const finalized = rows.filter((x) => x.event === "run_finalized" && x.runId === r.runId);
    const text = fs.readFileSync(path.join(sb.workDir, "target.txt"), "utf8");
    const decisions = readDecisions(r.runId);
    const allowedWrite = decisions.find((d) => d.allow === true && d.rule === "writeRoots");

    const pass = started.length === 1 && finalized.length === 1 && r.outcome === "accepted" &&
      text.includes("after") && !!allowedWrite;
    report(1, "real harness edits the file inside its allowed write root; kernel verifies and accepts", pass,
      `runId: ${r.runId}\noutcome: ${r.outcome}\ntarget.txt: ${JSON.stringify(text)}\n` +
      `started=${started.length} finalized=${finalized.length}\nallowed write decision: ${JSON.stringify(allowedWrite)}`);
  } finally {
    fs.rmSync(sb.base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- scenario 2
// THE DENY PROOF. The same contract, writeRoots pointed at a directory that
// does not contain target.txt: the guard must deny every attempted write to
// the real target, the file must stay untouched, and the run must end
// rejected because the kernel's own verifier (never the harness) finds no
// evidence of the edit.
async function scenario2() {
  const sb = sandbox();
  try {
    const r = runKernel(sb, contractFor(sb, [sb.decoyDir]));
    const text = fs.readFileSync(path.join(sb.workDir, "target.txt"), "utf8");
    const decisions = readDecisions(r.runId);
    const deniedWrite = decisions.find((d) => d.allow === false && d.rule === "writeRoots");

    const pass = r.outcome === "rejected" && text === "before" && !!deniedWrite;
    report(2, "writeRoots elsewhere: the real target is denied, untouched, and the run is rejected", pass,
      `runId: ${r.runId}\noutcome: ${r.outcome}\ntarget.txt: ${JSON.stringify(text)}\n` +
      `denied write decision: ${JSON.stringify(deniedWrite)}`);
  } finally {
    fs.rmSync(sb.base, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- pollution check
// Neither scenario is allowed to leave a mark on the live ACC goal-loop state
// this kernel effort shares a repo with. A user-level hook firing inside a
// kernel run would show up here — if it does, this is NOT fixed silently:
// it is ledgered and reported instead.
function checkNoPollution(before) {
  const after = listSafe(path.join(REPO, "runner", "directives"));
  const pass = JSON.stringify(before) === JSON.stringify(after);
  report("pollution", "no new file appears under the LIVE runner/directives/ during kernel runs", pass,
    `before: ${JSON.stringify(before)}\nafter:  ${JSON.stringify(after)}`);
}

const liveGoalsBefore = listSafe(path.join(REPO, "runner", "directives"));
await scenario1();
await scenario2();
checkNoPollution(liveGoalsBefore);

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} scenarios passed`);
process.exit(results.some((r) => !r.pass) ? 1 : 0);
