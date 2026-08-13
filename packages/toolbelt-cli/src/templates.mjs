// Content generators for every file `tool:new` writes. Kept separate from
// scaffold.mjs's orchestration so each template can be unit-tested (and
// schema-validated) in isolation.
import { manifestHash } from "./manifests-shared.mjs";
import { defaultSchemaName } from "./args.mjs";

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlLiteralOrNull(value) {
  return value === null || value === undefined ? "null" : sqlQuote(value);
}

// Double-quotes a Postgres identifier per the standard SQL identifier-quoting
// rule (an embedded `"` is doubled, exactly like sqlQuote doubles an embedded
// `'` for string literals). Finding 89 (independent security review of this
// repo, re-verified against current HEAD): SCHEMA_PATTERN's charset cannot
// produce anything SQL-injection-capable, but it permits exact matches for
// fully-reserved Postgres keywords (`order`, `user`, `group`, `table`, ...),
// which would otherwise produce a schema name that is syntactically legal to
// this CLI but a parse error at `supabase db push` time. Quoting every
// schema identifier interpolated into DDL sidesteps that category of bug
// entirely -- more robust than maintaining a reserved-word blocklist, and a
// no-op change in meaning for a schema name that was never reserved to begin
// with.
function quoteIdent(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

// --- tool.json ------------------------------------------------------------

const CLI_COMMAND_TODO_PREFIX = "TODO: document";

function buildEntry({ kind, route, id }) {
  const cli = { command: `${CLI_COMMAND_TODO_PREFIX} apps/toolbelt/apps/${id}'s CLI invocation` };
  const headless = { command: `${CLI_COMMAND_TODO_PREFIX} apps/toolbelt/apps/${id}'s headless entry point` };
  switch (kind) {
    case "ui":
      return { ui: { route } };
    case "cli":
      return { cli };
    case "headless":
      return { headless };
    case "hybrid":
      return { ui: { route }, cli };
    default:
      throw new Error(`buildEntry: unknown kind "${kind}"`);
  }
}

// registerBasename: filename (no directory) of the generated registration
// migration, already computed by the caller (needs the registration
// timestamp, which templates.mjs does not itself decide).
//
// Field order matches tool.schema.json's own `properties` declaration order
// (id, name, kind, version, ownership, entry, schemas, permissions,
// lifecycle -- description is optional and omitted here, never emitted as
// null, since no --description flag exists in the 5.1 usage spec). This
// object is the SINGLE source for both the pretty tool.json file on disk and
// the compact `manifest` jsonb literal embedded in the registration
// migration (buildRegistrationUpSql below), so the two can never drift the
// way two independently hand-maintained copies could.
export function buildManifest({ id, name, kind, route, hasSchema, schema, llm, registerBasename }) {
  return {
    id,
    name,
    kind,
    version: "0.1.0",
    ownership: { owner: "kylegsmith19@gmail.com", path: `apps/toolbelt/apps/${id}` },
    entry: buildEntry({ kind, route, id }),
    schemas: hasSchema ? [schema] : [],
    permissions: {
      db: {
        // Precedent split, judgment call (flagged in the m3-03 implementation
        // report): a schema-owning tool defaults to write:[schema,"core"],
        // mirroring apps/toolbelt/apps/prompt-organizer/tool.json (the one
        // real schema-owning UI manifest, which writes core.run rows via
        // core.log_run per 05-c-toolbelt.md section 3.3's observability
        // requirement). A --no-schema tool defaults to read:[]/write:[],
        // mirroring apps/toolbelt/apps/network-checker/tool.json (the one
        // real no-schema manifest). Either default is schema-valid either
        // way; review (05-c section 3.2) is what actually enforces it.
        read: hasSchema ? [schema] : [],
        write: hasSchema ? [schema, "core"] : [],
      },
      networkEgress: [],
      llmHandler: { access: llm === true },
    },
    lifecycle: {
      // "none" for a schema-less tool (tool.schema.json's own description
      // for lifecycle.migrate); otherwise "supabase db push", matching
      // apps/toolbelt/apps/network-checker/tool.json's precedent.
      //
      // Historical note (accurate only up to Finding 26's fix, independent
      // security review of this repo, re-verified against current HEAD):
      // this used to be deliberately NOT "gh workflow run
      // platform-migrations.yml" (Prompt Organizer's value) because that
      // workflow's underlying directory list was a hardcoded 3-entry
      // literal (validate-migrations.mjs's old MIGRATION_DIRS) that could
      // never include a freshly scaffolded tool's own
      // apps/toolbelt/apps/<id>/supabase/migrations until a human edited it
      // by hand. That is no longer true: apps/toolbelt/scripts/
      // validate-migrations.mjs's discoverMigrationDirs() now finds this
      // exact directory automatically the moment this tool's own tool.json
      // (schemas non-empty) and its migrations directory both exist on
      // disk, and platform-migrations.yml's staging step
      // (stage-migrations.mjs's collectStagedFiles()) is driven by that
      // same discovery, with no workflow-file edit required. "supabase db
      // push" is kept as the default here anyway, deliberately: it remains
      // the correct LOCAL instruction for testing this tool's schema
      // against a live project before ever pushing, independent of how the
      // shared CI/deploy pipeline later discovers and applies it.
      migrate: hasSchema ? "supabase db push" : "none",
      health: 'node --test "tests/*.test.mjs"',
      register: registerBasename,
    },
  };
}

export function manifestToPrettyJSON(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function manifestToCompactJSON(manifest) {
  return JSON.stringify(manifest);
}

// --- AGENTS.md --------------------------------------------------------

export function buildAgentsMd({ id, name, hasSchema, schema }) {
  const schemaLine = hasSchema
    ? `- Owns the \`${schema}\` schema in the shared toolbelt Supabase project. Write only within that schema (plus \`core\`, for \`core.log_run\` if this tool logs runs). Cross-schema writes belong to the repository that owns the target schema.`
    : `- Owns no database schema (scaffolded with --no-schema). If that changes, re-run \`tool:new\`'s reasoning by hand: add a schema-creation migration pair and update \`tool.json\`'s \`schemas\`/\`permissions.db\` fields and \`lifecycle.migrate\`.`;

  return `# AGENTS.md

## Application purpose

TODO: describe what ${name} (\`${id}\`) does. This file was generated by
\`packages/toolbelt-cli\`'s \`tool:new\` (docs/planning/05-c-toolbelt.md section
5.1); it is a boundary stub, not a finished product doc -- replace this
paragraph once the tool has a real purpose.

## Product boundaries

${schemaLine}
- Treat row-level security as the authorization boundary; do not weaken RLS or grants to make a test pass.
- Keep every migration paired with a down migration that reverses the same change (existing toolbelt convention).
- \`ownership.owner\` in \`tool.json\` is fixed to \`kylegsmith19@gmail.com\` by \`tool.schema.json\`; do not change it.

## Commands

\`\`\`bash
node --test "tests/*.test.mjs"
\`\`\`

## Next steps (delete this section once done)

- Replace the \`${CLI_COMMAND_TODO_PREFIX}\` placeholder(s) in \`tool.json\`'s \`entry\` block with the real invocation once this tool has one.
- Give this tool a real \`description\` in \`tool.json\` (optional field, currently omitted -- no \`--description\` flag exists in the scaffold CLI).${
    hasSchema
      ? `
- This tool's own \`supabase/migrations/\` is picked up automatically by both \`apps/toolbelt/scripts/validate-migrations.mjs\` and the live \`platform-migrations.yml\` deployment workflow -- no manual edit to either is needed. Run \`supabase db push\` from this tool's own directory to apply its schema locally before relying on the automated push.`
      : ""
  }
- Run \`npm run manifests:check\` from \`apps/toolbelt/\` after any \`tool.json\` edit.
`;
}

// --- web/index.html (kind ui|hybrid only) ------------------------------

// Escapes the five characters that matter for safe interpolation into HTML
// text content (never attribute-value or script/style context, which this
// generator never interpolates into): `&` first (so it cannot double-escape
// entities produced by the other replacements), then `<` `>` `"` `'`.
// Finding 90 (P2, security-severity, independent security review of this
// repo, re-verified against current HEAD -- confirmed by reading the whole
// of this file before this fix: no escaping function existed anywhere in
// it): buildWebIndexHtml previously interpolated `name` (fully
// attacker/operator-controlled free text; only length-checked by
// validateOptions in args.mjs, no character-class restriction) raw into
// `<title>` and `<h1>`, so a --name of `</title><script>alert(1)</script>`
// would land as live, executable markup in the scaffolded tool's own
// web/index.html. Applied to every HTML interpolation site below, including
// `id` -- which is already ID_PATTERN-restricted to `[a-z0-9-]` and so needs
// no escaping to be safe today, but costs nothing to escape defensively here
// too, in case that pattern is ever loosened without this file being
// revisited.
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildWebIndexHtml({ id, name }) {
  const safeName = escapeHtml(name);
  const safeId = escapeHtml(id);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${safeName}</title>
  </head>
  <body>
    <!--
      Empty page shell placeholder generated by packages/toolbelt-cli's
      tool:new (docs/planning/05-c-toolbelt.md section 5.1 generated layout:
      "web/ (empty page shell consuming packages/ui)"). This tool's real UI
      is expected to consume packages/ui (design tokens + components, ADR-02)
      once the Shell absorbs this route; replace this placeholder before
      entry.ui.route in tool.json is considered live.
    -->
    <h1>${safeName}</h1>
    <p>Placeholder page for apps/toolbelt/apps/${safeId}. Not yet implemented.</p>
  </body>
</html>
`;
}

// --- apps/toolbelt/apps/<id>/supabase/migrations/<ts>_<schema>_create_schema.sql --

export function buildSchemaCreateSql({ id, schema }) {
  return `-- Schema skeleton generated by packages/toolbelt-cli's tool:new for
-- apps/toolbelt/apps/${id}/tool.json (docs/planning/05-c-toolbelt.md section
-- 5.1 generated layout: "schema skeleton: create schema, grants, RLS
-- enable+force, owner policy per ADR-03"). RLS is enabled per TABLE, not per
-- schema, and this scaffold creates no domain tables (it has no model to
-- generate), so there is nothing to enable RLS on yet. Add each real table in
-- its own migration and copy the owner-policy pattern below onto it -- the
-- live pattern this mirrors is
-- apps/toolbelt/supabase/migrations/20260812160000_core_idea_owner_pin.sql's
-- Pattern B (single-owner table with no user_id column):
--
--   alter table ${schema}.<table> enable row level security;
--   alter table ${schema}.<table> force row level security;
--   create policy owner_rw on ${schema}.<table>
--     for all to authenticated
--     using ((select auth.uid()) = (select platform.owner()))
--     with check ((select auth.uid()) = (select platform.owner()));
--
-- (Pattern A, for a table with its own user_id column, is the same
-- migration's core.run policy -- see that file.)
--
-- This migration does NOT expose ${schema} over PostgREST
-- (alter role authenticator set pgrst.db_schemas = ...): that line is not
-- part of 5.1's "schema skeleton" list above, and computing the current
-- authoritative schema list safely belongs with the migration that adds the
-- first real table, following
-- apps/toolbelt/apps/prompt-organizer/supabase/migrations/20260807020000_prompt_create_prompt.sql
-- as the concrete template (and remember to record the prior value in that
-- migration's own down file, same as that one does).
create schema ${quoteIdent(schema)};

-- Base Postgres grants; RLS (per-table, added later) is the actual
-- row-level boundary. Without these, PostgREST gets "permission denied for
-- schema ${schema}" even with correct RLS policies on a later table, since
-- GRANT and RLS are independent layers (mirrors
-- apps/toolbelt/supabase/migrations/20260806190100_idea_create_schema.sql).
grant usage on schema ${quoteIdent(schema)} to anon, authenticated, service_role;
alter default privileges in schema ${quoteIdent(schema)} grant all on tables to anon, authenticated, service_role;
alter default privileges in schema ${quoteIdent(schema)} grant all on sequences to anon, authenticated, service_role;
`;
}

export function buildSchemaCreateDownSql({ id, schema }) {
  return `-- Reverts the schema-creation migration generated for
-- apps/toolbelt/apps/${id}/tool.json. No tables exist yet at scaffold time
-- (the up migration creates none), so this only drops the schema itself.
drop schema if exists ${quoteIdent(schema)} cascade;
`;
}

// --- apps/toolbelt/apps/<id>/tests/registration.test.mjs -----------------

export function buildRegistrationTestMjs({ registerBasename }) {
  return `// Generated by packages/toolbelt-cli's tool:new (docs/planning/05-c-toolbelt.md
// section 5.1 generated layout: "tests/registration.test.mjs (asserts
// manifest validity and registry row parity)"). Mirrors
// apps/toolbelt/tests/registry-manifest-hash.test.mjs's proof, scoped to just
// this one tool: (1) this tool's own tool.json is schema-valid, and (2) the
// registration migration's literal manifest_hash equals manifestHash()
// recomputed fresh from that same tool.json, so the two can never silently
// drift apart (TB-1b parity).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifestShape, manifestHash } from "../../../scripts/validate-manifests.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = join(__dirname, "..");
const MANIFEST_PATH = join(TOOL_DIR, "tool.json");
const MIGRATION_PATH = join(TOOL_DIR, "..", "..", "supabase", "migrations", "${registerBasename}");

// The hash sits on its own line as a bare single-quoted 64-hex-char literal,
// same anchoring rationale as registry-manifest-hash.test.mjs: the whole
// trimmed line must be exactly this, so it cannot match a substring inside
// the much longer minified-JSON manifest literal on the preceding line.
const HASH_LINE_RE = /^\\s*'([0-9a-f]{64})',\\s*$/m;

test("tool.json conforms to tool.schema.json", () => {
  const failures = checkManifestShape([MANIFEST_PATH]);
  assert.deepEqual(failures, []);
});

test("the registration migration's literal manifest_hash equals manifestHash() over the real tool.json on disk", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const match = HASH_LINE_RE.exec(sql);
  assert.ok(match, "expected exactly one bare 64-hex-char single-quoted literal line in the migration");

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(
    match[1],
    manifestHash(manifest),
    "manifest_hash in the registration migration no longer matches tool.json -- regenerate the registration migration",
  );
});
`;
}

// --- apps/toolbelt/supabase/migrations/<ts>_register_<id>.sql -------------

// manifest: the exact object buildManifest returned (guarantees the `manifest`
// jsonb literal, the tool.json file on disk, and manifestHash() all derive
// from one in-memory source of truth -- see buildManifest's own comment).
export function buildRegistrationUpSql({ manifest, id, name, schema, kind, route }) {
  const compact = manifestToCompactJSON(manifest);
  const hash = manifestHash(manifest);
  // core.app.schema_name is declared `text not null`
  // (apps/toolbelt/supabase/migrations/20260806190000_core_create_schema.sql).
  // A --no-schema tool owns no real schema, so `schema` here is the JS value
  // null -- but sqlQuote(null) would stringify it via String(null) into the
  // four-character STRING literal 'null' before quoting, a value that
  // happened to satisfy the NOT NULL constraint by accident while meaning
  // nothing (Finding 88, independent security review of this repo,
  // re-verified against current HEAD). Instead, fall back to a nominal
  // registry-key identifier derived from the tool's own id, exactly matching
  // this repo's own existing precedent for a schema-less tool
  // (20260812250000_register_network-checker.sql: schema_name = 'netcheck',
  // "recorded here as a nominal identifier ... rather than a claim that a
  // `netcheck` schema exists in this project"). schema_name is therefore a
  // nominal registry key for tool identity when the tool owns no real
  // schema, never a live schema claim -- tool.json's own `schemas` array
  // (see buildManifest) stays correctly empty for a --no-schema tool
  // regardless of what lands in this column. id is already
  // ID_PATTERN-restricted ([a-z0-9-], no leading/trailing dash), so this can
  // never introduce a SQL-unsafe character; defaultSchemaName's
  // dash-to-underscore transform (the same transform args.mjs uses for the
  // default *real* schema name) keeps this value shaped like every other
  // schema_name in the table -- a valid unquoted Postgres identifier -- even
  // though, like 'netcheck', it names no schema that actually exists.
  const schemaName = schema === null || schema === undefined ? defaultSchemaName(id) : schema;
  return `-- Generated registration migration (docs/planning/05-c-toolbelt.md
-- section 4.2) for apps/toolbelt/apps/${id}/tool.json, produced by
-- packages/toolbelt-cli's tool:new (m3-03). The shape follows section 4.2's
-- contract exactly: one idempotent upsert of the core.app row from tool.json
-- fields, matching m3-02's hand-written precedent
-- (apps/toolbelt/supabase/migrations/20260812240000_register_prompt-organizer.sql).
--
-- This is a brand-new row: the scaffold CLI's collision check (id taken on
-- disk, id already claimed by a manifest, or id already claimed by an
-- existing *_register_<id>.sql on disk) refuses to generate this migration
-- at all if '${id}' were already registered, so the ON CONFLICT branch below
-- exists only to make a re-run of this same migration safe, never to avoid
-- clobbering someone else's insert (same posture as
-- 20260812250000_register_network-checker.sql). \`status\` is deliberately
-- absent from the UPDATE SET list: re-running registration must never
-- clobber a status a separate, dedicated status-transition migration set
-- (e.g. a future promotion to 'live', or retirement to 'retired').
--
-- manifest_hash is the sha256 hex digest of the canonicalized manifest
-- (RFC-8785-style key-sorted JSON, no insignificant whitespace), computed by
-- apps/toolbelt/scripts/validate-manifests.mjs's canonicalJSON/manifestHash
-- functions -- imported and called directly by the generator that wrote this
-- file, never reimplemented. apps/toolbelt/apps/${id}/tests/registration.test.mjs
-- asserts this literal string equals manifestHash() computed fresh over the
-- real manifest file on disk, so the two can never silently drift apart
-- (TB-1b parity, docs/planning/05-c-toolbelt.md section 11).
insert into core.app (
  id, name, schema_name, status, kind, route, version, description,
  manifest, manifest_hash, registered_at
)
values (
  ${sqlQuote(id)},
  ${sqlQuote(name)},
  ${sqlQuote(schemaName)},
  'building',
  ${sqlQuote(kind)},
  ${sqlLiteralOrNull(route)},
  ${sqlQuote(manifest.version)},
  null,
  ${sqlQuote(compact)}::jsonb,
  ${sqlQuote(hash)},
  now()
)
on conflict (id) do update set
  name          = excluded.name,
  schema_name   = excluded.schema_name,
  kind          = excluded.kind,
  route         = excluded.route,
  version       = excluded.version,
  description   = excluded.description,
  manifest      = excluded.manifest,
  manifest_hash = excluded.manifest_hash,
  registered_at = excluded.registered_at;
`;
}

export function buildRegistrationDownSql({ id }) {
  return `-- Reverts the registration migration generated for
-- apps/toolbelt/apps/${id}/tool.json. Does not delete the row even though
-- the up migration is what created it: m3-02's acceptance criteria require
-- that no migration ever delete a core.app row (docs/planning/05-c-toolbelt.md
-- section 4.2: "retirement is a generated migration setting status =
-- 'retired', never a delete" -- core.run, core.outcome, core.metric_value,
-- and core.assumption all carry a foreign key to core.app.id, and by the
-- time this down migration is ever actually run, real rows may already
-- reference '${id}'). Instead this reverts every column the up migration set
-- back to the bare defaults 20260812230000_core_app_registry_extension.sql
-- established, landing the row in the same "not really registered" shape a
-- fresh pre-manifest insert would have had (same posture as
-- 20260812250000_register_network-checker_down.sql, the precedent for a
-- brand-new row rather than a pre-existing one).
update core.app
set status        = 'idea',
    kind          = 'ui',
    route         = null,
    version       = '0.0.0',
    description   = null,
    manifest      = null,
    manifest_hash = null,
    registered_at = null
where id = ${sqlQuote(id)};
`;
}
