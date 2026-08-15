// Orchestration: build the manifest + full write plan, run every collision
// check BEFORE any write (so the exit-2 path can never leave a partial
// write), then either print the plan (--dry-run) or execute it with
// rollback-on-failure.
//
// The whole check+write sequence for a given `id` runs under an exclusive,
// per-id lock (Finding 28, independent security review of this repo,
// re-verified against current HEAD: "Collision checks precede truncating
// writes... Two same-ID invocations can pass, overwrite registration, and
// one failure can delete the other's completed result."). See runScaffold's
// own comment for the full shape of that fix.
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync, renameSync, openSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, isAbsolute, basename } from "node:path";
import { resolveSchema } from "./args.mjs";
import { nextTimestamp } from "./timestamp.mjs";
import { detectCollisions } from "./collisions.mjs";
import { discoverMigrationDirs } from "./manifests-shared.mjs";
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

const defaultFsImpl = { mkdirSync, writeFileSync, rmSync, renameSync };

// Builds the complete plan: the manifest object, every {path, content} pair
// that WOULD be written, and the tool's own directory (needed for rollback
// scoping). Does not touch the filesystem itself except read-only listings
// (readdirSync, for timestamp collision avoidance) -- safe to call for
// --dry-run.
//
// `now` is an optional injected clock (a Date), threaded straight into every
// nextTimestamp() call below the same way tests/timestamp.test.mjs's own
// fake-clock convention already does for nextTimestamp itself -- it exists
// so this package's own tests can force two timestamp allocations to start
// from the exact same wall-clock second deterministically, instead of
// depending on real execution being fast enough to land two `new Date()`
// calls in the same second (true almost always, but not something a test
// should have to hope for). Defaults to `new Date()`, matching
// nextTimestamp's own default, so every existing caller (production
// included) is unaffected.
export function buildPlan(options, { toolbeltRoot, now = new Date() }) {
  const { id, name, kind, route } = options;
  const { hasSchema, schema } = resolveSchema(options);

  const toolDir = join(toolbeltRoot, "apps", id);
  const registrationDir = join(toolbeltRoot, "supabase", "migrations");
  // Under backend/, matching every existing tool: a tool's backend work all
  // lives there, so validate-migrations.mjs discovers it at exactly this path.
  const toolMigrationsDir = join(toolDir, "backend", "supabase", "migrations");

  // Finding 27 (independent security review, re-verified against current
  // HEAD): "Registration and schema versions are allocated independently,
  // often in the same second... Allocate globally unique ordered versions
  // for every emitted migration and concurrent scaffold." The OLD code
  // called nextTimestamp(safeReaddir(registrationDir)) and, separately,
  // nextTimestamp(safeReaddir(toolMigrationsDir)) -- each checked ONLY
  // against its own directory's existing files. Two calls issued a few
  // milliseconds apart in the same process routinely land on the identical
  // wall-clock second (this is the ordinary case, not an edge case --
  // `new Date()` has plenty of headroom below one second between two
  // synchronous statements), and neither call's existing-basenames list
  // could see the OTHER call's about-to-be-allocated basename, so the two
  // could legitimately mint the exact same 14-digit version prefix. That is
  // a real collision the instant both files exist together in the shared
  // global version-key namespace apps/toolbelt/scripts/
  // validate-migrations.mjs's checkVersionCollisions enforces across every
  // discovered migration directory (this tool's own toolMigrationsDir
  // included, the moment its tool.json is written and discoverMigrationDirs
  // picks it up -- see Finding 26's fix in manifests-shared.mjs).
  //
  // The fix: maintain ONE running Set of every basename already known to
  // exist anywhere in that same global namespace, seeded from
  // discoverMigrationDirs(toolbeltRoot) (the exact function
  // checkVersionCollisions' own default is built from, imported rather than
  // re-derived, so the two can never silently drift into checking two
  // different namespaces), PLUS toolMigrationsDir itself (which
  // discoverMigrationDirs cannot yet know about for a brand-new tool -- its
  // manifest does not exist on disk until writePlan runs -- but a
  // hand-constructed test fixture, or a second buildPlan call against a
  // toolbelt root where THIS tool already exists, may have pre-seeded real
  // files there). Every timestamp this function allocates is added back
  // into that same Set immediately after being minted, so a SECOND
  // allocation later in this same call (the schema timestamp, when
  // hasSchema) can never collide with the FIRST (the registration
  // timestamp) even though neither has been written to disk yet.
  const globalBasenames = new Set();
  for (const dir of discoverMigrationDirs(toolbeltRoot)) {
    for (const name of safeReaddir(dir)) globalBasenames.add(name);
  }
  for (const name of safeReaddir(toolMigrationsDir)) globalBasenames.add(name);

  const registerTs = nextTimestamp(globalBasenames, now);
  const registerBasename = `${registerTs}_register_${id}.sql`;
  const registerDownBasename = `${registerTs}_register_${id}_down.sql`;
  globalBasenames.add(registerBasename);
  globalBasenames.add(registerDownBasename);

  const manifest = buildManifest({ id, name, kind, route, hasSchema, schema, llm: options.llm, registerBasename });

  const files = [];
  files.push({ path: join(toolDir, "tool.json"), content: manifestToPrettyJSON(manifest) });
  files.push({ path: join(toolDir, "AGENTS.md"), content: buildAgentsMd({ id, name, hasSchema, schema }) });

  if (kind === "ui" || kind === "hybrid") {
    files.push({ path: join(toolDir, "frontend", "index.html"), content: buildWebIndexHtml({ id, name }) });
  }

  if (hasSchema) {
    const schemaTs = nextTimestamp(globalBasenames, now);
    const schemaBasename = `${schemaTs}_${schema}_create_schema.sql`;
    const schemaDownBasename = `${schemaTs}_${schema}_create_schema_down.sql`;
    globalBasenames.add(schemaBasename);
    globalBasenames.add(schemaDownBasename);
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

// ---- Finding 28: per-id exclusive lock --------------------------------
//
// openSync(lockPath, "wx") is an atomic exclusive-create at the filesystem
// level (POSIX O_CREAT|O_EXCL) -- two processes racing to create the same
// path can never both succeed, which is exactly what makes this a real
// mutex rather than another check-then-act race of the same shape as the
// bug it closes. The lock is scoped per-id (apps/<id>.lock, a sibling of
// the tool directory apps/<id>/ itself), not a single global lock across
// every id: the review's own wording is explicit that two invocations for
// DIFFERENT ids "should be allowed to run concurrently without contention",
// and a global lock would serialize unrelated scaffolds for no safety
// benefit (nothing about two different ids' plans can ever interfere with
// each other -- they touch disjoint toolDir subtrees, and Finding 27's own
// per-call timestamp bookkeeping already keeps a single invocation's OWN
// registration+schema pair from colliding with itself).
//
// A `.lock` file (not a directory) sitting in apps/ alongside real
// apps/<id>/ tool directories is silently skipped by every manifest walk
// that matters: findManifestPaths (manifests-shared.mjs, reused by
// validate-manifests.mjs and this CLI's own collisions.mjs) explicitly
// skips any apps/* entry that fails `statSync(...).isDirectory()`.
export function lockPathFor(toolbeltRoot, id) {
  return join(toolbeltRoot, "apps", `${id}.lock`);
}

// Returns { ok: true, release } on success, or { ok: false } if another
// invocation already holds this id's lock. `release` is always safe to call
// more than once (rmSync with force:true tolerates an already-missing
// path), so a caller's finally block never needs to guard against a
// double-release.
export function acquireLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false };
    throw err;
  }
  try {
    // The lock's own presence is the mutex, not the held file descriptor --
    // writing the PID is a debugging nicety only (lets a human inspect a
    // stuck lock file and see which process minted it), never read back by
    // this CLI itself.
    writeFileSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return {
    ok: true,
    release: () => {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Already gone (e.g. an operator manually cleared a stuck lock
        // mid-run) -- nothing left to release, not a failure of this call.
      }
    },
  };
}

