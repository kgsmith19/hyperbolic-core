#!/usr/bin/env node
// gui/server.mjs — rails of the web GUI (spec 2026-08-03-acc-oi-closure-design
// §5-§6): the kernel-settings tab is the first migrated tab; later tabs mount
// alongside. Loopback-only, ZERO business logic — reads and writes go through
// kernel/policy.mjs, the same single owner the WinForms tab used.
//
// Ethos answer (OI-022's recorded tension): binds 127.0.0.1 only. The
// web-borne risk — CSRF against a localhost mutator — is closed by
// construction: mutating routes demand the custom X-ACC header, Host must be
// local, and Origin must be local or the ONE exact ACC_ALLOWED_ORIGIN parsed
// at startup. That optional Shell bridge still requires the session token and
// emits narrowly-scoped CORS/PNA headers; no wildcard grant exists. That left
// one gap SEC-04
// named explicitly: X-ACC is CSRF hygiene, not auth. ACC-5 adds a session
// credential on every /api/* request without moving or weakening anything
// above. It blocks browsers and callers running as other OS users when file
// permissions hold; it cannot sandbox arbitrary processes already running as
// the same user (see the session-credential threat model below).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { loadKernelPolicy, saveKernelPolicy } from "../kernel/policy.mjs";
import { DONE_WHEN_MAX, normalizeRouteTag, validateUserDirectiveTags } from "../hooks/directive.mjs";
// The pid-liveness predicate is lane.mjs's (it owns cross-process ownership);
// this file and runner.mjs each used to keep their own copy of it.
import { pidAlive } from "../hooks/lane.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY_CAP = 64 * 1024;

// --- --ui-dist static serving --------------------------------------------
// When ACC_UI_DIST (or --ui-dist) names the UI repo's built dist/, `/` and
// every non-API GET serve from it, same-origin — so the loopback/X-ACC
// security model is unchanged and no CORS grant ever exists. The built-in
// guards.html/kernel.html pages they replaced were retired once the UI's
// contract suite (ui/e2e/contract.spec.ts) went green against a live server
// for every page it covers — see gui/README.md. Without --ui-dist, ACC has
// no browser UI at all: it is a headless core with a loopback API.
// The ONE request-derived filesystem path in this server is the static
// route below, which is containment-checked.
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon",
  ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain",
};
function serveDist(res, dist, route) {
  const root = path.resolve(dist);
  // Deliberately NO decodeURIComponent: an encoded ".." stays a literal
  // filename that resolves inside root and simply misses (SPA fallback).
  // Backslashes normalize to slashes so a Windows-shaped escape cannot
  // slip past the containment check on POSIX either.
  const candidate = path.resolve(root, "." + route.replaceAll("\\", "/"));
  let file = candidate === root || candidate.startsWith(root + path.sep) ? candidate : null;
  try { if (!file || !fs.statSync(file).isFile()) file = path.join(root, "index.html"); }
  catch { file = path.join(root, "index.html"); } // unknown path -> SPA shell (client routing)
  try {
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
}

// --- guards API (SPEC-0002): thin shell over two binaries ------------------
// Guard-config (enable/disable, secret/protected lists) lives in
// apps/toolbelt/guards/cli.mjs; vault + runbox lifecycle stays in this
// repo's hooks/engine.mjs. Each stays the single owner of its own state
// change — this server adds transport and, for routes the browser still
// expects as one shape (status), composition — never logic of its own.
// ACC_ENGINE/ACC_GUARDS_CLI are resolved per request so tests can drive fakes
// (and one read-only case the real ones) without a restart.
const enginePath = () => process.env.ACC_ENGINE || path.join(HERE, "..", "hooks", "engine.mjs");
// SPEC-0004 process controls shell the same node scripts the WinForms GUI did;
// each path is env-overridable so a test can point at a fake that records its
// argv/stdin. ACC_ROOT sandboxes the control files (stop-file, kill switch),
// the same discipline budget.mjs/runner already honour.
const budgetPath = () => process.env.ACC_BUDGET || path.join(HERE, "..", "hooks", "budget.mjs");
const usagePath = () => process.env.ACC_USAGE || path.join(HERE, "..", "hooks", "usage.mjs");
const repoRoot = () => (process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.join(HERE, ".."));
const policyFile = () => process.env.ACC_POLICY || path.join(HERE, "..", "policy.json");
const readPolicyJson = () => JSON.parse(fs.readFileSync(policyFile(), "utf8").replace(/^\uFEFF/, ""));
// Reads policy.json or sends the 500 itself and returns null \u2014 callers just
// check the return value and bail (`if (!policy) return;`).
function tryReadPolicy(res) {
  try { return readPolicyJson(); }
  catch (e) { send(res, 500, { error: `cannot read policy.json: ${e.message}` }); return null; }
}
const sliceStopFile = () => path.join(repoRoot(), "runner", "stop", "slice-runner.stop");

// --- launch surface (SPEC-0005, FR-012): the web Start-work tab -----------
// Same shape as every block above: the server shells the real owners
// (route.mjs, directive.mjs, lane.mjs, runner.mjs) and adds transport only.
// The directive store and router honour ACC_ROOT/ACC_ROUTING_MD themselves,
// so the only fake seam a test needs is the runner (a real one spawns claude).
const routeScript = () => path.join(HERE, "..", "hooks", "route.mjs");
const directiveScript = () => path.join(HERE, "..", "hooks", "directive.mjs");
const laneScript = () => path.join(HERE, "..", "hooks", "lane.mjs");
const runnerScript = () => process.env.ACC_RUNNER || path.join(HERE, "..", "runner", "runner.mjs");
// Mirrors hooks/directive.mjs's own resolution (ACC_DIRECTIVES_DIR, then
// ACC_ROOT) so this server reads logs from exactly the tree the store writes.
const directivesDir = () => process.env.ACC_DIRECTIVES_DIR || path.join(repoRoot(), "runner", "directives");
const runnerPidFile = (id) => path.join(repoRoot(), "runner", "state", `directive-${id}.pid`);

// Ids travel in bodies/queries, never in the URL path, and are validated
// against this shape BEFORE any filesystem path is built from one — the same
// character set hooks/directive.mjs's safeId enforces, so a passing id can
// never contain a separator, a dot, or anything traversal-shaped.
const DIRECTIVE_ID_RE = /^d-[A-Za-z0-9_-]{1,38}$/;
const validDirectiveId = (id) => typeof id === "string" && DIRECTIVE_ID_RE.test(id);
const LOG_TAIL_CAP = 16 * 1024;

// Is a runner loop live for this directive? Reads the pid file the runner's
// singleton owns (runner/state/directive-<id>.pid). Purely a status read here;
// the runner itself is the authority (it refuses a duplicate with exit 6).
const runnerLive = (id) => {
  try { return pidAlive(fs.readFileSync(runnerPidFile(id), "utf8").trim()); } catch { return false; }
};
// Launchable profile names from policy.json — underscore keys (_note) are
// documentation, not profiles.
const profileNames = (p) => Object.keys(p.profiles || {}).filter((k) => !k.startsWith("_"));
function readDirectiveBudget(body) {
  const raw = {
    wallClockMin: body.wallClockMin,
    turns: body.turns,
    tokens: body.tokens,
    dollars: body.dollars,
  };
  const out = {};
  for (const [key, integer] of [["wallClockMin", false], ["turns", true], ["tokens", true], ["dollars", false]]) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === "") continue;
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] < 0 || (integer && !Number.isInteger(raw[key]))) {
      throw new Error(`${key} must be a non-negative${integer ? " whole" : ""} number`);
    }
    out[key] = raw[key];
  }
  return out;
}

