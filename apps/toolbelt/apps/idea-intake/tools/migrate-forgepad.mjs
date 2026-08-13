#!/usr/bin/env node
// migrate-forgepad.mjs — one-shot CLI migrating ACC's Forgepad idea files
// into the `intake` schema (m3-08, docs/planning/issues/m3-08-chore-acc-forgepad-supersession.md).
// Field mapping and CLI invocation are transcribed verbatim from the
// authoritative spec, docs/planning/05-h-idea-intake.md section 10 (05-b-acc.md
// section 7 covers the same ground with older, superseded column names —
// 05-h is the source of truth here, matching the actually-committed schema
// in supabase/migrations/20260813002605_intake_create_schema.sql).
//
//   node apps/toolbelt/apps/idea-intake/tools/migrate-forgepad.mjs \
//     --acc-root <path> [--dry-run]
//
// DATABASE_URL (required unless --dry-run) is any libpq-recognized target —
// a bare local database name (peer/socket auth, e.g. run under
// `sudo -n -u postgres`) or a full `postgres://...` URI for a remote
// project — passed to libpq via the child-only PGDATABASE environment (never
// a process-list-visible argv value). This otherwise mirrors the
// spawnSync(...,"psql",...) pattern
// apps/toolbelt/apps/idea-intake/tests/intake-guards.test.mjs and
// apps/toolbelt/tests/registry-migrations-idempotency.test.mjs already use:
// no `pg` npm dependency exists anywhere in this monorepo, and
// apps/toolbelt/AGENTS.md asks to keep the runtime dependency-free absent a
// concrete need this issue does not establish.
//
// Why every migrated row is INSERTed as status='draft' first, even the ones
// that end up 'idea': intake.guard_idea_insert (the committed migration,
// section 3.1) unconditionally rejects any INSERT whose status is not
// 'draft', for EVERY role including a service/superuser connection that
// bypasses grants and RLS entirely — apps/toolbelt/apps/idea-intake/tests/intake-guards.test.mjs's
// "INSERT with status='idea' is rejected ... INDEPENDENTLY by the
// insert-guard trigger in a service context" test proves this directly. So
// "definite" ideas with a valid target are inserted as draft (with
// target_repo already populated — legal, since repo_required_beyond_draft
// only requires target_repo once status leaves 'draft') and promoted to
// 'idea' with a second statement in the very same transaction, the one
// state transition the guard_idea_update trigger allows. That promotion
// necessarily bumps updated_at to now() (the trigger does this
// unconditionally on every UPDATE, by design — II-1/II-3 are enforced as
// database properties, not app discipline, and this migration does not get
// a bypass) — created_at and, for every row that stays 'draft' (the
// majority: draft/research-needed/needs-repo rows touched only by the
// INSERT), updated_at both carry the original forgepad timestamps through
// untouched, satisfying section 10's "created/updated preserved" for the
// rows where preservation and the state machine do not conflict.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// === Pure mapping logic (05-h section 10's field mapping table) ===========

