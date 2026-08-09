// Tests for the directive store (hooks/directive.mjs) - the thing that carries
// work across context resets. Since SPEC-0005 PR-2 the store is the headless
// runner's continuity record: no console binding, no kicks, no typing — the
// interesting behaviour is the integrity of the store itself (locking, id
// safety, archive discipline, the OI-006 session-id guard) and the CLI the
// web GUI shells.
//
// Run: node --test hooks/directive.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// directive.mjs captures ACC_DIRECTIVES_DIR into a module-load-time const, so isolating
// every test used to mean a fresh tmpdir + a cache-busted re-import
// (`?t=${n}`) per test. That broke coverage measurement: node's lcov
// reporter keys by file path with last-write-wins across those instances, so
// a full-suite run only ever reported the LAST test's coverage, not the
// union of all of them (proven directly: two tests run in different orders
// flip which lines show covered). Import once, isolate by wiping the same
// directory's contents between tests instead -- directive.mjs's own ensureDirs()
// (and listDirectives'/readDirective's already-tested "directory doesn't exist yet"
// fallbacks) recreate what each test needs on demand.
const DIRECTIVES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acc-directive-"));
process.env.ACC_DIRECTIVES_DIR = DIRECTIVES_DIR;
const m = await import("./directive.mjs");

beforeEach(() => {
  fs.rmSync(DIRECTIVES_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIRECTIVES_DIR, { recursive: true });
});

// Real Claude Code session ids are always UUIDs (OI-006's bindSession guard
// rejects anything else as a rebind source), so every id used to exercise
// the rebind/adoption path below must actually look like one.
const SID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("a directive survives as a file and starts unbound", async () => {
  const g = m.createDirective({ text: "ship the thing", cwd: "C:/code", profile: "Normal" });
  assert.match(g.id, /^d-\d{8}-/);
  assert.equal(g.status, "active");
  assert.equal(g.sessionId, "", "no session has adopted it yet");
  assert.equal(m.readDirective(g.id).text, "ship the thing");
});

test("a bad policy file falls back to no directive defaults", () => {
  const policy = path.join(DIRECTIVES_DIR, "policy.json");
  process.env.ACC_POLICY = policy;
  fs.writeFileSync(policy, "{bad json");
  const g = m.createDirective({ text: "ship the thing" });
  assert.deepEqual(g.budget, { wallClockMin: 0, turns: 0, tokens: 0, dollars: 0 });
});

test("a directive stores its hard ceiling and starts with no session history", () => {
  const g = m.createDirective({
    text: "ship the thing",
    budget: { wallClockMin: 30, turns: 12, tokens: 3456, dollars: 7.5 },
  });
  assert.deepEqual(g.budget, { wallClockMin: 30, turns: 12, tokens: 3456, dollars: 7.5 });
  assert.deepEqual(g.sessionIds, []);
  assert.match(fs.readFileSync(m.logPath(g.id), "utf8"), /hard ceiling: wall 30 min, turns 12, tokens 3456, \$7.5 est/);
});

test("multi-line directive text round-trips intact (OI-004: text never becomes keystrokes)", async () => {
  const text = "line one\nline two\n\n- a bullet\n- another";
  const g = m.createDirective({ text });
  assert.equal(m.readDirective(g.id).text, text);
});

test("doneWhen round-trips byte-exact when provided", () => {
  const doneWhen = `tests are green and PR #123 is merged`;
  const g = m.createDirective({ text: "ship it", doneWhen });
  assert.equal(m.readDirective(g.id).doneWhen, doneWhen);
});

test("--text-file carries a multi-line directive the command line could not (GUI path)", async () => {
  const text = "rebuild the screen\n\n- keep the tabs\n- one green button\n";
  const f = path.join(DIRECTIVES_DIR, "directive.txt");
  fs.writeFileSync(f, "﻿" + text, "utf8"); // PowerShell writes a BOM; it must not survive
  assert.equal(m.textFromArgs(["new", "--text-file", f]), text);
  assert.equal(m.textFromArgs(["new", "--text", "typed"]), "typed");
});

