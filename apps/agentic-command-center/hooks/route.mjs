// route.mjs — advisory folder router.
//
// Scores task text against the table in C:\code\ROUTING.md and says which
// folder the session should be launched in. Advisory only: it never blocks a
// prompt and never changes directory itself.
//
// Two callers:
//   node route.mjs --text "add a supabase migration"   -> JSON on stdout,
//       used by the web Start-work page (gui/server.mjs /api/route/suggest)
//       to preselect the working folder.
//   node route.mjs doctor                               -> completeness check.
//
// Route suggestions are explicit service output. ACC does not inject them into
// agent prompts or impose repository-process instructions.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The table is config, not runner state: it anchors to the checkout (ACC_ROOT
// must not move it, or sandboxed tests would lose the real routes). It maps
// this machine's own folder layout, so it is never committed -- it sits
// beside the checkout, not inside it. HERE is
// <checkout>/apps/agentic-command-center/hooks, so four levels up is the
// directory containing the checkout. Two levels sufficed when ACC was its own
// repo; the subtree import into this monorepo silently repointed the default
// at <checkout>/apps/ROUTING.md, which never exists, and no test caught it
// because every test sets ACC_ROUTING_MD.
export const DEFAULT_TABLE = path.resolve(HERE, "..", "..", "..", "..", "ROUTING.md");
const TABLE = process.env.ACC_ROUTING_MD || DEFAULT_TABLE;

// A repo dir is covered ONLY by an exact route path (case-insensitive:
// Windows). The wide root route does not cover repos - a repo silently
// falling back to wide is the exact gap this check exists for (OI-003).
export function doctor(routes, repoDirs) {
  const routed = new Set(routes.map((r) => norm(r.path)));
  return repoDirs.filter((d) => !routed.has(norm(d)));
}

function loadTable() {
  let md;
  try {
    md = fs.readFileSync(TABLE, "utf8");
  } catch (e) {
    // Name the override explicitly: a missing table is a configuration gap,
    // and a bare ENOENT gives the caller nothing to act on.
    throw new Error(`cannot read routing table ${TABLE} (set ACC_ROUTING_MD to point at it): ${e.code || e.message}`);
  }
  const m = md.match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new Error(`no json block in ${TABLE}`);
  const t = JSON.parse(m[1]);
  if (!Array.isArray(t.routes) || !t.routes.length) throw new Error("empty routes");
  return t;
}

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
const isUnder = (child, parent) => {
  const c = norm(child), p = norm(parent);
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + "\\");
};

// A signal is a regex when it contains regex metacharacters (the table uses
// \b and \. for things like "\.tsx\b"), otherwise a whole-word literal.
function signalRe(sig) {
  const raw = /[\\^$*+?()[\]{}|]/.test(sig) ? sig : `\\b${sig.replace(/\s+/g, "\\s+")}\\b`;
  return new RegExp(raw, "i");
}

// Lowest common ancestor among the table's own paths, so a tie between two
// repos lands on the folder that contains both rather than on either one.
// The next rung up the escalation ladder: the nearest listed route that
// strictly contains this one. null at the widest route.
function parentOf(routes, p) {
  const up = routes
    .filter((r) => isUnder(p, r.path) && norm(r.path) !== norm(p))
    .sort((a, b) => norm(b.path).length - norm(a.path).length);
  return up.length ? up[0].path : null;
}

function ancestor(routes, hits) {
  const candidates = routes.filter((r) => hits.every((h) => isUnder(h.path, r.path)));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => norm(b.path).length - norm(a.path).length)[0];
}

export function route(text, table) {
  const t = table || loadTable();
  const scored = t.routes
    .map((r) => ({
      route: r,
      path: r.path,
      score: (r.signals || []).filter((s) => {
        try { return signalRe(s).test(text); } catch { return false; }
      }).length,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { path: null, label: null, score: 0, reason: "no signals matched" };

  const win = scored[0];
  const top = win.score;
  // Bias narrow. Widening mid-task costs one step and loses nothing; starting
  // too wide costs the whole session and is invisible. So only a genuine tie —
  // equal scores across unrelated routes — escalates to the common ancestor.
  const tied = scored.filter(
    (s) => s.score === top && !isUnder(s.path, win.path) && !isUnder(win.path, s.path)
  );
  const decide = (r, reason) => ({
    path: r.path,
    label: r.label,
    score: top,
    reason,
    parent: parentOf(t.routes, r.path),
  });
  if (!tied.length) return decide(win.route, `${top} signal(s)`);

  const contenders = [win, ...tied];
  const lca = ancestor(t.routes, contenders);
  if (!lca) return decide(win.route, `${top} signal(s), no common ancestor`);
  return decide(lca, `tie: ${contenders.map((c) => c.route.label).join(" + ")}`);
}

function cli(argv) {
  const i = argv.indexOf("--text");
  const text = i >= 0 ? argv.slice(i + 1).join(" ") : "";
  try {
    process.stdout.write(JSON.stringify(route(text)) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ path: null, error: String(e.message || e) }) + "\n");
  }
}

export function scanRoots(value = process.env.ACC_ROUTE_SCAN_ROOTS) {
  return value
    ? value.split(path.delimiter).filter(Boolean)
    : ["C:\\code", "C:\\code\\lifeos-ecosystem"];
}

// `route.mjs doctor` - completeness check: every first-level repo dir (has
// .git or AGENTS.md) under the scan roots needs its own EXACT entry in
// ROUTING.md. Exit 1 on gaps so it can gate.
function doctorCli() {
  const dirs = [];
  for (const root of scanRoots()) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(root, e.name);
      if (fs.existsSync(path.join(full, ".git")) || fs.existsSync(path.join(full, "AGENTS.md")))
        dirs.push(full);
    }
  }
  const missing = doctor(loadTable().routes, dirs);
  if (missing.length) {
    console.log(`UNROUTED repo dirs - add a route to ${TABLE}:`);
    for (const d of missing) console.log("  " + d);
    process.exit(1);
  }
  console.log(`routing clean: ${dirs.length} repo dirs, every one has an exact route`);
}

if (process.argv.includes("--text")) cli(process.argv);
else if (process.argv[2] === "doctor") doctorCli();
