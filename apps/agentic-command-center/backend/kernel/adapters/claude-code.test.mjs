// node --test kernel/adapters/claude-code.test.mjs  (run from C:\code\guards)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const A = await import("./claude-code.mjs");
const { spawnSpec } = await import("../../hooks/cmdline.mjs");

test("identity probes via spawnSpec — no args array ever rides shell:true", () => {
  const calls = [];
  const exec = (...c) => { calls.push(c); return "2.1.220 (Claude Code)\n"; };
  assert.deepEqual(A.identity({ exec }), { name: "claude-code", version: "2.1.220" });
  const sp = spawnSpec("claude", ["--version"]);
  assert.equal(calls[0][0], sp.file);
  if (sp.args) {
    assert.deepEqual(calls[0][1], sp.args);
    assert.equal(calls[0][2].shell, false);
  } else {
    assert.equal(calls[0][1].shell, true);
  }
});

test("a harness that cannot be probed fails closed, with no fallback (AC-A3)", () => {
  const exec = () => { throw new Error("ENOENT"); };
  assert.throws(() => A.identity({ exec }), /failed to start/);
});

test("a probe that returns no version number fails closed (AC-A3)", () => {
  assert.throws(() => A.identity({ exec: () => "not a version" }), /no version/);
});

test("buildArgs pins settings, session id and the tool allowlist; prompt never in argv", () => {
  const args = A.buildArgs({
    settingsPath: "C:/tmp/s.json", sessionId: "11111111-2222-3333-4444-555555555555",
    tools: ["Read", "Bash"],
  });
  assert.deepEqual(args, [
    "-p", "--output-format", "stream-json", "--verbose",
    "--settings", "C:/tmp/s.json",
    "--tools", "Read,Bash",
    "--session-id", "11111111-2222-3333-4444-555555555555",
  ]);
  assert.ok(!args.some((a) => /prompt|goal/i.test(a)), "the prompt goes over stdin, never argv");
});

test("send_step continues the SAME session via --resume (AC-A7)", () => {
  const args = A.buildArgs({
    settingsPath: "C:/tmp/s.json", sessionId: "11111111-2222-3333-4444-555555555555",
    tools: ["Read"], resume: true,
  });
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], "11111111-2222-3333-4444-555555555555");
  assert.ok(!args.includes("--session-id"), "--resume replaces --session-id; passing both is an error");
});

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-cc-"));
process.env.ACC_LANE_DIR = path.join(BASE, "lane");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ lane: { slots: 1, minGapMs: 0, pollMs: 10, breakerThreshold: 100000 } }));

// A fake child: stdin sink, stdout/stderr streams, close/error events.
function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242;
  c.stdin = { written: "", write(s) { this.written += s; }, end() { this.ended = true; } };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => { c.killed = true; };
  return c;
}

test("every launch holds a lane slot for the life of the run and frees it after (AC-A4)", async () => {
  const child = fakeChild();
  const laneDir = process.env.ACC_LANE_DIR;
  const handle = await A.startTask({
    runId: "r-lane", prompt: "do the thing", settingsPath: "C:/tmp/s.json",
    sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"],
    cwd: BASE, spawnFn: () => child,
  });
  assert.equal(fs.existsSync(path.join(laneDir, "slot-0")), true, "slot must be held during the run");
  assert.equal(child.stdin.written, "do the thing", "the prompt goes over stdin");
  assert.equal(child.stdin.ended, true);
  child.emit("close", 0);
  await handle.done;
  assert.equal(fs.existsSync(path.join(laneDir, "slot-0")), false, "slot must be released after the run");
});

