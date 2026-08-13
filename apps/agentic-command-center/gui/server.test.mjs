// node --test gui/server.test.mjs  (run from C:\code\guards)
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-gui-srv-"));
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_ROOT = path.join(BASE, "root");
// hooks/engine.mjs (like every other hook) now honours ACC_ROOT, so AC-009
// below -- which deliberately calls the REAL engine, never the fake one, as
// a read-only wiring proof -- needs a config.json at this sandbox root
// instead of the live repo's. Never touches the real repo's config.json.
fs.mkdirSync(process.env.ACC_ROOT, { recursive: true });
fs.writeFileSync(
  path.join(process.env.ACC_ROOT, "config.json"),
  JSON.stringify({ enabled: true, secrets: [], protected: [] }, null, 2) + "\n"
);
const KERNEL = {
  harness: "claude-code",
  budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 },
  hardCaps: { wallClockMin: 240 },
  autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 },
  checkpointMin: 20, alwaysAllowTools: ["TodoWrite"], extraDenyWriteRoots: [],
};
const resetPolicy = () => fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: { ...KERNEL, _note: "fixture" } }, null, 2));

const { startServer, handler, cli } = await import("./server.mjs");
let srv, base, TOKEN;
// ACC-5: every /api/* request now needs X-ACC-Token. This suite has ~60
// request call sites (bare `fetch(...)` plus the jpost/gpost/ppost/lpost
// helpers below, which are all just aliases of jpost) — rather than touch
// each one, the shared sandbox server's token is attached here, once, to any
// request this file sends to ITS OWN `base`. `fetch` is looked up by every
// call site at call time (plain global reference, not imported), so
// patching it here before any test body runs is enough; `after` restores it.
// The token-specific negative cases (missing / wrong header) below each spin
// up their own dedicated server instead of reusing this one, so they are
// never shadowed by this default.
const REAL_FETCH = globalThis.fetch;
before(async () => {
  const s = await startServer({ port: 0 });
  srv = s.server; base = `http://127.0.0.1:${s.port}`; TOKEN = s.token;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const authed = url.startsWith(base) && url.includes("/api/")
      ? { ...init, headers: { ...(init && init.headers), "X-ACC-Token": TOKEN } }
      : init;
    return REAL_FETCH(input, authed);
  };
});
beforeEach(resetPolicy);
after(() => { globalThis.fetch = REAL_FETCH; srv.close(); fs.rmSync(BASE, { recursive: true, force: true }); });

const good = () => ({ ...KERNEL, budget: { ...KERNEL.budget, toolCalls: 150 } });
// One JSON-POST helper for every group; each group aliases it for readability.
const jpost = (route, body, headers = {}) => fetch(`${base}${route}`, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", "X-ACC": "1", ...headers },
});
const post = (body, headers = {}) => jpost("/api/kernel-policy", body, headers);

test("GET / without a dist configured is a headless API with no page to serve", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 404);
});

test("GET /api/kernel-policy returns the live block", async () => {
  const r = await fetch(`${base}/api/kernel-policy`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).kernel.budget.toolCalls, 200);
});

test("a valid POST lands on disk and preserves _note", async () => {
  const r = await post(good());
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  assert.equal(onDisk.kernel.budget.toolCalls, 150);
  assert.equal(onDisk.kernel._note, "fixture");
});

// fetch() (undici) enforces the Fetch spec's forbidden-header list: a
// caller-supplied Host header is silently dropped and the real connection
// host is sent instead, so it cannot exercise the Host-spoofing defense.
// node:http's raw client has no such restriction — use it for that case.
const rawRequest = (method, headers) => new Promise((resolve) => {
  const port = Number(new URL(base).port);
  const req = http.request(
    { host: "127.0.0.1", port, path: "/api/kernel-policy", method, headers },
    (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, body })); }
  );
  req.end(method === "POST" ? JSON.stringify(good()) : undefined);
});

test("CSRF is closed by construction: no X-ACC header, foreign Origin, foreign Host all 403 and never write", async () => {
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  assert.equal((await post(good(), { "X-ACC": "" })).status, 403);
  assert.equal((await post(good(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await rawRequest("POST", { "content-type": "application/json", "X-ACC": "1", host: "evil.example" })).status, 403);
  assert.equal((await rawRequest("GET", { host: "evil.example" })).status, 403);
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before);
});

test("no CORS grant ever leaves this server", async () => {
  const r = await fetch(`${base}/api/kernel-policy`, { headers: { origin: "http://127.0.0.1" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("invalid input: bad JSON 400, invalid block 400 with the validator's message, file untouched", async () => {
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  const raw = await fetch(`${base}/api/kernel-policy`, { method: "POST", body: "{ nope", headers: { "X-ACC": "1" } });
  assert.equal(raw.status, 400);
  const bad = await post({ ...good(), checkpointMin: -1 });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /checkpointMin/);
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before);
});

test("unknown routes 404", async () => {
  assert.equal((await fetch(`${base}/api/other`)).status, 404);
  assert.equal((await fetch(`${base}/../policy.json`)).status, 404);
});

test("GET /api/kernel-policy surfaces a 500 when the policy file is unreadable", async () => {
  fs.writeFileSync(process.env.ACC_POLICY, "{ not json");
  const r = await fetch(`${base}/api/kernel-policy`);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /kernel policy unreadable/);
});

test("handler(): a request with no Host header at all is denied (defensive default)", () => {
  const res = { writeHead(code, headers) { res.code = code; res.headers = headers; }, end(body) { res.body = body; } };
  handler({ headers: {}, url: "/", method: "GET" }, res);
  assert.equal(res.code, 403);
});

test("a POST body over the cap is dropped before parsing (no memory blow-up)", async () => {
  const port = Number(new URL(base).port);
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/kernel-policy", method: "POST", headers: { "content-type": "application/json", "X-ACC": "1" } });
    req.on("error", resolve); // req.destroy() aborts the socket; either an error or an unfinished response is fine
    req.on("response", (res) => { res.resume(); res.on("end", resolve); });
    req.write("x".repeat(70 * 1024));
    req.end();
  });
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before, "an over-cap body must never reach saveKernelPolicy");
});

test("cli(): starts a server and logs LISTENING <port>; --port is optional (defaults to ephemeral)", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let withPort, withoutPort;
  try {
    withPort = await cli(["node", "server.mjs", "--port", "0"]);
    withoutPort = await cli(["node", "server.mjs"]);
    assert.match(logs.join("\n"), /^LISTENING \d+$/m);
    assert.ok(withPort.port > 0 && withoutPort.port > 0);
    assert.match(logs.join("\n"), /^http:\/\/127\.0\.0\.1:\d+\/#acc-token=.+$/m, "the one-time bootstrap fragment URL must be printed too");
    const r = await fetch(`http://127.0.0.1:${withPort.port}/api/kernel-policy`, { headers: { "X-ACC-Token": withPort.token } });
    assert.equal(r.status, 200);
  } finally {
    console.log = orig;
    withPort?.server.close();
    withoutPort?.server.close();
  }
});

