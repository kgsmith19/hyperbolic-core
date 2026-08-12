// node --test hooks/engine.test.mjs  (run from the repo root)
//
// hooks/engine.mjs is the CLI engine that owns the vault
// (vault-import/vault-rm/vault-keys/apply) and the runbox lifecycle
// (projects-add/rm, list/run/trash/restore/flush). Guard-config state
// (enable/disable, secrets/protected lists) moved to
// apps/toolbelt/guards/cli.mjs — see that module's own test suite.
//
// Every test below calls the exported `main({argv, io})` directly (mirrors
// hooks/budget.mjs's own main()/io convention) against a fresh ACC_ROOT
// sandbox created per test group, so coverage tooling actually sees these
// lines execute -- a subprocess call would not. A small subprocess group at
// the bottom proves the real CLI entry point end to end (argv parsing, real
// stdin, real exit code).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, RUNNERS } from "./engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.join(HERE, "engine.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-engine-test-"));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

let seq = 0;
function sandbox(config) {
  const root = path.join(BASE, `root-${seq++}`);
  fs.mkdirSync(root, { recursive: true });
  if (config !== null) {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config ?? { projects: [] }));
  }
  return root;
}

// Captures stdout/stderr writes instead of printing them, and never touches
// process.exit -- main() returns the exit code directly.
function io() {
  const out = [];
  const err = [];
  return {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

async function run(root, argv, opts = {}) {
  const prev = process.env.ACC_ROOT;
  process.env.ACC_ROOT = root;
  const i = io();
  try {
    const code = await main({ argv, io: i, ...opts });
    return { code, out: i.text(), err: i.errText() };
  } finally {
    if (prev === undefined) delete process.env.ACC_ROOT;
    else process.env.ACC_ROOT = prev;
  }
}

// ---------------------------------------------------------------------------
// status (guard-config's own status moved to apps/toolbelt/guards/cli.mjs)
// ---------------------------------------------------------------------------

test("status: reports projects plus derived vault/runbox counts — no guard-config fields", async () => {
  const root = sandbox({ projects: [] });
  const r = await run(root, ["status"]);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.deepEqual(j, { projects: [], vaultKeys: [], pending: 0, trashed: 0 });
});

test("status: a missing config.json fails closed via CliFail, not a crash", async () => {
  const root = sandbox(null);
  const r = await run(root, ["status"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no config\.json at/);
});

// ---------------------------------------------------------------------------
// projects-add / projects-rm
// ---------------------------------------------------------------------------

test("projects-add: registers a folder, dedupes case-insensitively, seeds .guards/runbox + .gitignore", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [], projects: [] });
  const proj = path.join(BASE, "proj-a");
  fs.mkdirSync(proj, { recursive: true });

  let r = await run(root, ["projects-add", proj]);
  assert.equal(r.code, 0);
  assert.match(r.out, /watching:/);
  assert.ok(fs.existsSync(path.join(proj, ".guards", "runbox")));
  assert.equal(fs.readFileSync(path.join(proj, ".guards", ".gitignore"), "utf8"), "*\n");

  r = await run(root, ["projects-add", proj.toUpperCase()]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).projects.length, 1);
});

test("projects-add: a missing or non-folder path fails", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [], projects: [] });
  let r = await run(root, ["projects-add"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: projects-add/);

  const notAFolder = path.join(BASE, "not-a-folder.txt");
  fs.writeFileSync(notAFolder, "x");
  r = await run(root, ["projects-add", notAFolder]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not a folder/);
});

test("projects-rm: removes from the list and leaves .guards on disk with a note", async () => {
  const proj = path.join(BASE, "proj-b");
  fs.mkdirSync(proj, { recursive: true });
  const root = sandbox({ enabled: true, secrets: [], protected: [], projects: [proj] });

  const r = await run(root, ["projects-rm", proj]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).projects.length, 0);
  assert.match(r.out, /was left on disk/);
});

test("projects-rm: with nothing left prints the central-runbox-only note", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [], projects: [] });
  const r = await run(root, ["projects-rm", path.join(BASE, "never-added")]);
  assert.match(r.out, /only the central runbox/);
});

// ---------------------------------------------------------------------------
// list / trash-list (runbox lifecycle, read side)
// ---------------------------------------------------------------------------