// Identical to the DDL CHECK on intake.idea.target_repo (section 1.2 /
// 20260813002605_intake_create_schema.sql) — must stay byte-identical so a
// row this tool decides is "idea-ready" is also one the database will
// actually accept into target_repo.
export const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const STATES = new Set(["draft", "definite", "research-needed", "rejected"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const FORGEPAD_ID_RE = /^f-[0-9a-f]{8}$/;
const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isCanonicalIso(value) {
  if (typeof value !== "string" || !CANONICAL_ISO_RE.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

// Deterministic UUIDv3-shaped key mirrored by the additive database migration.
// Only the immutable Forgepad provenance ID contributes to idempotency.
export function forgepadIdempotencyKey(id) {
  const bytes = createHash("md5").update(`hyperbolic-core/forgepad/${id}`, "utf8").digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x0f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Returns an array of human-readable problems; empty means the file is a
// well-shaped forgepad idea record. Deliberately collects every problem
// instead of throwing on the first, so the CLI's "list every bad file"
// pass (see loadForgepadFiles) can report a complete, actionable list.
export function validateForgepadIdea(idea) {
  if (idea === null || typeof idea !== "object" || Array.isArray(idea)) {
    return ["file content is not a JSON object"];
  }
  const problems = [];
  if (!FORGEPAD_ID_RE.test(idea.id ?? "")) {
    problems.push(`id must match f-<8 lowercase hex chars>, got ${JSON.stringify(idea.id)}`);
  }
  if (typeof idea.title !== "string" || !idea.title.trim()) {
    problems.push("title is required");
  } else if (idea.title.length > 200) {
    problems.push("title exceeds 200 characters");
  }
  if (!STATES.has(idea.state)) {
    problems.push(`state must be one of ${[...STATES].join(", ")}, got ${JSON.stringify(idea.state)}`);
  }
  if (idea.confidence !== undefined && !CONFIDENCES.has(idea.confidence)) {
    problems.push(`confidence must be one of ${[...CONFIDENCES].join(", ")}, got ${JSON.stringify(idea.confidence)}`);
  }
  if (idea.target !== undefined && typeof idea.target !== "string") problems.push("target must be a string");
  if (idea.source !== undefined && typeof idea.source !== "string") problems.push("source must be a string");
  if (idea.problem !== undefined && typeof idea.problem !== "string") problems.push("problem must be a string");
  if (idea.outcome !== undefined && typeof idea.outcome !== "string") problems.push("outcome must be a string");
  if (idea.notes !== undefined && typeof idea.notes !== "string") problems.push("notes must be a string");
  if (idea.githubIssue !== undefined && idea.githubIssue !== null) {
    problems.push("githubIssue must be null; non-null legacy submission provenance requires operator review");
  }
  if (!isCanonicalIso(idea.created)) {
    problems.push("created must be a canonical ISO timestamp");
  }
  if (!isCanonicalIso(idea.updated)) {
    problems.push("updated must be a canonical ISO timestamp");
  }
  return problems;
}

// `id` (`f-<hex8>`) -> `source`: `forgepad:f-xxxxxxxx`, original `source`
// value appended after "; " when present (section 10 row 1).
export function buildSource(idea) {
  const base = `forgepad:${idea.id}`;
  const original = typeof idea.source === "string" ? idea.source.trim() : "";
  return original ? `${base}; ${original}` : base;
}

// The single pure function this migration's correctness rests on: given one
// validated forgepad idea record, decide the exact intake.idea row it maps
// to (or that it must be skipped, for state=rejected). No I/O, no
// randomness, no Date.now() — fully deterministic and unit-testable in
// isolation, per this issue's testing bar.
export function mapForgepadIdea(idea) {
  const source = buildSource(idea);
  const idempotencyKey = forgepadIdempotencyKey(idea.id);

  // state=rejected -> not migrated (section 10 row: "intake has no rejected
  // state by design"). This check must come first: every other branch below
  // assumes a real target status exists, and (deliberately) throws for any
  // state value it does not recognize -- so if this early return were ever
  // deleted, every rejected fixture would start throwing instead of silently
  // producing a wrong row, which is what makes this ordering itself a cheap
  // mutation guard (see the "rejected short-circuits" tests).
  if (idea.state === "rejected") {
    return { skip: true, state: "rejected", id: idea.id, source };
  }

  const rawTarget = typeof idea.target === "string" ? idea.target.trim() : "";
  const targetIsRepo = rawTarget !== "" && OWNER_REPO_RE.test(rawTarget);
  const targetRepo = targetIsRepo ? rawTarget : null;

  let status = "draft";
  const prefixes = [];
  if (idea.state === "definite") {
    // requires target_repo, taken from `target` when it matches owner/repo;
    // else the row lands as draft with a "[needs repo]" note prefix.
    if (targetIsRepo) status = "idea";
    else prefixes.push("[needs repo]");
  } else if (idea.state === "research-needed") {
    prefixes.push("[research needed]");
  } else if (idea.state !== "draft") {
    throw new Error(`unrecognized forgepad state: ${JSON.stringify(idea.state)}`);
  }

  // `target` -> `target_repo` or `notes`: target_repo when it matches the
  // DDL pattern, otherwise appended to notes (section 10 row) so the raw
  // value is never silently dropped, in whichever state it occurs.
  const base = [...prefixes, idea.notes || ""].filter(Boolean).join(" ");
  const notes =
    !targetIsRepo && rawTarget !== ""
      ? base
        ? `${base}; target: ${rawTarget}`
        : `target: ${rawTarget}`
      : base;

  return {
    skip: false,
    state: idea.state,
    id: idea.id,
    idempotencyKey,
    source,
    title: idea.title,
    problem: idea.problem || "",
    outcome: idea.outcome || "",
    notes,
    confidence: idea.confidence || "medium",
    status,
    targetRepo,
    createdAt: idea.created,
    updatedAt: idea.updated,
  };
}

// Given the full set of mapped rows and the sources already present in
// intake.idea (from a prior run), splits into rows that still need
// inserting versus rows already migrated. Pure and DB-free on purpose so
// the idempotency decision itself is unit-testable without a live database
// (the live-database proof is the second-run-inserts-zero e2e test).
export function partitionNewRows(rows, existingSources) {
  const newRows = [];
  let alreadyPresent = 0;
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.idempotencyKey)) {
      throw new Error(`duplicate Forgepad idempotency key in input batch: ${row.idempotencyKey}`);
    }
    seen.add(row.idempotencyKey);
    if (existingSources.has(row.idempotencyKey)) alreadyPresent++;
    else newRows.push(row);
  }
  return { newRows, alreadyPresent };
}

// === File loading (validate/parse ALL files before any DB touch) ==========

// Reads every f-*.json file under ideasDir, JSON-parses and validates each.
// Deliberately collects every problem across every file rather than
// stopping at the first — the CLI's contract is "exits non-zero on any
// unparseable file without partial silence", which means the operator gets
// the complete bad-file list in one run, not a fix-one-rerun-find-the-next
// loop, and (more importantly) zero DB statements are ever built or run
// when any file is bad.
export function loadForgepadFiles(ideasDir) {
  if (!fs.existsSync(ideasDir)) {
    return { files: [], errors: [`ideas directory does not exist: ${ideasDir}`] };
  }
  if (!fs.statSync(ideasDir).isDirectory()) {
    return { files: [], errors: [`ideas path is not a directory: ${ideasDir}`] };
  }
  const names = fs
    .readdirSync(ideasDir)
    .filter((f) => f.startsWith("f-") && f.endsWith(".json"))
    .sort();

  const files = [];
  const errors = [];
  for (const name of names) {
    const full = path.join(ideasDir, name);
    let raw;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch (e) {
      errors.push(`${name}: cannot read file (${e.message})`);
      continue;
    }
    let idea;
    try {
      idea = JSON.parse(raw);
    } catch (e) {
      errors.push(`${name}: invalid JSON (${e.message})`);
      continue;
    }
    const problems = validateForgepadIdea(idea);
    const fileId = name.slice(0, -".json".length);
    if (idea && typeof idea === "object" && idea.id !== fileId) {
      problems.push(`filename id ${fileId} does not match content id ${idea.id}`);
    }
    if (problems.length) {
      errors.push(`${name}: ${problems.join("; ")}`);
      continue;
    }
    files.push({ name, idea });
  }
  return { files, errors };
}

// === Reporting ==============================================================

export function summarizeCounts(mappedRows) {
  const c = {
    draft: 0,
    definiteToIdea: 0,
    definiteToDraftNeedsRepo: 0,
    researchNeeded: 0,
    rejected: 0,
    rejectedIds: [],
  };
  for (const row of mappedRows) {
    if (row.skip) {
      c.rejected++;
      c.rejectedIds.push(row.id);
      continue;
    }
    if (row.state === "draft") c.draft++;
    else if (row.state === "definite" && row.status === "idea") c.definiteToIdea++;
    else if (row.state === "definite") c.definiteToDraftNeedsRepo++;
    else if (row.state === "research-needed") c.researchNeeded++;
  }
  return c;
}

function printCounts(counts, ideasDir, totalFiles) {
  console.log(`migrate-forgepad: scanned ${totalFiles} file(s) under ${ideasDir}`);
  console.log(`  draft                          : ${counts.draft}`);
  console.log(`  definite -> idea               : ${counts.definiteToIdea}`);
  console.log(`  definite -> draft [needs repo] : ${counts.definiteToDraftNeedsRepo}`);
  console.log(`  research-needed -> draft       : ${counts.researchNeeded}`);
  console.log(`  rejected (not migrated)        : ${counts.rejected}`);
  if (counts.rejectedIds.length) {
    console.log(`  rejected ids (operator review) : ${counts.rejectedIds.join(", ")}`);
  }
}

// === Database I/O (only reached for a real, non---dry-run invocation) =====

export function buildPsqlInvocation(databaseUrl, inheritedEnv = process.env) {
  const env = { ...inheritedEnv, PGDATABASE: databaseUrl };
  delete env.DATABASE_URL;
  return {
    args: ["-X", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-tA", "-q"],
    env,
  };
}

function runPsql(databaseUrl, sqlText) {
  const invocation = buildPsqlInvocation(databaseUrl);
  const result = spawnSync("psql", invocation.args, {
    encoding: "utf8",
    input: sqlText,
    timeout: 30000,
    // Keep the credential out of argv/process listings. Inherit the operator's
    // normal libpq controls, overriding only PGDATABASE with this invocation's
    // explicit target; child diagnostics never receive the URI as an argument.
    env: invocation.env,
  });
  if (result.error) {
    throw new Error(`migrate-forgepad: could not start psql: ${result.error.message}`);
  }
  return result;
}

export function buildImportSql(rows) {
  // JSON is base64-encoded before entering SQL, so arbitrary legacy text
  // (quotes, backslashes, CR/LF, Unicode, or SQL-looking strings) never
  // becomes SQL syntax. PostgreSQL performs the typed conversion.
  const payload = rows.map((row) => ({
    idempotency_key: row.idempotencyKey,
    title: row.title,
    problem: row.problem,
    outcome: row.outcome,
    notes: row.notes,
    confidence: row.confidence,
    source: row.source,
    target_repo: row.targetRepo,
    desired_status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }));
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  return `begin;
select pg_advisory_xact_lock(hashtextextended('migrate-forgepad-v1', 0));

do $$
begin
  if not exists (
    select 1 from pg_roles
    where rolname = current_user and (rolsuper or rolbypassrls)
  ) then
    raise exception 'migrate-forgepad requires a superuser or BYPASSRLS role';
  end if;
  if (select platform.owner()) is null then
    raise exception 'migrate-forgepad requires exactly one configured platform owner';
  end if;
end
$$;

create temporary table forgepad_import (
  idempotency_key uuid primary key,
  title text not null,
  problem text not null,
  outcome text not null,
  notes text not null,
  confidence text not null,
  source text not null,
  target_repo text,
  desired_status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

insert into forgepad_import
select *
from jsonb_to_recordset(convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb)
as payload(
  idempotency_key uuid,
  title text,
  problem text,
  outcome text,
  notes text,
  confidence text,
  source text,
  target_repo text,
  desired_status text,
  created_at timestamptz,
  updated_at timestamptz
);

do $$
begin
  if exists (
    select 1
    from forgepad_import expected
    join intake.idea actual using (idempotency_key)
    where actual.title is distinct from expected.title
       or actual.problem is distinct from expected.problem
       or actual.outcome is distinct from expected.outcome
       or actual.notes is distinct from expected.notes
       or actual.confidence is distinct from expected.confidence
       or actual.source is distinct from expected.source
       or actual.target_repo is distinct from expected.target_repo
       or actual.status is distinct from expected.desired_status
       or actual.user_id is distinct from (select platform.owner())
       or actual.created_at is distinct from expected.created_at
       or actual.updated_at is distinct from expected.updated_at
  ) then
    raise exception 'existing Forgepad row differs from the frozen import payload';
  end if;
end
$$;

create temporary table forgepad_inserted (id uuid primary key, idempotency_key uuid unique not null);

with inserted as (
  insert into intake.idea (
    idempotency_key, title, problem, outcome, notes, confidence,
    source, target_repo, user_id, created_at, updated_at
  )
  select idempotency_key, title, problem, outcome, notes, confidence,
         source, target_repo, (select platform.owner()), created_at, updated_at
  from forgepad_import
  on conflict (idempotency_key) do nothing
  returning id, idempotency_key
)
insert into forgepad_inserted select id, idempotency_key from inserted;

set local intake.preserve_updated_at = 'on';
update intake.idea actual
set status = 'idea', updated_at = expected.updated_at
from forgepad_import expected
join forgepad_inserted inserted using (idempotency_key)
where actual.id = inserted.id
  and expected.desired_status = 'idea';

commit;

select json_build_object(
  'inserted', (select count(*) from forgepad_inserted),
  'alreadyPresent', (select count(*) from forgepad_import) - (select count(*) from forgepad_inserted)
)::text;
`;
}

// Runs the whole batch of new rows in a single transaction: either every
// remaining row lands, or (ON_ERROR_STOP=1 stops the script before COMMIT,
// and Postgres rolls back the still-open transaction on disconnect) none
// do. Returns how many were actually inserted versus already present from a
// prior run.
export function insertRows(databaseUrl, rows) {
  if (!rows.length) return { inserted: 0, alreadyPresent: 0 };
  partitionNewRows(rows, new Set()); // fail before touching the DB on duplicate provenance IDs
  const result = runPsql(databaseUrl, buildImportSql(rows));
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `psql exited with status ${result.status}`).trim();
    const uncertain = result.signal ? "; commit outcome may be indeterminate, rerun to reconcile by provenance key" : "";
    throw new Error(`migrate-forgepad: import transaction failed${uncertain}: ${detail}`);
  }
  try {
    const counts = JSON.parse(result.stdout.trim());
    if (!Number.isInteger(counts.inserted) || !Number.isInteger(counts.alreadyPresent)) throw new Error("invalid counts");
    return counts;
  } catch {
    throw new Error(`migrate-forgepad: psql returned an invalid commit receipt: ${JSON.stringify(result.stdout)}`);
  }
}

// === CLI =====================================================================

export function parseArgs(argv) {
  const args = { accRoot: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--acc-root") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--acc-root requires a path");
      args.accRoot = value;
    }
    else if (a.startsWith("--acc-root=")) args.accRoot = a.slice("--acc-root=".length);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unrecognized argument: ${a}`);
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node apps/toolbelt/apps/idea-intake/tools/migrate-forgepad.mjs --acc-root <path> [--dry-run]",
      "",
      "  --acc-root <path>  ACC_ROOT whose forgepad/ideas/ directory holds f-*.json idea files.",
      "  --dry-run          Print per-state counts only; makes no database connection and inserts nothing.",
      "",
      "Without --dry-run, DATABASE_URL must be set to a libpq-recognized connection target",
      "(a bare local database name for peer/socket auth, or a postgres:// URI) reaching a",
      "database with the intake schema migration already applied, connected as a role that",
      "uses a PostgreSQL superuser or BYPASSRLS role. Plain table owners cannot bypass FORCE RLS.",
    ].join("\n"),
  );
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`migrate-forgepad: ${e.message}`);
    printUsage();
    return 1;
  }
  if (args.help) {
    printUsage();
    return 0;
  }
  if (!args.accRoot) {
    console.error("migrate-forgepad: --acc-root is required");
    printUsage();
    return 1;
  }

  const accRoot = path.resolve(args.accRoot);
  if (!fs.existsSync(accRoot) || !fs.statSync(accRoot).isDirectory()) {
    console.error(`migrate-forgepad: ACC root does not exist or is not a directory: ${accRoot}`);
    return 1;
  }

  const ideasDir = path.join(accRoot, "forgepad", "ideas");
  const { files, errors } = loadForgepadFiles(ideasDir);

  if (errors.length) {
    console.error(`migrate-forgepad: FAIL — ${errors.length} unparseable/invalid file(s), zero rows touched:`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  if (!files.length) {
    console.log(`migrate-forgepad: 0 forgepad idea file(s) found under ${ideasDir}; nothing to migrate.`);
    return 0;
  }

  const mapped = files.map(({ idea }) => mapForgepadIdea(idea));
  const counts = summarizeCounts(mapped);
  printCounts(counts, ideasDir, files.length);

  if (args.dryRun) {
    console.log("migrate-forgepad: dry run — no database connection made, no rows inserted.");
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("migrate-forgepad: FAIL — DATABASE_URL is not set; required for a real (non---dry-run) run.");
    return 1;
  }

  const toInsert = mapped.filter((row) => !row.skip);
  let result;
  try {
    result = insertRows(databaseUrl, toInsert);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  console.log(
    `migrate-forgepad: inserted ${result.inserted}, already migrated (skipped) ${result.alreadyPresent}, rejected (not migrated) ${counts.rejected}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
