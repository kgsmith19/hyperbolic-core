// node --test runner/runner.test.mjs  (run from C:\code\guards)
//
// Hermetic. ACC_RUNNER_ROOT sandboxes logs/alerts/stop/jobs (route.test.mjs
// discipline). ACC_LANE_DIR and ACC_POLICY sandbox the launch lane the same
// way — a real run here must never contend with a live runner or the
// slice-runner. No network, no real claude, no tokens.
//
// Two groups:
//   DECISION TABLE — runLoop's stuck/done/stop/maxRuns logic, driven by an
//     injected `run`, proven in milliseconds with no process spawned.
//   INTEGRATION — the real runOnce -> runClaudeOnce -> lane path, against a
//     FAKE `claude` on PATH (a stub binary, not a mock): proves the actual
//     spawn args, that the bootstrap really goes over stdin (never argv —
//     the documented reason being shell:true argv-mangling on Windows), that
//     a transport-shaped failure is retried and recovers, and that a hung
//     run is killed at its timeout. The stub ships two entry points
//     (`claude` POSIX shebang, `claude.cmd` Windows batch) both delegating to
//     one impl file, so the same test exercises runner.mjs's real spawn call
//     on either platform Kyle might run this suite from.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-runner-test-"));
process.env.ACC_RUNNER_ROOT = path.join(BASE, "runnerroot");
process.env.ACC_LANE_DIR = path.join(BASE, "lane");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.CLAUDE_CONFIG_DIR = path.join(BASE, "claude");
process.env.ACC_SCAN_CACHE = path.join(BASE, "scan-cache.json");
fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ lane: { slots: 1, minGapMs: 0, retries: 2, backoffBaseMs: 5, backoffCapMs: 20, pollMs: 20 } }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "runner.mjs");
const {
  loadJob, boardState, runLoop, install, status, runClaudeOnce, runOnce,
  killTreeWin32, killTreePosix, killTree, log, cli: cliFn,
} = await import("./runner.mjs");

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

function board(dir, statusFile, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, statusFile), text);
}

function job(overrides = {}) {
  const workdir = fs.mkdtempSync(path.join(BASE, "board-"));
  board(workdir, "BOARD.md", "- [ ] task one\n");
  return {
    name: `t-${Math.random().toString(36).slice(2)}`,
    workdir, statusFile: "BOARD.md", doneMarker: "DONE",
    bootstrap: "do the thing", maxStuck: 3, maxRuns: 5, runTimeoutMin: 180,
    ...overrides,
  };
}

function usageTurn(ts, { input = 0, out = 0, model = "claude-opus-5" } = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      model,
      usage: {
        input_tokens: input,
        output_tokens: out,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text: "ok" }],
    },
  });
}

function writeSessionTranscript(sid, lines, subLines = []) {
  const proj = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "proj");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), lines.join("\n") + "\n");
  if (subLines.length) {
    const sub = path.join(proj, sid, "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "agent-1.jsonl"), subLines.join("\n") + "\n");
  }
}

// ------------------------------------------------------------- loadJob
test("loadJob fills defaults and reads an explicit path", () => {
  const p = path.join(BASE, "explicit.json");
  fs.writeFileSync(p, JSON.stringify({ name: "x", workdir: BASE, bootstrap: "b", statusFile: "s.md", doneMarker: "D" }));
  const j = loadJob(p);
  assert.equal(j.maxStuck, 3);
  assert.equal(j.maxRuns, 100);
  assert.equal(j.runTimeoutMin, 180);
});

test("loadJob resolves a bare name under ACC_RUNNER_ROOT/jobs", () => {
  fs.mkdirSync(path.join(process.env.ACC_RUNNER_ROOT, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.ACC_RUNNER_ROOT, "jobs", "byname.json"),
    JSON.stringify({ name: "byname", workdir: BASE, bootstrap: "b", statusFile: "s.md", doneMarker: "D", maxRuns: 7 })
  );
  const j = loadJob("byname");
  assert.equal(j.maxRuns, 7);
});

test("loadJob strips a BOM before parsing", () => {
  const p = path.join(BASE, "bom.json");
  fs.writeFileSync(p, "\uFEFF" + JSON.stringify({ name: "b", workdir: BASE, bootstrap: "b", statusFile: "s.md", doneMarker: "D" }));
  assert.equal(loadJob(p).name, "b");
});

test("loadJob throws naming the missing key and the path", () => {
  const p = path.join(BASE, "bad.json");
  fs.writeFileSync(p, JSON.stringify({ name: "bad", workdir: BASE, bootstrap: "b" })); // no statusFile/doneMarker
  assert.throws(() => loadJob(p), /statusFile/);
});

// ------------------------------------------------------------- boardState
test("boardState: doneMarker must be its own trimmed line, not a substring", () => {
  const j = job();
  board(j.workdir, j.statusFile, "- [ ] one\nDONE-ish, not really\n");
  assert.equal(boardState(j).done, false);
  board(j.workdir, j.statusFile, "- [x] one\nDONE\n");
  assert.equal(boardState(j).done, true);
});

test("boardState: hash is stable for identical content and changes with content", () => {
  const j = job();
  board(j.workdir, j.statusFile, "same\n");
  const a = boardState(j);
  const b = boardState(j);
  assert.equal(a.hash, b.hash);
  board(j.workdir, j.statusFile, "different\n");
  assert.notEqual(boardState(j).hash, a.hash);
});