// Run a node script; `stdin`, when given, is written and closed. This is the
// ONLY channel a secret value ever travels (SPEC-0003): never argv, so it
// cannot land in a process listing or a log; the value is not returned here
// either — callers surface `code`/`stdout` only. `extraEnv`, when given, is
// merged over this process's own env for the child only.
function nodeExec(script, args, stdin, extraEnv) {
  return new Promise((resolveExec) => {
    const env = extraEnv ? { ...process.env, ...extraEnv } : undefined;
    const child = execFile(process.execPath, [script, ...args], { timeout: 120000, env }, (err, stdout, stderr) => {
      resolveExec({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
    if (stdin !== undefined) { child.stdin.end(stdin); }
  });
}
// apps/toolbelt/guards is a sibling app in this monorepo — a non-breaking
// DEFAULT, not a hard dependency: ACC_GUARDS_CLI/ACC_GUARDS_CONFIG override
// it (tests point these at fakes/fixtures; a deployment with a different
// layout can point them anywhere).
const guardsCliPath = () => process.env.ACC_GUARDS_CLI || path.join(HERE, "..", "..", "..", "toolbelt", "guards", "cli.mjs");
const guardsConfigPath = () => process.env.ACC_GUARDS_CONFIG || path.join(HERE, "..", "..", "..", "toolbelt", "guards", "config.json");
// engine.mjs still owns the "projects"/"runboxDir" fields inside the SAME
// config.json guard.mjs/cli.mjs read — GUARDS_CONFIG is how it finds it now
// that the file lives in apps/toolbelt/guards, not ACC's own root.
const engineExec = (args, stdin) => nodeExec(enginePath(), args, stdin, { GUARDS_CONFIG: guardsConfigPath() });
const guardsExec = (args, stdin) => nodeExec(guardsCliPath(), args, stdin, { GUARDS_CONFIG: guardsConfigPath() });

// Run a script and parse its stdout as JSON, or throw with a diagnosable
// message — the shared shape behind every route/suggest, directive-list and
// lane-status GET below, which all just shell a script and pass its JSON
// verdict through.
async function execJson(script, args, label) {
  const r = await nodeExec(script, args);
  try { return JSON.parse(r.stdout); }
  catch { throw new Error((r.stderr || `${label} exited ${r.code}`).slice(-500)); }
}

// A vault key must be an env-var-shaped name and a value must be single-line:
// the engine frames the vault as `KEY=VALUE\n` lines on stdin, so a `\n` in a
// value or an `=`/newline in a key would forge an extra entry. Enforced here
// as a security boundary (PROP-002), not politeness.
// The anti-forgery guarantee rests on engine.mjs framing the vault as
// `KEY=VALUE` lines split ONLY on /\r?\n/: rejecting \r and \n in a value is
// therefore sufficient (a U+2028/U+2029 in a value passes through as literal
// value text, not a new line). If the engine's split ever widens, widen
// validVaultValue's rejected set in lockstep.
const VAULT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// `__proto__`/`constructor`/`prototype` are env-var-shaped but would pollute
// the prototype of engine.mjs's plain-object vault via `v[key] = value` —
// rejected here even though the engine's string-value assignment happens to
// be inert today, so no future consumer can be surprised.
const VAULT_KEY_RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const validVaultKey = (k) => typeof k === "string" && VAULT_KEY_RE.test(k) && !VAULT_KEY_RESERVED.has(k);
const validVaultValue = (v) => typeof v === "string" && !/[\r\n]/.test(v) && v.length <= 8192;

// PROP-001: argv is built ONLY from these maps plus one validated arg. No
// browser string is ever a path, a flag, or shell input (execFile, no
// shell). Verbs that consume secret values (apply, vault-import) are
// deliberately absent — SPEC-0003 owns that surface with its own review.
//
// Split across two binaries: GUARDS_VERBS shells apps/toolbelt/guards'
// cli.mjs (guard-config: enable/disable, secret/protected lists);
// ENGINE_VERBS shells this repo's own hooks/engine.mjs (runbox lifecycle).
// The browser-facing route/request/response shape is unchanged either way —
// this split is an internal routing detail, not an API contract change.
const oneRef = (b) =>
  typeof b.arg === "string" && b.arg.length > 0 && b.arg.length <= 512 && !b.arg.includes("\0")
    ? [b.arg] : null;
const GUARDS_VERBS = {
  toggle: (b) => (b.arg === "on" || b.arg === "off" ? [b.arg] : null),
  "secret-add": oneRef, "secret-rm": oneRef,
  "protected-add": oneRef, "protected-rm": oneRef,
};
const ENGINE_VERBS = {
  "projects-add": oneRef, "projects-rm": oneRef,
  run: oneRef, trash: oneRef, restore: oneRef,
  // Permanent deletion keeps its human gate: the browser must send an
  // explicit confirm, and only the server ever writes the --really flag.
  flush: (b) => (b.confirm === true ? ["--really"] : null),
};

async function guardsJson(args) {
  const r = await guardsExec(args);
  if (r.code !== 0) throw new Error(r.stderr || `guards exited ${r.code}`);
  return JSON.parse(r.stdout);
}

async function engineJson(args) {
  const r = await engineExec(args);
  if (r.code !== 0) throw new Error(r.stderr || `engine exited ${r.code}`);
  return JSON.parse(r.stdout);
}

// --- spending/process controls (SPEC-0004) --------------------------------
const nonNegInt = (n) => Number.isInteger(n) && n >= 0;
const nonNegNum = (n) => Number.isFinite(n) && n >= 0;

// PROP-001: merge validated dials into the policy object while leaving every
// key the dials form does not own byte-identical. Returns the new policy
// object, or throws naming the first bad field — the caller writes only on a
// clean return, so a bad dial never partially corrupts policy.json.
function mergeDials(policy, d) {
  const req = (name, v, ok) => { if (!ok(v)) throw new Error(`invalid ${name}`); return v; };
  if (!Array.isArray(d.allow) || d.allow.some((s) => typeof s !== "string")) throw new Error("invalid allow (must be a string array)");
  return {
    ...policy,
    context: { ...(policy.context || {}), softK: req("softK", d.softK, nonNegInt), hardK: req("hardK", d.hardK, nonNegInt) },
    week: { ...(policy.week || {}), amberTokens: req("amberTokens", d.amberTokens, nonNegNum), redTokens: req("redTokens", d.redTokens, nonNegNum) },
    review: { ...(policy.review || {}), maxFinders: req("maxFinders", d.maxFinders, nonNegInt) },
    subagents: { ...(policy.subagents || {}), allow: d.allow.map((s) => s.trim()).filter(Boolean) },
  };
}

// Allowlisted control actions. Each returns a thunk performing exactly one
// side effect — the browser's `action` string only selects a thunk, it never
// becomes argv, a path, or a flag (PROP-002).
function controlAction(action) {
  const writeFile = (f, txt) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
  const table = {
    stop: () => { writeFile(sliceStopFile(), "stopped from the Command Center\n"); return { ok: true }; },
    resume: () => nodeExec(budgetPath(), ["unstop"]),
    fanout: () => nodeExec(budgetPath(), ["fanout", "30"]),
  };
  return Object.hasOwn(table, action) ? table[action] : null;
}

function readBody(req, res, cb) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > BODY_CAP) req.destroy(); // over-cap is dropped, never parsed
  });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return send(res, 400, { error: "body is not JSON" }); }
    cb(parsed);
  });
}

