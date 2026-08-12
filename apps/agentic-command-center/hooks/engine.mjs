// CLI engine for the vault and the runbox. The web GUI (gui/server.mjs)
// shells to this for every vault/runbox mutation; agents use `vault-keys`
// and `apply` to consume user-uploaded secrets without the values ever
// entering a conversation, and `list` / `run` / `trash` to work the runbox
// (see AGENTS.md). Values travel stdin -> vault.json -> target file, never
// argv and never stdout.
//
// Guard-config mutations (enable/disable, secret globs, protected paths)
// live in apps/toolbelt/guards/cli.mjs, a standalone module this file does
// not import — gui/server.mjs shells both and composes their output where
// the browser-facing API still expects one combined shape (e.g. status).
//
// Runbox lifecycle: scripts live in a runbox (central runbox/ here, or
// <project>/.guards/runbox for each folder in config "projects"). A script
// that runs successfully is auto-archived into that runbox's .trash unless
// its first lines contain "guards: keep". Trash is undo-able (restore);
// only `flush --really` (the GUI's confirmed Empty-trash button) or a manual
// file delete removes anything for good. Runboxes are never tracked in git.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRoot, isMainModule } from "./root.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ACC_ROOT redirects vault.json and the central runbox at a throwaway tree,
// same convention as every other hook (see root.mjs) -- it exists so tests
// can exercise THIS file instead of a copy, never the live vault/runbox a
// real Claude Code session depends on. Resolved per call, not cached, so one
// test's ACC_ROOT can never leak into the next.
const ROOT = () => resolveRoot(HERE);
// GUARDS_CONFIG points this file at the SAME config.json guard.mjs/cli.mjs
// read (apps/toolbelt/guards/config.json in production; gui/server.mjs sets
// this env var when it shells this file, since it's the one place already
// composing both modules). Falls back to ACC's own root for backward
// compatibility with every existing sandboxed test, none of which set
// GUARDS_CONFIG, and for standalone CLI use with a config placed there by
// hand. This file only ever reads "runboxDir" and "projects" from it.
const CONFIG = () => process.env.GUARDS_CONFIG || path.join(ROOT(), "config.json");
const VAULT = () => path.join(ROOT(), "vault.json");

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, j) => writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
const vault = () => readJson(VAULT(), {});

// Thrown by fail() to unwind out of whatever command handler raised it. Never
// escapes main() uncaught -- it is always the CLI's own "print this and exit
// 1" signal, not a bug. Kept distinct from a plain Error so main()'s catch
// can tell an expected CLI failure from a real defect and let the latter
// propagate instead of being swallowed as exit 1.
class CliFail extends Error {}
const fail = (m) => { throw new CliFail(m); };
const config = () => readJson(CONFIG(), null) ?? fail(`no config.json at ${CONFIG()}`);
const norm = (p) => path.resolve(p).replaceAll("\\", "/");

async function stdinText() {
  let b = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) b += c;
  return b;
}

// ---------- runbox helpers ----------
const RUNNABLE = /\.(ps1|cmd|bat|mjs|js)$/i;
const STAMP_RE = /^\d{8}-\d{6}_/;

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Every place scripts can live: the central runbox plus one .guards/runbox
// per configured project folder. label is what users type (`run label:name`).
function runboxes(c) {
  const boxes = [{
    label: "central",
    dir: norm(c.runboxDir ?? path.join(ROOT(), "runbox")),
    cwd: ROOT(),
  }];
  for (const p of c.projects ?? []) {
    boxes.push({ label: path.basename(norm(p)), dir: norm(path.join(p, ".guards", "runbox")), cwd: norm(p) });
  }
  return boxes;
}

function filesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => {
    try { return statSync(path.join(dir, f)).isFile(); } catch { return false; }
  });
}

