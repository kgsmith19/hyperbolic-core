// Content generators for every file `tool:new` writes. Kept separate from
// scaffold.mjs's orchestration so each template can be unit-tested (and
// schema-validated) in isolation.
import { manifestHash } from "./manifests-shared.mjs";

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
        // TB-5 is fail closed: generated tools may write only their declared
        // schema. Shared-schema writes require a separately reviewed grant.
        read: hasSchema ? [schema] : [],
        write: hasSchema ? [schema] : [],
      },
      networkEgress: [],
      llmHandler: { access: llm === true },
    },
    lifecycle: {
      // Every schema-owning tool shares one physical database and one global
      // Supabase migration ledger. App directories also retain paired down
      // files, which must never be handed directly to `supabase db push`.
      // The root workflow discovers all owners, validates one global version
      // sequence, stages forward files only, and performs one push.
      migrate: hasSchema ? "gh workflow run platform-migrations.yml" : "none",
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
    ? `- Owns the \`${schema}\` schema in the shared toolbelt Supabase project. Write only within that schema. Cross-schema writes belong to the repository that owns the target schema.`
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
- This tool's own \`supabase/migrations/\` is picked up automatically by both \`apps/toolbelt/scripts/validate-migrations.mjs\` and the live \`platform-migrations.yml\` deployment workflow -- no manual edit to either is needed. Validate with \`npm run migrations:check\` from \`apps/toolbelt/\`; apply only through the root workflow so paired down files never enter the Supabase CLI ledger.`
      : ""
  }
- Run \`npm run manifests:check\` from \`apps/toolbelt/\` after any \`tool.json\` edit.
`;
}

// --- frontend/index.html (kind ui|hybrid only) ------------------------------

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
// frontend/index.html. Applied to every HTML interpolation site below, including
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
      "frontend/ (empty page shell consuming packages/ui)"). This tool's real UI
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
  return `-- Generated registration migration (docs/planning/05-c-toolbelt.md
-- section 4.2) for apps/toolbelt/apps/${id}/tool.json, produced by
-- packages/toolbelt-cli's tool:new (m3-03). Exactly one idempotent upsert of
-- the core.app row from tool.json fields, matching every hand-written
-- registration migration's own shape (apps/toolbelt/supabase/migrations/
-- 20260814130200_register_idea-intake-v0.1.1.sql,
-- 20260813173000_register_network-checker-v1.sql): status is deliberately
-- excluded from the conflict update, since registration must never overwrite
-- an independent lifecycle transition (building -> live -> retired) applied
-- after this row first existed. Version bumps regenerate this migration
-- (section 4.2), which is exactly what "on conflict (id) do update set"
-- gives for free: re-running the SAME manifest is a true no-op, and a NEW
-- registration migration for a version bump updates every other column in
-- place through the same upsert -- both are ordinary applications of this
-- one statement, not two different code paths.
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
  ${sqlLiteralOrNull(schema)},
  'building',
  ${sqlQuote(kind)},
  ${sqlLiteralOrNull(route)},
  ${sqlQuote(manifest.version)},
  ${sqlLiteralOrNull(manifest.description ?? null)},
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