test("CLI: prints LISTENING <port> and serves on it", async () => {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  const child = spawn(process.execPath, [serverPath, "--port", "0"], {
    env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  const line = await new Promise((res) => child.stdout.once("data", (d) => res(String(d))));
  const m = line.match(/^LISTENING (\d+)/);
  assert.ok(m, `expected LISTENING banner, got: ${line}`);
  // The subprocess inherits this process's ACC_ROOT (unchanged so far), so it
  // reads the same token file the shared sandbox server above already
  // created — read it straight from disk rather than racing stdout buffering
  // for a second line.
  const token = fs.readFileSync(path.join(process.env.ACC_ROOT, "gui-token"), "utf8").split(/\r?\n/, 1)[0];
  const r = await fetch(`http://127.0.0.1:${m[1]}/api/kernel-policy`, { headers: { "X-ACC-Token": token } });
  assert.equal(r.status, 200);
  child.kill();
});

// ------------------------------------------------------------- guards API (SPEC-0002, SL-009)
// The server shells two binaries, each the single owner of its own state:
// hooks/engine.mjs (vault + runbox) and apps/toolbelt/guards/cli.mjs
// (guard-config: toggle, secret/protected lists). Tests drive both against
// FAKEs (runner.test.mjs's fake-claude discipline): canned outputs, argv
// recorded, the real repo's config.json never touched. ACC_ENGINE/
// ACC_GUARDS_CLI are read per request, so one suite can exercise fake and
// real. Both fakes read the SAME list.json fixture and each returns only
// the subset of "status" it owns — status: GET /api/guards/status composes
// them back into the one shape the browser has always received.
const ENGINE_DIR = path.join(BASE, "engine-state");
const FAKE_ENGINE = path.join(BASE, "fake-engine.mjs");
const GUARDS_DIR = path.join(BASE, "guards-state");
const FAKE_GUARDS = path.join(BASE, "fake-guards.mjs");
const RUNBOX = path.join(BASE, "rb");
fs.writeFileSync(
  FAKE_ENGINE,
  `
import fs from "node:fs";
const dir = process.env.FAKE_ENGINE_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(argv) + "\\n");
const mode = fs.existsSync(dir + "/mode.txt") ? fs.readFileSync(dir + "/mode.txt", "utf8").trim() : "ok";
if (mode === "fail") { process.stderr.write("engine says no"); process.exit(1); }
const lists = JSON.parse(fs.readFileSync(dir + "/list.json", "utf8"));
if (argv[0] === "status") {
  const { enabled, secrets, protected: p, ...rest } = lists.status;
  console.log(JSON.stringify(rest));
  process.exit(0);
}
if (argv[0] === "list" && argv[1] === "--json") { console.log(JSON.stringify(lists.pending)); process.exit(0); }
if (argv[0] === "trash-list" && argv[1] === "--json") { console.log(JSON.stringify(lists.trashed)); process.exit(0); }
console.log("did " + argv.join(" "));
`.trimStart()
);
fs.writeFileSync(
  FAKE_GUARDS,
  `
import fs from "node:fs";
const dir = process.env.FAKE_GUARDS_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(argv) + "\\n");
const mode = fs.existsSync(dir + "/mode.txt") ? fs.readFileSync(dir + "/mode.txt", "utf8").trim() : "ok";
if (mode === "fail") { process.stderr.write("guards says no"); process.exit(1); }
const lists = JSON.parse(fs.readFileSync(dir + "/list.json", "utf8"));
if (argv[0] === "status") {
  const { enabled, secrets, protected: p } = lists.status;
  console.log(JSON.stringify({ enabled, secrets, protected: p }));
  process.exit(0);
}
console.log("did " + argv.join(" "));
`.trimStart()
);
process.env.FAKE_ENGINE_DIR = ENGINE_DIR;
process.env.FAKE_GUARDS_DIR = GUARDS_DIR;

const engineCalls = () => {
  try { return fs.readFileSync(path.join(ENGINE_DIR, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const guardsCalls = () => {
  try { return fs.readFileSync(path.join(GUARDS_DIR, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

function resetEngine() {
  process.env.ACC_ENGINE = FAKE_ENGINE;
  process.env.ACC_GUARDS_CLI = FAKE_GUARDS;
  fs.rmSync(ENGINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(ENGINE_DIR, { recursive: true });
  fs.rmSync(GUARDS_DIR, { recursive: true, force: true });
  fs.mkdirSync(GUARDS_DIR, { recursive: true });
  fs.mkdirSync(RUNBOX, { recursive: true });
  fs.writeFileSync(path.join(RUNBOX, "fix.ps1"), "# does a thing\necho hi\n");
  const list = JSON.stringify({
    status: { enabled: true, secrets: [".env"], protected: ["/x"], projects: [], vaultKeys: ["K"], pending: 1, trashed: 0 },
    pending: [{ label: "central", name: "fix.ps1", dir: RUNBOX, runboxDir: RUNBOX, cwd: RUNBOX, keep: false, summary: "does a thing" }],
    trashed: [],
  });
  fs.writeFileSync(path.join(ENGINE_DIR, "list.json"), list);
  fs.writeFileSync(path.join(GUARDS_DIR, "list.json"), list);
}

const gpost = jpost;

test("AC-001: GET /api/guards/status composes guards-cli's and the engine's status JSON", async () => {
  resetEngine();
  const r = await fetch(`${base}/api/guards/status`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.enabled, true);
  assert.deepEqual(j.secrets, [".env"]);
  assert.deepEqual(j.vaultKeys, ["K"]);
});

test("GET /api/guards/list returns pending and trashed from the --json verbs", async () => {
  resetEngine();
  const r = await fetch(`${base}/api/guards/list`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.pending[0].name, "fix.ps1");
  assert.deepEqual(j.trashed, []);
});

test("AC-002: an allowlisted guard-config verb builds the exact guards-cli argv", async () => {
  resetEngine();
  const r = await gpost("/api/guards/engine", { verb: "toggle", arg: "on" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.code, 0);
  assert.deepEqual(guardsCalls().at(-1), ["toggle", "on"]);
  assert.equal(engineCalls().length, 0, "a guard-config verb must never reach the engine");
});

test("AC-002b: an allowlisted runbox verb builds the exact engine argv", async () => {
  resetEngine();
  const r = await gpost("/api/guards/engine", { verb: "trash", arg: "central:fix.ps1" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.code, 0);
  assert.deepEqual(engineCalls().at(-1), ["trash", "central:fix.ps1"]);
  assert.equal(guardsCalls().length, 0, "a runbox verb must never reach guards-cli");
});

test("AC-003: a verb outside the allowlist is refused and the engine is never invoked", async () => {
  resetEngine();
  for (const verb of ["apply", "vault-import", "rm -rf /", "status; curl evil"]) {
    const r = await gpost("/api/guards/engine", { verb, arg: "x" });
    assert.equal(r.status, 400, `verb "${verb}" must be refused`);
  }
  assert.equal(engineCalls().length, 0, "no refused verb may reach the engine");
});

test("AC-003b: a malformed arg (empty, huge, NUL, non-string) is refused before the engine", async () => {
  resetEngine();
  for (const arg of ["", "x".repeat(513), "a\0b", 42, null]) {
    const r = await gpost("/api/guards/engine", { verb: "trash", arg });
    assert.equal(r.status, 400);
  }
  assert.equal(engineCalls().length, 0);
});

test("AC-004: guards POSTs demand X-ACC and local Origin, like every mutating route", async () => {
  resetEngine();
  assert.equal((await gpost("/api/guards/engine", { verb: "toggle", arg: "on" }, { "X-ACC": "" })).status, 403);
  assert.equal((await gpost("/api/guards/engine", { verb: "toggle", arg: "on" }, { origin: "https://evil.example" })).status, 403);
  assert.equal(engineCalls().length, 0);
  assert.equal(guardsCalls().length, 0);
});

test("AC-005: preview returns the listed script's content", async () => {
  resetEngine();
  const r = await gpost("/api/guards/preview", { ref: "central:fix.ps1" });
  assert.equal(r.status, 200);
  assert.match((await r.json()).content, /does a thing/);
});

test("AC-006: preview refuses refs the engine's list does not contain — traversal never reaches the filesystem", async () => {
  resetEngine();
  for (const ref of ["../../etc/passwd", "central:../../../etc/passwd", "ghost.ps1"]) {
    const r = await gpost("/api/guards/preview", { ref });
    assert.equal(r.status, 404, `ref "${ref}" must 404`);
  }
});

test("AC-007: an engine failure surfaces as code+stderr, never masked as success", async () => {
  resetEngine();
  fs.writeFileSync(path.join(ENGINE_DIR, "mode.txt"), "fail");
  const r = await gpost("/api/guards/engine", { verb: "run", arg: "central:fix.ps1" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.code, 1);
  assert.match(j.out, /engine says no/);
});

test("AC-008: flush needs an explicit confirm and maps to `flush --really`", async () => {
  resetEngine();
  assert.equal((await gpost("/api/guards/engine", { verb: "flush" })).status, 400);
  assert.equal(engineCalls().length, 0);
  const r = await gpost("/api/guards/engine", { verb: "flush", confirm: true });
  assert.equal(r.status, 200);
  assert.deepEqual(engineCalls().at(-1), ["flush", "--really"]);
});

test("AC-009: the real engine answers status through the same route (read-only wiring proof)", async () => {
  resetEngine();
  delete process.env.ACC_ENGINE; // fall back to the real hooks/engine.mjs
  try {
    const r = await fetch(`${base}/api/guards/status`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.enabled, "boolean");
    assert.ok(Array.isArray(j.secrets));
  } finally {
    process.env.ACC_ENGINE = FAKE_ENGINE;
  }
});

test("GET /guards without a dist configured is a headless API with no page to serve", async () => {
  const r = await fetch(`${base}/guards`);
  assert.equal(r.status, 404);
});

test("an engine failure on the read routes surfaces as 500, never an empty 200", async () => {
  resetEngine();
  fs.writeFileSync(path.join(ENGINE_DIR, "mode.txt"), "fail");
  assert.equal((await fetch(`${base}/api/guards/status`)).status, 500);
  assert.equal((await fetch(`${base}/api/guards/list`)).status, 500);
});

test("preview of a listed script whose file is gone is a 500, not a crash or an empty success", async () => {
  resetEngine();
  fs.rmSync(path.join(RUNBOX, "fix.ps1"));
  const r = await gpost("/api/guards/preview", { ref: "central:fix.ps1" });
  assert.equal(r.status, 500);
});

test("PROP-001 hardening: prototype-key verbs (__proto__, toString, constructor) are refused as own-property misses", async () => {
  resetEngine();
  for (const verb of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
    const r = await gpost("/api/guards/engine", { verb, arg: "x" });
    assert.equal(r.status, 400, `prototype key "${verb}" must be refused, never resolved`);
  }
  assert.equal(engineCalls().length, 0);
});

// ------------------------------------------------------------- vault API (SPEC-0003, secret-value-in-transit)
// The fake engine records its STDIN so a test can prove the value's only sink
// is that channel — never argv, never a response field, never a log line.
function fakeStdinFrom() {
  try { return fs.readFileSync(path.join(ENGINE_DIR, "stdin.txt"), "utf8"); } catch { return ""; }
}
// Extend the fake engine to capture stdin for vault-import.
function withVaultFake() {
  fs.writeFileSync(FAKE_ENGINE, `
import fs from "node:fs";
const dir = process.env.FAKE_ENGINE_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(argv) + "\\n");
if (argv[0] === "vault-import") {
  let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => {
    fs.writeFileSync(dir + "/stdin.txt", s);
    const names = s.split(/\\r?\\n/).map((l) => l.trim()).filter((l) => l && l.indexOf("=") > 0).map((l) => l.slice(0, l.indexOf("=")).trim());
    if (!names.length) { process.stderr.write("no KEY=VALUE lines found on stdin"); process.exit(1); }
    console.log("stored: " + names.join(", ")); process.exit(0);
  });
} else { console.log("did " + argv.join(" ")); process.exit(0); }
`.trimStart());
  resetEngine();
  process.env.ACC_ENGINE = FAKE_ENGINE;
}

test("AC-001/PROP-001: a value's ONLY sink is engine stdin — never argv, never the response", async () => {
  withVaultFake();
  const r = await gpost("/api/guards/vault-import", { pairs: [{ key: "API_KEY", value: "s3cr3t-v4lue" }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.stored, ["API_KEY"]);
  assert.ok(!JSON.stringify(j).includes("s3cr3t"), "no response field may carry the value");
  assert.equal(fakeStdinFrom(), "API_KEY=s3cr3t-v4lue\n");
  for (const call of engineCalls()) assert.ok(!call.join(" ").includes("s3cr3t"), "the value must never be an argv token");
});

test("AC-002: multiple pairs travel as multiple stdin lines, named in order", async () => {
  withVaultFake();
  const r = await gpost("/api/guards/vault-import", { pairs: [{ key: "A", value: "1" }, { key: "B", value: "2" }] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).stored, ["A", "B"]);
  assert.equal(fakeStdinFrom(), "A=1\nB=2\n");
});

test("AC-003/PROP-002: an invalid key shape is refused before the engine", async () => {
  withVaultFake();
  for (const key of ["BAD KEY", "1KEY", "A=B", "", "K-1", "__proto__"]) {
    const r = await gpost("/api/guards/vault-import", { pairs: [{ key, value: "x" }] });
    assert.equal(r.status, 400, `key "${key}" must be refused`);
  }
  assert.equal(engineCalls().length, 0, "no invalid import may reach the engine");
});

test("AC-004/PROP-002: a value containing a newline is refused — it would forge a second vault line", async () => {
  withVaultFake();
  for (const value of ["a\nINJECTED=x", "a\r\nB=y", "trailing\n"]) {
    const r = await gpost("/api/guards/vault-import", { pairs: [{ key: "K", value }] });
    assert.equal(r.status, 400, `value ${JSON.stringify(value)} must be refused`);
  }
  assert.equal(engineCalls().length, 0);
});

test("vault-import with a non-string value or a malformed pairs array is refused", async () => {
  withVaultFake();
  for (const body of [{ pairs: [{ key: "K", value: 42 }] }, { pairs: [{ key: "K" }] }, { pairs: [] }, { pairs: "nope" }, {}]) {
    const r = await gpost("/api/guards/vault-import", body);
    assert.equal(r.status, 400);
  }
  assert.equal(engineCalls().length, 0);
});

test("AC-005: vault-rm sends the key NAME as argv (a name is not a secret)", async () => {
  withVaultFake();
  const r = await gpost("/api/guards/vault-rm", { key: "API_KEY" });
  assert.equal(r.status, 200);
  assert.deepEqual(engineCalls().at(-1), ["vault-rm", "API_KEY"]);
});

test("vault-rm validates the key shape too", async () => {
  withVaultFake();
  const r = await gpost("/api/guards/vault-rm", { key: "BAD KEY" });
  assert.equal(r.status, 400);
  assert.equal(engineCalls().length, 0);
});

test("AC-006: vault routes demand X-ACC and local Origin like every mutating route", async () => {
  withVaultFake();
  assert.equal((await gpost("/api/guards/vault-import", { pairs: [{ key: "K", value: "v" }] }, { "X-ACC": "" })).status, 403);
  assert.equal((await gpost("/api/guards/vault-rm", { key: "K" }, { origin: "https://evil.example" })).status, 403);
  assert.equal(engineCalls().length, 0);
});


// ------------------------------------------------------------- process/spending API (SPEC-0004)
// Fake usage + budget scripts record argv; policy.json lives in the sandbox
// (process.env.ACC_POLICY, already set at top). ACC_ROOT sandboxes the
// stop-file and kill-switch. Nothing touches the real machine.
const PROC_DIR = path.join(BASE, "proc");
const FAKE_USAGE = path.join(BASE, "fake-usage.mjs");
const FAKE_BUDGET = path.join(BASE, "fake-budget.mjs");
fs.writeFileSync(FAKE_USAGE, `
const a = process.argv.slice(2);
if (a[0] === "check") console.log(JSON.stringify({ tier: "amber", pct: 60, weekTokens: 1200000, redTokens: 2000000 }));
else if (a[0] === "week") console.log("TOTAL  $12.34");
`.trimStart());
fs.writeFileSync(FAKE_BUDGET, `
import fs from "node:fs";
fs.appendFileSync(process.env.FAKE_BUDGET_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("budget " + process.argv.slice(2).join(" ") + " ok");
`.trimStart());
const BUDGET_LOG = path.join(PROC_DIR, "budget-calls.jsonl");
const budgetCalls = () => { try { return fs.readFileSync(BUDGET_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const POLICY_BASE = {
  _comment: "keep me",
  context: { softK: 400, hardK: 600 },
  week: { amberTokens: 1e9, redTokens: 2e9 },
  directives: { budget: { wallClockMin: 0, turns: 0, tokens: 0, dollars: 0 } },
  review: { maxFinders: 3 },
  subagents: { allow: ["Explore"] },
  kernel: { harness: "claude-code", budget: { toolCalls: 200 } },
  rates: { opus: { in: 15 } },
};

function resetProc() {
  fs.rmSync(PROC_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROC_DIR, { recursive: true });
  process.env.ACC_ROOT = PROC_DIR;
  process.env.ACC_USAGE = FAKE_USAGE;
  process.env.ACC_BUDGET = FAKE_BUDGET;
  process.env.FAKE_BUDGET_LOG = BUDGET_LOG;
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify(POLICY_BASE, null, 2));
}
const ppost = jpost;

test("AC-001: GET /api/process/status returns tier, week text, dials, and control state", async () => {
  resetProc();
  const r = await fetch(`${base}/api/process/status`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tier.tier, "amber");
  assert.match(j.weekText, /\$12\.34/);
  assert.equal(j.dials.softK, 400);
  assert.deepEqual(j.dials.allow, ["Explore"]);
  assert.equal(j.stopped, false);
});

test("AC-002/PROP-001: saving dials updates the owned blocks and leaves every other key byte-identical", async () => {
  resetProc();
  const before = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  const r = await ppost("/api/process/dials", { softK: 350, hardK: 550, amberTokens: 1.2e9, redTokens: 1.8e9, maxFinders: 5, allow: ["Explore", "Plan"] });
  assert.equal(r.status, 200);
  const after = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  assert.equal(after.context.softK, 350);
  assert.equal(after.week.redTokens, 1.8e9);
  assert.equal(after.review.maxFinders, 5);
  assert.deepEqual(after.subagents.allow, ["Explore", "Plan"]);
  // untouched blocks
  assert.deepEqual(after.kernel, before.kernel);
  assert.deepEqual(after.rates, before.rates);
  assert.equal(after._comment, before._comment);
});

test("AC-003: an invalid dial is refused and policy.json is left untouched", async () => {
  resetProc();
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  for (const bad of [
    { softK: "x", hardK: 600, amberTokens: 1e9, redTokens: 2e9, maxFinders: 3, allow: [] },
    { softK: 400, hardK: -1, amberTokens: 1e9, redTokens: 2e9, maxFinders: 3, allow: [] },
    { softK: 400, hardK: 600, amberTokens: 1e9, redTokens: 2e9, maxFinders: 3, allow: "nope" },
  ]) {
    const r = await ppost("/api/process/dials", bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before, "no bad dial may write");
});

test("AC-004: control stop writes the slice-runner stop file", async () => {
  resetProc();
  const r = await ppost("/api/process/control", { action: "stop" });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(PROC_DIR, "runner", "stop", "slice-runner.stop")));
});

test("AC-005/AC-006: resume and fanout invoke the right budget verb", async () => {
  resetProc();
  await ppost("/api/process/control", { action: "resume" });
  await ppost("/api/process/control", { action: "fanout" });
  assert.deepEqual(budgetCalls(), [["unstop"], ["fanout", "30"]]);
});

test("AC-009: an action outside the allowlist (incl. a prototype key) is refused, nothing invoked", async () => {
  resetProc();
  for (const action of ["rm", "__proto__", "toString", "", "constructor", "clear-now", "cleanup-on", "cleanup-off"]) {
    const r = await ppost("/api/process/control", { action });
    assert.equal(r.status, 400, `action "${action}" must be refused`);
  }
  assert.equal(budgetCalls().length, 0);
});

test("AC-010: process routes demand X-ACC and local Origin", async () => {
  resetProc();
  assert.equal((await ppost("/api/process/dials", { softK: 1, hardK: 2, amberTokens: 0, redTokens: 0, maxFinders: 1, allow: [] }, { "X-ACC": "" })).status, 403);
  assert.equal((await ppost("/api/process/control", { action: "stop" }, { origin: "https://evil.example" })).status, 403);
});

test("status: an unreadable policy.json is a 500, and a non-JSON tier degrades to null", async () => {
  resetProc();
  fs.writeFileSync(FAKE_USAGE, 'const a=process.argv.slice(2); if(a[0]==="check")console.log("not json"); else console.log("wk");\n');
  fs.rmSync(process.env.ACC_POLICY);
  const r = await fetch(`${base}/api/process/status`);
  assert.equal(r.status, 500);
  // now a readable policy with a valid-but-non-JSON check → tier null, 200
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify(POLICY_BASE));
  const r2 = await fetch(`${base}/api/process/status`);
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).tier, null);
  fs.writeFileSync(FAKE_USAGE, `const a=process.argv.slice(2);\nif(a[0]==="check")console.log(JSON.stringify({tier:"green"}));else console.log("TOTAL $0.00");\n`);
});

test("status: policy blocks that are absent surface as undefined dials, not a crash", async () => {
  resetProc();
  fs.writeFileSync(FAKE_USAGE, `const a=process.argv.slice(2);\nif(a[0]==="check")console.log(JSON.stringify({tier:"green"}));else console.log("TOTAL $0.00");\n`);
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ _comment: "bare" }));
  const r = await fetch(`${base}/api/process/status`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.dials.allow, []);
});

test("dials: an unreadable policy.json is a 500", async () => {
  resetProc();
  fs.rmSync(process.env.ACC_POLICY);
  const r = await ppost("/api/process/dials", { softK: 1, hardK: 2, amberTokens: 0, redTokens: 0, maxFinders: 1, allow: [] });
  assert.equal(r.status, 500);
});

test("control: a non-string action is refused", async () => {
  resetProc();
  assert.equal((await ppost("/api/process/control", { action: 42 })).status, 400);
  assert.equal((await ppost("/api/process/control", {})).status, 400);
});

test("AC-007: vault-import surfaces an engine failure as code+out (no value in the tail)", async () => {
  resetEngine();
  fs.writeFileSync(FAKE_ENGINE, `process.stderr.write("no KEY=VALUE lines found on stdin"); process.exit(1);\n`);
  const r2 = await gpost("/api/guards/vault-import", { pairs: [{ key: "K", value: "v-secret" }] });
  assert.equal(r2.status, 200);
  const j = await r2.json();
  assert.equal(j.code, 1);
  assert.ok(!JSON.stringify(j).includes("v-secret"));
});

// ------------------------------------------------------------- launch API (SPEC-0005, FR-012)
// The web Start-work surface. The directive store, router, and lane are the
// REAL modules against sandboxed env (ACC_ROOT / ACC_ROUTING_MD /
// ACC_LANE_DIR — each already honours it); only the runner is faked
// (ACC_RUNNER), because the real one would spawn a claude. Ids are validated
// against /^d-[A-Za-z0-9_-]{1,38}$/ BEFORE any path is built — the traversal
// cases below prove no `../` shape ever reaches the filesystem.
const LAUNCH_DIR = path.join(BASE, "launch");
const FAKE_RUNNER = path.join(BASE, "fake-runner.mjs");
const RUNNER_LOG = path.join(BASE, "runner-calls.jsonl");
fs.writeFileSync(FAKE_RUNNER, `
import fs from "node:fs";
fs.appendFileSync(process.env.FAKE_RUNNER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`.trimStart());
const runnerCalls = () => {
  try { return fs.readFileSync(RUNNER_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const waitForProcessExit = async (pid) => {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") return;
      if (e.code !== "EPERM") throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`spawned test runner ${pid} did not exit before fixture cleanup`);
};
// A routing fixture whose signals are unambiguous: "guards"/"hook" scores the
// first route, "react" the second, "zebra" nothing.
const ROUTING_MD = path.join(BASE, "ROUTING.md");
const ROUTE_A = path.join(BASE, "code", "guards");
const ROUTE_B = path.join(BASE, "code", "web");
fs.mkdirSync(ROUTE_A, { recursive: true });
fs.mkdirSync(ROUTE_B, { recursive: true });
fs.writeFileSync(ROUTING_MD, "# routes\n```json\n" + JSON.stringify({
  routes: [
    { label: "guards", path: ROUTE_A, signals: ["guards", "hook"] },
    { label: "web", path: ROUTE_B, signals: ["react"] },
  ],
}) + "\n```\n");

function resetLaunch() {
  fs.rmSync(LAUNCH_DIR, { recursive: true, force: true });
  fs.rmSync(RUNNER_LOG, { force: true });
  fs.mkdirSync(LAUNCH_DIR, { recursive: true });
  process.env.ACC_ROOT = LAUNCH_DIR;
  process.env.ACC_ROUTING_MD = ROUTING_MD;
  process.env.ACC_LANE_DIR = path.join(LAUNCH_DIR, "lane");
  process.env.ACC_RUNNER = FAKE_RUNNER;
  process.env.FAKE_RUNNER_LOG = RUNNER_LOG;
  delete process.env.ACC_DIRECTIVES_DIR;
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({
    ...POLICY_BASE,
    profiles: { _note: "fixture", Normal: { label: "std" }, Heavy: { label: "big" } },
    lane: { slots: 1, minGapMs: 0, retries: 1, backoffBaseMs: 1, backoffCapMs: 2, pollMs: 10 },
  }, null, 2));
}
const lpost = jpost;
const newDirective = async (over = {}) => {
  const cwd = over.cwd !== undefined ? over.cwd : fs.mkdtempSync(path.join(LAUNCH_DIR, "work-"));
  const r = await lpost("/api/directives", {
    text: over.text ?? "fix the tests",
    doneWhen: over.doneWhen,
    cwd,
    profile: over.profile ?? "",
    tags: over.tags,
    wallClockMin: over.wallClockMin,
    turns: over.turns,
    tokens: over.tokens,
    dollars: over.dollars,
  });
  return { r, j: r.status === 200 ? await r.json() : null };
};
const pidFile = (id) => path.join(LAUNCH_DIR, "runner", "state", `directive-${id}.pid`);

test("AC-101: POST /api/route/suggest passes the router's verdict through (whitespace collapsed for argv safety)", async () => {
  resetLaunch();
  const r = await lpost("/api/route/suggest", { text: "  fix\nthe   guards hook  " });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.path, ROUTE_A);
  assert.equal(j.label, "guards");
  const miss = await (await lpost("/api/route/suggest", { text: "zebra zebra" })).json();
  assert.equal(miss.path, null);
});

test("AC-102: suggest refuses a missing, empty, non-string, or oversize text before any exec", async () => {
  resetLaunch();
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: "x".repeat(2001) }]) {
    assert.equal((await lpost("/api/route/suggest", body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
});

test("AC-103: POST /api/directives creates a real store entry — text and doneWhen survive byte-exact", async () => {
  resetLaunch();
  const text = 'line one\nline "two" with quotes\n\nline four';
  const doneWhen = "all acceptance tests are green";
  const { r, j } = await newDirective({ text, doneWhen, tags: ["ops", "OPS", "ui"] });
  assert.equal(r.status, 200);
  assert.match(j.id, /^d-/);
  assert.equal(j.text, text, "newlines and quotes must survive the trip into the store");
  assert.equal(j.doneWhen, doneWhen, "doneWhen must round-trip exactly");
  assert.equal(j.status, "active");
  assert.deepEqual(j.tags, ["ops", "ui"], "user tags are normalized and deduped");
  const list = await (await fetch(`${base}/api/directives`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, j.id);
  assert.deepEqual(list[0].tags, ["ops", "ui"]);
  assert.equal(list[0].doneWhen, doneWhen);
});

test("AC-104: create refuses bad text, a relative or nonexistent cwd, and an unknown profile — store untouched", async () => {
  resetLaunch();
  const good = fs.mkdtempSync(path.join(LAUNCH_DIR, "work-"));
  for (const body of [
    { text: "", cwd: good, profile: "" },
    { text: "x".repeat(32769), cwd: good, profile: "" },
    { text: "ok", cwd: "relative/dir", profile: "" },
    { text: "ok", cwd: path.join(LAUNCH_DIR, "ghost"), profile: "" },
    { text: "ok", cwd: good, profile: "Nope" },
    { text: "ok", cwd: good, profile: "_note" },
    { text: "ok", cwd: good, profile: "", wallClockMin: -1 },
    { text: "ok", cwd: good, profile: "", turns: 1.5 },
    { text: "ok", cwd: good, profile: "", tokens: -1 },
    { text: "ok", cwd: good, profile: "", dollars: "x" },
    { text: "ok", cwd: good, profile: "", tags: "oops" },
    { text: "ok", cwd: good, profile: "", tags: ["good", "__proto__"] },
    { text: "ok", cwd: good, profile: "", tags: Array.from({ length: 17 }, (_, i) => `t${i}`) },
    { text: "ok", doneWhen: 42, cwd: good, profile: "" },
    { text: "ok", doneWhen: "", cwd: good, profile: "" },
    { text: "ok", doneWhen: "line 1\nline 2", cwd: good, profile: "" },
    { text: "ok", doneWhen: "x".repeat(501), cwd: good, profile: "" },
  ]) {
    assert.equal((await lpost("/api/directives", body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.deepEqual(await (await fetch(`${base}/api/directives`)).json(), [], "no refused create may reach the store");
});

test("AC-105: a known profile is accepted and lands on the directive", async () => {
  resetLaunch();
  const { r, j } = await newDirective({ profile: "Heavy" });
  assert.equal(r.status, 200);
  assert.equal(j.profile, "Heavy");
});

test("AC-105a: route verdict label is auto-added as a tag when create can route", async () => {
  resetLaunch();
  const { r, j } = await newDirective({ text: "tighten guards hook checks", tags: ["ops"] });
  assert.equal(r.status, 200);
  assert.deepEqual(j.tags, ["ops", "guards"]);
});

test("AC-105b: directive hard-ceiling fields are accepted and land on the store entry", async () => {
  resetLaunch();
  const { r, j } = await newDirective({ wallClockMin: 30, turns: 12, tokens: 3456, dollars: 7.5 });
  assert.equal(r.status, 200);
  assert.deepEqual(j.budget, { wallClockMin: 30, turns: 12, tokens: 3456, dollars: 7.5 });
});

test("AC-106: GET /api/directives decorates each entry with live runner state from the pid file", async () => {
  resetLaunch();
  const { j } = await newDirective();
  fs.mkdirSync(path.dirname(pidFile(j.id)), { recursive: true });
  fs.writeFileSync(pidFile(j.id), String(process.pid)); // alive by construction
  let list = await (await fetch(`${base}/api/directives`)).json();
  assert.equal(list[0].running, true);
  fs.writeFileSync(pidFile(j.id), "999999999"); // no such pid
  list = await (await fetch(`${base}/api/directives`)).json();
  assert.equal(list[0].running, false);
  fs.rmSync(pidFile(j.id));
  list = await (await fetch(`${base}/api/directives`)).json();
  assert.equal(list[0].running, false);
});

test("AC-106a: legacy directives with no tags are exposed as tags:[] (never null)", async () => {
  resetLaunch();
  const id = "d-20260808-120000-lega";
  const live = path.join(LAUNCH_DIR, "runner", "directives");
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, `${id}.json`), JSON.stringify({
    id, text: "legacy", cwd: ROUTE_A, profile: "", status: "active", sessionId: "", sessionIds: [], cycles: 0, budget: { wallClockMin: 0, turns: 0, tokens: 0, dollars: 0 },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }, null, 2));
  const list = await (await fetch(`${base}/api/directives`)).json();
  assert.deepEqual(list[0].tags, []);
});

test("AC-107: POST /api/directives/status marks done (archives) and paused; refusals never touch the store", async () => {
  resetLaunch();
  const { j } = await newDirective();
  for (const body of [
    { id: j.id, status: "dead" },
    { id: j.id, status: "active" },
    { id: "not-an-id", status: "done" },
    { id: "d-" + "x".repeat(39), status: "done" },
    { id: `d-ok/../../${j.id}`, status: "done" },
    { id: j.id, status: "done", why: "two\nlines" },
    { id: j.id, status: "done", why: "x".repeat(501) },
  ]) {
    assert.equal((await lpost("/api/directives/status", body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await (await fetch(`${base}/api/directives`)).json()).length, 1, "refusals must leave it active");
  const r = await lpost("/api/directives/status", { id: j.id, status: "done", why: "finished from the page" });
  assert.equal(r.status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/directives`)).json(), [], "done must archive out of the live list");
});

test("AC-114: POST /api/directives/note appends steering text to the log without touching status, and validates first", async () => {
  resetLaunch();
  const { j } = await newDirective();
  for (const body of [
    { id: "not-an-id", text: "focus here" },
    { id: `d-ok/../../${j.id}`, text: "focus here" },
    { id: j.id, text: "" },
    { id: j.id, text: "   " },
    { id: j.id, text: "x".repeat(4001) },
  ]) {
    assert.equal((await lpost("/api/directives/note", body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  const r = await lpost("/api/directives/note", { id: j.id, text: "focus on the retry path\nignore the flaky one" });
  assert.equal(r.status, 200);
  const logRes = await fetch(`${base}/api/directives/log?id=${j.id}`);
  assert.match(await logRes.text(), /focus on the retry path\nignore the flaky one/);
  const list = await (await fetch(`${base}/api/directives`)).json();
  assert.equal(list[0].status, "active", "a note must never change status");
});

test("AC-108: GET /api/directives/log serves the live log, falls back to done/, bounds the tail, and 400s a traversal-shaped id", async () => {
  resetLaunch();
  const { j } = await newDirective({ text: "log me" });
  let r = await fetch(`${base}/api/directives/log?id=${j.id}`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /log me/);
  // oversize log: only the last 16 KiB travel
  const live = path.join(LAUNCH_DIR, "runner", "directives", `${j.id}.log.md`);
  fs.appendFileSync(live, "PADDING\n".repeat(4096) + "THE-TAIL-MARKER\n");
  r = await fetch(`${base}/api/directives/log?id=${j.id}`);
  const body = await r.text();
  assert.ok(body.length <= 16 * 1024 + 64, `tail must be bounded, got ${body.length}`);
  assert.match(body, /THE-TAIL-MARKER/);
  // done fallback — the padded log was archived wholesale, so its tail (not
  // its long-scrolled-out header) is what must still be served from done/
  await lpost("/api/directives/status", { id: j.id, status: "done" });
  r = await fetch(`${base}/api/directives/log?id=${j.id}`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /THE-TAIL-MARKER/);
  // refusals: bad shape 400 (before any path build), unknown id 404
  assert.equal((await fetch(`${base}/api/directives/log?id=..%2F..%2Fpolicy.json`)).status, 400);
  assert.equal((await fetch(`${base}/api/directives/log?id=d-gone-aaaa`)).status, 404);
});

test("AC-109: POST /api/launch spawns the runner with directive:<id> — and 409s while a live pid holds it", async () => {
  resetLaunch();
  const { j } = await newDirective();
  const r = await lpost("/api/launch", { id: j.id });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.ok(out.pid > 0, "the response must name the spawned pid");
  // The detached fake runner records its argv. Wait for both the record and
  // process exit so Windows does not retain its cwd during fixture cleanup.
  for (let i = 0; i < 40 && !runnerCalls().length; i++) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(runnerCalls().at(-1), [`directive:${j.id}`]);
  await waitForProcessExit(out.pid);
  // a live pid file refuses a second launch
  fs.mkdirSync(path.dirname(pidFile(j.id)), { recursive: true });
  fs.writeFileSync(pidFile(j.id), String(process.pid));
  assert.equal((await lpost("/api/launch", { id: j.id })).status, 409);
  // a stale pid file does not block, and the resulting process is reaped
  // before the next test removes this launch sandbox.
  fs.writeFileSync(pidFile(j.id), "999999999");
  const stale = await lpost("/api/launch", { id: j.id });
  assert.equal(stale.status, 200);
  const staleOut = await stale.json();
  for (let i = 0; i < 40 && runnerCalls().length < 2; i++) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(runnerCalls().at(-1), [`directive:${j.id}`]);
  await waitForProcessExit(staleOut.pid);
});

test("AC-110: launch refuses a malformed id before any path or spawn", async () => {
  resetLaunch();
  for (const id of ["", "nope", "d-", "d-has spaces", "d-" + "x".repeat(39), "d-a/../b", 42, null]) {
    assert.equal((await lpost("/api/launch", { id })).status, 400, `id ${JSON.stringify(id)} must be refused`);
  }
  assert.equal(runnerCalls().length, 0, "no refused launch may spawn");
});

test("AC-111: GET /api/lane/status passes the real lane's JSON through", async () => {
  resetLaunch();
  const r = await fetch(`${base}/api/lane/status`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.automation), "automation pool must be present");
  assert.ok("breaker" in j, "breaker state must be present");
});

test("AC-112: /api/process/status now names the launchable profiles (private keys filtered)", async () => {
  resetLaunch();
  const r = await fetch(`${base}/api/process/status`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.profiles, ["Normal", "Heavy"]);
  assert.deepEqual(j.directiveBudget, { wallClockMin: 0, turns: 0, tokens: 0, dollars: 0 });
});

// ------------------------------------------------------------- --ui-dist static serving
// The FIRST request-derived filesystem path in this server, so the traversal
// cases are the point: a request path must never resolve outside the dist
// root, raw or URL-encoded. /api/* is never shadowed; unknown paths
// (including the retired /guards and /kernel.html built-in routes) fall
// back to index.html (SPA client routing).
const DIST = path.join(BASE, "dist");
fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });
fs.writeFileSync(path.join(DIST, "index.html"), "<!doctype html><title>ACC-UI-DIST</title>");
fs.writeFileSync(path.join(DIST, "assets", "app.js"), "console.log('ui')");
fs.writeFileSync(path.join(BASE, "outside-secret.txt"), "NEVER-SERVED");

test("ui-dist: / serves the dist index, assets get their content type, unknown paths fall back to index (SPA)", async () => {
  process.env.ACC_UI_DIST = DIST;
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /ACC-UI-DIST/);
    const js = await fetch(`${base}/assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
    const spa = await fetch(`${base}/spending`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /ACC-UI-DIST/, "client-routed paths must serve the SPA shell");
  } finally { delete process.env.ACC_UI_DIST; }
});

test("ui-dist: the retired /guards and /kernel.html routes now fall through to the SPA, and /api/* is never shadowed", async () => {
  process.env.ACC_UI_DIST = DIST;
  try {
    assert.match(await (await fetch(`${base}/guards`)).text(), /ACC-UI-DIST/);
    assert.match(await (await fetch(`${base}/kernel.html`)).text(), /ACC-UI-DIST/);
    assert.equal((await fetch(`${base}/api/kernel-policy`)).status, 200);
  } finally { delete process.env.ACC_UI_DIST; }
});

test("ui-dist: traversal never escapes the dist root — raw, encoded, or backslash shapes", async () => {
  process.env.ACC_UI_DIST = DIST;
  try {
    for (const p of ["/../outside-secret.txt", "/..%2Foutside-secret.txt", "/%2e%2e/outside-secret.txt", "/assets/../../outside-secret.txt", "/..\\outside-secret.txt"]) {
      const r = await fetch(`${base}${p}`);
      const body = await r.text();
      assert.ok(!body.includes("NEVER-SERVED"), `path ${JSON.stringify(p)} escaped the dist root`);
    }
  } finally { delete process.env.ACC_UI_DIST; }
});

test("ui-dist: an unknown extension serves as octet-stream, and the --ui-dist CLI flag wires the env", async () => {
  fs.writeFileSync(path.join(DIST, "assets", "data.bin"), "blob");
  process.env.ACC_UI_DIST = DIST;
  try {
    const r = await fetch(`${base}/assets/data.bin`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /octet-stream/);
  } finally { delete process.env.ACC_UI_DIST; }
  const s = await cli(["node", "server.mjs", "--port", "0", "--ui-dist", DIST]);
  try {
    assert.equal(process.env.ACC_UI_DIST, DIST, "the flag must set the env the handler reads");
    assert.match(await (await fetch(`http://127.0.0.1:${s.port}/`)).text(), /ACC-UI-DIST/);
  } finally { s.server.close(); delete process.env.ACC_UI_DIST; }
});

test("ui-dist: a dist with no index.html surfaces a 500, never a crash or an empty 200", async () => {
  const emptyDist = path.join(BASE, "empty-dist");
  fs.mkdirSync(emptyDist, { recursive: true });
  process.env.ACC_UI_DIST = emptyDist;
  try {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 500);
  } finally { delete process.env.ACC_UI_DIST; }
});

test("ui-dist: unset means / is a 404 — ACC has no page of its own to fall back to", async () => {
  delete process.env.ACC_UI_DIST;
  assert.equal((await fetch(`${base}/`)).status, 404);
});

test("AC-113: every launch mutation demands X-ACC and local Origin", async () => {
  resetLaunch();
  const cwd = fs.mkdtempSync(path.join(LAUNCH_DIR, "work-"));
  assert.equal((await lpost("/api/route/suggest", { text: "guards" }, { "X-ACC": "" })).status, 403);
  assert.equal((await lpost("/api/directives", { text: "t", cwd, profile: "" }, { "X-ACC": "" })).status, 403);
  assert.equal((await lpost("/api/directives/status", { id: "d-x-1", status: "done" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await lpost("/api/launch", { id: "d-x-1" }, { "X-ACC": "" })).status, 403);
  assert.deepEqual(await (await fetch(`${base}/api/directives`)).json(), []);
  assert.equal(runnerCalls().length, 0);
});

// ------------------------------------------------------------- session credential (ACC-5, SEC-04 closure, m2-09)
// X-ACC-Token is the actual auth boundary, additive on top of the CSRF-
// hygiene checks proven all through this file already (loopback bind, local
// Host, local Origin, X-ACC on POST) — none of them move or weaken. Every
// case below gets its OWN fresh ACC_ROOT via mkdtempSync and calls
// REAL_FETCH directly: the shared sandbox server's token (TOKEN, attached
// automatically to `base` requests above) was already created long before
// any test body in this file runs, so it is the wrong server to observe
// "no token file yet" on, and the wrong token to send when a test's whole
// point is a missing/wrong one.
function withTempAccRoot(run) {
  const root = fs.mkdtempSync(path.join(BASE, "token-"));
  const savedRoot = process.env.ACC_ROOT, savedPolicy = process.env.ACC_POLICY;
  process.env.ACC_ROOT = root;
  process.env.ACC_POLICY = path.join(root, "policy.json");
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: KERNEL }, null, 2));
  return Promise.resolve().then(() => run(root)).finally(() => {
    process.env.ACC_ROOT = savedRoot; process.env.ACC_POLICY = savedPolicy;
  });
}

test("ACC-5: the token file is created with owner-only permissions on first start, absent before", () =>
  withTempAccRoot(async (root) => {
    const tokenPath = path.join(root, "gui-token");
    assert.equal(fs.existsSync(tokenPath), false, "precondition: no token file yet");
    const s = await startServer({ port: 0 });
    try {
      assert.ok(fs.existsSync(tokenPath), "starting the server must create the token file");
      assert.equal(typeof s.token, "string");
      assert.equal(s.token.length, 43, "32 random bytes as unpadded base64url is 43 characters");
      assert.match(s.token, /^[A-Za-z0-9_-]+$/, "base64url alphabet only");
      assert.equal(fs.readFileSync(tokenPath, "utf8").trim(), s.token, "the file must hold exactly the token the server is using");
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600, "token file must be owner-only (0600)");
      }
    } finally { s.server.close(); }
  })
);

test("ACC-5: an existing token file is loaded verbatim, never regenerated", () =>
  withTempAccRoot(async (root) => {
    const tokenPath = path.join(root, "gui-token");
    fs.writeFileSync(tokenPath, "fixture-preexisting-token-value\n", { mode: 0o600 });
    const s = await startServer({ port: 0 });
    try {
      assert.equal(s.token, "fixture-preexisting-token-value");
      assert.equal(fs.readFileSync(tokenPath, "utf8"), "fixture-preexisting-token-value\n", "an existing file must not be rewritten — restart reuses it, only deleting it rotates (gui/README.md)");
    } finally { s.server.close(); }
  })
);

test("ACC-5: an existing but empty/whitespace-only token file is treated as absent — a fresh token is minted, never an empty credential", () =>
  withTempAccRoot(async (root) => {
    const tokenPath = path.join(root, "gui-token");
    fs.writeFileSync(tokenPath, "   \n", { mode: 0o600 }); // corrupt/truncated write, e.g. a crash mid-create
    const s = await startServer({ port: 0 });
    const b = `http://127.0.0.1:${s.port}`;
    try {
      assert.ok(s.token.length > 0, "must never operate with an empty in-memory token");
      assert.notEqual(s.token.trim(), "");
      // If the empty fixture had become the live credential, a request with
      // NO header at all (presented "" via tokenMatches' own fallback) would
      // wrongly match an empty stored token. It must not.
      assert.equal((await REAL_FETCH(`${b}/api/kernel-policy`)).status, 401);
      assert.equal((await REAL_FETCH(`${b}/api/kernel-policy`, { headers: { "X-ACC-Token": s.token } })).status, 200);
    } finally { s.server.close(); }
  })
);

test("ACC-5: ACC_GUI_TOKEN_FILE redirects the token path, mirroring the ACC_ROOT/ACC_POLICY seam style", () =>
  withTempAccRoot(async (root) => {
    const customPath = path.join(BASE, "custom-gui-token");
    fs.rmSync(customPath, { force: true });
    process.env.ACC_GUI_TOKEN_FILE = customPath;
    try {
      const s = await startServer({ port: 0 });
      try {
        assert.ok(fs.existsSync(customPath), "token must be created at ACC_GUI_TOKEN_FILE when set");
        assert.equal(fs.existsSync(path.join(root, "gui-token")), false, "the default <ACC_ROOT>/gui-token path must be untouched once redirected");
        assert.equal(fs.readFileSync(customPath, "utf8").trim(), s.token);
      } finally { s.server.close(); }
    } finally { delete process.env.ACC_GUI_TOKEN_FILE; }
  })
);

test("ACC-5: /api/* rejects a missing token, a wrong token (same length, different length, and empty), and accepts the correct one", () =>
  withTempAccRoot(async () => {
    const s = await startServer({ port: 0 });
    const b = `http://127.0.0.1:${s.port}`;
    try {
      const noHeader = await REAL_FETCH(`${b}/api/kernel-policy`);
      assert.equal(noHeader.status, 401);
      assert.deepEqual(await noHeader.json(), { error: "unauthorized" }, "must match gui/README.md's error envelope exactly");

      // Same length as the real token: exercises the fixed-length hash-then-
      // compare path rather than any length-mismatch shortcut.
      const wrongSameLength = s.token.slice(0, -1) + (s.token.at(-1) === "A" ? "B" : "A");
      assert.equal(wrongSameLength.length, s.token.length);
      assert.notEqual(wrongSameLength, s.token);
      const wrongResp = await REAL_FETCH(`${b}/api/kernel-policy`, { headers: { "X-ACC-Token": wrongSameLength } });
      assert.equal(wrongResp.status, 401);

      assert.equal((await REAL_FETCH(`${b}/api/kernel-policy`, { headers: { "X-ACC-Token": "short" } })).status, 401);
      assert.equal((await REAL_FETCH(`${b}/api/kernel-policy`, { headers: { "X-ACC-Token": "" } })).status, 401);

      const ok = await REAL_FETCH(`${b}/api/kernel-policy`, { headers: { "X-ACC-Token": s.token } });
      assert.equal(ok.status, 200);
    } finally { s.server.close(); }
  })
);

// Mutation-testing note (honest limitation, not a gap this suite can close):
// a hand-designed mutant that replaces tokenMatches' hash-then-compare with
// the naive "if (presented.length !== token.length) return false; then
// timingSafeEqual on the raw bytes" pattern survives this entire file
// unchanged -- every functional assertion above (right token, wrong token at
// every length, empty, missing) still produces the identical status code,
// because a timing side-channel is by definition invisible to a pass/fail
// functional assertion. That naive pattern is the textbook-wrong version:
// it leaks the real token's length through response latency (an early
// return on mismatch is fast; a full compare is not), which is exactly what
// hashing both sides to a fixed 32-byte digest before comparing (see
// tokenMatches in server.mjs) exists to eliminate. The current
// implementation is correct by code review and by the SHA-256 hash
// construction itself, not by anything this functional suite can
// independently prove -- deliberately not "fixed" with a real-timing
// measurement test, since a threshold that's reliable across this
// environment's noise would itself be a source of flakiness, which is worse
// than an honestly-documented gap.
test("ACC-5: the check is additive (a correct token never bypasses Origin/Host) and leaves no route-existence oracle for an unauthenticated caller", () =>
  withTempAccRoot(async () => {
    const s = await startServer({ port: 0 });
    const b = `http://127.0.0.1:${s.port}`;
    try {
      assert.equal((await REAL_FETCH(`${b}/api/kernel-policy`, { headers: { "X-ACC-Token": s.token } })).status, 200, "sanity: the correct token alone succeeds");
      assert.equal(
        (await REAL_FETCH(`${b}/api/kernel-policy`, { headers: { "X-ACC-Token": s.token, origin: "https://evil.example" } })).status,
        403,
        "a foreign Origin must still be refused even with a correct token — additive, not a replacement"
      );
      const knownRoute = await REAL_FETCH(`${b}/api/kernel-policy`, { headers: { "X-ACC-Token": "wrong" } });
      const unknownRoute = await REAL_FETCH(`${b}/api/this-route-does-not-exist`, { headers: { "X-ACC-Token": "wrong" } });
      assert.equal(knownRoute.status, 401);
      assert.equal(unknownRoute.status, 401);
      assert.deepEqual(await knownRoute.json(), await unknownRoute.json(), "a known vs unknown route must be indistinguishable before auth");
    } finally { s.server.close(); }
  })
);

// --- Finding 31: the default token file must actually be git-ignored ------
// Regression for a real leak, not a hypothetical: a default-configured ACC
// (ACC_ROOT/ACC_GUI_TOKEN_FILE both unset) writes its bearer credential to
// "<app root>/gui-token" — see tokenFile() in server.mjs. If that path is
// not covered by apps/agentic-command-center/.gitignore, one `git add -A`/
// `git add .` in that state commits a live credential to history. This test
// asks the REAL `git check-ignore` about the REAL .gitignore file (never a
// hand-rolled matcher, per the review that filed this finding) so it can
// never drift from what git itself would actually do at commit time. It
// deliberately does NOT write a real file into the live repo tree (AGENTS.md
// "do not run hooks manually against live state") — check-ignore's pattern
// matching does not require the target path to exist.
test("Finding 31: the default gui-token path is matched by .gitignore (git check-ignore, not a hand-rolled matcher)", () => {
  const appRoot = path.join(HERE, ".."); // gui/server.test.mjs lives beside gui/server.mjs; ".." is the same app root tokenFile() defaults to
  const defaultTokenPath = path.join(appRoot, "gui-token");
  const r = spawnSync("git", ["-C", appRoot, "check-ignore", "--quiet", defaultTokenPath]);
  assert.equal(r.status, 0, `expected \`git check-ignore\` to match ${defaultTokenPath} against the real .gitignore; got exit ${r.status} (stderr: ${r.stderr})`);
});

// --- Finding 30: 0600 is a same-OS-user boundary, not a same-process one --
// (see the "Honest threat model" comment above loadOrCreateToken() in
// server.mjs). What IS enforceable and was previously missing: an existing
// token file must still actually be 0600 before it's trusted, or a same-user
// process that pre-created a looser-permission file before the server's
// first start would have its (attacker-known) content silently adopted as
// the live credential. Permission bits are meaningless on win32 (Node fakes
// them there), matching the existing platform guard a few tests up, so this
// whole scenario is skipped there — nothing for the code under test to do.
test(
  "Finding 30: a pre-existing token file with looser-than-owner-only permissions is not trusted verbatim — a fresh token is minted and the file is re-tightened to 0600",
  { skip: process.platform === "win32" ? "POSIX permission bits are not meaningful on win32" : false },
  () =>
    withTempAccRoot(async (root) => {
      const tokenPath = path.join(root, "gui-token");
      const plantedValue = "attacker-planted-token-value";
      fs.writeFileSync(tokenPath, plantedValue + "\n", { mode: 0o644 }); // world-readable: what a same-user process pre-creating the file before first start would look like
      assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o644, "precondition: the planted file really is looser than owner-only");
      const s = await startServer({ port: 0 });
      try {
        assert.notEqual(s.token, plantedValue, "a non-0600 pre-existing file must never become the live credential");
        assert.equal(fs.readFileSync(tokenPath, "utf8").trim(), s.token, "the file on disk must hold the freshly minted token, not the planted one");
        assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600, "the file must be re-tightened to owner-only, not left at its planted permissions");
      } finally { s.server.close(); }
    })
);

test(
  "Finding 30: an existing token file that is already 0600 keeps loading verbatim (no regression from the new permission check)",
  { skip: process.platform === "win32" ? "POSIX permission bits are not meaningful on win32" : false },
  () =>
    withTempAccRoot(async (root) => {
      const tokenPath = path.join(root, "gui-token");
      fs.writeFileSync(tokenPath, "fixture-owner-only-token\n", { mode: 0o600 });
      const s = await startServer({ port: 0 });
      try {
        assert.equal(s.token, "fixture-owner-only-token", "a properly-permissioned existing file must still be loaded verbatim, exactly as before this fix");
      } finally { s.server.close(); }
    })
);
