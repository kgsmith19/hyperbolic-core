#!/usr/bin/env node
// guards runner — relaunch `claude -p` per board task; fresh context per run.
// Usage:
//   node runner.mjs <job>            run the loop now
//   node runner.mjs <job> --once     single claude run (debug)
//   node runner.mjs <job> --install  register Task Scheduler entry (job.schedule)
//   node runner.mjs <job> --status   show recent log lines + alerts
// Jobs live in runner/jobs/<job>.json — schema in README.md.
// Loop exit codes: 0 done, 2 stuck, 3 maxRuns, 4 stop file, 5 red week tier,
// 6 another loop already runs this job (pid-file singleton, SPEC-0005).

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { withLaunchSlot, retryTransport, pidAlive } from "../hooks/lane.mjs";
import { spawnSpec } from "../hooks/cmdline.mjs";
import { readDirective, appendCycle, lastCycleBody, KICK_TEXT, logPath, receiptsDir } from "../hooks/directive.mjs";
import { directiveSpend } from "../hooks/directive-spend.mjs";
import { writeReceiptOnce } from "../hooks/receipt.mjs";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// ACC_RUNNER_ROOT redirects logs/alerts/stop/jobs at a throwaway tree, same
// discipline as ACC_ROOT elsewhere (route.test.mjs, lane.test.mjs): so
// runner.test.mjs can drive real runLoop decisions without writing into the
// live runner/logs a real board depends on.
const ROOT = process.env.ACC_RUNNER_ROOT ? resolve(process.env.ACC_RUNNER_ROOT) : HERE;
const LOG_CAP = 1024 * 1024;
const CLAUDE_MAX_TURNS = 200;

// A directive-backed job (SPEC-0001, FR-011): the directive store supplies
// workdir and identity; the bootstrap is only the kick constant because
// budget.mjs's SessionStart hook injects the full directive context (text,
// log tail, done/blocked protocol) into any child carrying ACC_DIRECTIVE.
// Refusals are the contract: a non-active directive or one with no working
// folder can never start a run.
export function loadDirectiveJob(id) {
  const d = readDirective(id);
  if (!d || d.status !== "active") throw new Error(`directive "${id}" is not active — nothing to run`);
  if (!d.cwd) throw new Error(`directive "${id}" has no working folder (cwd) — a headless run needs one`);
  return {
    name: `directive-${id}`, workdir: d.cwd, bootstrap: KICK_TEXT, directiveId: id,
    profile: d.profile || "", maxStuck: 3, maxRuns: 100, runTimeoutMin: 180, maxTurns: CLAUDE_MAX_TURNS,
  };
}

export function loadJob(name) {
  if (name.startsWith("directive:")) return loadDirectiveJob(name.slice("directive:".length));
  const path = name.endsWith(".json") ? resolve(name) : join(ROOT, "jobs", name + ".json");
  const job = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  for (const key of ["name", "workdir", "bootstrap", "statusFile", "doneMarker"]) {
    if (!job[key]) throw new Error(`job spec missing "${key}" (${path})`);
  }
  return { maxStuck: 3, maxRuns: 100, runTimeoutMin: 180, ...job };
}

export function log(job, line) {
  mkdirSync(join(ROOT, "logs"), { recursive: true });
  const file = join(ROOT, "logs", job.name + ".log");
  if (existsSync(file) && statSync(file).size >= LOG_CAP) renameSync(file, file + ".1");
  const stamped = `${new Date().toISOString()} ${line}`;
  appendFileSync(file, stamped + "\n");
  console.log(stamped);
}

export function alert(job, reason) {
  mkdirSync(join(ROOT, "alerts"), { recursive: true });
  const file = join(ROOT, "alerts", `${job.name}-${Date.now()}.txt`);
  writeFileSync(file, reason + "\n");
  log(job, `ALERT: ${reason} (${file})`);
}

