#!/usr/bin/env node
// lane.mjs — machine-wide launch lane for real-API claude spawns.
//
// THE JAM (2026-07-31): runner.mjs (claude -p per board task), the proof tier
// (real TUI sessions), the directive loop, and Kyle's interactive sessions all open
// API streams from one account with zero coordination. Concurrent bursts die in
// transport as "Unable to connect to API (econnreset)" — the edge resets the
// socket instead of returning a clean 429. The fix is not "retry harder"; it is
// the standard layers for loops against a rate-limited/overloaded API:
//   1. bounded concurrency — a cross-process semaphore, at most N real
//      sessions launched by automation at once (default 1);
//   2. start pacing — a minimum gap between launches, so N slots never means
//      "N connections on the same tick";
//   3. retry with exponential backoff + FULL JITTER — for the residue that
//      still dies in transport. Transport failures ONLY: a logic failure
//      (assertion, bad exit, model refusing) is returned untouched, because
//      retrying a real bug just spends tokens hiding it. 529 (model-layer
//      overload, not account-specific) gets a longer base delay than 429/
//      network errors — hammering an overloaded model faster only adds load;
//   4. a circuit breaker — enough transport failures in a short window means
//      something is actually down, not just contended. New automated
//      launches hold until the breaker cools down instead of retrying into a
//      known-bad API.
//
// Interactive launches (Kyle's own terminals) deliberately do NOT take this
// lane — a human launch must never queue behind a three-hour runner hold;
// humans are self-pacing, loops are not. The machine-wide `lane.total` cap
// (shim/claude.cmd + gate(), ADR-0003) is the ceiling that still covers them.
// (A second "interactive" slot category existed for the WinForms GUI's Go
// button; it was deleted with that GUI — SPEC-0005/ADR-0005 — when its last
// caller went.)
//
// STATE lives OUTSIDE ACC_ROOT, in os.tmpdir()/acc-lane (override:
// ACC_LANE_DIR — the lane's own tests sandbox with it). This is deliberate:
// e2e sandboxes redirect ACC_ROOT, and a lane that moved with it would let a
// sandboxed harness and the live runner spawn concurrently — the exact jam
// this file exists to prevent. One machine, one account, one lane root
// (categories are subdirectories of it, not separate roots).
//
// A slot is a DIRECTORY (mkdir is atomic on every platform); owner.json inside
// records {pid, label, at, ttlMs}. A slot is stale when its owner pid is dead
// or its own declared ttl has passed — so a crashed holder never wedges the
// lane, and pid-reuse cannot hold it past the ttl. Dials in policy.json
// `lane`, re-read on every acquire like every other hook's config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { isMainModule, readJson } from "./root.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = () => process.env.ACC_POLICY || path.join(HERE, "..", "policy.json");
const LANE_DIR = () => process.env.ACC_LANE_DIR || path.join(os.tmpdir(), "acc-lane");

const DEFAULTS = {
  slots: 1,          // concurrent automated sessions. 1 = strict serial.
  minGapMs: 3000,    // pause between launches even when a slot is free
  retries: 2,        // transport retries per run (attempts = retries + 1)
  backoffBaseMs: 2000,
  overloadBaseMs: 4000, // base delay for 529/overloaded_error specifically — a
                        // model-layer overload; retrying faster just adds load.
  backoffCapMs: 30000,
  pollMs: 500,       // slot-wait poll interval (jittered)
  slotTtlMs: 30 * 60 * 1000, // default hold ceiling; callers with long runs pass their own
  breakerThreshold: 3,      // this many transport failures in the window...
  breakerWindowMs: 5 * 60 * 1000,   // ...trips the breaker...
  breakerCooldownMs: 2 * 60 * 1000, // ...for this long since the LAST failure.
};

// Reads the flat `lane` object from policy.json over DEFAULTS, per call —
// dial edits apply on the next acquire with no restart.
export function laneConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(POLICY(), "utf8").replace(/^\uFEFF/, "")).lane || {}; } catch {}
  return { ...DEFAULTS, ...raw };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// EPERM means "alive but not ours" — on Windows and POSIX both.
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function ownerOf(slotDir) {
  return readJson(path.join(slotDir, "owner.json"), null);
}

// Stale = reclaimable. An unreadable owner.json counts once it is older than a
// grace beat (the writer may be mid-write); a dead pid or an expired ttl
// counts immediately.
function isStale(slotDir) {
  const o = ownerOf(slotDir);
  if (!o) {
    try { return Date.now() - fs.statSync(slotDir).mtimeMs > 10000; } catch { return true; }
  }
  if (!pidAlive(o.pid)) return true;
  const ttl = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : DEFAULTS.slotTtlMs;
  return Date.now() - Date.parse(o.at || 0) > ttl;
}