test("boardState: a missing status file is not done and hashes empty content", () => {
  const j = job();
  fs.rmSync(path.join(j.workdir, j.statusFile));
  assert.equal(boardState(j).done, false);
});

// ------------------------------------------------------------- runLoop (decision table)
test("runLoop: board already done returns 0 without ever calling run", async () => {
  const j = job();
  board(j.workdir, j.statusFile, "DONE\n");
  let called = false;
  const code = await runLoop(j, false, { run: async () => { called = true; return { code: 0, result: "", err: "" }; } });
  assert.equal(code, 0);
  assert.equal(called, false);
});

test("runLoop: a stop file is honored before the next run and consumed", async () => {
  const j = job({ name: "stopjob" });
  fs.mkdirSync(path.join(process.env.ACC_RUNNER_ROOT, "stop"), { recursive: true });
  const stopFile = path.join(process.env.ACC_RUNNER_ROOT, "stop", `${j.name}.stop`);
  fs.writeFileSync(stopFile, "");
  let called = false;
  const code = await runLoop(j, false, { run: async () => { called = true; return { code: 0, result: "", err: "" }; } });
  assert.equal(code, 4);
  assert.equal(called, false);
  assert.equal(fs.existsSync(stopFile), false, "stop file must be consumed");
});

test("runLoop: progress resets the stuck counter, run continues past maxStuck runs", async () => {
  const j = job({ maxStuck: 2, maxRuns: 5 });
  let n = 0;
  const code = await runLoop(j, false, {
    run: async () => {
      n++;
      board(j.workdir, j.statusFile, `progress ${n}\n`); // hash changes every run
      if (n >= 4) board(j.workdir, j.statusFile, "DONE\n");
      return { code: 0, result: "ok", err: "" };
    },
  });
  assert.equal(code, 0, "must finish via the done marker, not a false stuck alert");
  assert.equal(n, 4);
});