test("startTask spawns exactly what spawnSpec builds for this platform", async () => {
  const seen = [];
  const child = fakeChild();
  const handle = await A.startTask({
    runId: "r-spec", prompt: "p", settingsPath: "C:/tmp dir/s.json",
    sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"],
    cwd: BASE, spawnFn: (...a) => { seen.push(a); return child; },
  });
  const sp = spawnSpec("claude", A.buildArgs({ settingsPath: "C:/tmp dir/s.json", sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"] }));
  assert.equal(seen[0][0], sp.file);
  const opts = sp.args ? seen[0][2] : seen[0][1];
  if (sp.args) assert.deepEqual(seen[0][1], sp.args);
  assert.equal(opts.shell, sp.shell);
  child.emit("close", 0);
  await handle.done;
});

test("a harness that fails to spawn releases the slot and fails closed (AC-A3)", async () => {
  await assert.rejects(
    () => A.startTask({
      runId: "r-boom", prompt: "x", settingsPath: "C:/tmp/s.json",
      sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"], cwd: BASE,
      spawnFn: () => { throw new Error("ENOENT"); },
    }),
    /failed to start/
  );
  assert.equal(fs.existsSync(path.join(process.env.ACC_LANE_DIR, "slot-0")), false,
    "a failed spawn must not leak the lane slot");
});

test("stopTask kills the process TREE and confirms exit (AC-A5)", async () => {
  const child = fakeChild();
  const killed = [];
  const handle = await A.startTask({
    runId: "r-stop", prompt: "x", settingsPath: "C:/tmp/s.json",
    sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"], cwd: BASE,
    spawnFn: () => child, killFn: (c) => { killed.push(c.pid); c.emit("close", 143); },
  });
  await A.stopTask(handle);
  assert.deepEqual(killed, [4242], "must signal the tree, not just the shell wrapper");
  assert.equal((await handle.done).code, 143);
});

test("stopTask on no handle is a no-op", async () => {
  await assert.doesNotReject(() => A.stopTask(null));
  await assert.doesNotReject(() => A.stopTask());
});

test("stopTask on a handle whose done already rejected does not throw", async () => {
  const child = fakeChild();
  const handle = await A.startTask({
    runId: "r-stop-after-error", prompt: "x", settingsPath: "C:/tmp/s.json",
    sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"], cwd: BASE,
    spawnFn: () => child, killFn: () => {},
  });
  child.emit("error", new Error("already dead"));
  await assert.rejects(() => handle.done);
  await assert.doesNotReject(() => A.stopTask(handle));
});

test("startTask parses stdout stream-json lines into events, tolerating a non-JSON banner and split chunks", async () => {
  const child = fakeChild();
  const handle = await A.startTask({
    runId: "r-parse", prompt: "x", settingsPath: "C:/tmp/s.json",
    sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"], cwd: BASE,
    spawnFn: () => child,
  });
  child.stdout.emit("data", 'not json banner\n{"type":"system","subtype":"i');
  child.stdout.emit("data", 'nit","session_id":"sid-1"}\n\n{"type":"result"}\n');
  child.emit("close", 0);
  const { events } = await handle.done;
  assert.deepEqual(events, [
    { type: "system", subtype: "init", session_id: "sid-1" },
    { type: "result" },
  ]);
});

test("startTask surfaces stderr on the raw record", async () => {
  const child = fakeChild();
  const handle = await A.startTask({
    runId: "r-stderr", prompt: "x", settingsPath: "C:/tmp/s.json",
    sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"], cwd: BASE,
    spawnFn: () => child,
  });
  child.stderr.emit("data", "warning: something\n");
  child.emit("close", 1);
  const { raw } = await handle.done;
  assert.equal(raw.err, "warning: something\n");
});

test("a spawned harness that errors after launch releases the slot and fails closed (AC-A3)", async () => {
  const child = fakeChild();
  const laneDir = process.env.ACC_LANE_DIR;
  const handlePromise = A.startTask({
    runId: "r-late-error", prompt: "x", settingsPath: "C:/tmp/s.json",
    sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"], cwd: BASE,
    spawnFn: () => child,
  });
  const handle = await handlePromise;
  child.emit("error", new Error("EPIPE"));
  await assert.rejects(() => handle.done, /failed to start/);
  assert.equal(fs.existsSync(path.join(laneDir, "slot-0")), false,
    "a post-launch error must not leak the lane slot");
});

const STREAM = [
  { type: "system", subtype: "init", session_id: "sid-9" },
  { type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
      content: [{ type: "text", text: "working" }, { type: "tool_use", name: "Read", input: {} }] } },
  { type: "assistant", message: { usage: { input_tokens: 3, output_tokens: 4 },
      content: [{ type: "tool_use", name: "Bash", input: {} }, { type: "tool_use", name: "Edit", input: {} }] } },
  { type: "result", subtype: "success", session_id: "sid-9", result: "I fixed everything and all tests pass" },
];

test("readState counts real tool calls and tokens from the stream (AC-A6)", () => {
  const s = A.readState(STREAM);
  assert.equal(s.toolCalls, 3);
  assert.equal(s.tokens, 24);
  assert.equal(s.sessionId, "sid-9");
});

test("readState carries NO verdict field — the harness cannot report its own pass (AC-A6, AC-V5)", () => {
  const s = A.readState(STREAM);
  assert.deepEqual(Object.keys(s).sort(), ["sessionId", "tokens", "toolCalls"]);
  assert.equal(JSON.stringify(s).includes("all tests pass"), false,
    "the harness's own success claim must not survive into kernel state");
});

test("readState tolerates an empty or malformed stream", () => {
  assert.deepEqual(A.readState([]), { toolCalls: 0, tokens: 0, sessionId: null });
  assert.equal(A.readState([{ type: "assistant" }, null]).toolCalls, 0);
  assert.deepEqual(A.readState(undefined), { toolCalls: 0, tokens: 0, sessionId: null });
});

test("OI-019: readState tolerates a malformed (null or non-object) content block instead of crashing (AC-A6 fault tolerance)", () => {
  // A single stray null in a content array — a stream hiccup or CLI version
  // quirk, not necessarily anything wrong with the run itself — used to
  // throw a TypeError straight out of readState. run.mjs's own supervisor
  // tick (fixed earlier this session, OI-019) now catches that and aborts
  // the WHOLE run as a "supervisor-fault", which is a needlessly heavy
  // response to one malformed block readState could simply skip and keep
  // counting the rest — the same tolerance the top-level event loop already
  // gives a malformed event two lines above.
  const s = A.readState([{ type: "assistant", message: { content: [
    null, "not an object", 42, { type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: {} },
  ] } }]);
  assert.equal(s.toolCalls, 1);
});

test("readState tolerates an assistant message with no content array and full usage fields", () => {
  const s = A.readState([
    { type: "assistant", message: {} },
    { type: "assistant", message: { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } },
  ]);
  assert.equal(s.toolCalls, 0);
  assert.equal(s.tokens, 4);
});

test("readState ignores an assistant message with no usage at all", () => {
  const s = A.readState([{ type: "assistant", message: { content: [] } }]);
  assert.equal(s.tokens, 0);
});

test("sendStep continues an existing session over --resume (AC-A7)", async () => {
  const child = fakeChild();
  let seen = null;
  const p = A.sendStep(
    { sessionId: "11111111-2222-3333-4444-555555555555", settingsPath: "C:/tmp/s.json", tools: ["Read"], cwd: BASE, runId: "r-step" },
    "next instruction",
    { spawnFn: (...a) => { seen = a; return child; } }
  );
  await new Promise((r) => setTimeout(r, 20));
  child.emit("close", 0);
  await p;
  const parts = Array.isArray(seen[1]) ? seen[1] : [seen[0]];
  assert.ok(parts.some((p) => String(p).includes("--resume")), "must resume the session");
  assert.equal(child.stdin.written, "next instruction");
});