function tryTake(slotDir, label, ttlMs) {
  try {
    fs.mkdirSync(slotDir);
  } catch {
    if (!isStale(slotDir)) return false;
    // Reclaim, then race for it again — losing the race is fine, someone won.
    try { fs.rmSync(slotDir, { recursive: true, force: true }); fs.mkdirSync(slotDir); } catch { return false; }
  }
  fs.writeFileSync(
    path.join(slotDir, "owner.json"),
    JSON.stringify({ pid: process.pid, label, at: new Date().toISOString(), ttlMs })
  );
  return true;
}

// Everyone currently holding a slot — for wait logs and the statusline.
export function laneStatus() {
  let names = [];
  try { names = fs.readdirSync(LANE_DIR()).filter((n) => n.startsWith("slot-")); } catch {}
  return names.map((n) => ({ slot: n, ...(ownerOf(path.join(LANE_DIR(), n)) || {}) }));
}

// The full picture for the CLI / GUI status display.
export function laneStatusAll() {
  return { automation: laneStatus(), breaker: breakerState() };
}

// Start pacing. Read-modify-write with no lock: with slots=1 it is exact; with
// slots>1 a race can only SHORTEN one gap, never stack launches on a tick,
// which is all the gap is for.
async function paceStart(cfg, onLog) {
  const stamp = path.join(LANE_DIR(), "last-start.json");
  const last = Number(readJson(stamp, {}).t) || 0;
  const wait = last + cfg.minGapMs - Date.now();
  if (wait > 0) {
    onLog?.(`lane: pacing start, ${wait}ms behind the previous launch`);
    await sleep(wait + Math.floor(Math.random() * 250));
  }
  try { fs.writeFileSync(stamp, JSON.stringify({ t: Date.now() })); } catch {}
}

// ---------------------------------------------------------------- breaker
// Shared machine-wide signal, independent of category — it reflects whether
// the real API is healthy, not who happens to be asking. State: LANE_DIR()/
// breaker.json, a rolling list of failure timestamps trimmed to the window.
function breakerFile() {
  return path.join(LANE_DIR(), "breaker.json");
}

function readBreakerRaw() {
  try {
    const j = JSON.parse(fs.readFileSync(breakerFile(), "utf8"));
    return { failures: Array.isArray(j.failures) ? j.failures.map(Number).filter((n) => Number.isFinite(n)) : [] };
  } catch { return { failures: [] }; }
}

// Called once per transport-classified failure (see retryTransport). Trims to
// the window on write, so the file never grows unbounded.
export function recordTransportFailure(cause) {
  const cfg = laneConfig();
  const cutoff = Date.now() - cfg.breakerWindowMs;
  const failures = readBreakerRaw().failures.filter((t) => t > cutoff);
  failures.push(Date.now());
  try {
    fs.mkdirSync(LANE_DIR(), { recursive: true });
    fs.writeFileSync(breakerFile(), JSON.stringify({ failures, lastCause: cause || null }));
  } catch {}
}

// Tripped iff >= threshold failures fall inside the window AND the most
// recent one is still inside the cooldown — so the breaker self-clears once
// the API has been quiet for `cooldownMs`, even if older entries are still
// technically "in window".
export function breakerState() {
  const cfg = laneConfig();
  const cutoff = Date.now() - cfg.breakerWindowMs;
  const inWindow = readBreakerRaw().failures.filter((t) => t > cutoff);
  const last = inWindow.length ? Math.max(...inWindow) : 0;
  const tripped = inWindow.length >= cfg.breakerThreshold && Date.now() - last < cfg.breakerCooldownMs;
  return { tripped, count: inWindow.length, threshold: cfg.breakerThreshold, windowMs: cfg.breakerWindowMs, cooldownMs: cfg.breakerCooldownMs };
}

export function breakerReset() {
  try { fs.rmSync(breakerFile(), { force: true }); } catch {}
}

// Hold new acquires open while the breaker is tripped.
async function waitForBreaker(cfg, onLog) {
  let noted = false;
  for (;;) {
    const b = breakerState();
    if (!b.tripped) return;
    if (!noted) {
      onLog?.(`lane: circuit breaker open (${b.count} transport failures in the last ${Math.round(b.windowMs / 1000)}s) — holding new launches`);
      noted = true;
    }
    await sleep(cfg.pollMs + Math.floor(Math.random() * cfg.pollMs));
  }
}