test("runLoop: no progress for maxStuck runs alerts and returns 2", async () => {
  const j = job({ maxStuck: 3, maxRuns: 10 });
  let n = 0;
  const code = await runLoop(j, false, { run: async () => { n++; return { code: 0, result: "stuck", err: "" }; } }); // board never changes
  assert.equal(code, 2);
  assert.equal(n, 3, "must stop exactly at maxStuck, not run past it");
  const alerts = fs.readdirSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts")).filter((f) => f.startsWith(j.name));
  assert.equal(alerts.length, 1);
  assert.ok(fs.readFileSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts", alerts[0]), "utf8").includes("no board progress"));
});

test("runLoop: maxRuns exhausted without the done marker alerts and returns 3", async () => {
  const j = job({ maxStuck: 100, maxRuns: 3 });
  let n = 0;
  const code = await runLoop(j, false, {
    run: async () => { n++; board(j.workdir, j.statusFile, `tick ${n}\n`); return { code: 0, result: "", err: "" }; },
  });
  assert.equal(code, 3);
  assert.equal(n, 3);
});

test("runLoop: once=true returns after exactly one run's code", async () => {
  const j = job({ maxRuns: 10 });
  let n = 0;
  const code = await runLoop(j, true, { run: async () => { n++; return { code: 7, result: "", err: "" }; } });
  assert.equal(code, 7);
  assert.equal(n, 1);
});

test("runLoop: once=true with an undefined code falls back to 0, and stderr is logged", async () => {
  const j = job({ maxRuns: 10 });
  const code = await runLoop(j, true, { run: async () => ({ code: undefined, result: "", err: "boom on stderr" }) });
  assert.equal(code, 0);
  const logText = fs.readFileSync(path.join(process.env.ACC_RUNNER_ROOT, "logs", `${j.name}.log`), "utf8");
  assert.ok(logText.includes("stderr tail: boom on stderr"));
});

// ------------------------------------------------------------- install
test("install throws when the job carries no schedule", () => {
  assert.throws(() => install(job()), /job\.schedule/);
});

test("install builds the schtasks command via the injected exec, without needing schtasks to exist", () => {
  const j = job({ schedule: { type: "daily", time: "06:00" } });
  let captured = null;
  install(j, (cmd, args) => { captured = { cmd, args }; });
  assert.equal(captured.cmd, "schtasks");
  assert.ok(captured.args.includes(`guards-runner-${j.name}`));
  assert.ok(captured.args.includes("06:00"));
});

// ------------------------------------------------------------- status
function captureLog(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n");
}

test("status prints 'no log yet' when nothing has run", () => {
  const out = captureLog(() => status(job({ name: "neverran" })));
  assert.ok(out.includes("no log yet"));
});

test("status prints the log tail and any alerts", () => {
  const j = job({ name: "hasrun" });
  fs.mkdirSync(path.join(process.env.ACC_RUNNER_ROOT, "logs"), { recursive: true });
  fs.writeFileSync(path.join(process.env.ACC_RUNNER_ROOT, "logs", `${j.name}.log`), "2026-08-01T00:00:00Z line one\n");
  fs.mkdirSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts"), { recursive: true });
  fs.writeFileSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts", `${j.name}-123.txt`), "trouble\n");
  const printed = captureLog(() => status(j));
  assert.ok(printed.includes("line one"));
  assert.ok(printed.includes(`${j.name}-123.txt`));
});

// ------------------------------------------------------------- killTree branches
// Both platform branches proven on any one OS: killTreeWin32 by asserting the
// command it WOULD issue via an injected exec (never touching real taskkill,
// which doesn't exist on this sandbox); killTreePosix for real, against a
// spawned process group, in the integration test below (the one this repo's
// timeout path actually exercises on POSIX).
test("killTreeWin32 issues taskkill /pid <pid> /t /f, via the injected exec", () => {
  let captured = null;
  killTreeWin32({ pid: 4242 }, (cmd, args) => { captured = { cmd, args }; });
  assert.equal(captured.cmd, "taskkill");
  assert.deepEqual(captured.args, ["/pid", "4242", "/t", "/f"]);
});

test("killTreeWin32 swallows a failing exec rather than throwing", () => {
  assert.doesNotThrow(() => killTreeWin32({ pid: 1 }, () => { throw new Error("no taskkill here"); }));
});

test("killTree dispatches to the win32 branch on an injected platform, without a real taskkill on hand", () => {
  assert.doesNotThrow(() => killTree({ pid: 99999 }, "win32")); // killTreeWin32 swallows the real ENOENT itself
});

test("killTree dispatches to the posix branch on any non-win32 injected platform", () => {
  assert.doesNotThrow(() => killTree({ pid: -1, kill: () => {} }, "linux")); // killTreePosix swallows the bad pid itself
});

test("log() rotates the log file to .1 once it reaches the size cap", () => {
  const j = job({ name: "rotatejob" });
  const logDir = path.join(process.env.ACC_RUNNER_ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${j.name}.log`);
  fs.writeFileSync(logFile, "x".repeat(1024 * 1024)); // at the cap
  log(j, "one more line");
  assert.ok(fs.existsSync(logFile + ".1"), "the full log must be rotated aside");
  assert.ok(fs.readFileSync(logFile, "utf8").includes("one more line"));
});

test("killTreePosix signals the process GROUP (negative pid), and falls back to child.kill on failure", async () => {
  // NODE_V8_COVERAGE must not leak: this child is killed within 150ms of
  // spawning, and a coverage-instrumented process killed mid-write leaves a
  // truncated raw-profile JSON fragment that corrupts an ancestor's coverage
  // report generation under `node hooks/covgate.mjs` (found 2026-08-02).
  const child = spawn("node", ["-e", "setTimeout(() => {}, 5000)"], {
    detached: true, stdio: "ignore", env: { ...process.env, NODE_V8_COVERAGE: undefined },
  });
  await new Promise((r) => setTimeout(r, 50));
  killTreePosix(child);
  await new Promise((r) => setTimeout(r, 100));
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, "the real process must be dead, not orphaned");

  // Fallback path: an invalid pid makes process.kill(-pid,...) throw, and the
  // catch must fall back to child.kill() rather than propagate.
  assert.doesNotThrow(() => killTreePosix({ pid: -1, kill: () => {} }));

  // Both defenses failing at once must still not throw out of killTree —
  // it is called from inside a setTimeout in runClaudeOnce with nothing
  // downstream to catch it.
  assert.doesNotThrow(() => killTreePosix({ pid: -1, kill: () => { throw new Error("also broken"); } }));
});

// ------------------------------------------------------------- integration: fake claude
const BIN = path.join(BASE, "bin");
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(
  path.join(BIN, "claude-impl.mjs"),
  `
import fs from "node:fs";
const dir = process.env.FAKE_CLAUDE_STATE_DIR;
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
fs.mkdirSync(dir, { recursive: true });
const countFile = dir + "/calls.txt";
let n = 0;
try { n = Number(fs.readFileSync(countFile, "utf8")); } catch {}
n++;
fs.writeFileSync(countFile, String(n));
fs.writeFileSync(dir + "/argv.json", JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(dir + "/pid.txt", String(process.pid));
fs.writeFileSync(dir + "/env-directive.txt", process.env.ACC_DIRECTIVE || "");
fs.writeFileSync(dir + "/env-profile.txt", process.env.ACC_PROFILE || "");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync(dir + "/stdin.txt", stdin);
  if (mode === "ok") { process.stdout.write(JSON.stringify({ result: "BANANA" })); process.exit(0); }
  else if (mode === "badjson") { process.stdout.write("raw non-json output"); process.exit(0); }
  else if (mode === "noresult") { process.stdout.write(JSON.stringify({ ok: true })); process.exit(0); } // valid JSON, no "result" key
  else if (mode === "transport-then-ok") {
    if (n < 3) { process.stderr.write("Unable to connect to API (econnreset)"); process.exit(1); }
    process.stdout.write(JSON.stringify({ result: "RECOVERED" })); process.exit(0);
  } else if (mode === "hang") { setTimeout(() => { process.stdout.write("{}"); process.exit(0); }, 15000); }
  else { process.exit(1); }
});
`.trimStart()
);
fs.writeFileSync(
  path.join(BIN, "claude"),
  `#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-impl.mjs"));
`
);
fs.chmodSync(path.join(BIN, "claude"), 0o755);
fs.writeFileSync(path.join(BIN, "claude.cmd"), `@echo off\r\nnode "%~dp0claude-impl.mjs" %*\r\n`);
process.env.PATH = BIN + path.delimiter + process.env.PATH;

function fakeClaudeDir(name) {
  const d = path.join(BASE, "fake-" + name);
  process.env.FAKE_CLAUDE_STATE_DIR = d;
  return d;
}

test("integration: bootstrap travels over stdin, never argv; args match the documented flags", async () => {
  const dir = fakeClaudeDir("stdin");
  process.env.FAKE_CLAUDE_MODE = "ok";
  const j = job({ bootstrap: "multi word bootstrap with spaces and \"quotes\"" });
  const r = await runClaudeOnce(j);
  assert.equal(r.code, 0);
  assert.equal(r.result, "BANANA");
  assert.equal(fs.readFileSync(path.join(dir, "stdin.txt"), "utf8"), j.bootstrap);
  const argv = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));
  assert.deepEqual(argv, ["-p", "--permission-mode", "bypassPermissions", "--output-format", "json", "--max-turns", "200"]);
  assert.ok(!argv.join(" ").includes("multi word"), "bootstrap must never appear in argv");
});

test("integration: the spawn path is DEP0190-clean (--throw-deprecation stays exit 0)", async () => {
  const dir = fakeClaudeDir("dep0190");
  process.env.FAKE_CLAUDE_MODE = "ok";
  const j = job({ bootstrap: "dep check" });
  const driver = `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(HERE, "runner.mjs")).href)});
    const j = ${JSON.stringify(j)};
    const r = await m.runClaudeOnce(j);
    process.exit(r.code === 0 ? 0 : 1);
  `;
  const r = spawnSync(process.execPath, ["--throw-deprecation", "--input-type=module", "-e", driver], {
    encoding: "utf8", env: { ...process.env },
  });
  assert.ok(!/DEP0190/.test(r.stderr), `spawn still triggers DEP0190:\n${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
});