const localHost = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(h || ""));
const localOrigin = (o) => o === undefined || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(o));

function parseAllowedOrigin(raw = process.env.ACC_ALLOWED_ORIGIN) {
  if (raw === undefined || raw === "") return null;
  if (raw !== raw.trim()) throw new Error("ACC_ALLOWED_ORIGIN must be one exact origin without surrounding whitespace");
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error("ACC_ALLOWED_ORIGIN must be one valid http(s) origin"); }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash || parsed.origin !== raw
  ) {
    throw new Error("ACC_ALLOWED_ORIGIN must be one exact origin with no path, query, fragment, or credentials");
  }
  if (parsed.protocol !== "https:" && !/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(parsed.hostname)) {
    throw new Error("ACC_ALLOWED_ORIGIN must use https unless it is loopback development");
  }
  return parsed.origin;
}

const CORS_VARY = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network";
const CORS_HEADERS = "X-ACC-Token, X-ACC, Content-Type";
const PREFLIGHT_HEADERS = new Set(["x-acc-token", "x-acc", "content-type"]);

function configuredCorsRequest(req, allowedOrigin) {
  return Boolean(allowedOrigin && req.headers.origin === allowedOrigin);
}

function setCorsResponseHeaders(req, res, allowedOrigin) {
  if (!configuredCorsRequest(req, allowedOrigin)) return;
  res.setHeader("access-control-allow-origin", allowedOrigin);
  res.setHeader("vary", CORS_VARY);
}

