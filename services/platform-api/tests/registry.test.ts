import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { migrate, openDatabase } from "@hyperbolic/sqlite-kit";

import { discoverManifests, manifestHash, syncRegistry } from "../src/registry.ts";

const serviceDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(serviceDir, "../..");

function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), "registry-"));
  const db = openDatabase(path.join(root, "var", "platform.db"));
  migrate(db, path.join(serviceDir, "db/migrations"));
  const write = (relative: string, manifest: object) => {
    mkdirSync(path.join(root, relative), { recursive: true });
    writeFileSync(path.join(root, relative, "tool.json"), JSON.stringify(manifest));
  };
  const row = (id: string) => db.prepare("select * from core_app where id = ?").get(id) as Record<string, unknown> | undefined;
  return { root, db, write, row };
}

const ui = { id: "notes", name: "Notes", kind: "ui", version: "1.0.0", description: "d", schemas: ["notes"], entry: { ui: { route: "/notes" } } };

test("discovery finds apps, nested toolbelt apps and services, in a stable order", () => {
  const s = scratch();
  s.write("apps/zeta", { ...ui, id: "zeta" });
  s.write("apps/alpha", { ...ui, id: "alpha" });
  s.write("services/svc", { ...ui, id: "svc", kind: "headless", entry: {} });
  s.write("apps/no-manifest/src", {});
  rmSync(path.join(s.root, "apps/no-manifest/src/tool.json"));
  assert.deepEqual(discoverManifests(s.root).map((f) => path.relative(s.root, f)), [
    "apps/alpha/tool.json",
    "apps/zeta/tool.json",
    "services/svc/tool.json",
  ]);
});

test("a sync maps every registered field and starts a new app as 'building'", () => {
  const s = scratch();
  s.write("apps/notes", ui);
  s.write("services/worker", { id: "worker", name: "Worker", kind: "headless", version: "0.1.0", schemas: [] });
  assert.deepEqual(syncRegistry(s.db, s.root, "2026-10-29T00:00:00.000Z"), { registered: ["notes", "worker"], retired: [] });
  const notes = s.row("notes")!;
  assert.deepEqual(
    { id: notes.id, name: notes.name, schema_name: notes.schema_name, status: notes.status, kind: notes.kind, route: notes.route, version: notes.version, registered_at: notes.registered_at },
    { id: "notes", name: "Notes", schema_name: "notes", status: "building", kind: "ui", route: "/notes", version: "1.0.0", registered_at: "2026-10-29T00:00:00.000Z" },
  );
  assert.deepEqual(JSON.parse(String(notes.manifest)), ui);
  assert.equal(notes.manifest_hash, manifestHash(ui));
  const worker = s.row("worker")!;
  assert.equal(worker.schema_name, "none");
  assert.equal(worker.route, null);
});

test("a re-sync updates manifest fields but never the status; a vanished app is retired, not deleted", () => {
  const s = scratch();
  s.write("apps/notes", ui);
  s.write("apps/old", { ...ui, id: "old", entry: { ui: { route: "/old" } } });
  syncRegistry(s.db, s.root);
  s.db.prepare("update core_app set status = 'live' where id = 'notes'").run();
  s.write("apps/notes", { ...ui, version: "1.1.0" });
  rmSync(path.join(s.root, "apps/old"), { recursive: true });
  assert.deepEqual(syncRegistry(s.db, s.root).retired, ["old"]);
  assert.equal(s.row("notes")!.status, "live");
  assert.equal(s.row("notes")!.version, "1.1.0");
  assert.equal(s.row("old")!.status, "retired");
  assert.deepEqual(syncRegistry(s.db, s.root).retired, [], "already retired is not retired again");
});

test("a malformed or duplicate manifest fails the sync loudly and changes nothing", () => {
  const s = scratch();
  s.write("apps/notes", ui);
  syncRegistry(s.db, s.root);
  writeFileSync(path.join(s.root, "apps/notes/tool.json"), "{not json");
  assert.throws(() => syncRegistry(s.db, s.root), /apps\/notes\/tool\.json is not valid JSON/);
  s.write("apps/notes", ui);
  s.write("services/notes", ui);
  assert.throws(() => syncRegistry(s.db, s.root), /duplicate app id "notes"/);
  s.write("services/notes", { ...ui, id: "x", name: "" });
  assert.throws(() => syncRegistry(s.db, s.root), /has no name/);
  assert.equal(s.row("notes")!.status, "building");
});

test("the hash is byte-for-byte the toolbelt validator's, over every real manifest in the repo", async () => {
  const toolbelt = (await import(path.join(repoRoot, "packages/manifest-tools/validate-manifests.mjs"))) as { manifestHash: (m: unknown) => string };
  const real = discoverManifests(repoRoot);
  assert.ok(real.length >= 8, `expected the repo's manifests, found ${real.length}`);
  const { readFileSync } = await import("node:fs");
  for (const file of real) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(manifestHash(manifest), toolbelt.manifestHash(manifest), file);
  }
});
