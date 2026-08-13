#!/usr/bin/env node
// gui/server.mjs — rails of the web GUI (spec 2026-08-03-acc-oi-closure-design
// §5-§6): the kernel-settings tab is the first migrated tab; later tabs mount
// alongside. Loopback-only, ZERO business logic — reads and writes go through
// kernel/policy.mjs, the same single owner the WinForms tab used.
//
// Ethos answer (OI-022's recorded tension): binds 127.0.0.1 only. The
// web-borne risk — CSRF against a localhost mutator — is closed by
// construction: mutating routes demand the custom X-ACC header (unsettable
// cross-origin without a CORS grant this server never issues), Origin/Host
// must be local, and no CORS header ever leaves. That left one gap SEC-04
// named explicitly: X-ACC is CSRF hygiene, not auth, so any OTHER local
// process could already drive this API just by knowing the port. ACC-5
// closes that additively for a DIFFERENT OS USER — every /api/* request now
// also demands the X-ACC-Token session credential (see the "session
// credential" block below for the precise boundary this delivers, and why
// it stops there) — without moving or weakening anything above.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { loadKernelPolicy, saveKernelPolicy } from "../kernel/policy.mjs";
import { DONE_WHEN_MAX, normalizeRouteTag, validateUserDirectiveTags } from "../hooks/directive.mjs";

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