function writeScript(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

test("list: an empty runbox says so in plain text, and as [] for --json", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: path.join(BASE, "empty-rb") });
  let r = await run(root, ["list"]);
  assert.match(r.out, /runbox is empty/);
  r = await run(root, ["list", "--json"]);
  assert.deepEqual(JSON.parse(r.out), []);
});

test("list: shows pending scripts across the central runbox and every project runbox, with keep + summary + non-runnable files filtered out", async () => {
  const rb = path.join(BASE, "central-rb-1");
  writeScript(rb, "fix.ps1", "# fixes a thing\nWrite-Host hi\n");
  writeScript(rb, "keeper.mjs", "// guards: keep\n// a standing script\nconsole.log(1)\n");
  writeScript(rb, "notes.txt", "not a script"); // filtered by RUNNABLE

  const proj = path.join(BASE, "proj-list");
  fs.mkdirSync(proj, { recursive: true });
  writeScript(path.join(proj, ".guards", "runbox"), "helper.js", "console.log('hi')\n");

  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb, projects: [proj] });
  let r = await run(root, ["list", "--json"]);
  const items = JSON.parse(r.out);
  assert.equal(items.length, 3);
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(byName["fix.ps1"].summary, "fixes a thing");
  assert.equal(byName["fix.ps1"].keep, false);
  assert.equal(byName["keeper.mjs"].keep, true);
  assert.equal(byName["keeper.mjs"].summary, "a standing script"); // the marker line is skipped, not treated as the summary
  assert.equal(byName["helper.js"].label, path.basename(proj));
  assert.ok(!("notes.txt" in byName));

  r = await run(root, ["list"]);
  assert.match(r.out, /fix\.ps1  \[keep\]|fix\.ps1\n/); // plain-text form present, sanity only
  assert.match(r.out, /keeper\.mjs  \[keep\]/);
});

test("list: a script with no leading comment has an empty summary", async () => {
  const rb = path.join(BASE, "central-rb-2");
  writeScript(rb, "bare.mjs", "console.log(1)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  const r = await run(root, ["list", "--json"]);
  assert.equal(JSON.parse(r.out)[0].summary, "");
});

test("trash-list: empty vs populated vs --json", async () => {
  const rb = path.join(BASE, "central-rb-3");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  let r = await run(root, ["trash-list"]);
  assert.match(r.out, /trash is empty/);

  writeScript(rb, "gone.mjs", "// was trashed\nconsole.log(1)\n");
  await run(root, ["trash", "gone.mjs"]);

  r = await run(root, ["trash-list"]);
  assert.match(r.out, /central:\d{8}-\d{6}_gone\.mjs/);
  r = await run(root, ["trash-list", "--json"]);
  assert.equal(JSON.parse(r.out).length, 1);
});

// ---------------------------------------------------------------------------
// resolveRef shapes: bare name, label:name, absolute path, ambiguity, misses
// ---------------------------------------------------------------------------

test("trash: a bare name resolves when unambiguous", async () => {
  const rb = path.join(BASE, "central-rb-4");
  writeScript(rb, "solo.mjs", "console.log(1)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  const r = await run(root, ["trash", "solo.mjs"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /trashed central:solo\.mjs/);
  assert.equal(fs.readdirSync(rb).filter((f) => f !== ".trash").length, 0);
});

test("trash: label:name resolves a specific runbox when the bare name is ambiguous", async () => {
  const rb = path.join(BASE, "central-rb-5");
  writeScript(rb, "dup.mjs", "console.log('central')\n");
  const proj = path.join(BASE, "proj-dup");
  fs.mkdirSync(proj, { recursive: true });
  writeScript(path.join(proj, ".guards", "runbox"), "dup.mjs", "console.log('proj')\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb, projects: [proj] });

  const ambiguous = await run(root, ["trash", "dup.mjs"]);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err, /"dup\.mjs" is ambiguous/);

  const label = path.basename(proj);
  const r = await run(root, ["trash", `${label}:dup.mjs`]);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(rb, "dup.mjs"))); // only the project's copy moved
});