test("integration: non-JSON stdout falls back to the raw text as result", async () => {
  fakeClaudeDir("badjson");
  process.env.FAKE_CLAUDE_MODE = "badjson";
  const r = await runClaudeOnce(job());
  assert.equal(r.code, 0);
  assert.equal(r.result, "raw non-json output");
});

test("integration: valid JSON with no result key falls back to an empty string, not 'undefined'", async () => {
  fakeClaudeDir("noresult");
  process.env.FAKE_CLAUDE_MODE = "noresult";
  const r = await runClaudeOnce(job());
  assert.equal(r.code, 0);
  assert.equal(r.result, "");
});

test("integration: a hung run is killed PROMPTLY at its timeout, not merely eventually", async () => {
  // The real assertion is TIMING, not just "not code 0": a plain child.kill()
  // under shell:true only signals the shell wrapper, orphaning the real
  // process for its full natural duration (verified: 8s+ instead of ~200ms)
  // — that orphan is exactly the invisible extra stream the lane exists to
  // prevent. killTree's process-group kill must return well before the fake
  // binary's own 15s hang timer, or this is silently back to orphaning.
  const dir = fakeClaudeDir("hang");
  process.env.FAKE_CLAUDE_MODE = "hang";
  const t0 = Date.now();
  // The fake binary is a real spawn -> sh -> node -> dynamic-import chain.
  // Coverage instrumentation can make that startup take hundreds of
  // milliseconds, so the timeout must leave enough room for the child to
  // write its proof-of-life PID before the kill. The assertion is elapsed
  // << the 15s natural hang, not an artificially tiny timeout.
  const r = await runClaudeOnce(job({ runTimeoutMin: 0.02 })); // 1.2s timeout
  const elapsed = Date.now() - t0;
  assert.notEqual(r.code, 0, "a killed process must not report success");
  assert.ok(elapsed < 5000, `kill took ${elapsed}ms — the process was orphaned, not killed (see killTree)`);
  // Direct proof, not just timing: the fake binary's own pid (written before
  // it ever blocks on the hang timer) must actually be dead, not merely
  // detached from our stdio pipes. process.kill(pid, 0) is a liveness probe
  // on every platform Node supports (throws ESRCH once the pid is gone), so
  // this runs on Windows too (OI-014) — proving killTreeWin32's real
  // `taskkill /pid <pid> /t /f` actually kills the fake claude's process
  // tree, not just detaches from it, on the windows-integration CI job.
  await new Promise((res) => setTimeout(res, 300));
  const pid = Number(fs.readFileSync(path.join(dir, "pid.txt"), "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, `fake claude pid ${pid} is still alive — orphaned, not killed`);
});

test("integration: runOnce retries a transport failure through the real lane and recovers", async () => {
  fakeClaudeDir("transport");
  process.env.FAKE_CLAUDE_MODE = "transport-then-ok";
  const r = await runOnce(job({ name: "transportjob" }));
  assert.equal(r.code, 0);
  assert.equal(r.result, "RECOVERED");
});

test("integration: a paced second launch logs via the JOB'S OWN log(), not just stdout", async () => {
  // Proves runOnce's withLaunchSlot onLog wiring end to end — the "waiting
  // for a slot" line is gated at a real 15s (too slow to wait out in a fast
  // suite; lane.test.mjs already proves it fires), but minGapMs pacing is
  // instant to trigger: bump it, run twice back to back, and the SECOND
  // job's own log file (the one a human actually reads from the Process
  // tab) must carry the pacing line, proving runner.mjs's callback wiring —
  // not just lane.mjs's internal mechanics — actually connects.
  // minGapMs must comfortably exceed job A's OWN full runOnce() duration
  // (paceStart timestamps at slot-acquisition, so the "gap" job B races
  // against includes all of job A's spawn+wait+log+release, not just the
  // moment between the two calls) — 250ms genuinely flaked under the real
  // covgate.mjs gate (all ten fast-tier files running concurrently, every
  // one coverage-instrumented): job A itself occasionally took >250ms under
  // that load, so pacing correctly and silently skipped, and the test's own
  // assumption broke, not runner.mjs (found 2026-08-02).
  fakeClaudeDir("pace");
  process.env.FAKE_CLAUDE_MODE = "ok";
  const saved = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ lane: { slots: 1, minGapMs: 3000, retries: 2, backoffBaseMs: 1, backoffCapMs: 2, pollMs: 20 } }));
  try {
    const jA = job({ name: "pace-a" });
    const jB = job({ name: "pace-b" });
    await runOnce(jA);
    await runOnce(jB);
    const logB = fs.readFileSync(path.join(process.env.ACC_RUNNER_ROOT, "logs", `${jB.name}.log`), "utf8");
    assert.ok(/lane: pacing start/.test(logB), logB);
  } finally {
    fs.writeFileSync(process.env.ACC_POLICY, saved);
  }
});