// ---- Finding 28: invocation-owned staging + atomic reveal, owned-only rollback --
//
// The OLD writePlan wrote every file directly to its FINAL path, in order,
// and rolled back on any failure by unconditionally deleting plan.toolDir
// wholesale plus any individual stray file outside it. That rollback was
// only ever safe because the pre-write collision check was assumed to
// guarantee plan.toolDir was brand new -- true for a single invocation in
// isolation, but NOT true under the TOCTOU race Finding 28 describes: two
// same-id invocations can both pass detectCollisions (neither has written
// anything when the other checks), after which the OLD code's writes went
// straight to the same real paths, so the second invocation's writes could
// silently overwrite the first's, AND a failure in either one's write phase
// would rmSync(plan.toolDir) -- deleting whatever is THERE NOW, which might
// by then be the OTHER invocation's fully-completed result.
//
// The fix has two parts, and runScaffold's own per-id lock (above) is what
// makes the second part's safety argument actually hold:
//
//   1. Every file is first written to an INVOCATION-OWNED location that is
//      not visible under its real name yet: files inside plan.toolDir go to
//      a `.tmp-<random>` staging directory that becomes plan.toolDir itself
//      via ONE atomic renameSync once every file in it has been written
//      successfully; files outside plan.toolDir (the registration up/down
//      pair, which lands in the pre-existing SHARED registrationDir and so
//      cannot be staged-then-renamed as a whole new directory the way
//      toolDir can) are each written under a `.tmp-<random>-<basename>`
//      name in that same directory, then individually renamed into place
//      at the very end. A failure anywhere in this first phase has touched
//      NO final path at all -- plan.toolDir still does not exist, and
//      registrationDir contains no new file under its real name -- so
//      rollback here is just deleting our own never-revealed temp
//      artifacts, never a real path anything else could be depending on.
//   2. Only once every write has succeeded does the reveal/rename phase
//      run. Because runScaffold holds this id's exclusive lock for the
//      ENTIRE check+write sequence, no other same-id invocation can have
//      created plan.toolDir in the meantime -- detectCollisions already
//      confirmed it was absent, and the lock is what makes that guarantee
//      still hold at write time, not just at check time. That is what
//      makes it safe for a reveal-phase failure's rollback to delete
//      plan.toolDir: this invocation is PROVABLY the only writer that has
//      ever touched that exact path in this window, so deleting it deletes
//      only what THIS call created, never a concurrent sibling's completed
//      result -- the exact property Finding 28 requires ("delete only
//      owned paths... never a blanket recursive delete of a directory that
//      existed, even partially, before this invocation's own lock was
//      acquired").
//
// `.tmp-*` names are deliberately excluded from every scanner that matters
// by construction, not by a special case added to those scanners:
// collisions.mjs's REGISTER_UP_RE and validate-migrations.mjs's
// checkVersionCollisions both require the basename to START with a digit
// run (`^\d+_...`); a name starting with `.tmp-` never matches either, so a
// transient temp file is invisible to both regardless of timing.
//
// fsImpl is injectable so tests can force a failure at a specific write (or
// a specific rename) without touching the real fs module globally
// (tests/scaffold.test.mjs's adversarial "no partial writes" and
// "concurrency" suites).
export function writePlan(plan, { fsImpl = defaultFsImpl } = {}) {
  const token = randomBytes(6).toString("hex");
  const stagingToolDir = `${plan.toolDir}.tmp-${token}`;
  const regTempByFinal = new Map(); // finalPath -> tempPath, insertion order preserved
  let stagedAnyToolFile = false;
  let toolDirRevealed = false;
  const revealedRegFinals = [];

  const cleanupStaging = () => {
    fsImpl.rmSync(stagingToolDir, { recursive: true, force: true });
    for (const tempPath of regTempByFinal.values()) {
      fsImpl.rmSync(tempPath, { force: true });
    }
  };

  // Phase 1: stage. Nothing below this point writes to a final path.
  try {
    for (const file of plan.files) {
      if (isInside(plan.toolDir, file.path)) {
        const stagedPath = join(stagingToolDir, relative(plan.toolDir, file.path));
        fsImpl.mkdirSync(dirname(stagedPath), { recursive: true });
        fsImpl.writeFileSync(stagedPath, file.content);
        stagedAnyToolFile = true;
      } else {
        const tempPath = join(dirname(file.path), `.tmp-${token}-${basename(file.path)}`);
        fsImpl.mkdirSync(dirname(tempPath), { recursive: true });
        fsImpl.writeFileSync(tempPath, file.content);
        regTempByFinal.set(file.path, tempPath);
      }
    }
  } catch (err) {
    cleanupStaging();
    throw err;
  }

  // Phase 2: reveal. Every write already landed at a temp location, so the
  // only remaining failure mode is the rename itself.
  try {
    if (stagedAnyToolFile) {
      fsImpl.renameSync(stagingToolDir, plan.toolDir);
      toolDirRevealed = true;
    }
    for (const [finalPath, tempPath] of regTempByFinal) {
      fsImpl.renameSync(tempPath, finalPath);
      revealedRegFinals.push(finalPath);
    }
  } catch (err) {
    // Owned-only rollback: remove exactly what THIS call has already made
    // visible under its real name (safe per this function's own header
    // comment), then clean up anything still sitting at a temp name --
    // never a wider blanket delete of a directory this call did not itself
    // just create.
    if (toolDirRevealed) {
      fsImpl.rmSync(plan.toolDir, { recursive: true, force: true });
    }
    for (const finalPath of revealedRegFinals) {
      fsImpl.rmSync(finalPath, { force: true });
    }
    cleanupStaging();
    throw err;
  }

  return plan.files.map((file) => file.path);
}

