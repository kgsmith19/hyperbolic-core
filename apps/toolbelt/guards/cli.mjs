#!/usr/bin/env node
// CLI for the guard's own config: enable/disable, secret globs, protected
// paths. A caller (e.g. a web control panel) shells this for every guard
// mutation; guard.mjs itself only ever reads config, never writes it.
//
// Deliberately narrow: this file owns exactly the fields guard.mjs's
// decide() consults for its own three checks (enabled, secrets, protected;
// "repos" cell data is edited by hand in config.<profile>.json, no CLI
// surface exists for it here or previously). Vault and runbox management are
// a separate concern owned by whatever caller embeds this module — not
// duplicated here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveConfigPaths } from "./config-loader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const isMainModule = (url) => !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(url));

// Resolved PER CALL, not once at module load: this module is imported
// in-process by its own test suite (not just spawned as a subprocess), so a
// module-level constant would freeze in whatever GUARDS_CONFIG/GUARDS_PROFILE
// happened to be set (or unset) at import time — and every later test's env
// override would silently mutate the real default config.json instead of its
// own sandbox. Same discipline hooks/budget.mjs's ROOT()/hooks/engine.mjs's
// CONFIG() already use for exactly this reason.
//
// basePath/overlayPath (config-loader.mjs, shared with guard.mjs): enabled
// and secrets are portable, so their mutations always target basePath;
// protected is machine-specific, so its mutations target overlayPath —
// which collapses onto the same file as basePath whenever GUARDS_CONFIG is
// set, reproducing today's single-file behavior exactly.
const paths = () => resolveConfigPaths(HERE, process.env);

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, j) => writeFileSync(p, JSON.stringify(j, null, 2) + "\n");

class CliFail extends Error {}
const fail = (m) => { throw new CliFail(m); };

// status reports the full effective (base + overlay) config -- the same
// merged view guard.mjs itself would enforce on this machine.
const config = () => {
  try {
    return loadConfig(HERE, process.env);
  } catch (e) {
    return fail(`no config.json at ${e.message}`);
  }
};

// enabled/secrets mutate the tracked base; protected mutates the resolved
// per-machine overlay. Both fail closed if their target file is missing --
// bootstrap a new profile overlay from config.example.json first.
function mutateList(field, cmd, val) {
  const target = field === "protected" ? paths().overlayPath : paths().basePath;
  const c = readJson(target, null) ?? fail(`no config.json at ${target}`);
  const list = c[field] ?? [];
  c[field] = cmd.endsWith("add") ? [...new Set([...list, val])] : list.filter((x) => x !== val);
  writeJson(target, c);
  return c[field];
}

const PROCESS_IO = {
  out: process.stdout.write.bind(process.stdout),
  err: process.stderr.write.bind(process.stderr),
};
const say = (io, m) => io.out(m + "\n");
const warn = (io, m) => io.err(m + "\n");

// Same dispatch-table shape as every other CLI in this codebase's family
// (main({argv, io}), returns an exit code, never calls process.exit itself)
// so a test can call every command in-process with an injected io and a
// GUARDS_CONFIG-sandboxed config file.
export async function main({ argv = process.argv.slice(2), io = PROCESS_IO } = {}) {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "status": {
        const c = config();
        say(io, JSON.stringify({
          enabled: c.enabled,
          secrets: c.secrets ?? [],
          protected: c.protected ?? [],
        }));
        return 0;
      }
      case "toggle": {
        if (!["on", "off"].includes(args[0])) fail("usage: toggle on|off");
        const target = paths().basePath;
        const c = readJson(target, null) ?? fail(`no config.json at ${target}`);
        c.enabled = args[0] === "on";
        writeJson(target, c);
        say(io, `guards ${c.enabled ? "ENABLED" : "DISABLED"}`);
        return 0;
      }
      case "secret-add":
      case "secret-rm":
      case "protected-add":
      case "protected-rm": {
        const field = cmd.startsWith("secret") ? "secrets" : "protected";
        const val = args[0] ?? fail("value required");
        const list = mutateList(field, cmd, val);
        say(io, `${field}: ${list.join(", ") || "(empty)"}`);
        return 0;
      }
      default:
        fail([
          "usage: cli.mjs <command>",
          "  status | toggle on|off",
          "  secret-add/rm <glob> | protected-add/rm <path>",
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