delete process.env.FAKE_CLAUDE_MODE;
delete process.env.FAKE_CLAUDE_STATE_DIR;

// ------------------------------------------------------------- CLI (subprocess)
function cli(args, env = {}) {
  try {
    return { code: 0, out: execFileSync("node", [RUNNER, ...args], { encoding: "utf8", env: { ...process.env, ...env } }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

test("CLI: no args prints usage and exits 1", () => {
  const r = cli([]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("usage:"));
});

test("CLI: no args, ACC_RUNNER_ROOT genuinely unset, still prints usage safely", () => {
  // ROOT is a module-load-time const, so the fallback branch (-> HERE, the
  // real guards/runner dir) is only reachable in a fresh subprocess — proven
  // safe here because the no-args path returns before anything ever touches
  // a ROOT-derived path (no logs/, no alerts/, no jobs/ lookup).
  const r = cli([], { ACC_RUNNER_ROOT: undefined });
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("usage:"));
});

test("CLI: --install with no schedule throws uncaught and exits non-zero", () => {
  const p = path.join(BASE, "cli-noschedule.json");
  fs.writeFileSync(p, JSON.stringify(job()));
  const r = cli([p, "--install"]);
  assert.notEqual(r.code, 0);
  assert.ok(r.out.includes("job.schedule"));
});

test("CLI: a job that is already done exits 0 immediately and never touches claude", () => {
  const j = job({ name: "clidone" });
  board(j.workdir, j.statusFile, "DONE\n");
  const p = path.join(BASE, "cli-done.json");
  fs.writeFileSync(p, JSON.stringify(j));
  const r = cli([p]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("queue complete"));
  assert.equal(fs.existsSync(path.join(BASE, "fake-clidone")), false, "must never have spawned the fake claude");
});

test("CLI: --status reflects the prior run's log", () => {
  const p = path.join(BASE, "cli-done.json"); // reuse the job from the previous test
  const r = cli([p, "--status"]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("queue complete"));
});

// In-process coverage of cli() itself: subprocess invocations above prove the
// real end-to-end behavior AND the guarded process.exit wiring; these prove
// cli()'s own dispatch table returns the right code for each branch WITHOUT
// spawning a process, which is also the only way this file's own coverage
// tool ever sees cli() run (a subprocess's coverage never reports back here).
test("cli(): no args returns 1 without throwing", async () => {
  assert.equal(await cliFn([]), 1);
});

test("cli(): --install dispatches to install() (proven by the schedule-missing error surfacing through it)", async () => {
  // cli()'s --install branch calls install(job) with NO injected exec, so on
  // this sandbox (no real schtasks) a job WITH a schedule would throw ENOENT
  // from the real exec — a fact about schtasks, not about dispatch. Using a
  // job with no schedule instead proves dispatch reached install() via
  // install()'s OWN validation error, identically on every platform.
  const p = path.join(BASE, "cli-fn-install.json");
  fs.writeFileSync(p, JSON.stringify(job({ name: "clifninstall" })));
  await assert.rejects(() => cliFn([p, "--install"]), /job\.schedule/);
});

test("cli(): --status dispatches and returns 0", async () => {
  const p = path.join(BASE, "cli-fn-status.json");
  fs.writeFileSync(p, JSON.stringify(job({ name: "clifnstatus" })));
  assert.equal(await cliFn([p, "--status"]), 0);
});

test("cli(): default dispatch runs the loop and returns runLoop's own code", async () => {
  const j = job({ name: "clifndone" });
  board(j.workdir, j.statusFile, "DONE\n");
  const p = path.join(BASE, "cli-fn-done.json");
  fs.writeFileSync(p, JSON.stringify(j));
  assert.equal(await cliFn([p]), 0);
});

// ------------------------------------------------------------- directive jobs (SPEC-0001, FR-011)
// The directive store is real (hooks/directive.mjs against a sandboxed
// ACC_ROOT), never a forged fixture — these tests exercise the same store
// mutations the live loop uses.
process.env.ACC_ROOT = path.join(BASE, "accroot");
const D = await import("../hooks/directive.mjs");
const runnerNs = await import("./runner.mjs");
const { loadDirectiveJob, directiveState } = runnerNs;

function directive(over = {}) {
  const cwd = over.cwd !== undefined ? over.cwd : fs.mkdtempSync(path.join(BASE, "dwork-"));
  return D.createDirective({ text: over.text ?? "fix the tests", cwd, profile: over.profile, budget: over.budget });
}

test("AC-001: loadJob('directive:<id>') synthesizes a job from the store with file-job defaults", () => {
  const d = directive();
  const j = loadJob(`directive:${d.id}`);
  assert.equal(j.name, `directive-${d.id}`);
  assert.equal(j.workdir, d.cwd);
  assert.equal(j.directiveId, d.id);
  assert.equal(D.KICK_TEXT, "Continue the active ACC directive.",
    "the bootstrap wire constant must be the canonical export");
  assert.equal(j.bootstrap, D.KICK_TEXT);
  assert.equal(j.maxStuck, 3);
  assert.equal(j.maxRuns, 100);
  assert.equal(j.runTimeoutMin, 180);
});

test("AC-002: a directive with no working folder is refused — no job object", () => {
  const d = directive({ cwd: "" });
  assert.throws(() => loadDirectiveJob(d.id), /working folder|cwd/i);
});

test("AC-003 / PROP-001: any non-active or absent directive is refused", () => {
  for (const status of ["done", "blocked"]) {
    const d = directive();
    D.setStatus(d.id, status, "test");
    assert.throws(() => loadDirectiveJob(d.id), /not active/i, `status ${status} must refuse`);
  }
  assert.throws(() => loadDirectiveJob("never-existed"), /not active/i);
});

test("directiveState: active with no log is not done and hashes stably", () => {
  const d = directive();
  const a = directiveState(d.id);
  assert.equal(a.done, false);
  assert.equal(directiveState(d.id).hash, a.hash);
});

test("directiveState: identical consecutive summaries hash identically — headers/timestamps excluded (AC-006's foundation)", () => {
  const d = directive();
  D.appendCycle(d.id, { sessionId: "headless", ctx: 0, text: "same summary" });
  const a = directiveState(d.id);
  D.appendCycle(d.id, { sessionId: "headless", ctx: 0, text: "same summary" });
  assert.equal(directiveState(d.id).hash, a.hash,
    "two cycles with identical bodies must not read as progress");
  D.appendCycle(d.id, { sessionId: "headless", ctx: 0, text: "different summary" });
  assert.notEqual(directiveState(d.id).hash, a.hash);
});

test("AC-005: the loop ends 0 when the directive itself reports done", async () => {
  const d = directive();
  const j = loadJob(`directive:${d.id}`);
  let calls = 0;
  const code = await runLoop(j, false, {
    run: async () => {
      calls++;
      D.setStatus(d.id, "done", "finished by the model");
      return { code: 0, result: "all done", err: "" };
    },
  });
  assert.equal(code, 0);
  assert.equal(calls, 1);
});

test("AC-005: if the directive leaves active status between preflight checks, the loop returns 0 without spawning", async () => {
  const d = directive();
  const j = loadJob(`directive:${d.id}`);
  let calls = 0;
  const code = await runLoop(j, false, {
    run: async () => { calls++; return { code: 0, result: "", err: "" }; },
    tier: () => { D.setStatus(d.id, "done", "finished just before launch"); return "green"; },
  });
  assert.equal(code, 0);
  assert.equal(calls, 0);
});

test("AC-006: identical consecutive summaries trip the stuck brake (alert + exit 2)", async () => {
  const d = directive();
  const j = { ...loadJob(`directive:${d.id}`), maxStuck: 2, maxRuns: 10 };
  const code = await runLoop(j, false, {
    run: async () => ({ code: 0, result: "same words every time", err: "" }),
  });
  assert.equal(code, 2);
  const alerts = fs.readdirSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts"))
    .filter((f) => f.startsWith(j.name + "-"));
  assert.ok(alerts.length >= 1, "a stuck stop must leave an alert");
});

test("AC-006: a differing summary resets the stuck counter", async () => {
  const d = directive();
  const j = { ...loadJob(`directive:${d.id}`), maxStuck: 2, maxRuns: 4 };
  let n = 0;
  const code = await runLoop(j, false, {
    run: async () => ({ code: 0, result: `progress step ${++n}`, err: "" }),
  });
  assert.equal(code, 3, "always-different summaries must reach maxRuns (3), never stuck (2)");
});

test("AC-007 / PROP-002: each run appends exactly one cycle entry carrying the run's summary", async () => {
  const d = directive();
  const j = loadJob(`directive:${d.id}`);
  await runLoop(j, true, { run: async () => ({ code: 0, result: "did X to the parser", err: "" }) });
  assert.equal(Number(D.readDirective(d.id).cycles), 1, "exactly one cycle per run");
  assert.match(D.logTail(d.id), /did X to the parser/);
});

test("AC-008: a red week tier holds the loop — no run, alert, exit 5", async () => {
  const d = directive();
  const j = loadJob(`directive:${d.id}`);
  let calls = 0;
  const code = await runLoop(j, false, {
    run: async () => { calls++; return { code: 0, result: "x", err: "" }; },
    tier: () => "red",
  });
  assert.equal(code, 5);
  assert.equal(calls, 0, "a red tier must stop the run before any spawn");
});

test("AC-009: a directive wall-clock ceiling shrinks the next run timeout to the remaining budget", async () => {
  const d = directive({ budget: { wallClockMin: 1 } });
  const file = path.join(process.env.ACC_ROOT, "runner", "directives", `${d.id}.json`);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  onDisk.createdAt = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2) + "\n");
  const j = loadJob(`directive:${d.id}`);
  let seenTimeout = 0;
  const code = await runLoop(j, true, {
    run: async (runJob) => {
      seenTimeout = runJob.runTimeoutMin;
      D.setStatus(d.id, "done", "finished");
      return { code: 0, result: "done", err: "" };
    },
  });
  assert.equal(code, 0);
  assert.ok(seenTimeout < 1 && seenTimeout > 0.4, `expected ~0.5 min remaining, got ${seenTimeout}`);
});

test("AC-009: a directive turn ceiling clamps the next run's --max-turns to the remaining budget", async () => {
  const d = directive({ budget: { turns: 3 } });
  const sid = "00000000-0000-4000-8000-000000000111";
  D.bindSession({ sessionId: sid, directiveId: d.id });
  writeSessionTranscript(sid, [
    usageTurn("2026-08-01T00:00:00.000Z", { input: 10, out: 1 }),
    usageTurn("2026-08-01T00:01:00.000Z", { input: 20, out: 2 }),
  ]);
  const j = loadJob(`directive:${d.id}`);
  let seenTurns = 0;
  const code = await runLoop(j, true, {
    run: async (runJob) => {
      seenTurns = runJob.maxTurns;
      D.setStatus(d.id, "done", "finished");
      return { code: 0, result: "done", err: "" };
    },
  });
  assert.equal(code, 0);
  assert.equal(seenTurns, 1);
});

test("AC-009: token/dollar directive ceilings halt the loop before another run starts (alert + exit 7)", async () => {
  const d = directive({ budget: { tokens: 100, dollars: 0.001 } });
  const sid = "00000000-0000-4000-8000-000000000222";
  D.bindSession({ sessionId: sid, directiveId: d.id });
  writeSessionTranscript(sid, [
    usageTurn("2026-08-01T00:00:00.000Z", { input: 90, out: 20 }),
  ]);
  const j = loadJob(`directive:${d.id}`);
  let called = false;
  const code = await runLoop(j, false, {
    run: async () => { called = true; return { code: 0, result: "", err: "" }; },
  });
  assert.equal(code, 7);
  assert.equal(called, false, "a spent-out directive must halt before the next launch");
  const alerts = fs.readdirSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts"))
    .filter((f) => f.startsWith(j.name + "-"));
  assert.ok(alerts.length >= 1);
  assert.match(D.logTail(d.id, 5000), /HALTED/);
  assert.match(D.logTail(d.id, 5000), /token ceiling reached/);
});

test("AC-009: an exact whole-dollar spend is reported without decimal noise", async () => {
  const d = directive({ budget: { dollars: 1 } });
  const sid = "00000000-0000-4000-8000-000000000223";
  D.bindSession({ sessionId: sid, directiveId: d.id });
  writeSessionTranscript(sid, [
    usageTurn("2026-08-01T00:00:00.000Z", { input: 1_250_000, model: "claude-haiku-5" }),
  ]);
  const j = loadJob(`directive:${d.id}`);
  const code = await runLoop(j, false, {
    run: async () => ({ code: 0, result: "", err: "" }),
  });
  assert.equal(code, 7);
  assert.match(D.logTail(d.id, 5000), /dollar ceiling reached \(\$1\/\$1 est\)/);
});

test("issue #68: a budget-exhausted halt writes exactly one receipt, and a retried halt never duplicates it", async () => {
  const d = directive({ budget: { tokens: 100, dollars: 0.001 } });
  const sid = "00000000-0000-4000-8000-000000000333";
  D.bindSession({ sessionId: sid, directiveId: d.id });
  writeSessionTranscript(sid, [
    usageTurn("2026-08-01T00:00:00.000Z", { input: 90, out: 20 }),
  ]);
  const j = loadJob(`directive:${d.id}`);
  const code = await runLoop(j, false, { run: async () => ({ code: 0, result: "", err: "" }) });
  assert.equal(code, 7);

  const file = path.join(D.receiptsDir(), `${d.id}.receipt.json`);
  assert.ok(fs.existsSync(file), "a receipt must exist after a budget halt");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(receipt.status, "budget_exhausted");
  assert.match(receipt.why, /token ceiling reached/);
  assert.equal(receipt.blockerClass, "budget-tokens");
  // The directive itself is unchanged — still active, still resumable.
  assert.equal(D.readDirective(d.id).status, "active");

  // Retrying the loop against the still-active, still-breached directive
  // (e.g. an operator or scheduler relaunching it) must halt again without
  // writing a second, possibly-different receipt.
  const code2 = await runLoop({ ...j, name: j.name + "-retry" }, false, {
    run: async () => ({ code: 0, result: "", err: "" }),
  });
  assert.equal(code2, 7);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), receipt, "the original receipt is untouched by the retry");
});