// Full pipeline: validate is the caller's job (src/args.mjs), this assumes
// options already passed validateOptions. Returns a result object; never
// throws for an ordinary collision or lock contention (both are exitCode 2,
// not an exception) -- only an unexpected I/O failure during the write
// phase throws (caught by the caller, see src/cli.mjs), and by the time it
// does, writePlan has already rolled back.
//
// The entire check+write sequence for options.id runs under that id's
// exclusive lock (Finding 28's fix -- see acquireLock/writePlan's own
// comments for the full shape and the safety argument): acquired before
// buildPlan/detectCollisions even run, released in a finally that covers
// every return path (collision, dry-run, success, and the write-phase
// exception path alike), so a second same-id invocation that arrives while
// this one is still checking OR still writing gets a clear, immediate
// refusal instead of racing it.
export function runScaffold(options, { toolbeltRoot, dryRun = false, fsImpl, now } = {}) {
  const lockPath = lockPathFor(toolbeltRoot, options.id);
  const lock = acquireLock(lockPath);
  if (!lock.ok) {
    return {
      ok: false,
      exitCode: 2,
      locked: true,
      reasons: [
        `another tool:new invocation for id "${options.id}" is already in progress ` +
          `(lock held at ${lockPath}). Wait for it to finish and try again, or -- only after ` +
          `confirming no other invocation is actually still running, e.g. after a killed process -- ` +
          `remove that lock file directly.`,
      ],
    };
  }

  try {
    // Reject ordinary id/schema collisions before migration discovery. A
    // colliding on-disk manifest may itself be incomplete or legacy-shaped;
    // it must still produce the documented exit-2 collision instead of
    // turning a harmless read-only preflight into an unexpected exception.
    const { hasSchema, schema } = resolveSchema(options);
    const candidateManifest = buildManifest({
      id: options.id,
      name: options.name,
      kind: options.kind,
      route: options.route,
      hasSchema,
      schema,
      llm: options.llm,
      registerBasename: "pending_registration.sql",
    });
    const collisions = detectCollisions({ toolbeltRoot, id: options.id, candidateManifest });
    if (collisions.length > 0) {
      return { ok: false, exitCode: 2, reasons: collisions };
    }

    const plan = buildPlan(options, { toolbeltRoot, now });

    if (dryRun) {
      return { ok: true, exitCode: 0, dryRun: true, plan };
    }

    const written = writePlan(plan, { fsImpl });
    return { ok: true, exitCode: 0, dryRun: false, plan, written };
  } finally {
    lock.release();
  }
}

export { isInside };