test("RUNNERS: every supported extension produces an [exe, args] shape naming the file", () => {
  // Exercised directly rather than via `run` for .ps1/.cmd/.bat: those
  // binaries are Windows-only and this repo's fast tier also runs on Linux
  // CI (this file's own header). .mjs/.js are exercised for real below.
  assert.deepEqual(RUNNERS[".ps1"]("x.ps1"), ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "x.ps1"]]);
  assert.deepEqual(RUNNERS[".cmd"]("x.cmd"), ["cmd", ["/c", "x.cmd"]]);
  assert.deepEqual(RUNNERS[".bat"]("x.bat"), ["cmd", ["/c", "x.bat"]]);
  assert.deepEqual(RUNNERS[".mjs"]("x.mjs"), ["node", ["x.mjs"]]);
  assert.deepEqual(RUNNERS[".js"]("x.js"), ["node", ["x.js"]]);
});

test("run: a .js script runs the same way .mjs does", async () => {
  const rb = path.join(BASE, "central-rb-js");
  writeScript(rb, "plain.js", "process.exit(0)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  const r = await run(root, ["run", "plain.js"]);
  assert.equal(r.code, 0);
});

test("run: an absolute path also resolves a pending script", async () => {
  const rb = path.join(BASE, "central-rb-6");
  writeScript(rb, "abs.mjs", "process.exit(0)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  const r = await run(root, ["run", path.join(rb, "abs.mjs")]);
  assert.equal(r.code, 0);
});

test("trash: a name matching nothing fails, listing what IS available", async () => {
  const rb = path.join(BASE, "central-rb-7");
  writeScript(rb, "real.mjs", "console.log(1)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  const r = await run(root, ["trash", "nope.mjs"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no pending script named "nope\.mjs"/);
  assert.match(r.err, /central:real\.mjs/);
});

test("trash: usage error when no ref given", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  const r = await run(root, ["trash"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: trash/);
});

// ---------------------------------------------------------------------------
// run: exit codes, keep marker, self-cleanup, unsupported extension
// ---------------------------------------------------------------------------

test("run: a successful non-keep script is archived to .trash after running", async () => {
  const rb = path.join(BASE, "central-rb-8");
  writeScript(rb, "ok.mjs", "process.exit(0)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  const r = await run(root, ["run", "ok.mjs"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /archived to the runbox trash/);
  assert.ok(!fs.existsSync(path.join(rb, "ok.mjs")));
  assert.equal(fs.readdirSync(path.join(rb, ".trash")).length, 1);
});

test("run: a `guards: keep` script stays in the runbox after a successful run", async () => {
  const rb = path.join(BASE, "central-rb-9");
  writeScript(rb, "standing.mjs", "// guards: keep\nprocess.exit(0)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  const r = await run(root, ["run", "standing.mjs"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /kept in the runbox/);
  assert.ok(fs.existsSync(path.join(rb, "standing.mjs")));
});

test("run: a script that deletes itself (self-archiving installer) is reported, not double-archived", async () => {
  const rb = path.join(BASE, "central-rb-10");
  writeScript(rb, "selfclean.mjs", `import fs from "node:fs"; fs.unlinkSync(process.argv[1]);`);
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  const r = await run(root, ["run", "selfclean.mjs"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /script cleaned itself up/);
});

test("run: a failing script stays in the runbox and its exit code is propagated", async () => {
  const rb = path.join(BASE, "central-rb-11");
  writeScript(rb, "boom.mjs", "process.exit(3)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  const r = await run(root, ["run", "boom.mjs"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /FAILED \(exit 3\)/);
  assert.ok(fs.existsSync(path.join(rb, "boom.mjs")));
});

test("run: usage error with no ref given", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  const r = await run(root, ["run"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: run/);
});

// ---------------------------------------------------------------------------
// restore: bare/stamped names, repeated-trash newest-wins, dest collision
// ---------------------------------------------------------------------------

test("restore: the stamped trash name and the bare original name both resolve", async () => {
  const rb = path.join(BASE, "central-rb-12");
  writeScript(rb, "r1.mjs", "console.log(1)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  await run(root, ["trash", "r1.mjs"]);
  const stamped = fs.readdirSync(path.join(rb, ".trash"))[0];

  const r = await run(root, ["restore", stamped]);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(rb, "r1.mjs")));
});

test("restore: repeated trashing of the same name restores the newest copy", async () => {
  const rb = path.join(BASE, "central-rb-13");
  writeScript(rb, "r2.mjs", "console.log('v1')\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  await run(root, ["trash", "r2.mjs"]);
  await new Promise((res) => setTimeout(res, 1100)); // stamp() has 1s resolution
  writeScript(rb, "r2.mjs", "console.log('v2')\n");
  await run(root, ["trash", "r2.mjs"]);
  assert.equal(fs.readdirSync(path.join(rb, ".trash")).length, 2);

  const r = await run(root, ["restore", "r2.mjs"]);
  assert.equal(r.code, 0);
  assert.match(fs.readFileSync(path.join(rb, "r2.mjs"), "utf8"), /v2/);
  assert.equal(fs.readdirSync(path.join(rb, ".trash")).length, 1); // one restored, one left
});

test("restore: refuses to clobber a same-named file already back in the runbox", async () => {
  const rb = path.join(BASE, "central-rb-14");
  writeScript(rb, "r3.mjs", "console.log(1)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  await run(root, ["trash", "r3.mjs"]);
  writeScript(rb, "r3.mjs", "console.log('back already')\n");

  const r = await run(root, ["restore", "r3.mjs"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists in the runbox/);
});

test("restore: nothing matching fails with a pointer to trash-list", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  const r = await run(root, ["restore", "never-trashed.mjs"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /nothing in trash matches/);
});

test("restore: usage error with no ref given", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  const r = await run(root, ["restore"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: restore/);
});

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

test("flush: without --really refuses -- this is the confirmed-only Empty-trash path", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  const r = await run(root, ["flush"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /flush is permanent/);
});

test("flush: --really deletes every trashed script for good", async () => {
  const rb = path.join(BASE, "central-rb-15");
  writeScript(rb, "f1.mjs", "console.log(1)\n");
  writeScript(rb, "f2.mjs", "console.log(2)\n");
  const root = sandbox({ enabled: true, secrets: [], protected: [], runboxDir: rb });
  await run(root, ["trash", "f1.mjs"]);
  await run(root, ["trash", "f2.mjs"]);

  const r = await run(root, ["flush", "--really"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /flushed 2 archived script\(s\)/);
  assert.equal(fs.readdirSync(path.join(rb, ".trash")).length, 0);
});

// ---------------------------------------------------------------------------
// vault: import / rm / keys / apply
// ---------------------------------------------------------------------------

test("vault-import: parses KEY=VALUE lines off stdin, skipping blanks and # comments", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  const stdin = ["# a comment", "", "API_KEY=abc123", "OTHER=with=equals=inside"].join("\n");
  const r = await withStdin(stdin, () => run(root, ["vault-import"]));
  assert.equal(r.code, 0);
  assert.match(r.out, /stored: API_KEY, OTHER/);
  const v = JSON.parse(fs.readFileSync(path.join(root, "vault.json"), "utf8"));
  assert.equal(v.API_KEY, "abc123");
  assert.equal(v.OTHER, "with=equals=inside");
});

test("vault-import: no KEY=VALUE lines at all fails", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  const r = await withStdin("# only a comment\n\n", () => run(root, ["vault-import"]));
  assert.equal(r.code, 1);
  assert.match(r.err, /no KEY=VALUE lines/);
});

test("vault-rm: removes an existing key, fails on a missing one", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  fs.writeFileSync(path.join(root, "vault.json"), JSON.stringify({ A: "1", B: "2" }));

  let r = await run(root, ["vault-rm", "A"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /removed: A/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "vault.json"), "utf8")), { B: "2" });

  r = await run(root, ["vault-rm", "A"]); // already gone
  assert.equal(r.code, 1);
  assert.match(r.err, /not in vault: A/);
});

test("vault-keys: prints stored key names only, one per line, empty vault prints nothing", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  let r = await run(root, ["vault-keys"]);
  assert.equal(r.out, "\n");

  fs.writeFileSync(path.join(root, "vault.json"), JSON.stringify({ A: "1", B: "2" }));
  r = await run(root, ["vault-keys"]);
  assert.equal(r.out, "A\nB\n");
});

test("apply: creates a new env-format file when the target does not exist", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  fs.writeFileSync(path.join(root, "vault.json"), JSON.stringify({ A: "1" }));
  const target = path.join(BASE, "apply-new.env");
  const r = await run(root, ["apply", target, "A"]);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(target, "utf8"), "A=1\n");
});

test("apply: upserts into an existing file, updating in place and appending new keys", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  fs.writeFileSync(path.join(root, "vault.json"), JSON.stringify({ A: "new", C: "3" }));
  const target = path.join(BASE, "apply-existing.env");
  fs.writeFileSync(target, "A=old\nB=keep-me\n");

  const r = await run(root, ["apply", target, "A", "C"]);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(target, "utf8"), "A=new\nB=keep-me\nC=3\n");
});

