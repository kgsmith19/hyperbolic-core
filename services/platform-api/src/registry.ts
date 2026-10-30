// The app registry (#514): core_app rows built from the tool.json manifests in
// the repo, replacing the Supabase registration migrations. Field mapping and
// the hash match packages/manifest-tools/validate-manifests.mjs; a new app starts
// "building", a sync never overwrites a status already set, and an app whose
// manifest is gone is retired, never deleted.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export const manifestHash = (manifest: unknown) => createHash("sha256").update(JSON.stringify(canonicalize(manifest)), "utf8").digest("hex");

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const children = (dir: string) => (isDir(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")).sort() : []);

/** The root spine's tool.json, then every tool.json under apps/*, apps/*\/apps/* and services/*, in a stable order. */
export function discoverManifests(root: string): string[] {
  const found: string[] = [];
  const add = (dir: string) => {
    const file = path.join(dir, "tool.json");
    if (existsSync(file) && statSync(file).isFile()) found.push(file);
  };
  add(root);
  for (const app of children(path.join(root, "apps"))) {
    add(path.join(root, "apps", app));
    for (const nested of children(path.join(root, "apps", app, "apps"))) add(path.join(root, "apps", app, "apps", nested));
  }
  for (const service of children(path.join(root, "services"))) add(path.join(root, "services", service));
  return found;
}

interface Manifest {
  id: string;
  name: string;
  kind: string;
  version: string;
  description?: string;
  schemas?: string[];
  entry?: { ui?: { route?: string } };
}

function load(file: string): Manifest {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch (error) {
    throw new Error(`registry: ${file} is not valid JSON (${(error as Error).message})`);
  }
  for (const key of ["id", "name", "kind", "version"] as const) {
    if (typeof manifest[key] !== "string" || !manifest[key]) throw new Error(`registry: ${file} has no ${key}`);
  }
  return manifest;
}

export interface SyncResult {
  registered: string[];
  retired: string[];
}

export function syncRegistry(db: DatabaseSync, root: string, now = new Date().toISOString()): SyncResult {
  const manifests = discoverManifests(root).map((file) => ({ file, manifest: load(file) }));
  const ids = new Set<string>();
  for (const { file, manifest } of manifests) {
    if (ids.has(manifest.id)) throw new Error(`registry: duplicate app id "${manifest.id}" (${file})`);
    ids.add(manifest.id);
  }
  const upsert = db.prepare(
    `insert into core_app (id, name, schema_name, status, kind, route, version, description, manifest, manifest_hash, registered_at)
     values (?, ?, ?, 'building', ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       name = excluded.name, schema_name = excluded.schema_name, kind = excluded.kind, route = excluded.route,
       version = excluded.version, description = excluded.description, manifest = excluded.manifest,
       manifest_hash = excluded.manifest_hash, registered_at = excluded.registered_at`,
  );
  const retired: string[] = [];
  db.exec("begin immediate");
  try {
    for (const { manifest } of manifests) {
      upsert.run(
        manifest.id, manifest.name, manifest.schemas?.[0] ?? "none", manifest.kind, manifest.entry?.ui?.route ?? null,
        manifest.version, manifest.description ?? null, JSON.stringify(manifest), manifestHash(manifest), now,
      );
    }
    const stale = db.prepare("select id from core_app where status <> 'retired'").all() as { id: string }[];
    for (const { id } of stale) {
      if (ids.has(id)) continue;
      db.prepare("update core_app set status = 'retired' where id = ?").run(id);
      retired.push(id);
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return { registered: [...ids].sort(), retired: retired.sort() };
}
