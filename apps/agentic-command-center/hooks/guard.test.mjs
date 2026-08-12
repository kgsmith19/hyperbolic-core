// node --test hooks/guard.test.mjs  (run from C:\code\guards)
//
// hooks/guard.mjs is the interactive PreToolUse security hook Claude Code
// calls on every Edit/Write/NotebookEdit/Read (registered in
// ~/.claude/settings.json) -- closes #22. Split the same way kernel/guard.mjs
// (pure decide()) / kernel/guardhook.mjs (I/O) is split: the rule-level tests
// below import decide() directly, so covgate can actually see this file's
// lines execute (a subprocess's coverage is invisible to the parent test
// process's V8 instrumentation; a plain import's is not). A second, smaller
// group spawns the real file as a subprocess -- the only way to prove the I/O
// wrapper's fail-closed contract (bad config, unreadable stdin, exit codes)
// end to end, mirroring kernel/guardhook.test.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "./guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = path.join(HERE, "guard.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-guard-test-"));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const ev = (tool_name, file_path) => ({ tool_name, tool_input: { file_path } });
const cfg = (over = {}) => ({ secrets: [], protected: [], repos: {}, ...over });

// ---------------------------------------------------------------------------
// decide() — the rule set, unit-tested by direct import (covgate's subject).
// ---------------------------------------------------------------------------

test("a tool_input with no file_path (or notebook_path) is allowed -- nothing to check", () => {
  const d = decide({ tool_name: "Bash", tool_input: { command: "ls" } }, cfg({ protected: ["/x"] }));
  assert.equal(d.allow, true);
});

test("a payload with no tool_input at all is allowed -- optional chaining, not a crash", () => {
  const d = decide({ tool_name: "Bash" }, cfg({ protected: ["/x"] }));
  assert.equal(d.allow, true);
});

test("notebook_path is used when file_path is absent (NotebookEdit)", () => {
  const d = decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/work/.env" } }, cfg({ secrets: [".env"] }));
  assert.equal(d.allow, false);
  assert.match(d.reason, /secret pattern/i);
});

test("a config with no repos key at all behaves like an empty one", () => {
  const d = decide(ev("Write", "/work/src/a.js"), { secrets: [], protected: [] });
  assert.equal(d.allow, true);
});

test("a repo entry with no cells key at all leaves every path unowned", () => {
  const d = decide(ev("Edit", "/work/proj/src/a.js"), cfg({ repos: { "/work/proj": {} } }));
  assert.equal(d.allow, true);
});

test("secrets: reads AND writes of a matching basename are denied", () => {
  for (const tool of ["Read", "Write", "Edit"]) {
    const d = decide(ev(tool, "/work/.env"), cfg({ secrets: [".env", "*.pem"] }));
    assert.equal(d.allow, false, `${tool} on .env must be denied`);
    assert.match(d.reason, /secret pattern/i);
  }
  const d2 = decide(ev("Read", "/work/certs/server.pem"), cfg({ secrets: [".env", "*.pem"] }));
  assert.equal(d2.allow, false, "glob match on *.pem must deny");
});

test("secrets check is case-insensitive on the basename", () => {
  const d = decide(ev("Read", "/work/.env"), cfg({ secrets: [".ENV"] }));
  assert.equal(d.allow, false);
});

test("a non-matching path is allowed for a read-only tool", () => {
  const d = decide(ev("Read", "/work/readme.md"), cfg({ secrets: [".env"] }));
  assert.equal(d.allow, true);
});

test("a Read of a protected path is allowed -- the protected check only applies to write tools", () => {
  const d = decide(ev("Read", "/guards/hooks/guard.mjs"), cfg({ protected: ["/guards"] }));
  assert.equal(d.allow, true);
});