test("apply: a leading BOM on the target is stripped so the first KEY= line still matches", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  fs.writeFileSync(path.join(root, "vault.json"), JSON.stringify({ A: "new" }));
  const target = path.join(BASE, "apply-bom.env");
  fs.writeFileSync(target, "\uFEFFA=old\n");

  await run(root, ["apply", target, "A"]);
  const text = fs.readFileSync(target, "utf8");
  assert.equal(text, "A=new\n");
  assert.equal((text.match(/A=/g) || []).length, 1); // no stale duplicate line
});

test("apply: refuses when a requested key is not in the vault, naming what's missing", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  fs.writeFileSync(path.join(root, "vault.json"), JSON.stringify({ A: "1" }));
  const r = await run(root, ["apply", path.join(BASE, "apply-missing.env"), "A", "B"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not in vault: B/);
});

test("apply: usage error when target or keys are missing", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  let r = await run(root, ["apply"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: apply/);
  r = await run(root, ["apply", "/some/file"]); // target with no keys
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: apply/);
});

// ---------------------------------------------------------------------------
// unknown command
// ---------------------------------------------------------------------------

test("an unrecognized (or absent) command prints usage and fails", async () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  let r = await run(root, ["bogus"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: engine\.mjs <command>/);
  r = await run(root, []);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: engine\.mjs <command>/);
});

