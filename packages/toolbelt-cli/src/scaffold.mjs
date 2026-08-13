// Orchestration: build the manifest + full write plan, run every collision
// check BEFORE any write (so the exit-2 path can never leave a partial
// write), then either print the plan (--dry-run) or execute it with
// rollback-on-failure.
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { resolveSchema } from "./args.mjs";
import { nextTimestamp } from "./timestamp.mjs";
import { detectCollisions } from "./collisions.mjs";
import {
  buildManifest,
  manifestToPrettyJSON,
  buildAgentsMd,
  buildWebIndexHtml,
  buildSchemaCreateSql,
  buildSchemaCreateDownSql,
  buildRegistrationTestMjs,
  buildRegistrationUpSql,
  buildRegistrationDownSql,
} from "./templates.mjs";

const defaultFsImpl = { mkdirSync, writeFileSync, rmSync };

// Builds the complete plan: the manifest object, every {path, content} pair
// that WOULD be written, and the tool's own directory (needed for rollback
// scoping). Does not touch the filesystem itself except read-only listings
// (readdirSync, for timestamp collision avoidance) -- safe to call for
// --dry-run.
export function buildPlan(options, { toolbeltRoot }) {
  const { id, name, kind, route } = options;
  const { hasSchema, schema } = resolveSchema(options);

  const toolDir = join(toolbeltRoot, "apps", id);
  const registrationDir = join(toolbeltRoot, "supabase", "migrations");
  const toolMigrationsDir = join(toolDir, "supabase", "migrations");

  const registerTs = nextTimestamp(safeReaddir(registrationDir));
  const registerBasename = `${registerTs}_register_${id}.sql`;
  const registerDownBasename = `${registerTs}_register_${id}_down.sql`;

  const manifest = buildManifest({ id, name, kind, route, hasSchema, schema, llm: options.llm, registerBasename });

  const files = [];
  files.push({ path: join(toolDir, "tool.json"), content: manifestToPrettyJSON(manifest) });
  files.push({ path: join(toolDir, "AGENTS.md"), content: buildAgentsMd({ id, name, hasSchema, schema }) });

  if (kind === "ui" || kind === "hybrid") {
    files.push({ path: join(toolDir, "web", "index.html"), content: buildWebIndexHtml({ id, name }) });
  }

  if (hasSchema) {
    const schemaTs = nextTimestamp(safeReaddir(toolMigrationsDir));
    const schemaBasename = `${schemaTs}_${schema}_create_schema.sql`;
    const schemaDownBasename = `${schemaTs}_${schema}_create_schema_down.sql`;
    files.push({ path: join(toolMigrationsDir, schemaBasename), content: buildSchemaCreateSql({ id, schema }) });
    files.push({ path: join(toolMigrationsDir, schemaDownBasename), content: buildSchemaCreateDownSql({ id, schema }) });
  }

  files.push({
    path: join(toolDir, "tests", "registration.test.mjs"),
    content: buildRegistrationTestMjs({ registerBasename }),
  });

  files.push({
    path: join(registrationDir, registerBasename),
    content: buildRegistrationUpSql({ manifest, id, name, schema, kind, route: hasRoute(kind) ? route : null }),
  });
  files.push({
    path: join(registrationDir, registerDownBasename),
    content: buildRegistrationDownSql({ id }),
  });

  return { manifest, files, toolDir, registrationDir, id };
}

function hasRoute(kind) {
  return kind === "ui" || kind === "hybrid";
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Executes plan.files in order. On any error partway through, rolls back
// EVERYTHING this call wrote: the entire new tool directory (plan.toolDir,
// which is guaranteed brand-new by the pre-write collision check, so removing
// it wholesale is always safe) plus any individual files written outside that
// directory (the registration pair, which lands in the pre-existing
// apps/toolbelt/supabase/migrations/ -- only the specific files THIS call
// wrote are removed, never the directory itself). Then re-throws, so the
// caller can report failure; by the time it does, the filesystem is back to
// exactly its pre-call state.
//
// fsImpl is injectable so tests can force a failure at a specific write
// without touching the real fs module globally (tests/scaffold.test.mjs's
// adversarial "no partial writes" suite).
export function writePlan(plan, { fsImpl = defaultFsImpl } = {}) {
  const written = [];
  try {
    for (const file of plan.files) {
      fsImpl.mkdirSync(dirname(file.path), { recursive: true });
      fsImpl.writeFileSync(file.path, file.content);
      written.push(file.path);
    }
  } catch (err) {
    fsImpl.rmSync(plan.toolDir, { recursive: true, force: true });
    for (const path of written) {
      if (!isInside(plan.toolDir, path)) {
        fsImpl.rmSync(path, { force: true });
      }
    }
    throw err;
  }
  return written;
}

// Full pipeline: validate is the caller's job (src/args.mjs), this assumes
// options already passed validateOptions. Returns a result object; never
// throws for an ordinary collision (that is exitCode 2, not an exception) --
// only an unexpected I/O failure during the write phase throws (caught by
// the caller, see src/cli.mjs), and by the time it does, writePlan has
// already rolled back.
export function runScaffold(options, { toolbeltRoot, dryRun = false, fsImpl } = {}) {
  const plan = buildPlan(options, { toolbeltRoot });
  const collisions = detectCollisions({ toolbeltRoot, id: options.id, candidateManifest: plan.manifest });
  if (collisions.length > 0) {
    return { ok: false, exitCode: 2, reasons: collisions, plan };
  }

  if (dryRun) {
    return { ok: true, exitCode: 0, dryRun: true, plan };
  }

  const written = writePlan(plan, { fsImpl });
  return { ok: true, exitCode: 0, dryRun: false, plan, written };
}

export { isInside };