test("binding by ACC_DIRECTIVE records the session; re-binding the same session is inert", async () => {
  const g = m.createDirective({ text: "t" });
  const b1 = m.bindSession({ sessionId: SID(1), directiveId: g.id });
  assert.equal(b1.sessionId, SID(1));
  const b2 = m.bindSession({ sessionId: SID(1), directiveId: g.id });
  assert.equal(b2.sessionId, SID(1), "same session re-firing SessionStart changes nothing");
  assert.deepEqual(b2.sessionIds, [SID(1)]);
});

test("a finished directive is never adopted", async () => {
  const g = m.createDirective({ text: "t" });
  m.bindSession({ sessionId: SID(1), directiveId: g.id });
  m.setStatus(g.id, "done");
  assert.equal(m.bindSession({ sessionId: SID(3), directiveId: g.id }), null);
});

test("cycles append to the log and the tail is bounded", async () => {
  const g = m.createDirective({ text: "t" });
  m.appendCycle(g.id, { sessionId: "s1", ctx: 152000, text: "did the first half" });
  const after = m.appendCycle(g.id, { sessionId: "s2", ctx: 151000, text: "x".repeat(9000) });
  assert.equal(after.cycles, 2);

  const tail = m.logTail(g.id, 1000);
  assert.ok(tail.length <= 1000 + 40, `tail was ${tail.length} chars`);
  assert.match(tail, /earlier progress trimmed/);
  assert.match(m.logTail(g.id, 100000), /did the first half/);
  assert.match(m.logTail(g.id, 100000), /ended at 152k/);
});

test("a done directive is archived out of the live directory", async () => {
  const g = m.createDirective({ text: "t" });
  m.setStatus(g.id, "done", "shipped");
  assert.equal(m.listDirectives().length, 0, "live dir holds only work in flight");
  assert.ok(fs.existsSync(path.join(DIRECTIVES_DIR, "done", `${g.id}.json`)));
  assert.match(fs.readFileSync(path.join(DIRECTIVES_DIR, "done", `${g.id}.log.md`), "utf8"), /DONE/);
});

test("directive ids cannot escape the directives directory", async () => {
  assert.equal(m.readDirective("../../../etc/passwd"), null);
  assert.equal(m.setStatus("..\\..\\evil", "done"), null);
});

// --- error paths and edge branches not reachable via the happy-path tests --

test("createDirective refuses empty/whitespace-only/absent text", () => {
  assert.throws(() => m.createDirective({ text: "   " }), /a directive needs text/);
  assert.throws(() => m.createDirective({}), /a directive needs text/, "text itself is undefined, not just blank");
});

test("createDirective validates doneWhen as optional single-line text within one documented limit", () => {
  assert.throws(() => m.createDirective({ text: "t", doneWhen: 42 }), /doneWhen must be a string/);
  assert.throws(() => m.createDirective({ text: "t", doneWhen: "   " }), /doneWhen must be a single line of 1\.\.500 characters/);
  assert.throws(() => m.createDirective({ text: "t", doneWhen: "line 1\nline 2" }), /doneWhen must be a single line of 1\.\.500 characters/);
  assert.throws(() => m.createDirective({ text: "t", doneWhen: "x".repeat(m.DONE_WHEN_MAX + 1) }), /doneWhen must be a single line of 1\.\.500 characters/);
  const g = m.createDirective({ text: "t" });
  assert.equal("doneWhen" in g, false, "omitting doneWhen stays backward-compatible");
});

test("legacy directives missing doneWhen still load safely", () => {
  const g = m.createDirective({ text: "t", doneWhen: "done once CI is green" });
  const p = path.join(DIRECTIVES_DIR, `${g.id}.json`);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  delete raw.doneWhen;
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
  const loaded = m.readDirective(g.id);
  assert.equal(loaded.id, g.id);
  assert.equal("doneWhen" in loaded, false);
});

test("bindSession discards an explicit directiveId whose directive exists but is not active", () => {
  const g = m.createDirective({ text: "t" });
  m.setStatus(g.id, "paused"); // paused stays in the live dir (unlike done/blocked), so readDirective still finds it
  assert.equal(m.bindSession({ sessionId: SID(33), directiveId: g.id }), null);
});

test("bindSession sets cwd only when the directive doesn't already have one", () => {
  const g = m.createDirective({ text: "t" }); // no cwd at creation
  const b = m.bindSession({ sessionId: SID(34), directiveId: g.id, cwd: "C:/new" });
  assert.equal(b.cwd, "C:/new");
});

