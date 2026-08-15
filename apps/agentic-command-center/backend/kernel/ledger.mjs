// The run record. Append-only JSONL: one `run_started` at launch and one
// `run_finalized` at close for every run — success, failure, or abort. A
// started line with no finalized line is an INTERRUPTED run, and that is
// visible by construction rather than by a flag someone must remember to set.
//
// Appends are idempotent by (runId, event): the launch lane retries transport
// failures and a resumed kernel must not double-write, so the FIRST record for
// a run wins and later duplicates are dropped (AC-G4).
//
// Nothing here ever receives a credential value. Callers pass key NAMES only;
// kernel/credentials.mjs is the single place values exist, and they go into a
// child process env, never into an argument that could reach this file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kernelRoot } from "./policy.mjs";

export const ledgerDir = () => path.join(kernelRoot(), "runner", "ledger");
export const runsFile = () => path.join(ledgerDir(), "runs.jsonl");
export const decisionsFile = (runId) => path.join(ledgerDir(), `${runId}.decisions.jsonl`);
export const autonomyFile = () => path.join(ledgerDir(), "autonomy.json");

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function readLines(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // A truncated trailing line (killed mid-write) must not discard the
    // records before it — skip it, never throw.
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

export function readRuns() {
  return readLines(runsFile());
}

// OI-019: the same TOCTOU shape as withDecisionLock below (found right after
// it, same session) — two processes racing appendStarted/appendFinalized for
// the SAME runId (a real scenario: this file's own header notes the launch
// lane retries transport failures) can both read "not present yet" before
// either has appended, breaking the AC-G4 promise that a run's first record
// wins and duplicates are dropped. Reproduced live: 20 concurrent callers for
// one runId produced 2 duplicate run_started lines, not 1. withLock("runs",
// ...) below closes it the same way withDecisionLock closes the decisions
// race — one exclusive-create lock file guarding the whole runs.jsonl, since
// appendOnce's idempotency check scans the entire file, not a per-run slice.
function appendOnce(event, entry) {
  return withLock("runs", () => {
    const exists = readRuns().some((r) => r.event === event && r.runId === entry.runId);
    // Test seam ONLY (default 0, a no-op): the natural read-to-append window
    // here is a handful of microseconds, so forcing two real processes to
    // land inside it reproduces only rarely by chance. Widening the window
    // on demand makes the race deterministic for kernel/ledger.test.mjs
    // instead of relying on a timing coin flip — same pattern as
    // guardhook.mjs's ACC_GUARDHOOK_STDIN_TIMEOUT_MS test seam.
    const delay = Number(process.env.ACC_LEDGER_APPEND_ONCE_DELAY_MS) || 0;
    if (delay) sleepSync(delay);
    if (exists) return false;
    appendLine(runsFile(), { event, ...entry });
    return true;
  });
}

export function appendStarted(entry) {
  return appendOnce("run_started", entry);
}

export function appendFinalized(entry) {
  return appendOnce("run_finalized", entry);
}

export function appendDecision(runId, decision) {
  appendLine(decisionsFile(runId), { ts: new Date().toISOString(), ...decision });
}

export function readDecisions(runId) {
  return readLines(decisionsFile(runId));
}

export function decisionCounts(runId) {
  const rows = readDecisions(runId);
  const allow = rows.filter((r) => r.allow === true).length;
  return { allow, deny: rows.length - allow, total: rows.length };
}

// OI-019: a real Claude Code turn fires several tool calls at once, each as
// its own guardhook.mjs process. Reading decisionCounts() then later calling
// appendDecision() — two separate syscalls, in two separate processes — is a
// classic TOCTOU race: N concurrent fires can all read the same "attempts"
// value before any of them has appended, so all N pass a ceiling check meant
// to allow only one more. Found live: 60 concurrent fires against a ceiling
// of 3 let 6-14 through. withLock() closes windows like this one by making a
// read-decide-append sequence a single atomic unit, serialized by an
// exclusive-create lock file — no runtime dependency, just fs primitives.
// The exact same shape recurred in appendOnce() above (found moments later,
// same session), hence a shared, name-parameterized primitive rather than
// two copies. Timeouts read per-call, not frozen at module load: a fresh
// process per fire (guardhook.mjs) wouldn't care either way, but withLock is
// also called repeatedly within one long-lived process (this suite, run.mjs's
// supervisor) where a test must be able to shrink the timeout at runtime.
const lockStaleMs = () => Number(process.env.ACC_LEDGER_LOCK_STALE_MS) || 5000;
const lockWaitTimeoutMs = () => Number(process.env.ACC_LEDGER_LOCK_TIMEOUT_MS) || 4000;
const lockFile = (name) => path.join(ledgerDir(), `${name}.lock`);
// Under same-file exclusive-create contention, Windows can report EPERM
// instead of EEXIST. Both conditions mean another caller currently owns the
// lock and are retried inside the existing bounded, fail-closed wait loop.
const lockContention = (error) => error?.code === "EEXIST" || error?.code === "EPERM";

// Atomics.wait blocks the calling thread synchronously (Node's main thread
// supports this, unlike a browser main thread) — a real sleep, not a busy
// spin that pins a CPU core while a sibling process holds the lock.
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(name) {
  const file = lockFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + lockWaitTimeoutMs();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, "wx"));
      return () => { try { fs.unlinkSync(file); } catch { /* already released */ } };
    } catch (e) {
      if (!lockContention(e)) throw e;
      // A lock left behind by a process that died mid-hold must not wedge
      // every future caller shut forever — reap it once it is clearly stale
      // rather than merely old (a legitimate holder's own hold is short).
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > lockStaleMs()) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch { /* lock vanished between the check and here — retry immediately */ }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the "${name}" lock`);
      }
      sleepSync(5);
    }
  }
}

// A named, cross-process mutex: fn runs with exclusive access to whatever
// resource `name` identifies (by convention, a lock file per shared
// resource — one per runId's decisions, one for the whole runs.jsonl).
export function withLock(name, fn) {
  const release = acquireLock(name);
  try {
    return fn();
  } finally {
    release();
  }
}

// fn receives the attempt count read UNDER the lock and must itself perform
// any appendDecision() for this fire before returning, so the count the next
// waiter reads already reflects this one. Whatever fn returns is returned.
export function withDecisionLock(runId, fn) {
  return withLock(`${runId}.decisions`, () => fn(decisionCounts(runId).total));
}

// Queryable by status, harness identity, and date range (AC-L3). No dashboard:
// the spec's out-of-scope list rules presentation out, and JSONL + this filter
// is the whole "queryable" requirement.
export function query({ status, harness, since, until } = {}) {
  const rows = readRuns();
  const finals = new Map();
  for (const r of rows) if (r.event === "run_finalized") finals.set(r.runId, r);
  const from = since ? Date.parse(since) : null;
  const to = until ? Date.parse(until) : null;
  const out = [];
  for (const s of rows) {
    if (s.event !== "run_started") continue;
    const f = finals.get(s.runId);
    const at = Date.parse(s.startedAt);
    if (from !== null && at < from) continue;
    if (to !== null && at > to) continue;
    const row = {
      runId: s.runId,
      status: f ? f.outcome : "interrupted",
      harness: f ? f.harness : null,
      startedAt: s.startedAt,
      finishedAt: f ? f.finishedAt : null,
      criteria: f ? f.criteria : null,
    };
    if (status && row.status !== status) continue;
    if (harness && (!row.harness || row.harness.name !== harness)) continue;
    out.push(row);
  }
  return out;
}

export function runCli(argv) {
  const [cmd, ...args] = argv;
  if (cmd !== "query") {
    throw new Error("usage: ledger.mjs query [--status <s>] [--harness <h>] [--since <date>] [--until <date>]");
  }
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return query({
    status: flag("--status"), harness: flag("--harness"),
    since: flag("--since"), until: flag("--until"),
  });
}

// Guarded so the module stays importable by its own suite without running the
// CLI on import — the same shape hooks/covgate.mjs and runner/runner.mjs use.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const row of runCli(process.argv.slice(2))) console.log(JSON.stringify(row));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
