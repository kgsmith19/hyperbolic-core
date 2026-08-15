/**
 * The context index (07-brain-architecture.md section 7.6): "a context
 * index built from the repo's own guidance chain: root AGENTS.md, per-app
 * AGENTS.md/CLAUDE.md, docs/planning/*, and TEST_LEDGER.md files...
 * Assembly: on `brain refresh-context` and on daemon start; stored as an
 * index of (path, headings, mtime); selection is lexical and path-scoped
 * in V1 (no vector store)."
 *
 * This module builds and persists that index. LEXICAL SELECTION (using
 * the index to actually pick context for a task's prompt.context_refs)
 * is not wired into the planner yet -- m4-09's skeleton planner never
 * populates context_refs at all -- so this is deliberately just the
 * assembly half for now; selection lands whenever the planner grows real
 * decomposition.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface ContextEntry {
  path: string;
  headings: string[];
  mtime: string;
}

export interface ContextIndex {
  builtAt: string;
  repoRoot: string;
  entries: ContextEntry[];
}

const HEADING_RE = /^#{1,6}\s+(.+)$/;

function extractHeadings(text: string): string[] {
  const headings: string[] = [];
  for (const line of text.split("\n")) {
    const match = HEADING_RE.exec(line.trim());
    if (match) headings.push(match[1]!.trim());
  }
  return headings;
}

function indexFile(absPath: string, repoRoot: string): ContextEntry {
  const text = readFileSync(absPath, "utf8");
  const stat = statSync(absPath);
  return { path: path.relative(repoRoot, absPath), headings: extractHeadings(text), mtime: stat.mtime.toISOString() };
}

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "ui", ".next"]);

/** Every AGENTS.md/CLAUDE.md/TEST_LEDGER.md in the tree, at any depth,
 * skipping build/dependency directories -- the "root AGENTS.md, per-app
 * AGENTS.md/CLAUDE.md... TEST_LEDGER.md files" part of 7.6's own list. */
function findNamedFiles(root: string, names: Set<string>, maxDepth = 6): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && names.has(entry.name)) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, 0);
  return found;
}

/** docs/planning/*.md -- "the planning artifact naming the component" (07
 * section 7.6's context-selection list). Flat, not recursive: the issues/
 * subdirectory is deliberately excluded here (per-issue detail, not the
 * architecture-level artifacts this index is for). */
function findPlanningDocs(root: string): string[] {
  const dir = path.join(root, "docs", "planning");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(dir, e.name));
}

export function buildContextIndex(repoRoot: string, now: string): ContextIndex {
  const guidanceFiles = findNamedFiles(repoRoot, new Set(["AGENTS.md", "CLAUDE.md", "TEST_LEDGER.md"]));
  const planningDocs = findPlanningDocs(repoRoot);
  const allPaths = [...new Set([...guidanceFiles, ...planningDocs])].sort();
  const entries = allPaths.map((p) => indexFile(p, repoRoot));
  return { builtAt: now, repoRoot, entries };
}

function contextIndexPath(dataDir: string): string {
  return path.join(dataDir, "context-index.json");
}

export function writeContextIndex(dataDir: string, index: ContextIndex): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(contextIndexPath(dataDir), JSON.stringify(index, null, 2));
}