test("AC-010: --install on a directive job is refused", () => {
  const d = directive();
  const j = loadJob(`directive:${d.id}`);
  assert.throws(() => install(j, () => {}), /directive/i);
});

test("AC-004 integration: a directive job's child carries ACC_DIRECTIVE and the directive's profile; a file job's carries neither", async () => {
  const dirState = fakeClaudeDir("acc-directive");
  process.env.FAKE_CLAUDE_MODE = "ok";
  const cwd = fs.mkdtempSync(path.join(BASE, "dwork-"));
  const d = D.createDirective({ text: "fix the tests", cwd, profile: "Heavy" });
  const j = loadJob(`directive:${d.id}`);
  const r = await runClaudeOnce({ ...j, runTimeoutMin: 1 });
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(dirState, "env-directive.txt"), "utf8"), d.id);
  // The Start-work page stores the chosen profile ON the directive; with the
  // WinForms launcher (the old ACC_PROFILE setter) gone, the runner is the
  // only thing that can hand it to the session budget.mjs governs.
  assert.equal(fs.readFileSync(path.join(dirState, "env-profile.txt"), "utf8"), "Heavy",
    "the directive's profile must reach the child as ACC_PROFILE");

  const fileJob = job({ bootstrap: "plain file job" });
  await runClaudeOnce({ ...fileJob, runTimeoutMin: 1 });
  assert.equal(fs.readFileSync(path.join(dirState, "env-directive.txt"), "utf8"), "",
    "a file job must never masquerade as a directive session");
  assert.equal(fs.readFileSync(path.join(dirState, "env-profile.txt"), "utf8"), "",
    "a file job carries no profile");
});