function firstComment(file) {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/).slice(0, 10)) {
      const t = line.trim();
      if (/^(#|\/\/)/.test(t)) {
        const text = t.replace(/^(#|\/\/)\s*/, "");
        if (/^guards:\s*keep/i.test(text)) continue; // marker line, not a description
        if (text) return text.slice(0, 160);
      } else if (t) break; // first real code line: no leading comment
    }
  } catch { /* unreadable: no summary */ }
  return "";
}

function hasKeepMarker(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).slice(0, 10).some((l) => /^\s*(#|\/\/)\s*guards:\s*keep/i.test(l));
  } catch { return false; }
}

function pendingScripts(c) {
  const out = [];
  for (const box of runboxes(c)) {
    for (const name of filesIn(box.dir)) {
      if (!RUNNABLE.test(name)) continue;
      const full = path.join(box.dir, name);
      out.push({
        label: box.label, name, dir: box.dir, cwd: box.cwd,
        keep: hasKeepMarker(full),
        summary: firstComment(full),
        mtime: statSync(full).mtime.toISOString(),
      });
    }
  }
  return out;
}

function trashedScripts(c) {
  const out = [];
  for (const box of runboxes(c)) {
    const trash = path.join(box.dir, ".trash");
    for (const name of filesIn(trash)) {
      out.push({
        label: box.label, name, dir: trash, runboxDir: box.dir,
        summary: firstComment(path.join(trash, name)),
        mtime: statSync(path.join(trash, name)).mtime.toISOString(),
      });
    }
  }
  return out;
}

// Hidden attribute keeps trash invisible in Explorer; the GUI's "Show deleted"
// toggle is how it becomes visible again. Best-effort — dot-folder either way.
function ensureTrash(runboxDir) {
  const trash = path.join(runboxDir, ".trash");
  if (!existsSync(trash)) {
    mkdirSync(trash, { recursive: true });
    spawnSync("attrib", ["+h", trash], { shell: false });
  }
  return trash;
}

function moveToTrash(item) {
  const trash = ensureTrash(item.dir);
  const dest = path.join(trash, `${stamp()}_${item.name}`);
  renameSync(path.join(item.dir, item.name), dest);
  return dest;
}

// ref forms: "name", "label:name", or an absolute path inside a runbox.
function resolveRef(items, ref, what) {
  let matches;
  if (path.isAbsolute(ref)) {
    matches = items.filter((i) => norm(path.join(i.dir, i.name)) === norm(ref));
  } else if (ref.includes(":")) {
    const [label, name] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
    matches = items.filter((i) => i.label === label && i.name === name);
  } else {
    matches = items.filter((i) => i.name === ref);
  }
  if (matches.length === 0) {
    fail(`no ${what} named "${ref}". Available:\n${items.map((i) => `  ${i.label}:${i.name}`).join("\n") || "  (none)"}`);
  }
  if (matches.length > 1) {
    fail(`"${ref}" is ambiguous — say which one:\n${matches.map((i) => `  ${i.label}:${i.name}`).join("\n")}`);
  }
  return matches[0];
}

// Exported so tests can exercise every extension's runner shape directly —
// actually spawning powershell/cmd is Windows-only and this repo's fast tier
// runs on Linux CI too (see the top-level package.json comment).
export const RUNNERS = {
  ".ps1": (f) => ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f]],
  ".cmd": (f) => ["cmd", ["/c", f]],
  ".bat": (f) => ["cmd", ["/c", f]],
  ".mjs": (f) => ["node", [f]],
  ".js": (f) => ["node", [f]],
};

const PROCESS_IO = {
  out: process.stdout.write.bind(process.stdout),
  err: process.stderr.write.bind(process.stderr),
};
const say = (io, m) => io.out(m + "\n");
const warn = (io, m) => io.err(m + "\n");

