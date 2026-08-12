// Claude Code PreToolUse guard, registered in ~/.claude/settings.json for
// Edit|Write|NotebookEdit|Read across all projects. Three checks, in order:
//   1. secrets  — basename globs; reads AND writes blocked so keys never enter
//                 the conversation.
//   2. protected — guard machinery + its registration; blocks a DIRECT write.
//                  With policy.json autoApprove.enabled:true (accepted risk,
//                  OI-032, Kyle 2026-08-06) an agent can still reach the same
//                  target indirectly via a runbox script the watcher runs
//                  unattended — this is a speed bump on the direct path, not
//                  an absolute boundary. See AGENTS.md's autoApprove note.
//   3. cells    — per-repo path ownership (see config.json "repos"), matched
//                 by the TARGET file's path — not the session folder — so a
//                 session launched from a parent folder is guarded the same
//                 as one launched inside the repo. Writes to a cell-owned
//                 path are blocked unless .agents/task.json in that repo
//                 declares the owning cell.
// Scope: only tools named in the hook matcher. Writes via Bash (redirects,
// sed -i, tee) are NOT intercepted — convention enforcer, not a security boundary.
//
// decide() is the rule set, exported so hooks/guard.test.mjs can exercise it
// directly (import + call) instead of only through a subprocess — the same
// split kernel/guard.mjs (pure) / kernel/guardhook.mjs (I/O) already uses, and
// the reason covgate.mjs can now actually gate this file (#22): a subprocess
// call's coverage is invisible to the parent test process's V8 instrumentation,
// a plain import's is not. Below decide(), the IO wrapper — config read,
// stdin read, exit code — runs ONLY when this file is the process entry point
// (`node hooks/guard.mjs`, exactly how the hook is invoked), never on import,
// so guard.test.mjs can import decide() without inheriting the wrapper's
// process.exit calls or its blocking stdin read.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./root.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ACC_GUARD_CONFIG lets a test point this file at a fixture config without
// touching the real one — same override idiom kernel/policy.mjs's POLICY()
// already uses for policy.json. Unset in production, where it always
// resolves to the real path; not a bypass surface, since anyone who could set
// env vars for this hook process already has stronger routes in (editing
// config.json or ~/.claude/settings.json directly).
const CONFIG_PATH = process.env.ACC_GUARD_CONFIG || path.join(HERE, "..", "config.json");
// Repo root, for operator-facing command examples below — computed from this
// file's own location so the message is correct on any checkout path/machine,
// not hardcoded to one developer's C:\code\guards.
const REPO_ROOT = path.join(HERE, "..");