test("appendCycle on a nonexistent directive returns null; missing text/sessionId/ctx fall back cleanly", () => {
  assert.equal(m.appendCycle("d-doesnotexist", { text: "x" }), null);
  const g = m.createDirective({ text: "t" });
  const after = m.appendCycle(g.id, {});
  assert.equal(after.cycles, 1);
  assert.match(m.logTail(g.id, 10000), /_session \? ended at 0k_/);
  assert.match(m.logTail(g.id, 10000), /no closing summary captured/);
});

test("appendCycle swallows a log-write failure instead of throwing", () => {
  const g = m.createDirective({ text: "t" });
  fs.rmSync(m.logPath(g.id));
  fs.mkdirSync(m.logPath(g.id)); // appendFileSync against a directory throws EISDIR
  const after = m.appendCycle(g.id, { text: "x" });
  assert.equal(after.cycles, 1, "cycle count still advances even though the log write failed");
});

test("setStatus swallows a log-write failure and an archive failure instead of throwing", () => {
  const g1 = m.createDirective({ text: "t1" });
  fs.rmSync(m.logPath(g1.id));
  fs.mkdirSync(m.logPath(g1.id));
  const s1 = m.setStatus(g1.id, "done", "note"); // log-append fails; archiving is independent and still proceeds
  assert.equal(s1.status, "done");

  const g2 = m.createDirective({ text: "t2" });
  fs.rmSync(path.join(DIRECTIVES_DIR, "done"), { recursive: true, force: true });
  fs.writeFileSync(path.join(DIRECTIVES_DIR, "done"), "blocking file where the archive dir should be");
  const s2 = m.setStatus(g2.id, "done", "shipped");
  assert.equal(s2.status, "done", "the live record still updates even though archiving failed");
});

// --- issue #14: concurrent mutators must not lose updates ---
// SessionStart (bindSession), the Stop hook (appendCycle), the headless
// runner (appendCycle), and model runs (setStatus) are separate PROCESSES
// touching the same directive file; before the mutate() lock, each was
// read -> change -> write with nothing serializing it, so two concurrent
// writers silently lost one side's update. Real subprocesses (not in-process
// calls) because the lock is a cross-process file lock;
// ACC_DIRECTIVE_MUTATE_DELAY_MS widens the microseconds-wide natural race
// window so the test is deterministic rather than a timing coin flip —
// proven red against the unlocked code (cycles came back 1-2 of 5), green
// and stable with the lock.
test("issue #14: N concurrent appendCycle processes lose no update", async () => {
  const { spawn } = await import("node:child_process");
  const g = m.createDirective({ text: "t" });
  const N = 5;
  const mjs = path.join(path.dirname(new URL(import.meta.url).pathname), "directive.mjs");
  const runs = Array.from({ length: N }, () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["-e",
      `import(${JSON.stringify("file://" + mjs)}).then(d => d.appendCycle(${JSON.stringify(g.id)}, { text: "x" }))`],
      { env: { ...process.env, ACC_DIRECTIVES_DIR: DIRECTIVES_DIR, ACC_DIRECTIVE_MUTATE_DELAY_MS: "60" } });
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  }));
  await Promise.all(runs);
  assert.equal(m.readDirective(g.id).cycles, N, "every concurrent cycle increment must land — a lower count is a lost update");
});

test("CLI: main() 'log' swallows a log-write failure instead of throwing", () => {
  const g = m.createDirective({ text: "t" });
  fs.rmSync(m.logPath(g.id));
  fs.mkdirSync(m.logPath(g.id));
  assert.equal(runMain(["log", g.id, "--text", "x"]), `logged to ${m.logPath(g.id)}`);
});

// --- OI-006: a hand-run SessionStart cannot hijack a live directive's binding ---

test("OI-006: a non-UUID sessionId cannot steal an active directive's session binding", async () => {
  const g = m.createDirective({ text: "t" });
  m.bindSession({ sessionId: SID(30), directiveId: g.id });
  const before = m.readDirective(g.id);

  // The reproduction class from the ledger: a hand-piped SessionStart payload
  // ("hbtest") carrying the directive's id.
  const hijacked = m.bindSession({ sessionId: "hbtest", directiveId: g.id });
  assert.equal(hijacked.id, g.id, "the bind still resolves the directive");
  assert.equal(hijacked.sessionId, before.sessionId, "the real session id must survive a garbage rebind attempt");
});

