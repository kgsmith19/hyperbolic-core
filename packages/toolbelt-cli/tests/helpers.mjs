// Shared fixture helpers for this package's own tests. Mirrors
// apps/toolbelt/tests/validate-manifests.test.mjs's withFixtureRoot pattern
// deliberately: every automated test in this package operates on a
// disposable temp directory, NEVER the real apps/toolbelt/ tree, so the test
// suite can run repeatedly (including concurrently with other work in this
// shared repo) without ever mutating or racing against real, committed
// files. The one real-tree invocation this issue requires is run
// interactively and reported separately (see the m3-03 implementation
// report), not baked into `node --test`.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// A minimal, schema-valid root spine manifest (mirrors the real
// apps/toolbelt/tool.json). Every fixture toolbelt root includes one, since
// findManifestPaths always looks for <root>/tool.json.
export function rootManifest(overrides = {}) {
  return {
    id: "toolbelt",
    name: "Toolbelt Root Spine",
    kind: "headless",
    version: "0.1.0",
    ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt" },
    entry: { headless: { command: "select 1;", schedule: "0 3 * * *" } },
    schemas: ["core", "idea"],
    permissions: {
      db: { read: ["core", "idea"], write: ["core", "idea"] },
      networkEgress: [],
      llmHandler: { access: false },
    },
    lifecycle: { migrate: "gh workflow run platform-migrations.yml", health: "node --test", register: "pending" },
    ...overrides,
  };
}

// layout: { "tool.json": {...}, "apps/tool-a/tool.json": {...}, "supabase/migrations/x.sql": "..." }
// -> materializes a scratch toolbelt-root tree (always includes
// supabase/migrations/ even if layout adds nothing there, matching the real
// tree's shape) and hands its absolute path to fn. Cleans up afterward
// regardless of whether fn throws.
export function withFixtureToolbeltRoot(layout, fn) {
  const dir = mkdtempSync(join(tmpdir(), "toolbelt-cli-fixture-"));
  try {
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    for (const [relPath, contents] of Object.entries(layout)) {
      const fullPath = join(dir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
    }
    const result = fn(dir);
    if (result && typeof result.then === "function") {
      return result.finally(() => rmSync(dir, { recursive: true, force: true }));
    }
    rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// Snapshot of every file path (relative to root) currently on disk under
// root, sorted. Used to assert "the tree is EXACTLY what it was before" --
// stronger than checking individual expected paths are absent, since it also
// catches any unexpected stray file the implementation might leave behind.
export function snapshotTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else out.push(full.slice(root.length + 1));
    }
  };
  walk(root);
  return out;
}
