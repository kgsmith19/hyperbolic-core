// The decision. Pure: a payload plus a context in, an allow/deny out. All I/O
// lives in kernel/guardhook.mjs, so every rule below is unit-testable without
// spawning anything.
//
// Deny by default. A rule must explicitly grant an action or it does not
// happen, and the FIRST matching rule wins — the order in this file is the
// security model, not a style choice.
//
// Documented ceilings, honestly: an ALLOWED Bash command can still do
// something unintended inside its allowance, and WebSearch has no host to
// scope. This is a deterministic process-level boundary, not an OS sandbox.
// OI-027 (accepted 2026-08-04): path checks are string-based, not real OS
// canonicalization — a symlink inside an allowed writeRoot pointing outside
// it, or an exotic Windows path form (UNC, 8.3 short names, NTFS alternate
// data streams), could alias a location the string comparison can't see.
// Closing either needs fs.realpathSync (real I/O), which this module
// deliberately does not do (see line 1) — accepted as a ceiling rather than
// changing that design, same as the Bash/WebSearch ceilings above.
import path from "node:path";

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);

// path.posix.normalize collapses ".."/"." segments (pure string manipulation,
// no filesystem I/O — still safe for this module's "pure" contract). Without
// it, a harness-supplied file_path like "C:/work/src/../../code/guards/x"
// textually starts with the writeRoot "C:/work/src" and would be ALLOWED,
// while the real filesystem write actually lands in C:/code/guards (a
// denyRoot) once the OS resolves the ".." segments — a live path-traversal
// bypass of the deny-by-default boundary, found and closed 2026-08-04.
const norm = (p) => path.posix.normalize(String(p).replaceAll("\\", "/")).toLowerCase().replace(/\/+$/, "");
const under = (target, root) => target === root || target.startsWith(root + "/");
const underAny = (target, roots) => roots.some((r) => under(target, norm(r)));

const verdict = (allow, rule, reason, tool, target = null) => ({ allow, rule, reason, tool, target });

// `engine.mjs apply <targetFile> <KEY...>` is the sanctioned way a harness
// receives secrets. The contract says which key NAMES it may use; anything
// else is denied before any pattern allow can reach it.
function vaultViolation(command, allowedKeys) {
  const m = command.match(/engine\.mjs["']?\s+apply\s+(\S+)((?:\s+[A-Za-z_][A-Za-z0-9_]*)+)/);
  if (!m) return null;
  const requested = m[2].trim().split(/\s+/);
  const notGranted = requested.filter((k) => !allowedKeys.includes(k));
  return notGranted.length ? notGranted : null;
}

export function decide(payload, ctx) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input || {};
  if (!tool) return verdict(false, "payload", "hook payload carries no tool_name — failing closed", null);

  const { contract, policy, denyRoots, stagingDir, attempts, ceiling } = ctx;
  const a = contract?.allowedActions || {};

  if (Number.isFinite(ceiling) && attempts >= ceiling) {
    return verdict(false, "ceiling", `tool-call ceiling of ${ceiling} reached`, tool);
  }

  if (tool === "Bash") {
    const command = String(input.command || "");
    const smuggled = vaultViolation(command, a.vaultKeys || []);
    if (smuggled) {
      return verdict(false, "vaultKeys", `vault key(s) not granted by this contract: ${smuggled.join(", ")}`, tool);
    }
    const pattern = (a.bashPatterns || []).find((p) => command.startsWith(p));
    return pattern
      ? verdict(true, "bashPatterns", `matches allowed prefix "${pattern}"`, tool, command)
      : verdict(false, "bashPatterns", "command matches no allowed prefix — not granted by the contract", tool, command);
  }

  if (WRITE_TOOLS.has(tool)) {
    const raw = input.file_path ?? input.notebook_path;
    if (!raw) return verdict(false, "write", "write tool with no file path — failing closed", tool);
    const target = norm(raw);
    if (underAny(target, denyRoots)) {
      return verdict(false, "alwaysDeny", "guard machinery and settings are never writable, whatever the contract says", tool, target);
    }
    if (stagingDir && under(target, norm(stagingDir))) {
      return verdict(false, "staging", "the run's own generated settings are never writable", tool, target);
    }
    if (underAny(target, contract?.pinnedPaths || [])) {
      return verdict(false, "pinnedPaths", "path is pinned for this run — satisfy it, do not rewrite it", tool, target);
    }
    return underAny(target, a.writeRoots || [])
      ? verdict(true, "writeRoots", "inside an allowed write root", tool, target)
      : verdict(false, "writeRoots", "path is not granted by the contract", tool, target);
  }

  if (READ_TOOLS.has(tool)) {
    const raw = input.file_path ?? input.notebook_path ?? input.path;
    if (!raw) return verdict(false, "read", "read tool with no path — failing closed", tool);
    const target = norm(raw);
    return underAny(target, [...(a.readRoots || []), ...(a.writeRoots || [])])
      ? verdict(true, "readRoots", "inside an allowed read root", tool, target)
      : verdict(false, "readRoots", "path is not granted by the contract", tool, target);
  }

  if (tool === "WebFetch") {
    let host;
    try { host = new URL(String(input.url)).hostname.toLowerCase(); } catch { host = null; }
    if (!host) return verdict(false, "networkHosts", "unparseable url — failing closed", tool, String(input.url));
    return (a.networkHosts || []).map((h) => h.toLowerCase()).includes(host)
      ? verdict(true, "networkHosts", "host is granted by the contract", tool, host)
      : verdict(false, "networkHosts", "host is not granted by the contract", tool, host);
  }

  // A search has no host to scope against — the contract can only grant or
  // withhold searching as a whole. Stated as a ceiling, not hidden.
  if (tool === "WebSearch") {
    return (a.networkHosts || []).length
      ? verdict(true, "networkHosts", "network is granted; a search cannot be host-scoped", tool)
      : verdict(false, "networkHosts", "contract grants no network access", tool);
  }

  if (tool === "Agent") {
    const type = String(input.subagent_type || "");
    return (a.subagents || []).includes(type)
      ? verdict(true, "subagents", "subagent type is granted by the contract", tool, type)
      : verdict(false, "subagents", `subagent type "${type}" is not granted by the contract`, tool, type);
  }

  if ((policy?.alwaysAllowTools || []).includes(tool)) {
    return verdict(true, "alwaysAllowTools", "permitted by kernel policy", tool);
  }

  return verdict(false, "default", `tool "${tool}" is not granted by the contract`, tool);
}