test("OI-006: a real UUID sessionId still rebinds normally (the headless-resume path)", async () => {
  const g = m.createDirective({ text: "t" });
  m.bindSession({ sessionId: SID(31), directiveId: g.id });

  const adopted = m.bindSession({ sessionId: SID(32), directiveId: g.id });
  assert.equal(adopted.id, g.id);
  assert.equal(adopted.sessionId, SID(32), "each fresh runner session rebinds by ACC_DIRECTIVE");
  assert.deepEqual(adopted.sessionIds, [SID(31), SID(32)]);
});

// --- direct unit coverage for the remaining exported helpers ---------------

test("directiveForSession finds an active directive by exact sessionId, and refuses no id / no match", () => {
  assert.equal(m.directiveForSession(""), null, "no sessionId given");
  assert.equal(m.directiveForSession(SID(20)), null, "no directives exist yet");
  const g = m.createDirective({ text: "t" });
  m.bindSession({ sessionId: SID(20), directiveId: g.id });
  assert.equal(m.directiveForSession(SID(20)).id, g.id);
  assert.equal(m.directiveForSession(SID(21)), null, "a different session matches nothing");
});

test("listDirectives returns [] instead of throwing when the directives directory doesn't exist yet", () => {
  fs.rmSync(DIRECTIVES_DIR, { recursive: true, force: true });
  assert.deepEqual(m.listDirectives(), []);
});

test("logTail returns '' instead of throwing when the log file doesn't exist", () => {
  assert.equal(m.logTail("d-doesnotexist"), "");
});

// --- the CLI dispatcher (main) -----------------------------------------
// Run in-process (not spawned) so coverage actually attributes to it: a
// spawned subprocess is invisible to this file's own coverage instrumentation
// (the same reason budget.mjs/statusline.mjs/engine.mjs/guard.mjs report no
// coverage row at all today -- their tests only ever spawn them).

function runMain(args) {
  const savedArgv = process.argv;
  const savedLog = console.log;
  const out = [];
  console.log = (...a) => out.push(a.map(String).join(" "));
  process.argv = [savedArgv[0], savedArgv[1], ...args];
  try {
    m.main();
  } finally {
    process.argv = savedArgv;
    console.log = savedLog;
  }
  return out.join("\n");
}

test("CLI: main() 'new' creates a directive via --text and prints it", () => {
  const printed = JSON.parse(runMain(["new", "--text", "cli directive"]));
  assert.equal(printed.text, "cli directive");
  assert.ok(m.readDirective(printed.id));
});

test("CLI: main() 'new' accepts hard-ceiling flags", () => {
  const printed = JSON.parse(runMain([
    "new", "--text", "cli directive",
    "--wall-clock-min", "45", "--turns", "20", "--tokens", "5000", "--dollars", "6.25",
  ]));
  assert.deepEqual(printed.budget, { wallClockMin: 45, turns: 20, tokens: 5000, dollars: 6.25 });
});

test("CLI: main() 'new' accepts --done-when and stores it exactly", () => {
  const doneWhen = "the flaky test is fixed and main is green";
  const printed = JSON.parse(runMain(["new", "--text", "cli directive", "--done-when", doneWhen]));
  assert.equal(printed.doneWhen, doneWhen);
  assert.equal(m.readDirective(printed.id).doneWhen, doneWhen);
});

test("CLI: main() with no subcommand defaults to 'list', printing active directives as JSON", () => {
  const g = m.createDirective({ text: "t" });
  const printed = JSON.parse(runMain([]));
  assert.ok(printed.some((x) => x.id === g.id));
});

test("CLI: main() 'show' resolves an explicit id, the sole active directive, refuses to guess among several, and falls back to 'no active directive'", () => {
  assert.equal(runMain(["show"]), "no active directive", "no active directives at all");
  const g1 = m.createDirective({ text: "t1" });
  assert.equal(JSON.parse(runMain(["show", g1.id])).id, g1.id, "explicit positional id");
  assert.equal(JSON.parse(runMain(["show"])).id, g1.id, "resolveId falls back to the sole active directive");
  m.createDirective({ text: "t2" });
  assert.equal(runMain(["show"]), "no active directive", "resolveId refuses to guess among multiple active directives");
});