// EPERM = the pid exists but belongs to another user: alive for our purposes
// (same reading as the runner's own singleton check).
const pidAlive = (pid) => {
  const n = Number(pid || 0);
  if (!n) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
};
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
const guardsCliPath = () => process.env.ACC_GUARDS_CLI || path.join(HERE, "..", "..", "toolbelt", "guards", "cli.mjs");
const guardsConfigPath = () => process.env.ACC_GUARDS_CONFIG || path.join(HERE, "..", "..", "toolbelt", "guards", "config.json");
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
export function mergeDials(policy, d) {
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

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

// --- session credential (ACC-5 / SEC-04 closure, issue m2-09) --------------
// The loopback bind + Host/Origin + X-ACC checks above are CSRF hygiene
// (SEC-04): they stop a web page from driving this API, but any OTHER local
// process on the machine could already speak to the port with no privilege
// check at all. X-ACC-Token is the auth boundary that closes that FOR A
// DIFFERENT OS USER — additive to every check above; none of them move or
// weaken. A shared secret, not platform-JWT verification: ACC makes zero
// network calls today and must keep working fully offline on a
// single-operator machine, so JWKS fetching (or any other network
// dependency) is the wrong shape for a loopback socket like this one.
//
// Honest threat model (read this before assuming more than 0600 delivers):
// POSIX file permissions are per-UID, not per-process. Mode 0600 keeps a
// DIFFERENT OS ACCOUNT from reading the token file; it does NOT keep out
// another process running as the SAME OS account (a stray npm postinstall
// script, another local dev tool, a compromised editor extension) — that
// process can read the file exactly as freely as this server does, and then
// present the token like any legitimate caller. This is the boundary
// `docs/planning/05-b-acc.md` §4 actually specifies (ACC-5c: "created with
// owner-only permissions") and it is a deliberate scope, not an oversight:
// that same section's mechanism-choice table weighs and rejects OS-level
// socket permissions (unix socket / named pipe — the mechanism that WOULD
// additionally isolate same-user processes from each other) as
// "platform-divergent..., larger change than the threat warrants" for what
// ACC is: a local single-operator dev tool, not a multi-tenant service.
// Earlier drafts of the comments in this file described the closed gap as
// "same-user local process" — that phrasing overclaimed what 0600 delivers
// and has been corrected here and at the top of this file.
//
// Token file: one line, 32 random bytes base64url, mode 0600, created on
// first use if absent. ACC_GUI_TOKEN_FILE redirects the path (same seam
// style as ACC_ROOT/ACC_POLICY above); the default is "<ACC_ROOT>/gui-token".
// Rotation has no dedicated mechanism: delete the file and restart, and a
// fresh one is minted (gui/README.md documents this for the operator).
//
// An EXISTING file is trusted only if its permission bits are still exactly
// 0600 (loadOrCreateToken(), below) — otherwise it is treated the same as
// absent and a fresh one is minted and rewritten with the right mode. Without
// this check, a same-user process could pre-create a world- or group-
// readable "gui-token" file before the server's first start and have its
// (attacker-known) content silently trusted as the live credential — the
// exact same-UID-but-different-process actor the paragraph above already
// says this design does not try to keep out, so trusting an unverified file
// would give that actor MORE than the documented boundary promises, for
// free. The permission check is skipped on win32: Node's fs mode bits there
// don't carry POSIX owner/group/other semantics (see the platform guard on
// the mode assertion in gui/server.test.mjs), so there is nothing meaningful
// to check or enforce, and 0600 mode requests are Windows no-ops regardless.
//
// Finding #66 (P2, independent security review): the paragraph above only
// ever checked permissions with `fs.statSync`, which FOLLOWS a symlink, and
// the mint-fresh path wrote with the default `"w"` flag (no exclusivity
// guard). Two gaps, both closed together below:
//   - Symlink-following, both directions. A same-user process could plant a
//     symlink at the token path — pointing at an attacker-controlled file
//     (this code would then silently TRUST that file's content as the live
//     credential) or at a path this process has no business writing
//     (mint-fresh would then silently WRITE a fresh random token THROUGH the
//     symlink to that target, clobbering it). `fs.lstatSync` — which reports
//     the symlink itself, never its target — replaces `fs.statSync` for the
//     trust check, and every mint-fresh write below uses the exclusive-
//     create flag described next, which POSIX open(2) never opens or
//     creates through an existing symlink at the final path component
//     (verified: EEXIST on both a dangling symlink and one pointing at a
//     real file, never a silent write-through). Symlink rejection applies on
//     EVERY platform, unlike the 0600 mode comparison: `isSymbolicLink()` is
//     meaningful even where POSIX mode bits are not.
//   - No atomicity guard on the mint-fresh write. Two servers racing to
//     mint a token on first start could each independently observe "absent,
//     mint fresh" and each `writeFileSync` their own random value with the
//     default flag — whichever write lands last silently wins, so the two
//     processes could end up disagreeing about which token is "real" with
//     no signal that it happened. `{ flag: "wx" }` (`O_WRONLY|O_CREAT|
//     O_EXCL`) makes the create atomic and exclusive: it fails with EEXIST
//     if literally anything already occupies the path (another process's
//     just-written file, or a pre-planted symlink) rather than overwriting
//     it. loadOrCreateToken() below turns that EEXIST into "retry from the
//     top" — the loser reads back whatever the winner (or, for a cleared
//     symlink, this same process's own next attempt) actually left there,
//     so every racing caller converges on one agreed-upon value instead of
//     each silently believing its own.
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
const tokenFile = () => process.env.ACC_GUI_TOKEN_FILE || path.join(repoRoot(), "gui-token");
// Takes an already-`lstat`'d Stats object rather than a path: every caller
// below needs that same Stats object anyway (first to decide whether
// anything occupies the path at all, then whether it's trustworthy), so
// this avoids a second stat syscall per attempt. A symlink is NEVER owner-
// only, on any platform — see the Finding #66 comment above for why lstat,
// not stat, is what makes that true instead of transparently following the
// link. The 0600 mode comparison remains win32-exempt exactly as before
// this fix (meaningless bits there — every non-symlink file is trusted).
const ownerOnly = (st) => !st.isSymbolicLink() && (process.platform === "win32" || (st.mode & 0o777) === 0o600);

function loadOrCreateToken() {
  const file = tokenFile();
  // Bounded retry, not a single attempt: the loser of a real race (see the
  // Finding #66 comment above) must loop back and READ the winner's file
  // rather than either overwriting it or giving up. 5 is generous headroom
  // over the two-process case this repo actually exercises end-to-end (the
  // concurrency test in server.test.mjs) — it exists only so a pathological
  // run of losses fails loudly instead of spinning forever.
  for (let attempt = 0; attempt < 5; attempt++) {
    let existing = null;
    try { existing = fs.lstatSync(file); } catch {} // ENOENT (or similar) -> nothing occupies this path yet

    if (existing && ownerOnly(existing)) {
      try {
        const line = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0].trim();
        if (line) return line;
      } catch {} // unreadable despite passing lstat (e.g. removed mid-check) -> fall through to mint
    }
    // Nothing trustworthy at this path: absent, a symlink, wrong
    // permissions, unreadable, or present-but-empty (a crash mid-create can
    // leave a valid-mode, zero-content file). Whatever IS there — including
    // a symlink — must be cleared before the exclusive create below can
    // claim the path outright. Best-effort: another process may be doing
    // the exact same cleanup concurrently, and a lost unlink race here just
    // falls through to the create attempt, which then settles things via
    // EEXIST like every other race this loop handles.
    if (existing) { try { fs.unlinkSync(file); } catch {} }

    const fresh = randomBytes(32).toString("base64url");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      // "wx" = O_WRONLY|O_CREAT|O_EXCL: fails EEXIST if anything already
      // occupies this path — a regular file (another process just won this
      // same race) or a symlink (pre-planted, dangling or pointing at a
      // real file; open(2) with O_EXCL never opens or creates through an
      // existing symlink at the final path component). That is what
      // actually closes both Finding #66 gaps: no two racing processes can
      // each believe their own mint "won" (only one write can ever land
      // here), and a pre-planted symlink can never be written through,
      // unlike the old default `"w"` flag, which followed it in both
      // directions.
      fs.writeFileSync(file, fresh + "\n", { flag: "wx", mode: 0o600 });
      // Belt-and-braces: "wx" guarantees this call always creates the file
      // fresh, so the `mode` option above IS honored (unlike the old
      // existing-file case) — but open(2) still ANDs the requested mode
      // against the process umask, so an unusually restrictive umask could
      // leave the file weaker than 0600 despite the option. The explicit
      // chmod re-asserts owner-only regardless of umask.
      if (process.platform !== "win32") fs.chmodSync(file, 0o600);
      return fresh;
    } catch (e) {
      if (e && e.code === "EEXIST") continue; // lost the race -- loop back and read whoever won
      throw e;
    }
  }
  throw new Error(`gui-token: could not establish a trustworthy token file at ${file} after 5 attempts`);
}