// A directive's "board" is its own store: done the moment its status leaves
// `active` (setStatus archives it, so readDirective returns null); progress
// is the BODY of the last log entry — a model repeating the same closing
// summary verbatim is the headless stuck mode (see lastCycleBody for why
// headers/timestamps are excluded).
export function directiveState(id) {
  const d = readDirective(id);
  if (!d || d.status !== "active") return { done: true, hash: "" };
  return { done: false, hash: createHash("sha256").update(lastCycleBody(id)).digest("hex") };
}

export function boardState(job) {
  if (job.directiveId) return directiveState(job.directiveId);
  const file = join(job.workdir, job.statusFile);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return {
    done: text.split(/\r?\n/).some((l) => l.trim() === job.doneMarker),
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

// shell:true interposes /bin/sh (POSIX) or cmd.exe (Windows) between us and
// the real claude process. A plain child.kill() only signals that WRAPPER —
// a documented Node child_process gotcha — and the real claude process is
// left ORPHANED, still running, still holding its API stream. Found
// 2026-08-01 proving the timeout path in runner.test.mjs: a "killed" run's
// close event fired only after the full hang duration, not the timeout,
// because the orphan kept the stdio pipes open. This is not cosmetic: an
// orphan that outlives the lane slot that was supposed to gate it (see
// hooks/lane.mjs) is exactly the kind of invisible extra stream that
// contributes to the account-wide concurrency jam this whole change exists
// to close. `detached: true` on POSIX makes the spawned shell the leader of
// its OWN process group (verified: signaling -pid kills the group in ~10ms
// with zero orphan, vs 8s+ orphaned with a plain child.kill()); Windows has
// no process-group equivalent here, so `taskkill /t` walks the PID tree
// instead. Split into two named, independently callable functions (rather
// than one function with an internal platform if/else) so a suite running on
// EITHER platform can exercise both branches directly — a single real OS can
// only prove one of these by actually killing something; the other is proven
// by asserting the command it would issue. `platform`/`exec` are injected for
// exactly that reason; the real call site always uses the live OS default.
export function killTreeWin32(child, exec = execFileSync) {
  try { exec("taskkill", ["/pid", String(child.pid), "/t", "/f"]); } catch {}
}
export function killTreePosix(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch {} }
}
export function killTree(child, platform = process.platform) {
  if (platform === "win32") killTreeWin32(child);
  else killTreePosix(child);
}

export function runClaudeOnce(job) {
  return new Promise((resolveRun) => {
    // Deliberately NOT --bare: each session must keep the user's hook stack —
    // the PreToolUse guard in apps/toolbelt/guards (extracted from this repo's
    // former hooks/guard.mjs) is the safety layer that makes bypassPermissions
    // acceptable. The bootstrap goes over STDIN, never argv — argv is now quoted/shell-
    // free per platform via hooks/cmdline.mjs (see OI-023); a multi-word
    // prompt in argv still would not survive the shell boundary intact.
    const args = [
      "-p",
      "--permission-mode", "bypassPermissions",
      "--output-format", "json",
      "--max-turns", String(job.maxTurns || CLAUDE_MAX_TURNS),
    ];
    const sp = spawnSpec("claude", args);
    const opts = {
      cwd: job.workdir, shell: sp.shell, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", // see killTree
      // runTimeoutMin owns the clock; never let the 600s print-mode
      // background-wait ceiling kill a session mid-task (lost run 2).
      // NODE_V8_COVERAGE must not leak: this
      // spawn is a hard `killTree` target on timeout (taskkill /t /f on
      // Windows, SIGTERM on the process group on POSIX), and a coverage-
      // instrumented child killed mid-write leaves a truncated raw-profile
      // JSON fragment that corrupts an ancestor's coverage report generation
      // (found 2026-08-02 via runner.test.mjs's own "hang" fixture — a real
      // node process under `node hooks/covgate.mjs` — not that claude itself
      // is ever coverage-instrumented, but the fake stub runner.test.mjs
      // spawns through this exact path is).
      // ACC_DIRECTIVE makes budget.mjs's SessionStart hook inject the full
      // directive context into this child — the entire continuity mechanism
      // for directive jobs, and set ONLY for them: a file job's child must
      // never adopt a directive it was not launched for.
      // ACC_PROFILE: the Start-work page stores the chosen profile ON the
      // directive; this spawn is the only remaining path that can hand it to
      // the session (budget.mjs/statusline.mjs apply it via applyProfile).
      env: {
        ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_CODE_RUNNER: "1", NODE_V8_COVERAGE: undefined,
        ACC_DIRECTIVE: job.directiveId || "",
        ACC_PROFILE: job.profile || "",
      },
    };
    const child = sp.args ? spawn(sp.file, sp.args, opts) : spawn(sp.file, opts);
    child.stdin.write(job.bootstrap);
    child.stdin.end();
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      log(job, `run timed out after ${job.runTimeoutMin} min — killing (tree)`);
      killTree(child);
    }, job.runTimeoutMin * 60 * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = "";
      try {
        result = JSON.parse(out).result ?? "";
      } catch {
        result = out;
      }
      resolveRun({ code, result: String(result).slice(-2000), err: err.slice(-500) });
    });
  });
}