// ------------------------------------------------------------- pid-file singleton (SPEC-0005, FR-012)
// Two runner loops on one directive was practically impossible while the only
// launch path was a human's own console; the web Launch button makes it one
// accidental double-click. The runner OWNS this invariant (the server's 409
// pre-check is UX only): runLoop writes state/<job.name>.pid at entry, refuses
// with exit 6 while that pid is alive, reclaims a stale file, and removes its
// own in a finally.
const pidFileFor = (j) => path.join(process.env.ACC_RUNNER_ROOT, "state", `${j.name}.pid`);

test("singleton: a live pid refuses the second loop (exit 6) — no run, and the holder's file survives", async () => {
  const j = job({ name: "single-live" });
  fs.mkdirSync(path.dirname(pidFileFor(j)), { recursive: true });
  fs.writeFileSync(pidFileFor(j), String(process.pid)); // this very test process: alive by construction
  let called = false;
  const code = await runLoop(j, false, { run: async () => { called = true; return { code: 0, result: "", err: "" }; } });
  assert.equal(code, 6);
  assert.equal(called, false, "a refused loop must never spawn a run");
  assert.equal(fs.readFileSync(pidFileFor(j), "utf8"), String(process.pid),
    "the loser must not unlink the holder's pid file on its way out");
});