function handlePreflight(req, res, allowedOrigin) {
  if (req.method !== "OPTIONS") return false;
  if (!req.url.split("?")[0].startsWith("/api/") || !configuredCorsRequest(req, allowedOrigin)) {
    send(res, 403, { error: "cross-origin preflight denied" });
    return true;
  }
  const method = String(req.headers["access-control-request-method"] || "").toUpperCase();
  const privateNetwork = req.headers["access-control-request-private-network"];
  const headers = String(req.headers["access-control-request-headers"] || "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (
    (method !== "GET" && method !== "POST") ||
    headers.some((header) => !PREFLIGHT_HEADERS.has(header)) ||
    (privateNetwork !== undefined && privateNetwork !== "true")
  ) {
    send(res, 403, { error: "cross-origin preflight denied" });
    return true;
  }
  setCorsResponseHeaders(req, res, allowedOrigin);
  res.setHeader("access-control-allow-methods", "GET, POST");
  res.setHeader("access-control-allow-headers", CORS_HEADERS);
  res.setHeader("access-control-max-age", "600");
  if (privateNetwork === "true") {
    res.setHeader("access-control-allow-private-network", "true");
  }
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
  return true;
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

// --- session credential (ACC-5 / SEC-04 closure, issue m2-09) --------------
// The loopback bind + Host/Origin + X-ACC checks above are CSRF hygiene
// (SEC-04): they stop a web page from driving this API, but any OTHER local
// process on the machine could already speak to the port. X-ACC-Token adds a
// credential boundary for browsers and other OS users, but it cannot isolate
// ACC from arbitrary processes already running as the same OS user: those
// processes can inspect that user's files or browser state. It is additive
// to every check above; none of them move or weaken. A shared secret, not
// platform-JWT verification: ACC makes zero network calls today and must
// keep working fully offline on a single-operator machine, so JWKS fetching
// (or any other network dependency) is the wrong shape for a loopback socket
// like this one.
//
// Token file: one line, 32 random bytes base64url, mode 0600, created on
// first use if absent. ACC_GUI_TOKEN_FILE redirects the path (same seam
// style as ACC_ROOT/ACC_POLICY above); the default is the ignored private
// state path "<ACC_ROOT>/.acc/gui-token", never a repository-tracked path.
// Rotation has no dedicated mechanism: delete the file and restart, and a
// fresh one is minted (gui/README.md documents this for the operator).
//
// Read/created exactly once, at the moment a server actually starts
// (startServer(), below) — NOT re-resolved per request. A real deployment
// starts one server per process and ACC_ROOT never moves under it, so this
// is a single filesystem touch for the process's whole life; startServer()
// pins the result into that server's request handler, so every request
// after startup is a plain in-memory compare, never a re-read or a
// re-resolve of ACC_ROOT/ACC_GUI_TOKEN_FILE. (Deliberately NOT a
// module-global cache keyed off "the current env": this suite exercises one
// long-lived shared server while freely repointing ACC_ROOT at other
// sandboxes for unrelated fixtures, same as every other env seam in this
// file — a cache that silently re-derived on that would rotate the running
// server's credential out from under it.)
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const tokenFile = () => process.env.ACC_GUI_TOKEN_FILE || path.join(repoRoot(), ".acc", "gui-token");
const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);

function validToken(raw) {
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!TOKEN_RE.test(token) || raw !== token && raw !== `${token}\n`) return null;
  try {
    return Buffer.from(token, "base64url").toString("base64url") === token ? token : null;
  } catch { return null; }
}