test("a direct write inside a protected root is denied", () => {
  for (const target of ["/guards/hooks/guard.mjs", "/guards/policy.json"]) {
    const d = decide(ev("Write", target), cfg({ protected: ["/guards"] }));
    assert.equal(d.allow, false, `${target} must be denied`);
    assert.match(d.reason, /guard machinery/i);
  }
});

test("a write outside every protected root is allowed", () => {
  const d = decide(ev("Write", "/work/src/a.js"), cfg({ protected: ["/guards"] }));
  assert.equal(d.allow, true);
});

test("the central runbox is exempt from the protected check", () => {
  const d = decide(ev("Write", "/guards/runbox/fix.ps1"), cfg({ runboxDir: "/guards/runbox", protected: ["/guards"] }));
  assert.equal(d.allow, true);
});

test("a project's .guards runbox is exempt too", () => {
  const d = decide(ev("Write", "/work/proj/.guards/fix.ps1"), cfg({ projects: ["/work/proj"], protected: ["/work/proj"] }));
  assert.equal(d.allow, true);
});

test("a path outside every configured repo is allowed regardless of tool", () => {
  const d = decide(ev("Write", "/elsewhere/a.js"), cfg({ repos: { "/work/proj": { cells: { core: ["src/"] } } } }));
  assert.equal(d.allow, true);
});

test("cells: an owned path with no task.json declaration is denied", () => {
  const d = decide(
    ev("Edit", "/work/proj/src/kernel/a.js"),
    cfg({ repos: { "/work/proj": { cells: { core: ["src/kernel/"] } } } })
  );
  assert.equal(d.allow, false);
  assert.match(d.reason, /owned by the "core" cell/);
  assert.match(d.reason, /no cell/);
});

test("cells: an owned path with the WRONG cell declared is denied and names both", () => {
  const repoRoot = path.join(BASE, "wrong-cell-repo").replaceAll("\\", "/");
  fs.mkdirSync(path.join(repoRoot, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".agents", "task.json"), JSON.stringify({ cell: "interface" }));

  const d = decide(
    ev("Edit", `${repoRoot}/src/kernel/a.js`),
    cfg({ repos: { [repoRoot]: { cells: { core: ["src/kernel/"] } } } })
  );
  assert.equal(d.allow, false);
  assert.match(d.reason, /owned by the "core" cell/);
  assert.match(d.reason, /declares "interface"/);
});

test("cells: the correctly-declared cell may write its own path", () => {
  const repoRoot = path.join(BASE, "right-cell-repo").replaceAll("\\", "/");
  fs.mkdirSync(path.join(repoRoot, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".agents", "task.json"), JSON.stringify({ cell: "core" }));

  const d = decide(
    ev("Edit", `${repoRoot}/src/kernel/a.js`),
    cfg({ repos: { [repoRoot]: { cells: { core: ["src/kernel/"] } } } })
  );
  assert.equal(d.allow, true);
});

test("cells: an unowned path inside a configured repo (e.g. README) is allowed with no declaration", () => {
  const d = decide(
    ev("Edit", "/work/proj/README.md"),
    cfg({ repos: { "/work/proj": { cells: { core: ["src/kernel/"] } } } })
  );
  assert.equal(d.allow, true);
});

test("cells: alwaysAllowed paths bypass cell ownership with no declaration", () => {
  const d = decide(
    ev("Write", "/work/proj/.agents/task.json"),
    cfg({ repos: { "/work/proj": { cells: { rules: [".agents/"] }, alwaysAllowed: [".agents/task.json"] } } })
  );
  assert.equal(d.allow, true);
});

test("a session launched from a parent folder is guarded by the TARGET path, not the cwd", () => {
  // decide() matches config.repos by the file_path it is given, never by
  // process.cwd() -- this is the exact guarantee the file's own header
  // comment names ("a session launched from a parent folder is guarded the
  // same as one launched inside the repo").
  const d = decide(
    ev("Edit", "/work/proj/src/kernel/a.js"),
    cfg({ repos: { "/work/proj": { cells: { core: ["src/kernel/"] } } } })
  );
  assert.equal(d.allow, false);
  assert.match(d.reason, /owned by the "core" cell/);
});