test("singleton: a stale pid file (dead process, or garbage content) is reclaimed and the loop proceeds", async () => {
  const dead = spawnSync("node", ["-e", ""], { env: { ...process.env, NODE_V8_COVERAGE: undefined } }).pid;
  for (const stale of [String(dead), "not-a-pid"]) {
    const j = job({ name: `single-stale-${stale === "not-a-pid" ? "junk" : "dead"}` });
    board(j.workdir, j.statusFile, "DONE\n");
    fs.mkdirSync(path.dirname(pidFileFor(j)), { recursive: true });
    fs.writeFileSync(pidFileFor(j), stale);
    const code = await runLoop(j, false, { run: async () => ({ code: 0, result: "", err: "" }) });
    assert.equal(code, 0, `stale content ${JSON.stringify(stale)} must be reclaimed, not refused`);
    assert.equal(fs.existsSync(pidFileFor(j)), false, "the reclaimed file must be released on exit");
  }
});

test("singleton: the pid file carries this process's pid during the run and is released after", async () => {
  const j = job({ name: "single-during" });
  let seen = "";
  const code = await runLoop(j, true, {
    run: async () => {
      seen = fs.readFileSync(pidFileFor(j), "utf8");
      board(j.workdir, j.statusFile, "DONE\n");
      return { code: 0, result: "", err: "" };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen, String(process.pid), "the pid file must exist and name this loop while a run is in flight");
  assert.equal(fs.existsSync(pidFileFor(j)), false, "a finished loop must release its pid file");
});

test("singleton: losing the reclaim re-create race (or an unremovable obstruction) refuses, never throws or loops", async () => {
  // A DIRECTORY at the pid-file path is the deterministic stand-in for the
  // narrow race where another starter re-creates the file between our unlink
  // and our second wx attempt: the first wx fails EEXIST, the read yields no
  // live pid, the unlink cannot clear it, and the second wx fails again —
  // that path must land on "refuse" (exit 6), not an uncaught throw.
  const j = job({ name: "single-obstructed" });
  fs.mkdirSync(pidFileFor(j), { recursive: true });
  let called = false;
  const code = await runLoop(j, false, { run: async () => { called = true; return { code: 0, result: "", err: "" }; } });
  assert.equal(code, 6);
  assert.equal(called, false);
  fs.rmdirSync(pidFileFor(j));
});

test("singleton: every early exit path releases the pid file too (stop file, red tier)", async () => {
  const jStop = job({ name: "single-stop" });
  fs.mkdirSync(path.join(process.env.ACC_RUNNER_ROOT, "stop"), { recursive: true });
  fs.writeFileSync(path.join(process.env.ACC_RUNNER_ROOT, "stop", `${jStop.name}.stop`), "");
  assert.equal(await runLoop(jStop, false, { run: async () => ({ code: 0, result: "", err: "" }) }), 4);
  assert.equal(fs.existsSync(pidFileFor(jStop)), false);

  const d = directive();
  const jRed = loadJob(`directive:${d.id}`);
  assert.equal(await runLoop(jRed, false, { run: async () => ({ code: 0, result: "", err: "" }), tier: () => "red" }), 5);
  assert.equal(fs.existsSync(pidFileFor(jRed)), false);
});

test("liveTier: parses the check verb's JSON, and every failure shape reads green (documented fail-open)", () => {
  const { liveTier } = runnerNs;
  assert.equal(liveTier(() => JSON.stringify({ tier: "red", weekTokens: 9 })), "red");
  assert.equal(liveTier(() => JSON.stringify({ tier: "amber" })), "amber");
  assert.equal(liveTier(() => JSON.stringify({})), "green", "missing tier field");
  assert.equal(liveTier(() => "not json"), "green", "unparseable output");
  assert.equal(liveTier(() => { throw new Error("spawn failed"); }), "green", "exec failure");
  // The real spawn path, against the real usage.mjs in this sandbox (empty
  // transcript tree, no thresholds): must complete and land on a real tier.
  assert.ok(["green", "amber", "red"].includes(liveTier()));
});