// The dispatch table, one handler per command. Each returns the process exit
// code (0 unless noted); `fail()` inside a handler unwinds to main()'s catch
// instead. Exported as `main()` (mirrors hooks/budget.mjs's `main({argv, io})`
// convention) so tests can call every command in-process -- with an injected
// io and an ACC_ROOT-sandboxed config/vault/runbox tree -- and covgate can see
// every line actually execute, instead of only what a subprocess wrapper test
// can prove.
export async function main({ argv = process.argv.slice(2), io = PROCESS_IO } = {}) {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "status": {
        const c = config();
        say(io, JSON.stringify({
          projects: c.projects ?? [],
          vaultKeys: Object.keys(vault()),
          pending: pendingScripts(c).length,
          trashed: trashedScripts(c).length,
        }));
        return 0;
      }
      case "projects-add": {
        const p = args[0] ? norm(args[0]) : fail("usage: projects-add <folder>");
        if (!existsSync(p) || !statSync(p).isDirectory()) fail(`not a folder: ${p}`);
        const c = config();
        const list = c.projects ?? [];
        if (!list.some((x) => norm(x).toLowerCase() === p.toLowerCase())) list.push(p);
        c.projects = list;
        const runbox = path.join(p, ".guards", "runbox");
        mkdirSync(runbox, { recursive: true });
        ensureTrash(runbox);
        // Self-ignoring: .guards never shows up in the project's git, no matter
        // what the project's own .gitignore says.
        writeFileSync(path.join(p, ".guards", ".gitignore"), "*\n");
        writeJson(CONFIG(), c);
        say(io, `watching: ${c.projects.join(", ")}`);
        return 0;
      }
      case "projects-rm": {
        const p = args[0] ? norm(args[0]) : fail("usage: projects-rm <folder>");
        const c = config();
        c.projects = (c.projects ?? []).filter((x) => norm(x).toLowerCase() !== p.toLowerCase());
        writeJson(CONFIG(), c);
        say(io, `watching: ${c.projects.join(", ") || "(only the central runbox)"}`);
        say(io, `note: ${p}\\.guards was left on disk — delete it by hand if you want it gone`);
        return 0;
      }
      case "list": {
        const items = pendingScripts(config());
        if (args[0] === "--json") { say(io, JSON.stringify(items)); return 0; }
        if (!items.length) { say(io, "runbox is empty — no pending scripts."); return 0; }
        for (const i of items) {
          say(io, `${i.label}:${i.name}${i.keep ? "  [keep]" : ""}\n    ${i.summary || "(no description)"}`);
        }
        return 0;
      }
      case "trash-list": {
        const items = trashedScripts(config());
        if (args[0] === "--json") { say(io, JSON.stringify(items)); return 0; }
        if (!items.length) { say(io, "trash is empty."); return 0; }
        for (const i of items) say(io, `${i.label}:${i.name}`);
        return 0;
      }
      case "run": {
        const ref = args[0] ?? fail("usage: run <name | label:name | full path>");
        const item = resolveRef(pendingScripts(config()), ref, "pending script");
        const full = path.join(item.dir, item.name);
        const runner = RUNNERS[path.extname(item.name).toLowerCase()];
        if (!runner) fail(`cannot run ${item.name} — supported: .ps1 .cmd .bat .mjs .js`);
        const [exe, exeArgs] = runner(full);
        say(io, `[guards] running ${item.label}:${item.name} ...`);
        const r = spawnSync(exe, exeArgs, { stdio: "inherit", cwd: item.cwd });
        const code = r.status ?? 1;
        if (code === 0 && !item.keep) {
          if (existsSync(full)) {
            moveToTrash(item);
            say(io, `\n[guards] done — archived to the runbox trash (undo: restore ${item.name})`);
          } else {
            say(io, `\n[guards] done — script cleaned itself up`); // e.g. an installer that self-archives
          }
        } else if (code === 0) {
          say(io, `\n[guards] done — kept in the runbox (standing script)`);
        } else {
          warn(io, `\n[guards] FAILED (exit ${code}) — script left in the runbox`);
        }
        return code;
      }
      case "trash": {
        const ref = args[0] ?? fail("usage: trash <name | label:name>");
        const item = resolveRef(pendingScripts(config()), ref, "pending script");
        moveToTrash(item);
        say(io, `trashed ${item.label}:${item.name} — undo with: restore ${item.name}`);
        return 0;
      }
      case "restore": {
        const ref = args[0] ?? fail("usage: restore <name | label:name>  (name as shown in trash-list, stamp optional)");
        const items = trashedScripts(config());
        // Accept both the stamped trash name and the original name.
        const bare = (n) => n.replace(STAMP_RE, "");
        let matches = items.filter((i) => i.name === ref || `${i.label}:${i.name}` === ref);
        if (!matches.length) {
          matches = items.filter((i) => bare(i.name) === ref || `${i.label}:${bare(i.name)}` === ref);
        }
        if (!matches.length) fail(`nothing in trash matches "${ref}". trash-list shows what's there.`);
        // Same script trashed repeatedly: restore the newest copy.
        matches.sort((a, b) => b.name.localeCompare(a.name));
        const item = matches[0];
        const dest = path.join(item.runboxDir, bare(item.name));
        if (existsSync(dest)) fail(`cannot restore: ${dest} already exists in the runbox`);
        renameSync(path.join(item.dir, item.name), dest);
        say(io, `restored ${item.label}:${bare(item.name)}`);
        return 0;
      }
      case "flush": {
        // Permanent. Only the GUI's confirmed button (or a human typing --really)
        // reaches this; agents must never call it.
        if (args[0] !== "--really") fail("flush is permanent — this is the GUI's Empty-trash button. CLI: flush --really");
        const items = trashedScripts(config());
        for (const i of items) rmSync(path.join(i.dir, i.name));
        say(io, `flushed ${items.length} archived script(s) for good.`);
        return 0;
      }
      case "vault-import": { // KEY=VALUE lines on stdin; blank lines and # comments skipped
        const v = vault();
        const names = [];
        for (const line of (await stdinText()).split(/\r?\n/)) {
          const t = line.trim();
          if (!t || t.startsWith("#")) continue;
          const i = t.indexOf("=");
          if (i < 1) continue;
          const k = t.slice(0, i).trim();
          v[k] = t.slice(i + 1).trim();
          names.push(k);
        }
        if (!names.length) fail("no KEY=VALUE lines found on stdin");
        writeJson(VAULT(), v);
        say(io, `stored: ${names.join(", ")}`);
        return 0;
      }
      case "vault-rm": {
        const v = vault();
        if (!(args[0] in v)) fail(`not in vault: ${args[0]}`);
        delete v[args[0]];
        writeJson(VAULT(), v);
        say(io, `removed: ${args[0]}`);
        return 0;
      }
      case "vault-keys":
        say(io, Object.keys(vault()).join("\n"));
        return 0;
      case "apply": { // apply <targetFile> <KEY...>: upsert KEY=value lines into an env-format file
        const [target, ...keys] = args;
        if (!target || !keys.length) fail("usage: apply <targetFile> <KEY...>");
        const v = vault();
        const missing = keys.filter((k) => !(k in v));
        if (missing.length) fail(`not in vault: ${missing.join(", ")} — the user must add these via the Guards GUI first`);
        // Strip a UTF-8 BOM: with one, the first line never matches KEY= and a
        // stale duplicate line wins on read.
        const lines = existsSync(target)
          ? readFileSync(target, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
          : [];
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        for (const k of keys) {
          const idx = lines.findIndex((l) => l.startsWith(k + "="));
          if (idx >= 0) lines[idx] = `${k}=${v[k]}`;
          else lines.push(`${k}=${v[k]}`);
        }
        writeFileSync(target, lines.join("\n") + "\n");
        say(io, `applied to ${target}: ${keys.join(", ")}`);
        return 0;
      }
      default:
        fail([
          "usage: engine.mjs <command>",
          "  status | projects-add/rm <folder>",
          "  list [--json] | run <ref> | trash <ref> | trash-list [--json] | restore <ref> | flush --really",
          "  vault-import | vault-rm <KEY> | vault-keys | apply <file> <KEY...>",
          "guard-config commands (enable/disable, secret globs, protected paths) moved to apps/toolbelt/guards/cli.mjs",
        ].join("\n"));
    }
  } catch (e) {
    if (!(e instanceof CliFail)) throw e; // a real bug: never swallow it as a clean exit 1
    warn(io, e.message);
    return 1;
  }
}

export async function runAsMain() {
  process.exit(await main());
}

if (isMainModule(import.meta.url)) await runAsMain();