const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
const globRe = (g) =>
  new RegExp(`^${g.toLowerCase().split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

// Pure decision over an already-parsed hook payload and an already-parsed
// config: no config.json read, no stdin read, no process.exit. The one real
// I/O it does (reading a repo's .agents/task.json) is unavoidable — cell
// ownership is decided by what is actually declared on disk right now, not by
// anything the caller could inject as a pure value without reproducing the
// exact file this rule exists to check.
export function decide(payload, config) {
  const filePath = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (!filePath) return { allow: true };

  const target = norm(filePath);
  const base = path.basename(target);

  if ((config.secrets ?? []).some((g) => globRe(g).test(base))) {
    return {
      allow: false,
      reason: `guard: "${base}" matches a secret pattern — reads and writes are blocked so keys never enter the conversation. Ask the user for the specific value you need, or use the guards vault (engine.mjs vault-keys / apply).`,
    };
  }

  if (!WRITE_TOOLS.has(payload.tool_name)) return { allow: true };

  // Runboxes are the sanctioned drop-zones: agents may write scripts there for
  // the user to review and run (/approve or the Guards GUI), so they are exempt
  // from every write rule below. Covers the central runbox and each
  // <project>/.guards folder.
  const runboxDirs = [
    ...(config.runboxDir ? [config.runboxDir] : []),
    ...(config.projects ?? []).map((p) => path.join(p, ".guards")),
  ].map(norm);
  if (runboxDirs.some((d) => target === d || target.startsWith(d + "/"))) return { allow: true };

  for (const p of config.protected ?? []) {
    const pref = norm(p);
    if (target === pref || target.startsWith(pref + "/")) {
      return {
        allow: false,
        reason: `guard: "${filePath}" is guard machinery — this direct edit is refused. Write a script into ${config.runboxDir ?? "the runbox"} instead: with autoApprove off the user runs it after review (/approve or the Guards GUI); with autoApprove on (the current default) it runs unattended on the next watcher cycle — not a human gate, an accepted risk (OI-032).`,
      };
    }
  }

  // Cell ownership: which configured repo contains the TARGET file?
  const repoKey = Object.keys(config.repos ?? {}).find((k) => {
    const pref = norm(k);
    return target === pref || target.startsWith(pref + "/");
  });
  if (!repoKey) return { allow: true };
  const repo = config.repos[repoKey];

  const rel = target.slice(norm(repoKey).length + 1); // normalized + lowercase
  if ((repo.alwaysAllowed ?? []).includes(rel)) return { allow: true };

  const cells = repo.cells ?? {};
  const owner = Object.keys(cells).find((c) => cells[c].some((p) => rel.startsWith(p)));
  if (!owner) return { allow: true }; // unowned path (README, config, etc.)

  let declared = null;
  try {
    declared = JSON.parse(readFileSync(path.join(repoKey, ".agents/task.json"), "utf8")).cell;
  } catch {} // no declaration file: declared stays null and owned paths are blocked below

  if (declared === owner) return { allow: true };
  return {
    allow: false,
    reason:
      `guard: "${rel}" is owned by the "${owner}" cell but this task declares ` +
      `${declared ? `"${declared}"` : "no cell"}. Either declare {"cell": "${owner}"} in ` +
      `${repoKey}/.agents/task.json (rules/ADR edits require an explicitly-declared "rules" task), ` +
      `or write the need into ${repoKey}/cross-domain-change-request.md (repo root - always writable) instead of editing across the boundary.`,
  };
}

// --- I/O wrapper: only when this file is the process entry point -----------
if (isMainModule(import.meta.url)) {
  function deny(msg) {
    console.error(msg);
    process.exit(2);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    deny(`guard: cannot read ${CONFIG_PATH} (${e.message}) — failing closed. Fix or delete the hook registration in ~/.claude/settings.json.`);
  }
  if (!config.enabled) process.exit(0);

  // Read the hook payload asynchronously. readFileSync(0) returns empty on
  // Windows pipes — that is how the original lifeos path-guard crashed on every
  // invocation. The 4s cap keeps a never-closing pipe from holding the tool call
  // until the hook timeout; whatever arrived by then is used. Cap is
  // env-overridable (mirrors kernel/guardhook.mjs's STDIN_TIMEOUT_MS) so a
  // test can prove the timeout path fires without a real multi-second wait.
  const STDIN_TIMEOUT_MS = Number(process.env.ACC_GUARD_STDIN_TIMEOUT_MS) || 4000;
  const raw = await new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve(buf), STDIN_TIMEOUT_MS);
    // "end" and "error" resolve identically (whatever is buffered so far) —
    // one shared handler, not two, matching kernel/guardhook.mjs: an
    // unhandled stream "error" would otherwise crash the process instead of
    // failing closed via deny() below.
    const finish = () => { clearTimeout(timer); resolve(buf); };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    deny(`guard: no hook payload on stdin (got ${raw.length} bytes) — failing closed rather than silently allowing. If this repeats, toggle guards off in the Command Center (http://127.0.0.1:43117/guards) or run: node ${path.join(REPO_ROOT, "hooks", "engine.mjs")} toggle off`);
  }

  const d = decide(payload, config);
  if (!d.allow) deny(d.reason);
  process.exit(0);
}