// The laned, retried real launch. Split out from runLoop so a test can inject
// a different `run` (below) without touching the lane wiring itself — that
// wiring has its own coverage in hooks/lane.test.mjs; here it only needs
// proving that runner.mjs actually calls it correctly (runner.test.mjs's
// "integration" group, against a fake claude binary).
export function runOnce(job) {
  return withLaunchSlot(
    `runner:${job.name}`,
    () => retryTransport(`runner:${job.name}`, () => runClaudeOnce(job), { onLog: (l) => log(job, l) }),
    { ttlMs: (job.runTimeoutMin + 10) * 60 * 1000, onLog: (l) => log(job, l) }
  );
}

// The week tier, via the same `usage.mjs check` verb the Command Center
// status route shells — one authority, two callers. Any failure reads as
// green: fail-open by design (revisit when
// SL-010 gives usage.mjs an in-process API with its own coverage budget).
// `exec` is injectable so the failure branches are testable without breaking
// a real usage store.
export function liveTier(exec = execFileSync) {
  try {
    const out = exec(process.execPath, [join(HERE, "..", "hooks", "usage.mjs"), "check"], { encoding: "utf8" });
    return JSON.parse(out).tier || "green";
  } catch {
    return "green";
  }
}

// One loop per job, machine-wide (SPEC-0005). Two runner loops on one
// directive was practically impossible while the only launch path was a
// human's own console; the web Launch button makes it one accidental
// double-click, and two loops would double-spend tokens and interleave cycle
// appends. The runner owns this invariant — the server's 409 is UX only.
// Exclusive-create (wx), not check-then-write: a plain existsSync probe would
// leave a window for two simultaneous starters to both conclude "free" (the
// TOCTOU class hooks/directive.mjs's withLock already guards against).
function claimPidFile(file) {
  mkdirSync(dirname(file), { recursive: true });
  try { writeFileSync(file, String(process.pid), { flag: "wx" }); return { ok: true }; } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let holder = "";
  try { holder = readFileSync(file, "utf8").trim(); } catch {}
  if (pidAlive(holder)) return { ok: false, holder };
  // Stale (dead pid or garbage): reclaim. Losing the re-create race means a
  // live starter claimed it in the gap — that starter wins, we refuse.
  try { unlinkSync(file); } catch {}
  try { writeFileSync(file, String(process.pid), { flag: "wx" }); return { ok: true, reclaimed: holder }; } catch {
    return { ok: false, holder: "a concurrent starter" };
  }
}

export async function runLoop(job, once, { run = runOnce, tier = liveTier } = {}) {
  const pidFile = join(ROOT, "state", job.name + ".pid");
  const claim = claimPidFile(pidFile);
  if (!claim.ok) {
    log(job, `another loop already runs this job (pid ${claim.holder}) — refusing (exit 6)`);
    return 6;
  }
  if (claim.reclaimed) log(job, `reclaimed a stale pid file (pid ${claim.reclaimed} is gone)`);
  try {
    return await runLoopInner(job, once, { run, tier });
  } finally {
    try { unlinkSync(pidFile); } catch {}
  }
}