function applyWindowsOwnerAcl(target, directory = false) {
  if (process.platform !== "win32") return;
  const username = process.env.USERNAME;
  if (!username) throw new Error("cannot secure ACC GUI token: USERNAME is unset");
  const grant = directory ? `${username}:(OI)(CI)F` : `${username}:F`;
  execFileSync("icacls", [target, "/inheritance:r", "/grant:r", grant], { stdio: "ignore", windowsHide: true });
}

function secureTokenDirectory(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`ACC GUI token directory must be a real directory: ${dir}`);
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`ACC GUI token directory is not owned by the current user: ${dir}`);
    }
    fs.chmodSync(dir, 0o700);
  } else {
    applyWindowsOwnerAcl(dir, true);
  }
}

function readToken(file) {
  let linkStat;
  try { linkStat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
    throw new Error(`ACC GUI token must be a regular file, not a link or special file: ${file}`);
  }

  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`ACC GUI token must be a regular file: ${file}`);
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error(`ACC GUI token is not owned by the current user: ${file}`);
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error(`ACC GUI token must have owner-only permissions (0600): ${file}`);
      }
    } else {
      applyWindowsOwnerAcl(file);
    }
    const token = validToken(fs.readFileSync(fd, "utf8"));
    if (!token) throw new Error(`invalid ACC GUI token file: ${file}`);
    return token;
  } finally {
    fs.closeSync(fd);
  }
}

