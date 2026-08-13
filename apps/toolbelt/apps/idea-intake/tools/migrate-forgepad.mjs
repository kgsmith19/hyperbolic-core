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
// project — passed straight through to `psql` as its dbname argument. This
// mirrors the spawnSync(...,"psql",...) pattern
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
  if (typeof idea.created !== "string" || Number.isNaN(Date.parse(idea.created))) {
    problems.push("created must be a parseable date string");
  }
  if (typeof idea.updated !== "string" || Number.isNaN(Date.parse(idea.updated))) {
    problems.push("updated must be a parseable date string");
  }
  // Finding 14 (independent review): mapForgepadIdea never copies
  // githubIssue anywhere in the intake.idea row (05-h section 10's mapping
  // table marks it "ignored" — reserved and never populated in forgepad's
  // own history, store.mjs's createIdea always initialized it null and no
  // promote-to-GitHub route was ever built). That is fine for the null case
  // this repo's entire git history actually contains, but a non-null value
  // would otherwise vanish through this importer with zero trace — the
  // exact "silently dropped" failure mode this file's own contract
  // (loadForgepadFiles's doc comment: "the CLI's contract is exits non-zero
  // on any unparseable file without partial silence") already refuses for
  // every other unexpected shape. Fail closed the same way: a non-null
  // githubIssue is a validation problem, not a silent pass-through.
  if (idea.githubIssue !== undefined && idea.githubIssue !== null) {
    problems.push(
      `githubIssue is ${JSON.stringify(idea.githubIssue)}, not null — this migration never carries it forward and must not silently drop it; resolve manually before migrating`,
    );
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
//
// Finding 11 (independent review): the ORIGINAL version of this function
// only deduped against `existingSources` (rows already committed from a
// PRIOR run) — it never deduped WITHIN one batch. Two forgepad files in the
// SAME run mapping to the same forgepad id (a malformed/duplicated fixture,
// or an operator copy-paste) would both sail past that check and both get
// handed to insertRows, landing as two rows for one idea. The dedupe key is
// `row.id` — the raw, immutable `f-<hex8>` forgepad id every mapped row
// carries (mapForgepadIdea copies `idea.id` straight through) — deliberately
// NOT `row.source`: `source` also embeds the idea's own optional, mutable
// original-source text, so two rows for the true same forgepad idea could
// still present different `source` strings and slip past a source-keyed
// check. First occurrence wins (stable, deterministic — same rule a real
// insert would apply by file-processing order); every later duplicate is
// counted in `duplicateInBatch` and never reaches insertRows at all.
export function partitionNewRows(rows, existingSources) {
  const seenIds = new Set();
  const deduped = [];
  let duplicateInBatch = 0;
  for (const row of rows) {
    if (seenIds.has(row.id)) {
      duplicateInBatch++;
      continue;
    }
    seenIds.add(row.id);
    deduped.push(row);
  }

  const newRows = [];
  let alreadyPresent = 0;
  for (const row of deduped) {
    if (existingSources.has(row.source)) alreadyPresent++;
    else newRows.push(row);
  }
  return { newRows, alreadyPresent, duplicateInBatch };
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
  if (!fs.existsSync(ideasDir)) return { files: [], errors: [] };
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

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPsql(databaseUrl, sqlText) {
  return spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-tA", "-q"], {
    encoding: "utf8",
    input: sqlText,
    timeout: 30000,
  });
}