// ---------------------------------------------------------------- acquire
export async function acquireSlot(label, { ttlMs, onLog } = {}) {
  const cfg = laneConfig();
  fs.mkdirSync(LANE_DIR(), { recursive: true });
  const ttl = ttlMs || cfg.slotTtlMs;

  await waitForBreaker(cfg, onLog);

  let lastNote = 0;
  for (;;) {
    for (let i = 0; i < Math.max(1, cfg.slots); i++) {
      const slotDir = path.join(LANE_DIR(), `slot-${i}`);
      if (tryTake(slotDir, label, ttl)) {
        await paceStart(cfg, onLog);
        return {
          slot: i,
          release: () => { try { fs.rmSync(slotDir, { recursive: true, force: true }); } catch {} },
        };
      }
    }
    if (Date.now() - lastNote > 15000) {
      lastNote = Date.now();
      const held = laneStatus().map((s) => `${s.label || "?"}(${s.pid || "?"})`).join(", ");
      onLog?.(`lane: waiting for a slot — held by ${held || "unknown"}`);
    }
    await sleep(cfg.pollMs + Math.floor(Math.random() * cfg.pollMs));
  }
}

// The only call sites should ever need: hold a slot exactly as long as fn runs.
export async function withLaunchSlot(label, fn, opts = {}) {
  const slot = await acquireSlot(label, opts);
  try { return await fn(); } finally { slot.release(); }
}

// Transport-class failure, or null. Deliberately matched against the FAILURE
// TEXT, not the exit code: exit codes say "failed", only the text says WHY,
// and only the why decides whether a retry can possibly help.
export function transportFailure(text) {
  const m = String(text || "").match(
    /econn(reset|refused|aborted)|etimedout|epipe|socket hang up|fetch failed|network error|unable to connect|connection (reset|refused|closed|error)|overloaded|rate.?limit|too many requests|api error.{0,40}\b(429|500|502|503|504|529)\b|\b(429|529)\b/i
  );
  return m ? m[0] : null;
}

// Run `run` up to attempts times, backing off between TRANSPORT failures only.
// Returns the last result either way — callers keep their existing failure
// handling; the lane never converts a failure into a throw. Every transport
// failure is also recorded to the shared circuit breaker, win or lose.
//   failed(r) — is this result a failure at all (default: r.code !== 0)
//   textOf(r) — where the failure text lives (default: err + result)
export async function retryTransport(label, run, opts = {}) {
  const cfg = laneConfig();
  const attempts = Math.max(1, (opts.retries ?? cfg.retries) + 1);
  const failed = opts.failed || ((r) => !r || r.code !== 0);
  const textOf = opts.textOf || ((r) => `${r?.err || ""} ${r?.result || ""}`);
  // attempts is always >= 1 (Math.max above), and every iteration returns
  // via one of the two lines inside the loop — the last iteration always
  // satisfies `i === attempts - 1`, so the loop can never fall through.
  // Unbounded `for (;;)` on purpose, not `i < attempts`: a bounded condition
  // would give V8 a "loop exhausted normally" branch to instrument that can
  // never actually be taken — dead code covergate's own branch floor caught
  // twice on 2026-08-01 (first the trailing `return r`, then this). The
  // honest fix is to stop implying an exit path that cannot happen, not to
  // manufacture a test for one.
  let r;
  for (let i = 0; ; i++) {
    r = await run();
    if (!failed(r)) return r;
    const cause = transportFailure(textOf(r));
    if (!cause) return r; // real failure — never recorded, never retried
    recordTransportFailure(cause);
    if (i === attempts - 1) return r; // out of tries
    const overload = /overloaded|529/i.test(cause);
    const base = overload ? (opts.overloadBaseMs ?? cfg.overloadBaseMs) : (opts.backoffBaseMs ?? cfg.backoffBaseMs);
    const cap = opts.backoffCapMs ?? cfg.backoffCapMs;
    // FULL jitter (AWS's "Exponential Backoff And Jitter" guidance), not
    // equal jitter: delay is uniform over [0, ceiling], not [0.5, 1] of it —
    // the wider spread is what actually breaks up a thundering herd of
    // callers that all failed on the same tick.
    const ceiling = Math.min(cap, base * 2 ** i);
    const delay = Math.round(Math.random() * ceiling);
    opts.onLog?.(`lane: transport failure (${cause}) — retry ${i + 1}/${attempts - 1} for ${label} in ${delay}ms${overload ? " [overload backoff]" : ""}`);
    await sleep(delay);
  }
}