// Constant-time compare that never branches on length first: both sides are
// hashed to a fixed 32-byte SHA-256 digest before crypto.timingSafeEqual, so
// it always compares equal-length buffers — a length mismatch (the common
// shape of a guess) can neither throw nor short-circuit the comparison
// before it starts.
function tokenMatches(presented, token) {
  const want = createHash("sha256").update(token).digest();
  const got = createHash("sha256").update(typeof presented === "string" ? presented : "").digest();
  return timingSafeEqual(want, got);
}

// `token` defaults to a freshly loaded/created one so `handler(req, res)` —
// called directly with no server behind it at all, e.g. a test exercising a
// single defensive check — still works. startServer() below instead pins ONE
// token per server instance and passes it explicitly (a closure, not this
// default), so independent server instances in the same process can never
// cross-contaminate each other's credential.
export function handler(req, res, token = loadOrCreateToken()) {
  if (!localHost(req.headers.host)) return send(res, 403, { error: "non-local Host" });
  if (!localOrigin(req.headers.origin)) return send(res, 403, { error: "non-local Origin" });
  // Every mutating route demands the custom header (unsettable cross-origin
  // without a CORS grant this server never issues) — enforced ONCE here so a
  // future route cannot forget it. Non-POST methods carry no mutation.
  if (req.method === "POST" && req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
  const route = req.url.split("?")[0];
  // Every /api/* request needs the session credential, GET and POST alike
  // (ACC-5) — checked before any route match so an unauthenticated caller
  // gets the identical 401 whether the path exists or not: no route-
  // existence oracle. Non-API GETs (the --ui-dist static path, already open
  // by design) are unaffected: the browser has to load that page at all
  // before it can ever hold a token to send.
  if (route.startsWith("/api/") && !tokenMatches(req.headers["x-acc-token"], token)) {
    return send(res, 401, { error: "unauthorized" });
  }
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
  const token = loadOrCreateToken(); // once, before the socket can accept a single request
  const server = http.createServer((req, res) => handler(req, res, token));
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, token }));
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
  return s;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