function fetchExistingSources(databaseUrl, sources) {
  if (!sources.length) return new Set();
  const list = sources.map(sqlString).join(", ");
  const result = runPsql(databaseUrl, `select source from intake.idea where source in (${list});`);
  if (result.status !== 0) {
    throw new Error(`migrate-forgepad: failed to query existing intake.idea rows: ${(result.stderr || result.stdout).trim()}`);
  }
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// The exact conflict target of intake_idea_forgepad_source_ref
// (20260814050000_intake_forgepad_source_dedup.sql) — byte-identical to the
// index's own expression and partial predicate, which Postgres requires for
// ON CONFLICT to recognize it as the arbiter index at all.
const FORGEPAD_SOURCE_CONFLICT_TARGET =
  "(substring(source from '^forgepad:f-[0-9a-f]{8}')) where source like 'forgepad:f-________%'";

// INSERT always lands as 'draft' (the only status guard_idea_insert
// accepts, see the file header). Rows mapped to status='idea' promote with
// a SEPARATE top-level UPDATE statement, not a data-modifying WITH CTE
// bundled into the INSERT as one statement: Postgres data-modifying CTEs
// and the primary statement all execute against the SAME snapshot (per the
// CTE docs: "they cannot 'see' one another's effects on the target
// tables"), so `with inserted as (insert ... returning id) update ... where
// id = (select id from inserted)` silently updates ZERO rows -- the row the
// INSERT just created is invisible to the UPDATE's own table scan within
// that one statement, even though the id value itself is available from the
// CTE (found the hard way: the first real-Postgres e2e run of this file
// showed every "definite" fixture staying status='draft'). Two separate
// statements in the same transaction do not share a snapshot -- each gets a
// fresh one under READ COMMITTED -- so the UPDATE genuinely sees the row.
// The WHERE clause matches on `source`, which is unique within one
// migration batch by construction (each value embeds the file's own
// f-<hex8> id).
//
// Finding 11 (independent review): `ON CONFLICT ... DO NOTHING RETURNING
// source` closes the TOCTOU window fetchExistingSources's pre-check alone
// left open (two concurrent CLI runs could both pass that pre-check for the
// same forgepad idea, since it happens in its own psql invocation BEFORE
// this transaction opens). The arbiter is intake_idea_forgepad_source_ref
// (the migration above) — a real database uniqueness guarantee, not just an
// application-level check — so even if two runs' transactions race here,
// at most one INSERT actually lands; the loser's DO NOTHING makes that a
// silent, successful no-op instead of an aborted transaction. `RETURNING
// source` is how insertRows (below) tells a genuine insert apart from a
// conflict that resolved to nothing, so the reported "inserted" count stays
// accurate even under a real race, not just optimistic based on the
// pre-check.
//
// The promotion UPDATE's `where source = ... and status = 'draft'` stays
// correct even when this row's own INSERT lost the race: if some other
// process already inserted (and possibly already promoted) the same
// forgepad idea, this UPDATE either finds nothing to do (status is already
// 'idea', not 'draft') or redundantly re-applies an idempotent transition —
// never a wrong state.
//
// user_id is set to platform.owner() explicitly (never left to its
// auth.uid() default, which is null outside a PostgREST request) so the
// migrated row is visible to the real owner under the RLS owner-pin the
// moment this transaction commits.
function buildRowSql(row) {
  const cols = ["title", "problem", "outcome", "notes", "confidence", "source", "target_repo", "user_id", "created_at", "updated_at"];
  const values = [
    sqlString(row.title),
    sqlString(row.problem),
    sqlString(row.outcome),
    sqlString(row.notes),
    sqlString(row.confidence),
    sqlString(row.source),
    row.targetRepo === null ? "NULL" : sqlString(row.targetRepo),
    "(select platform.owner())",
    `${sqlString(row.createdAt)}::timestamptz`,
    `${sqlString(row.updatedAt)}::timestamptz`,
  ];
  const insertSql =
    `insert into intake.idea (${cols.join(", ")}) values (${values.join(", ")}) ` +
    `on conflict ${FORGEPAD_SOURCE_CONFLICT_TARGET} do nothing returning source;`;
  if (row.status === "idea") {
    return `${insertSql}\nupdate intake.idea set status = 'idea' where source = ${sqlString(row.source)} and status = 'draft';`;
  }
  return insertSql;
}

// Runs the whole batch of new rows in a single transaction: either every
// remaining row lands, or (ON_ERROR_STOP=1 stops the script before COMMIT,
// and Postgres rolls back the still-open transaction on disconnect) none
// do. Returns how many were actually inserted versus already present —
// counting BOTH rows the pre-check already knew about (`alreadyPresent`
// from partitionNewRows) and any row that lost a genuine TOCTOU race inside
// this very transaction (Finding 11: detected via the RETURNING clause
// buildRowSql adds to every INSERT, since ON CONFLICT DO NOTHING makes a
// raced row silently absent from the script's output instead of erroring).
export function insertRows(databaseUrl, rows) {
  if (!rows.length) return { inserted: 0, alreadyPresent: 0, duplicateInBatch: 0 };
  const existing = fetchExistingSources(databaseUrl, rows.map((r) => r.source));
  const { newRows, alreadyPresent, duplicateInBatch } = partitionNewRows(rows, existing);
  if (!newRows.length) return { inserted: 0, alreadyPresent, duplicateInBatch };

  const script = ["begin;", ...newRows.map(buildRowSql), "commit;"].join("\n");
  const result = runPsql(databaseUrl, script);
  if (result.status !== 0) {
    throw new Error(`migrate-forgepad: insert transaction failed, rolled back: ${(result.stderr || result.stdout).trim()}`);
  }
  const returnedSources = new Set(
    result.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const actuallyInserted = newRows.filter((r) => returnedSources.has(r.source)).length;
  const racedAway = newRows.length - actuallyInserted;
  return { inserted: actuallyInserted, alreadyPresent: alreadyPresent + racedAway, duplicateInBatch };
}

// === CLI =====================================================================

// Finding 12 (independent review): the ORIGINAL `--acc-root` branch below
// blindly consumed the next argv token with no check that it wasn't itself
// a flag. `--acc-root --dry-run` therefore silently set accRoot to the
// literal string "--dry-run" and left dryRun FALSE — a plausible operator
// typo (a forgotten path argument) that produced no parse error at all and
// went on to fail later in a confusing, indirect way (a bogus path passed
// to loadForgepadFiles). Any token starting with "--" is unambiguously not
// a path this tool would ever be given (a real ACC root is never named
// literally "--something"), so rejecting it here — the same "fail loud,
// name the problem" posture this file already uses everywhere else — turns
// a silent wrong-value bug into an immediate, actionable parse error.
function readFlagValue(argv, i, flagName) {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value, got ${JSON.stringify(value ?? "")}`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = { accRoot: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--acc-root") {
      args.accRoot = readFlagValue(argv, i, "--acc-root");
      i++;
    } else if (a.startsWith("--acc-root=")) args.accRoot = a.slice("--acc-root=".length);
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
      "bypasses PostgREST's authenticated grants (table owner / superuser / service role).",
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

  // Finding 12 (independent review): the ORIGINAL code built ideasDir
  // straight from `args.accRoot` with no check that accRoot itself exists,
  // so a genuinely nonexistent/mistyped absolute root (e.g. an operator
  // typo) and a legitimately-empty-but-real ACC checkout's forgepad/ideas/
  // both fell into the exact same `!files.length` branch below and printed
  // the identical clean "0 forgepad idea file(s) found ... nothing to
  // migrate" exit-0 message. That is the correct, harmless outcome for a
  // real fresh ACC root with no ideas yet — but for a typo'd path it is a
  // silent false "zero rows, all good" that could wrongly reassure an
  // operator deciding whether the Finding-10 Forgepad-deletion follow-up is
  // safe to run. Checking the root itself first turns the typo case into an
  // immediate, unambiguous, nonzero-exit error, while leaving the
  // real-empty-root case exactly as clean-exit-0 as before.
  const resolvedAccRoot = path.resolve(args.accRoot);
  if (!fs.existsSync(resolvedAccRoot) || !fs.statSync(resolvedAccRoot).isDirectory()) {
    console.error(`migrate-forgepad: FAIL — --acc-root does not exist or is not a directory: ${resolvedAccRoot}`);
    return 1;
  }

  const ideasDir = path.join(resolvedAccRoot, "forgepad", "ideas");
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
    `migrate-forgepad: inserted ${result.inserted}, already migrated (skipped) ${result.alreadyPresent}, ` +
      `rejected (not migrated) ${counts.rejected}, duplicate forgepad id within this run (skipped) ${result.duplicateInBatch}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