test("CLI: main() 'log' appends via --text or trailing positional words, and refuses with no resolvable directive", () => {
  assert.equal(runMain(["log", "whatever", "--text", "x"]), "no active directive", "no directive exists yet to log against");
  const g = m.createDirective({ text: "t" });
  runMain(["log", g.id, "--text", "explicit flag note"]);
  assert.match(m.logTail(g.id, 10000), /explicit flag note/);
  runMain(["log", g.id, "trailing", "positional", "words"]);
  assert.match(m.logTail(g.id, 10000), /trailing positional words/);
});

test("CLI: main() 'log' also accepts --text-file, the same multi-line-safe path 'new' uses (web guidance box)", () => {
  const g = m.createDirective({ text: "t" });
  const f = path.join(DIRECTIVES_DIR, "note.txt");
  fs.writeFileSync(f, "focus on the retry path first\nignore the flaky one for now", "utf8");
  runMain(["log", g.id, "--text-file", f]);
  assert.match(m.logTail(g.id, 10000), /focus on the retry path first\nignore the flaky one for now/);
});

test("CLI: main() 'done'/'blocked'/'paused' set status via resolveId, and refuse without a resolvable id", () => {
  assert.equal(runMain(["done"]), "no active directive (pass the id)");

  const g1 = m.createDirective({ text: "t1" });
  assert.equal(runMain(["done", g1.id]), `directive ${g1.id} -> done`);
  assert.equal(m.readDirective(g1.id), null, "done archives the directive out of the live directory");

  const g2 = m.createDirective({ text: "t2" });
  assert.equal(runMain(["blocked", g2.id, "--why", "stuck"]), `directive ${g2.id} -> blocked`);
  assert.equal(m.readDirective(g2.id), null, "blocked also archives the directive out of the live directory");

  const g3 = m.createDirective({ text: "t3" });
  assert.equal(runMain(["paused", g3.id]), `directive ${g3.id} -> paused`);
  assert.equal(m.readDirective(g3.id).status, "paused");
});

test("CLI: main() prints usage for an unrecognized command", () => {
  assert.match(runMain(["frobnicate"]), /^usage: directive\.mjs/);
});

test("a directive persists after its directory moves — directivesDir() resolves per call, never at import", async () => {
  const g = m.createDirective({ text: "portable directive", cwd: "C:/code" });
  const moved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acc-directive-moved-")), "store");
  fs.cpSync(DIRECTIVES_DIR, moved, { recursive: true });
  const saved = process.env.ACC_DIRECTIVES_DIR;
  try {
    process.env.ACC_DIRECTIVES_DIR = moved;
    assert.equal(m.readDirective(g.id).text, "portable directive");
    assert.ok(m.listDirectives().some((d) => d.id === g.id));
  } finally {
    process.env.ACC_DIRECTIVES_DIR = saved;
    fs.rmSync(path.dirname(moved), { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- SPEC-0001 (headless runner wiring)
test("lastCycleBody returns the last cycle's BODY only — headers/timestamps/session lines never leak in", async () => {
  const d = m.createDirective({ text: "t", cwd: "/w" });
  assert.equal(m.lastCycleBody(d.id), "", "no log yet is empty, not a throw");
  m.appendCycle(d.id, { sessionId: "s-1", ctx: 123000, text: "first summary" });
  assert.equal(m.lastCycleBody(d.id), "first summary");
  m.appendCycle(d.id, { sessionId: "s-2", ctx: 456000, text: "first summary" });
  assert.equal(m.lastCycleBody(d.id), "first summary",
    "identical bodies at different times/sessions must compare equal — this is the headless stuck signal");
  m.appendCycle(d.id, { sessionId: "s-3", ctx: 1, text: "second summary" });
  assert.equal(m.lastCycleBody(d.id), "second summary", "always the LAST cycle");
  assert.equal(m.lastCycleBody("no-such-directive"), "", "missing directive is empty, not a throw");
});
