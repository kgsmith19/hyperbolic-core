// The Claude Code harness adapter — the ONLY file in the kernel that knows a
// harness-specific command line exists (AC-A8). Everything else talks to the
// interface in kernel/adapter.mjs.
//
// Verified CLI surface (claude --help, 2026-08-03): -p, --output-format
// stream-json, --verbose, --settings, --session-id, --tools, --resume,
// --version.
//
// --tools is a real allowlist over the built-in tool set, so a tool the
// contract does not permit does not exist for the run at all. The kernel
// guardhook then enforces the ARGUMENTS of the tools that do exist. Two
// independent layers, neither relying on hook-matcher wildcard semantics.
import { execFileSync, spawn } from "node:child_process";
import { acquireSlot } from "../../hooks/lane.mjs";
import { killTree } from "../../runner/runner.mjs";
import { spawnSpec } from "../../hooks/cmdline.mjs";

export const id = "claude-code";

// Spawn shapes come from hooks/cmdline.mjs: POSIX = argv + no shell; Windows
// = one pre-quoted string + shell (the .cmd shim needs it). See OI-023.
export function identity({ exec = execFileSync } = {}) {
  let out;
  try {
    const sp = spawnSpec("claude", ["--version"]);
    const opts = { encoding: "utf8", timeout: 15000, windowsHide: true, shell: sp.shell };
    out = String(sp.args ? exec(sp.file, sp.args, opts) : exec(sp.file, opts));
  } catch (e) {
    throw new Error(`kernel: harness "${id}" failed to start — \`claude --version\` (${e.message})`);
  }
  const m = out.match(/\d+\.\d+\.\d+/);
  if (!m) throw new Error(`kernel: harness "${id}" version probe returned no version: ${out.trim().slice(0, 120)}`);
  return { name: id, version: m[0] };
}

// The prompt is deliberately absent: it goes over stdin, never argv. Args
// here are raw — quoting for the platform's spawn boundary is spawnSpec's
// job (hooks/cmdline.mjs), not this function's.
export function buildArgs({ settingsPath, sessionId, tools, resume = false }) {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--settings", settingsPath,
    "--tools", tools.join(","),
  ];
  args.push(...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]));
  return args;
}

// Every automated spawn takes a launch-lane slot (AC-A4). One account, many
// loops: concurrent real sessions die in transport as econnreset, which is
// exactly why hooks/lane.mjs exists. The slot is held for the LIFE of the run,
// so it is acquired here and released on close — not with withLaunchSlot,
// because the caller needs the handle while the run is still going.
//
// killTree is imported from runner/runner.mjs rather than reimplemented: under
// shell:true a plain child.kill() signals only the shell wrapper and leaves
// the real harness orphaned, still holding its API stream.
export async function startTask({
  runId, prompt, settingsPath, sessionId, tools, cwd, env = {}, ttlMs,
  onLog, spawnFn = spawn, killFn = killTree, resume = false,
}) {
  const slot = await acquireSlot(`kernel:${runId}`, { ttlMs, onLog });
  let child;
  try {
    const sp = spawnSpec("claude", buildArgs({ settingsPath, sessionId, tools, resume }));
    const opts = {
      cwd, shell: sp.shell, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", // see killTree
      env: {
        ...process.env, ...env,
        // NODE_V8_COVERAGE must not leak into the harness: left behind by a
        // coverage run it corrupts the report when the child is killed mid-write.
        NODE_V8_COVERAGE: undefined,
        CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
      },
    };
    child = sp.args ? spawnFn(sp.file, sp.args, opts) : spawnFn(sp.file, opts);
  } catch (e) {
    slot.release();
    throw new Error(`kernel: harness "${id}" failed to start (${e.message})`);
  }

  const raw = { out: "", err: "" };
  const events = [];
  let pending = "";
  child.stdout.on("data", (d) => {
    raw.out += d;
    pending += d;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* non-JSON banner line */ }
    }
  });
  child.stderr.on("data", (d) => { raw.err += d; });

  const done = new Promise((resolveDone, rejectDone) => {
    child.on("error", (e) => {
      slot.release();
      rejectDone(new Error(`kernel: harness "${id}" failed to start (${e.message})`));
    });
    child.on("close", (code) => {
      slot.release();
      resolveDone({ code, events, raw });
    });
  });
  // An unhandled rejection here would crash the kernel before it can write a
  // ledger entry; run.mjs awaits `done` and turns the rejection into
  // failed-to-start.
  done.catch(() => {});

  child.stdin.write(prompt);
  child.stdin.end();

  // `events` is the LIVE array the stdout parser pushes into, not a copy: the
  // orchestrator's ceiling checks read it while the run is still going, which
  // is the only way a token ceiling can stop a run instead of noticing after.
  const handle = { pid: child.pid, child, done, killFn, events };
  return handle;
}

export async function stopTask(handle) {
  if (!handle) return;
  handle.killFn(handle.child);
  await handle.done.catch(() => {});
}

// What the harness DID, never what it claims about how it went. The result
// event carries the model's own summary ("all tests pass"); it is deliberately
// dropped here so it cannot reach an acceptance decision — that is the
// verifier's job, from the filesystem, after the process is dead (AC-A6/AC-V5).
export function readState(events) {
  let toolCalls = 0;
  let tokens = 0;
  let sessionId = null;
  for (const e of events || []) {
    if (!e || typeof e !== "object") continue;
    if (e.session_id) sessionId = e.session_id;
    if (e.type !== "assistant" || !e.message) continue;
    // OI-019: the same tolerance the top-level event loop above already
    // gives a malformed event — a stray null/non-object block (a stream
    // hiccup, not necessarily anything wrong with the run) must not throw
    // and abort the whole run via run.mjs's supervisor-fault path; skipping
    // it just undercounts by that one entry, a safe direction to be wrong in.
    for (const block of e.message.content || []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") toolCalls++;
    }
    const u = e.message.usage;
    if (u) {
      tokens += (u.input_tokens || 0) + (u.output_tokens || 0) +
        (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
  }
  return { toolCalls, tokens, sessionId };
}

// Continue the SAME harness session with more input. v1's orchestrator runs
// single-shot tasks; this exists because the adapter interface requires it and
// a harness swap must have a defined continuation path.
export async function sendStep(session, input, opts = {}) {
  const handle = await startTask({ ...session, prompt: input, resume: true, ...opts });
  return handle.done;
}