// ------------------------------------------------------------- launch cap
// Machine-wide ceiling on concurrent claude.exe, independent of the lane
// slots above (those are cooperative; this is enforced at every claude
// resolution via the shim — see shim/claude.cmd). Policy: policy.json
// lane.total.{cap, exe}. No cap/exe configured = fail open (gate() below).
const UTILITY_ARGS = new Set(["--version", "-v", "--help", "-h", "doctor", "update", "install", "mcp", "config"]);

// Subcommands/flags that never start a session — these bypass the cap
// entirely, uncounted, so `claude --version` never queues behind a busy
// machine.
export function isUtilityInvocation(args) {
  const first = args && args[0];
  return first != null && UTILITY_ARGS.has(String(first));
}

// One real Win32_Process query, filtered by NAME only (path-filtering happens
// in countCappedProcesses) — Name alone would also match the unrelated
// desktop app's claude.exe, which is exactly why the caller must filter by
// ExecutablePath afterward.
export function queryClaudeProcesses() {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
    "Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress -Depth 3";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const trimmed = out.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Matched by absolute exe PATH, never by image name — claude.exe is also the
// name of the (separate, unrelated) desktop app's bundled binary at a
// different path, which must never count against this cap.
export function countCappedProcesses(exePaths, listProcesses = queryClaudeProcesses) {
  const procs = listProcesses() || [];
  const wanted = new Set((exePaths || []).map((p) => String(p).toLowerCase()));
  return procs.filter((p) => p && p.ExecutablePath && wanted.has(String(p.ExecutablePath).toLowerCase()));
}

function laneLabelForPid(pid) {
  const hit = laneStatus().find((s) => Number(s.pid) === Number(pid));
  return hit ? hit.label || null : null;
}

// The gate: ok:true means "let it through" (default — every unconfigured or
// erroring path fails open, on purpose). ok:false means "refuse" and is the
// ONLY outcome the shim (shim/claude.cmd) maps to exit 42.
export function gate(args, opts = {}) {
  if (isUtilityInvocation(args)) return { ok: true, reason: "utility" };
  const cfg = laneConfig();
  const total = (cfg.total && typeof cfg.total === "object") ? cfg.total : {};
  const cap = Number(total.cap);
  if (!Number.isFinite(cap)) return { ok: true, reason: "no-cap-configured" };
  const exePaths = Array.isArray(total.exe) ? total.exe : [];
  if (!exePaths.length) return { ok: true, reason: "no-exe-configured" };
  let matched;
  try {
    matched = countCappedProcesses(exePaths, opts.listProcesses);
  } catch (e) {
    return { ok: true, reason: "count-failed", error: String((e && e.message) || e) };
  }
  if (matched.length < cap) return { ok: true, count: matched.length, cap };
  return {
    ok: false,
    count: matched.length,
    cap,
    holders: matched.map((p) => ({ pid: p.ProcessId, startedAt: p.CreationDate || null, label: laneLabelForPid(p.ProcessId) })),
  };
}

// Broken out of the CLI dispatch below so it has a deterministic unit test:
// exercising this via a real refused CLI subprocess would need an actual
// live claude.exe on the machine to populate `holders`, which is
// environment-dependent and not something a hermetic test controls.
export function formatHolders(holders) {
  return (holders || [])
    .map((h) => `pid ${h.pid}${h.label ? ` [${h.label}]` : ""}${h.startedAt ? ` (started ${h.startedAt})` : ""}`)
    .join(", ") || "unknown";
}

// ------------------------------------------------------------------- CLI
// `node hooks/lane.mjs <cmd>` — single-shot commands for callers that cannot
// import ESM directly (the web GUI shells `status`). One line of JSON to
// stdout, exits immediately. (The try-acquire/reown/release handshake that
// served the WinForms GUI died with it — SPEC-0005.)
export function runCli(argv) {
  const [cmd] = argv;
  if (cmd === "status") return laneStatusAll();
  return { ok: false, reason: `unknown command: ${cmd}` };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  if (cmd === "gate") {
    // Deliberately NOT routed through runCli's JSON-on-stdout convention:
    // shim/claude.cmd only cares about the exit code, and a JSON line on
    // every single successful `claude` launch would be noise in Kyle's
    // terminal. Silent on allow; one human-readable line on stderr to
    // refuse.
    const gateArgs = rest[0] === "--" ? rest.slice(1) : rest;
    const out = gate(gateArgs);
    if (out && out.ok === false) {
      console.error(`lane: claude launch cap reached (${out.count}/${out.cap}) — held by ${formatHolders(out.holders)}`);
      process.exitCode = 42;
    }
  } else {
    const out = runCli(argv);
    console.log(JSON.stringify(out));
    if (out && out.ok === false) process.exitCode = 1;
  }
}