function loadOrCreateToken() {
  const file = tokenFile();
  secureTokenDirectory(file);
  const existing = readToken(file);
  if (existing) return existing;

  const fresh = randomBytes(32).toString("base64url");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
  } catch (error) {
    // Another concurrently starting ACC process won the exclusive create.
    if (error?.code === "EEXIST") return readToken(file);
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${fresh}\n`, "utf8");
    fs.fsyncSync(fd);
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  applyWindowsOwnerAcl(file);
  return fresh;
}

// The token's shape (43 base64url characters) is public, so malformed inputs
// may be rejected early. Valid candidates are hashed to equal-length digests
// and compared with timingSafeEqual. This avoids raw-secret comparison but
// does not claim constant end-to-end HTTP response timing.
function tokenMatches(presented, token) {
  if (typeof presented !== "string" || !TOKEN_RE.test(presented)) return false;
  const want = createHash("sha256").update(token).digest();
  const got = createHash("sha256").update(presented).digest();
  return timingSafeEqual(want, got);
}

// `token` defaults to a freshly loaded/created one so `handler(req, res)` —
// called directly with no server behind it at all, e.g. a test exercising a
// single defensive check — still works. startServer() below instead pins ONE
// token per server instance and passes it explicitly (a closure, not this
// default), so independent server instances in the same process can never
// cross-contaminate each other's credential.
/**
 * Every cross-cutting check a request clears before any route sees it.
 *
 * Returns the resolved route when the request may proceed, or `null` when it
 * has already been answered and the caller must stop. Its own function so the
 * property handler's comments assert -- these run ONCE, and a future route
 * cannot forget them -- is structural rather than a matter of where someone
 * pastes the next `if`.
 */
function enforceRequestSecurity(req, res, token, allowedOrigin) {
  if (!localHost(req.headers.host)) {
    send(res, 403, { error: "non-local Host" });
    return null;
  }
  if (!localOrigin(req.headers.origin) && !configuredCorsRequest(req, allowedOrigin)) {
    send(res, 403, { error: "non-local Origin" });
    return null;
  }
  if (handlePreflight(req, res, allowedOrigin)) return null;
  setCorsResponseHeaders(req, res, allowedOrigin);
  // Every mutating route demands the custom header (unsettable cross-origin
  // without a CORS grant this server never issues). Non-POST methods carry
  // no mutation.
  if (req.method === "POST" && req.headers["x-acc"] !== "1") {
    send(res, 403, { error: "missing X-ACC header" });
    return null;
  }
  const route = req.url.split("?")[0];
  // Every /api/* request needs the session credential, GET and POST alike
  // (ACC-5) — checked before any route match so an unauthenticated caller
  // gets the identical 401 whether the path exists or not: no route-
  // existence oracle. Non-API GETs (the --ui-dist static path, already open
  // by design) are unaffected: the browser has to load that page at all
  // before it can ever hold a token to send.
  if (route.startsWith("/api/") && !tokenMatches(req.headers["x-acc-token"], token)) {
    send(res, 401, { error: "unauthorized" });
    return null;
  }
  return route;
}

export function handler(req, res, token = loadOrCreateToken(), allowedOrigin = parseAllowedOrigin()) {
  const route = enforceRequestSecurity(req, res, token, allowedOrigin);
  if (route === null) return;
  // With a dist configured, it owns "/" and every non-API GET.
  const dist = process.env.ACC_UI_DIST;
  if (req.method === "GET" && dist && !route.startsWith("/api/")) {
    return serveDist(res, dist, route);
  }
  if (route === "/api/kernel-policy") {
    if (req.method === "GET") {
      try { return send(res, 200, { kernel: loadKernelPolicy() }); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (req.method === "POST") {
        return readBody(req, res, (block) => {
        try { return send(res, 200, { ok: true, kernel: saveKernelPolicy(block) }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      });
    }
  }
  if (route === "/api/guards/status" && req.method === "GET") {
    // Composed from two binaries (guard-config + runbox/vault) into the same
    // combined shape the browser has always received — an internal routing
    // detail, not an API contract change.
    return Promise.all([guardsJson(["status"]), engineJson(["status"])])
      .then(([g, e]) => send(res, 200, { ...g, ...e }))
      .catch((e) => send(res, 500, { error: e.message }));
  }
  if (route === "/api/guards/list" && req.method === "GET") {
    return Promise.all([engineJson(["list", "--json"]), engineJson(["trash-list", "--json"])])
      .then(([pending, trashed]) => send(res, 200, { pending, trashed }))
      .catch((e) => send(res, 500, { error: e.message }));
  }
  if (route === "/api/guards/engine" && req.method === "POST") {
    return readBody(req, res, async (b) => {
      // Object.hasOwn, not bare property access: a prototype-key verb
      // ("__proto__", "toString") would otherwise resolve to an Object
      // prototype member — non-callable ones threw here and HUNG the
      // request (found by this route's own suite, 2026-08-07).
      const verb = typeof b.verb === "string" ? b.verb : null;
      const table = verb && Object.hasOwn(GUARDS_VERBS, verb) ? GUARDS_VERBS
        : verb && Object.hasOwn(ENGINE_VERBS, verb) ? ENGINE_VERBS
        : null;
      const args = table && table[verb](b);
      if (!args) return send(res, 400, { error: `verb "${b.verb}" is not allowed here or its arg is invalid` });
      const r = await (table === GUARDS_VERBS ? guardsExec([verb, ...args]) : engineExec([verb, ...args]));
      // A non-zero exit is a RESULT, not a transport error: 200 with the
      // code and output tail, so the page can show exactly what failed.
      send(res, 200, { code: r.code, out: (r.stdout + r.stderr).slice(-4000) });
    });
  }
  if (route === "/api/guards/vault-import" && req.method === "POST") {
    return readBody(req, res, async (b) => {
      const pairs = Array.isArray(b.pairs) ? b.pairs : null;
      if (!pairs || !pairs.length) return send(res, 400, { error: "pairs must be a non-empty array" });
      // Validate EVERY pair before invoking the engine: one bad entry rejects
      // the whole import, so a partial write can never happen.
      for (const p of pairs) {
        if (!p || !validVaultKey(p.key)) return send(res, 400, { error: `invalid vault key: ${JSON.stringify(p && p.key)}` });
        if (!validVaultValue(p.value)) return send(res, 400, { error: `invalid value for ${p.key} (must be single-line text)` });
      }
      const stdin = pairs.map((p) => `${p.key}=${p.value}\n`).join("");
      const r = await engineExec(["vault-import"], stdin);
      // Always 200 — a non-zero engine exit is a RESULT the page shows, not a
      // transport error. Names only on success (derived from the validated
      // request keys); on failure the engine's own output, which by contract
      // names keys, never values.
      send(res, 200, r.code === 0
        ? { stored: pairs.map((p) => p.key) }
        : { code: r.code, out: (r.stdout + r.stderr).slice(-2000) });
    });
  }
  if (route === "/api/guards/vault-rm" && req.method === "POST") {
    return readBody(req, res, async (b) => {
      if (!validVaultKey(b.key)) return send(res, 400, { error: `invalid vault key: ${JSON.stringify(b.key)}` });
      const r = await engineExec(["vault-rm", b.key]);
      send(res, 200, { code: r.code, out: (r.stdout + r.stderr).slice(-2000) });
    });
  }
  if (route === "/api/guards/preview" && req.method === "POST") {
    return readBody(req, res, async (b) => {
      // AC-006: the ref resolves ONLY through the engine's own list — a
      // browser string never becomes a filesystem path by itself.
      let items;
      try { items = await engineJson(["list", "--json"]); }
      catch (e) { return send(res, 500, { error: e.message }); }
      const item = (items || []).find((i) => `${i.label}:${i.name}` === b.ref || i.name === b.ref);
      if (!item) return send(res, 404, { error: "no pending script matches that ref" });
      try {
        return send(res, 200, { content: fs.readFileSync(path.join(item.dir, item.name), "utf8").slice(0, BODY_CAP) });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    });
  }
  if (route === "/api/process/status" && req.method === "GET") {
    return (async () => {
      const check = await nodeExec(usagePath(), ["check"]);
      const week = await nodeExec(usagePath(), ["week"]);
      let tier = null;
      try { tier = JSON.parse(check.stdout.trim()); } catch {}
      const p = tryReadPolicy(res);
      if (!p) return;
      const dials = {
        softK: p.context?.softK, hardK: p.context?.hardK,
        amberTokens: p.week?.amberTokens, redTokens: p.week?.redTokens,
        maxFinders: p.review?.maxFinders, allow: p.subagents?.allow ?? [],
      };
      const profiles = profileNames(p);
      send(res, 200, {
        tier, weekText: (week.stdout + week.stderr).trim(), dials, profiles, directiveBudget: p.directives?.budget || {},
        stopped: fs.existsSync(sliceStopFile()),
      });
    })();
  }
  if (route === "/api/process/dials" && req.method === "POST") {
    return readBody(req, res, (b) => {
      const policy = tryReadPolicy(res);
      if (!policy) return;
      let merged;
      try { merged = mergeDials(policy, b); }
      catch (e) { return send(res, 400, { error: e.message }); } // bad dial -> file untouched
      // Atomic write (tmp + rename), matching kernel/policy.mjs: a crash
      // mid-write can't truncate policy.json, the file the whole system reads.
      const tmp = policyFile() + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
      fs.renameSync(tmp, policyFile());
      send(res, 200, { ok: true });
    });
  }
  if (route === "/api/route/suggest" && req.method === "POST") {
    return readBody(req, res, async (b) => {
      // Whitespace collapses to single spaces before the length check: the
      // text becomes one argv token, so newlines/tabs must never reach it.
      const text = typeof b.text === "string" ? b.text.replace(/\s+/g, " ").trim() : "";
      if (!text || text.length > 2000) return send(res, 400, { error: "text must be 1..2000 characters" });
      try { return send(res, 200, await execJson(routeScript(), ["--text", text], "router")); }
      catch (e) { return send(res, 500, { error: e.message }); }
    });
  }
  if (route === "/api/directives" && req.method === "GET") {
    return (async () => {
      let list;
      try { list = await execJson(directiveScript(), ["list"], "directive list"); }
      catch (e) { return send(res, 500, { error: e.message }); }
      send(res, 200, list.map((d) => ({ ...d, running: runnerLive(d.id) })));
    })();
  }
  if (route === "/api/directives" && req.method === "POST") {
    return readBody(req, res, async (b) => {
      const text = typeof b.text === "string" ? b.text : "";
      if (!text.trim() || text.length > 32768) return send(res, 400, { error: "text must be 1..32768 characters" });
      const doneWhen = b.doneWhen === undefined ? undefined : String(b.doneWhen).trim();
      if (b.doneWhen !== undefined) {
        if (typeof b.doneWhen !== "string") return send(res, 400, { error: "doneWhen must be a string" });
        if (/[\r\n]/.test(b.doneWhen) || !doneWhen || doneWhen.length > DONE_WHEN_MAX) {
          return send(res, 400, { error: `doneWhen must be a single line of 1..${DONE_WHEN_MAX} characters` });
        }
      }
      // The runner refuses a cwd-less directive at launch (loadDirectiveJob),
      // so a create with no real folder would only ever produce a dud entry —
      // demand it here, where the human can still fix it.
      if (typeof b.cwd !== "string" || !path.isAbsolute(b.cwd) || !fs.existsSync(b.cwd)) {
        return send(res, 400, { error: "cwd must be an absolute path that exists (a headless run needs one)" });
      }
      const policy = tryReadPolicy(res);
      if (!policy) return;
      const profiles = profileNames(policy);
      const profile = b.profile === undefined || b.profile === "" ? "" : b.profile;
      if (profile !== "" && !profiles.includes(profile)) return send(res, 400, { error: `unknown profile ${JSON.stringify(b.profile)}` });
      let tags;
      try { tags = validateUserDirectiveTags(b.tags); }
      catch (e) { return send(res, 400, { error: e.message }); }
      let budget;
      try { budget = readDirectiveBudget(b); } catch (e) { return send(res, 400, { error: e.message }); }
      // Route-tag insertion is derived from the router's own verdict only.
      let routeTag = "";
      try {
        const routeText = text.replace(/\s+/g, " ").trim().slice(0, 2000);
        if (routeText) routeTag = normalizeRouteTag((await execJson(routeScript(), ["--text", routeText], "router")).label);
      } catch {}
      // The text travels via a temp file (--text-file), the same proven path
      // the WinForms GUI used: newlines and quotes never touch argv.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-directive-"));
      try {
        const tmp = path.join(tmpDir, "text.md");
        fs.writeFileSync(tmp, text);
        const args = ["new", "--text-file", tmp, "--cwd", b.cwd];
        if (doneWhen !== undefined) args.push("--done-when", doneWhen);
        if (profile) args.push("--profile", profile);
        for (const tag of tags) args.push("--tag", tag);
        if (routeTag) args.push("--route-tag", routeTag);
        for (const [flag, value] of [["--wall-clock-min", budget.wallClockMin], ["--turns", budget.turns], ["--tokens", budget.tokens], ["--dollars", budget.dollars]]) {
          if (value !== undefined) args.push(flag, String(value));
        }
        const r = await nodeExec(directiveScript(), args);
        let d;
        try { d = JSON.parse(r.stdout); } catch {}
        if (!d || !d.id) return send(res, 500, { error: (r.stdout + r.stderr).slice(-500) || `directive new exited ${r.code}` });
        send(res, 200, d);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }
  if (route === "/api/directives/status" && req.method === "POST") {
    return readBody(req, res, async (b) => {
      if (!validDirectiveId(b.id)) return send(res, 400, { error: "invalid directive id" });
      // done and paused are the two human verdicts this page offers; blocked/
      // dead belong to the model and the runner respectively.
      if (b.status !== "done" && b.status !== "paused") return send(res, 400, { error: `status must be "done" or "paused"` });
      const why = b.why === undefined ? "" : b.why;
      if (typeof why !== "string" || /[\r\n]/.test(why) || why.length > 500) {
        return send(res, 400, { error: "why must be a single line of at most 500 characters" });
      }
      const args = [b.status, b.id];
      if (why) args.push("--why", why);
      const r = await nodeExec(directiveScript(), args);
      send(res, 200, { code: r.code, out: (r.stdout + r.stderr).slice(-2000) });
    });
  }
  if (route === "/api/directives/note" && req.method === "POST") {
    return readBody(req, res, async (b) => {
      if (!validDirectiveId(b.id)) return send(res, 400, { error: "invalid directive id" });
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (!text || text.length > 4000) return send(res, 400, { error: "text must be 1..4000 characters" });
      // Steer a running directive without restarting it: appended to the
      // directive's log, so the next SessionStart's logTail() carries it into
      // the next cycle. Same --text-file path /api/directives (create) uses —
      // newlines/quotes never touch argv.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-note-"));
      try {
        const tmp = path.join(tmpDir, "note.md");
        fs.writeFileSync(tmp, text);
        const r = await nodeExec(directiveScript(), ["log", b.id, "--text-file", tmp]);
        send(res, 200, { code: r.code, out: (r.stdout + r.stderr).slice(-500) });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }
  if (route === "/api/directives/log" && req.method === "GET") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id") || "";
    if (!validDirectiveId(id)) return send(res, 400, { error: "invalid directive id" });
    // Live log first, then the archive setStatus moved it to.
    for (const f of [path.join(directivesDir(), `${id}.log.md`), path.join(directivesDir(), "done", `${id}.log.md`)]) {
      try {
        return send(res, 200, fs.readFileSync(f, "utf8").slice(-LOG_TAIL_CAP), "text/plain; charset=utf-8");
      } catch {}
    }
    return send(res, 404, { error: "no log for that directive" });
  }
  if (route === "/api/lane/status" && req.method === "GET") {
    return (async () => {
      try { return send(res, 200, await execJson(laneScript(), ["status"], "lane status")); }
      catch (e) { return send(res, 500, { error: e.message }); }
    })();
  }
  if (route === "/api/launch" && req.method === "POST") {
    return readBody(req, res, (b) => {
      if (!validDirectiveId(b.id)) return send(res, 400, { error: "invalid directive id" });
      // UX pre-check only — the runner's own pid-file singleton (exit 6) owns
      // the no-two-loops invariant; this 409 just tells the page why.
      if (runnerLive(b.id)) return send(res, 409, { error: "a runner loop already holds this directive" });
      const child = spawn(process.execPath, [runnerScript(), `directive:${b.id}`], {
        detached: true, stdio: "ignore", cwd: repoRoot(),
      });
      child.unref();
      send(res, 200, { ok: true, pid: child.pid });
    });
  }
  if (route === "/api/process/control" && req.method === "POST") {
    return readBody(req, res, async (b) => {
      const thunk = typeof b.action === "string" ? controlAction(b.action) : null;
      if (!thunk) return send(res, 400, { error: `action "${b.action}" is not allowed here` });
      const r = await thunk(); // a plain object (file ops) or a nodeExec result
      send(res, 200, r.code !== undefined ? { code: r.code, out: (r.stdout + r.stderr).slice(-2000) } : r);
    });
  }
  send(res, 404, { error: "not found" });
}

export function startServer({ port = 0 } = {}) {
  const allowedOrigin = parseAllowedOrigin(); // validate and pin once; env changes cannot widen a live server
  const token = loadOrCreateToken(); // once, before the socket can accept a single request
  const server = http.createServer((req, res) => handler(req, res, token, allowedOrigin));
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, token, allowedOrigin }));
  });
}

// One-line trigger (kept testable in-process, same shape as hooks/covgate.mjs's
// own bottom line): a real CLI invocation spawns a long-running listener that
// only exits by being force-killed, which on Windows never flushes V8
// coverage — so cli() is exported and unit-tested directly instead.
export async function cli(argv = process.argv) {
  const i = argv.indexOf("--port");
  const d = argv.indexOf("--ui-dist");
  if (d !== -1 && argv[d + 1]) process.env.ACC_UI_DIST = argv[d + 1];
  const s = await startServer({ port: i === -1 ? 0 : Number(argv[i + 1]) });
  console.log(`LISTENING ${s.port}`); // consumers (Playwright, scripts) parse this line
  // One-time bootstrap (ACC-5): the browser reads this URL fragment once to
  // seed sessionStorage, then strips it (see ui/src/api.ts) — fragments never
  // reach this server, or any server, which is the whole point. The token
  // value is never printed or logged anywhere else.
  console.log(`http://127.0.0.1:${s.port}/#acc-token=${s.token}`);
  if (s.allowedOrigin) {
    const shell = new URL("/acc", s.allowedOrigin);
    shell.hash = `acc-token=${s.token}`;
    console.log(shell.toString());
  }
  return s;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