test("a task.json that is not valid JSON is treated as no declaration -- owned paths stay blocked", () => {
  const repoRoot = path.join(BASE, "corrupt-task-repo").replaceAll("\\", "/");
  fs.mkdirSync(path.join(repoRoot, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".agents", "task.json"), "not json {{{");

  const d = decide(
    ev("Edit", `${repoRoot}/src/kernel/a.js`),
    cfg({ repos: { [repoRoot]: { cells: { core: ["src/kernel/"] } } } })
  );
  assert.equal(d.allow, false);
  assert.match(d.reason, /no cell/);
});

// ---------------------------------------------------------------------------
// The I/O wrapper -- real subprocess, real stdin, real exit code. Only what
// decide() cannot cover: config/stdin failures and the enabled flag.
// ---------------------------------------------------------------------------

// Runs the REAL hooks/guard.mjs (not a copy) pointed at a fixture config via
// ACC_GUARD_CONFIG — this file's coverage instrumentation stays attached to
// the actual source under test, unlike spawning a copy at a different path.
let seq = 0;
function run(config, payload) {
  let configPath;
  if (config !== undefined) {
    configPath = path.join(BASE, `wrapper-config-${seq++}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config));
  } else {
    configPath = path.join(BASE, "wrapper-config-missing.json"); // never written -> ENOENT
  }
  const r = spawnSync(process.execPath, [GUARD_PATH], {
    encoding: "utf8",
    input: payload === undefined ? "" : JSON.stringify(payload),
    timeout: 10000,
    env: { ...process.env, ACC_GUARD_CONFIG: configPath },
  });
  return { code: r.status, err: String(r.stderr || "") };
}

test("wrapper: a missing/malformed config.json fails closed with exit 2", () => {
  const r = run(undefined, ev("Read", "/anywhere/file.txt"));
  assert.equal(r.code, 2);
  assert.match(r.err, /failing closed/i);
});

test("wrapper: enabled:false lets everything through, even a secret path", () => {
  const r = run({ enabled: false, secrets: [".env"] }, ev("Read", "/work/.env"));
  assert.equal(r.code, 0);
});

test("wrapper: unparseable stdin payload fails closed with exit 2", () => {
  const r = run({ enabled: true }, undefined);
  assert.equal(r.code, 2);
  assert.match(r.err, /no hook payload/i);
});

test("wrapper: a real deny from decide() reaches the process as exit 2 with the reason on stderr", () => {
  const r = run({ enabled: true, secrets: [".env"], protected: [], repos: {} }, ev("Read", "/work/.env"));
  assert.equal(r.code, 2);
  assert.match(r.err, /secret pattern/i);
});

test("wrapper: a real allow from decide() reaches the process as exit 0", () => {
  const r = run({ enabled: true, secrets: [], protected: [], repos: {} }, ev("Read", "/work/readme.md"));
  assert.equal(r.code, 0);
});

test("wrapper: a stdin that never ends is still bounded by the read timeout, and fails closed", async () => {
  // spawnSync's `input` always closes the write end once delivered, so it can
  // never exercise the timeout arm -- only a live, still-open stdin can.
  // ACC_GUARD_STDIN_TIMEOUT_MS shrinks the 4s production cap to something a
  // fast-tier test can actually wait out.
  const configPath = path.join(BASE, `wrapper-config-${seq++}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
  const child = spawn(process.execPath, [GUARD_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ACC_GUARD_CONFIG: configPath, ACC_GUARD_STDIN_TIMEOUT_MS: "50" },
  });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  // stdin was never written to or ended -- reaching exit at all proves the
  // timer resolved the read, not an "end" event.
  assert.equal(code, 2);
  assert.match(err, /no hook payload/i);
});