// ---------------------------------------------------------------------------
// stdin helper for vault-import
// ---------------------------------------------------------------------------

// engine.mjs reads process.stdin directly (not an injected stream), so
// vault-import tests must feed the real process stdin. Only ever used
// sequentially (node:test's default concurrency for a single file), so a
// module-scope override is safe.
async function withStdin(text, fn) {
  const Readable = (await import("node:stream")).Readable;
  const real = process.stdin;
  const fake = Readable.from([text]);
  fake.setEncoding = () => {}; // engine.mjs calls process.stdin.setEncoding(); no-op is fine, chunks are already strings
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "stdin", { value: real, configurable: true });
  }
}

// ---------------------------------------------------------------------------
// runAsMain(): the real process.exit(await main()) wiring, exercised without
// actually exiting this test process.
// ---------------------------------------------------------------------------

test("runAsMain: exits with main()'s own return code, using real process.argv", async () => {
  const { runAsMain } = await import("./engine.mjs");
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  const prevArgv = process.argv;
  const prevRoot = process.env.ACC_ROOT;
  const prevExit = process.exit;
  process.env.ACC_ROOT = root;
  process.argv = [...prevArgv.slice(0, 2), "vault-keys"];
  let captured;
  process.exit = (code) => { captured = code; };
  try {
    await runAsMain();
  } finally {
    process.argv = prevArgv;
    process.env.ACC_ROOT = prevRoot;
    process.exit = prevExit;
  }
  assert.equal(captured, 0);
});

// ---------------------------------------------------------------------------
// Real subprocess: proves the actual CLI entry point (argv, real stdin, real
// exit code) end to end, mirroring hooks/guard.test.mjs's "wrapper" group.
// ---------------------------------------------------------------------------

test("subprocess: `node hooks/engine.mjs status` against a real ACC_ROOT sandbox", () => {
  const root = sandbox({ projects: ["/watched"] });
  const out = execFileSync(process.execPath, [ENGINE_PATH, "status"], {
    encoding: "utf8",
    env: { ...process.env, ACC_ROOT: root },
  });
  const j = JSON.parse(out);
  assert.deepEqual(j.projects, ["/watched"]);
  assert.deepEqual(j.vaultKeys, []);
});

test("subprocess: an unknown command exits 1 with usage on stderr", () => {
  const root = sandbox({ enabled: true, secrets: [], protected: [] });
  assert.throws(
    () => execFileSync(process.execPath, [ENGINE_PATH, "not-a-real-command"], {
      encoding: "utf8",
      env: { ...process.env, ACC_ROOT: root },
    }),
    (e) => e.status === 1 && /usage: engine\.mjs/.test(String(e.stderr))
  );
});