function fmtSpend(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function directiveBudgetState(job) {
  if (!job.directiveId) return null;
  const directive = readDirective(job.directiveId);
  if (!directive || directive.status !== "active") return { done: true };
  const budget = directive.budget || {};
  const spend = directiveSpend(directive.sessionIds || []);
  const breaches = [];
  let runTimeoutMin = job.runTimeoutMin;
  let maxTurns = job.maxTurns || CLAUDE_MAX_TURNS;

  if (budget.wallClockMin > 0) {
    const remainingMs = budget.wallClockMin * 60 * 1000 - (Date.now() - Date.parse(directive.createdAt || 0));
    if (remainingMs <= 0) breaches.push(`wall-clock ceiling reached (${budget.wallClockMin} min)`);
    else runTimeoutMin = Math.min(runTimeoutMin, remainingMs / 60000);
  }
  if (budget.turns > 0) {
    const remainingTurns = budget.turns - spend.turns;
    if (remainingTurns <= 0) breaches.push(`turn ceiling reached (${spend.turns}/${budget.turns})`);
    else maxTurns = Math.min(maxTurns, remainingTurns);
  }
  if (budget.tokens > 0 && spend.tokens >= budget.tokens) {
    breaches.push(`token ceiling reached (${spend.tokens}/${budget.tokens})`);
  }
  if (budget.dollars > 0 && spend.dollars >= budget.dollars) {
    breaches.push(`dollar ceiling reached ($${fmtSpend(spend.dollars)}/$${fmtSpend(budget.dollars)} est)`);
  }

  return {
    directive,
    budget,
    spend,
    breach: breaches.join("; "),
    runTimeoutMin,
    maxTurns: Math.max(1, Math.floor(maxTurns)),
  };
}

function haltDirective(job, reason) {
  alert(job, `${reason} — halting directive loop (exit 7)`);
  try {
    appendFileSync(
      logPath(job.directiveId),
      `\n### HALTED - ${new Date().toISOString()}\n${reason}\n`
    );
  } catch {}
  // A budget breach halts the LOOP, not the directive itself (it stays
  // "active" and resumable — see runner/README.md), so this is the one
  // terminal-for-this-run state setStatus never sees. writeReceiptOnce is
  // idempotent, so a directive halted again on a later loop restart (the
  // exact "retries" case issue #68 calls out) never gets a second receipt.
  try {
    const directive = readDirective(job.directiveId);
    if (directive) {
      writeReceiptOnce(receiptsDir(), directive, {
        status: "budget_exhausted",
        why: reason,
        lastSummary: lastCycleBody(job.directiveId),
      });
    }
  } catch {}
  return 7;
}

async function runLoopInner(job, once, { run, tier }) {
  let stuck = 0;
  for (let n = 1; n <= job.maxRuns; n++) {
    const stopFile = join(ROOT, "stop", job.name + ".stop");
    if (existsSync(stopFile)) {
      unlinkSync(stopFile);
      log(job, "stop file honored - exiting between runs (exit 4)");
      return 4;
    }
    const before = boardState(job);
    if (before.done) {
      log(job, job.directiveId ? "directive left active status — complete" : `done marker "${job.doneMarker}" present — queue complete`);
      return 0;
    }
    // FR-005: a red week is a hard stop for anything that spends tokens
    // unattended. Directive jobs only; file jobs never had a tier gate
    // (unchanged here).
    if (job.directiveId && tier() === "red") {
      alert(job, "week token tier is RED — holding headless directive runs (exit 5)");
      return 5;
    }
    let runJob = job;
    if (job.directiveId) {
      const ceiling = directiveBudgetState(job);
      if (ceiling?.done) {
        log(job, "directive left active status — complete");
        return 0;
      }
      if (ceiling?.breach) return haltDirective(job, ceiling.breach);
      runJob = { ...job, runTimeoutMin: ceiling.runTimeoutMin, maxTurns: ceiling.maxTurns };
    }
    log(runJob, `run ${n}/${job.maxRuns} starting (stuck ${stuck}/${job.maxStuck})`);
    // Every run goes through the machine-wide launch lane (hooks/lane.mjs):
    // one automated session at a time across runner + e2e, paced starts, and
    // transport-only retries — the econnreset class dies here, and a session
    // that fails for a REAL reason still fails exactly as before.
    const { code, result, err } = await run(runJob);
    log(runJob, `run ${n} exited ${code}; tail: ${result.slice(-400).replaceAll("\n", " | ")}`);
    if (err) log(runJob, `stderr tail: ${err.replaceAll("\n", " | ")}`);
    // The run's closing summary becomes the next fresh context's continuity
    // (budget.mjs injects it as the log tail) AND the stuck signal
    // (directiveState hashes it). Archived-mid-run is fine: appendCycle
    // returns null against a directive that already left the live store.
    if (job.directiveId) appendCycle(job.directiveId, { sessionId: "headless", ctx: 0, text: result });
    const after = boardState(job);
    if (after.done) {
      log(job, "queue complete");
      return 0;
    }
    if (job.directiveId) {
      const ceiling = directiveBudgetState(job);
      if (ceiling?.breach) return haltDirective(job, ceiling.breach);
    }
    stuck = after.hash === before.hash ? stuck + 1 : 0;
    if (stuck >= job.maxStuck) {
      alert(job, `no board progress after ${stuck} consecutive runs — stopping`);
      return 2;
    }
    if (once) return code ?? 0;
  }
  alert(job, `maxRuns (${job.maxRuns}) reached without the done marker`);
  return 3;
}

// `exec` is injectable so runner.test.mjs can assert the schtasks command
// this builds without schtasks needing to exist (it does not, on the
// sandbox this suite also runs in) — the real CLI path always uses the
// default, unchanged from before.
export function install(job, exec = execFileSync) {
  if (job.directiveId) throw new Error("directive jobs are ad-hoc — not schedulable via --install");
  const s = job.schedule;
  if (!s || s.type !== "daily" || !s.time) {
    throw new Error('install needs job.schedule = {"type":"daily","time":"HH:MM"}');
  }
  const tr = `node ${join(ROOT, "runner.mjs")} ${job.name}`;
  exec(
    "schtasks",
    ["/Create", "/F", "/TN", `guards-runner-${job.name}`, "/TR", tr, "/SC", "DAILY", "/ST", s.time],
    { stdio: "inherit" },
  );
  console.log(`installed daily task guards-runner-${job.name} at ${s.time}`);
}

export function status(job) {
  const file = join(ROOT, "logs", job.name + ".log");
  console.log(
    existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(-15).join("\n") : "no log yet",
  );
  const alertsDir = join(ROOT, "alerts");
  if (existsSync(alertsDir)) {
    const alerts = readdirSync(alertsDir).filter((f) => f.startsWith(job.name + "-"));
    if (alerts.length) console.log(`alerts: ${alerts.join(", ")}`);
  }
}

// Returns an exit code rather than calling process.exit itself, so it is
// safe to call in-process from a test (a real process.exit would kill the
// test runner) — the ONLY process.exit call is the single guarded line
// below, which subprocess CLI tests still exercise for real.
export async function cli(argv = process.argv.slice(2)) {
  const [name, flag] = argv;
  if (!name) {
    console.error("usage: node runner.mjs <job> [--once|--install|--status]");
    return 1;
  }
  const job = loadJob(name);
  if (flag === "--install") { install(job); return 0; }
  if (flag === "--status") { status(job); return 0; }
  return await runLoop(job, flag === "--once");
}
// Guarded so the file is importable by runner.test.mjs without running the
// CLI on import — the same shape as the other executable modules
// already use.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await cli());
