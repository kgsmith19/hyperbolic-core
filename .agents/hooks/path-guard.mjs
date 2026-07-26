// Minimal PreToolUse path guard. No folder-level convention existed when this
// repo was bootstrapped, so this file establishes it for lifeos.
//
// Cells own paths. A task declares its cell in .agents/task.json (gitignored),
// e.g. {"cell": "kernel"}. Edits to a cell-owned path are blocked unless the
// declared cell owns it. Cross-boundary needs go in cross-domain-change-request.md.
//
// Scope note: this guard only sees tools matched by the hook's `matcher`
// (Edit|Write|NotebookEdit). Writes performed through Bash (redirects, sed -i,
// tee, git checkout) are NOT intercepted and bypass cell ownership entirely.
// Treat this as a convention enforcer, not a security boundary.
import { readFileSync } from "node:fs";
import path from "node:path";

const CELLS = {
  kernel: ["src/kernel/", "supabase/migrations/", "tests/kernel/"],
  interface: ["src/api/", "tests/api/"],
  rules: [".agents/", "docs/adr/"],
};
const ALWAYS_ALLOWED = [".agents/task.json", "cross-domain-change-request.md"];

const payload = JSON.parse(readFileSync(0, "utf8"));
// NotebookEdit passes `notebook_path`, not `file_path`. Reading only file_path
// meant every notebook edit hit the !filePath bail below and sailed through,
// despite NotebookEdit being named in the matcher.
const filePath = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
if (!filePath) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const rel = path.relative(root, filePath).replaceAll("\\", "/").toLowerCase();
// Outside the repo: not ours to guard. Match ".." exactly or a "../" prefix --
// a bare startsWith("..") would also skip a legitimately named "..foo" at root.
if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) process.exit(0);
if (ALWAYS_ALLOWED.includes(rel)) process.exit(0);

const owner = Object.keys(CELLS).find((c) => CELLS[c].some((p) => rel.startsWith(p)));
if (!owner) process.exit(0); // unowned path (README, config, etc.)

let declared = null;
try {
  declared = JSON.parse(readFileSync(path.join(root, ".agents/task.json"), "utf8")).cell;
} catch {} // no declaration file: declared stays null and owned paths are blocked below

if (declared === owner) process.exit(0);
console.error(
  `path-guard: "${rel}" is owned by the "${owner}" cell but this task declares ` +
    `${declared ? `"${declared}"` : "no cell"}. Either declare {"cell": "${owner}"} in ` +
    `.agents/task.json (rules/ADR edits require an explicitly-declared "rules" task), ` +
    `or write the need into cross-domain-change-request.md instead of editing across the boundary.`
);
process.exit(2);
