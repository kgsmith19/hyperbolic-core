// Proves the generated content is actually correct, not merely "looks
// plausible": every manifest this generator can produce is checked against
// the REAL tool.schema.json validator (imported, never reimplemented), and
// every registration migration's invariants are checked the same way
// apps/toolbelt/tests/registry-manifest-hash.test.mjs checks the real
// committed ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildManifest,
  manifestToPrettyJSON,
  manifestToCompactJSON,
  buildRegistrationUpSql,
  buildRegistrationDownSql,
  buildAgentsMd,
  buildWebIndexHtml,
  buildSchemaCreateSql,
  buildSchemaCreateDownSql,
  buildRegistrationTestMjs,
  escapeHtml,
} from "../src/templates.mjs";
import { checkManifestShape, manifestHash } from "../src/manifests-shared.mjs";

function checkShape(manifest) {
  const dir = mkdtempSync(join(tmpdir(), "toolbelt-cli-templates-test-"));
  try {
    const path = join(dir, "tool.json");
    writeFileSync(path, manifestToPrettyJSON(manifest));
    return checkManifestShape([path]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES = [
  { label: "ui with schema", opts: { id: "scratch-ui", name: "Scratch UI", kind: "ui", route: "/scratch-ui", hasSchema: true, schema: "scratch_ui", llm: false, registerBasename: "20260101000000_register_scratch-ui.sql" } },
  { label: "cli with schema", opts: { id: "scratch-cli", name: "Scratch CLI", kind: "cli", route: undefined, hasSchema: true, schema: "scratch_cli", llm: false, registerBasename: "20260101000000_register_scratch-cli.sql" } },
  { label: "cli without schema", opts: { id: "scratch-noschema", name: "Scratch No Schema", kind: "cli", route: undefined, hasSchema: false, schema: null, llm: false, registerBasename: "20260101000000_register_scratch-noschema.sql" } },
  { label: "headless without schema", opts: { id: "scratch-headless", name: "Scratch Headless", kind: "headless", route: undefined, hasSchema: false, schema: null, llm: true, registerBasename: "20260101000000_register_scratch-headless.sql" } },
  { label: "hybrid with schema and llm", opts: { id: "scratch-hybrid", name: "Scratch Hybrid", kind: "hybrid", route: "/scratch-hybrid", hasSchema: true, schema: "scratch_hybrid", llm: true, registerBasename: "20260101000000_register_scratch-hybrid.sql" } },
];

for (const { label, opts } of CASES) {
  test(`buildManifest(${label}) conforms to the real tool.schema.json`, () => {
    const manifest = buildManifest(opts);
    const failures = checkShape(manifest);
    assert.deepEqual(failures, [], `expected zero shape failures for ${label}, got: ${JSON.stringify(failures)}`);
  });

  test(`buildManifest(${label}) matches every input field`, () => {
    const manifest = buildManifest(opts);
    assert.equal(manifest.id, opts.id);
    assert.equal(manifest.name, opts.name);
    assert.equal(manifest.kind, opts.kind);
    assert.equal(manifest.ownership.owner, "kylegsmith19@gmail.com");
    assert.equal(manifest.ownership.path, `apps/toolbelt/apps/${opts.id}`);
    assert.deepEqual(manifest.schemas, opts.hasSchema ? [opts.schema] : []);
    assert.equal(manifest.permissions.llmHandler.access, opts.llm);
    assert.equal(manifest.lifecycle.register, opts.registerBasename);
    assert.equal(
      manifest.lifecycle.migrate,
      opts.hasSchema ? "gh workflow run platform-migrations.yml" : "none",
    );
    assert.ok(!("description" in manifest), "description must be omitted, never emitted as null");
  });
}

test("buildManifest(ui) sets entry.ui.route and no entry.cli", () => {
  const manifest = buildManifest(CASES[0].opts);
  assert.equal(manifest.entry.ui.route, "/scratch-ui");
  assert.equal(manifest.entry.cli, undefined);
});

test("buildManifest(hybrid) sets both entry.ui.route and entry.cli.command", () => {
  const manifest = buildManifest(CASES[4].opts);
  assert.equal(manifest.entry.ui.route, "/scratch-hybrid");
  assert.match(manifest.entry.cli.command, /^TODO: document/);
});

test("buildManifest(cli) sets entry.cli.command and no entry.ui", () => {
  const manifest = buildManifest(CASES[1].opts);
  assert.match(manifest.entry.cli.command, /^TODO: document/);
  assert.equal(manifest.entry.ui, undefined);
});

test("buildManifest(headless) sets entry.headless.command", () => {
  const manifest = buildManifest(CASES[3].opts);
  assert.match(manifest.entry.headless.command, /^TODO: document/);
});

test("a schema-owning tool defaults to least-privilege read/write for its owned schema only", () => {
  const manifest = buildManifest(CASES[0].opts);
  assert.deepEqual(manifest.permissions.db.read, ["scratch_ui"]);
  assert.deepEqual(manifest.permissions.db.write, ["scratch_ui"]);
});

test("a --no-schema tool defaults to empty read/write (mirrors network-checker)", () => {
  const manifest = buildManifest(CASES[2].opts);
  assert.deepEqual(manifest.permissions.db.read, []);
  assert.deepEqual(manifest.permissions.db.write, []);
});

test("manifestToPrettyJSON and manifestToCompactJSON both round-trip to the exact same object (verbatim/hash parity)", () => {
  const manifest = buildManifest(CASES[0].opts);
  assert.deepEqual(JSON.parse(manifestToPrettyJSON(manifest)), manifest);
  assert.deepEqual(JSON.parse(manifestToCompactJSON(manifest)), manifest);
});

// --- registration SQL -----------------------------------------------------

test("buildRegistrationUpSql embeds a manifest_hash that equals manifestHash() over the exact same manifest object", () => {
  const manifest = buildManifest(CASES[0].opts);
  const sql = buildRegistrationUpSql({ manifest, id: manifest.id, name: manifest.name, schema: "scratch_ui", kind: manifest.kind, route: "/scratch-ui" });
  const hash = manifestHash(manifest);
  assert.ok(sql.includes(`'${hash}'`), "expected the literal manifest_hash to appear in the generated SQL");
});

test("buildRegistrationUpSql embeds the exact compact JSON manifestToCompactJSON produces", () => {
  const manifest = buildManifest(CASES[0].opts);
  const sql = buildRegistrationUpSql({ manifest, id: manifest.id, name: manifest.name, schema: "scratch_ui", kind: manifest.kind, route: "/scratch-ui" });
  const compact = manifestToCompactJSON(manifest).replaceAll("'", "''");
  assert.ok(sql.includes(`'${compact}'::jsonb`));
});

test("buildRegistrationUpSql is exactly one idempotent ON CONFLICT (id) DO UPDATE upsert, matching every hand-written registration migration's own shape", () => {
  const manifest = buildManifest(CASES[1].opts);
  const sql = buildRegistrationUpSql({ manifest, id: manifest.id, name: manifest.name, schema: "scratch_cli", kind: manifest.kind, route: null }).toLowerCase();
  assert.match(sql, /insert\s+into\s+core\.app/);
  assert.match(sql, /on\s+conflict\s*\(\s*id\s*\)\s+do\s+update\s+set/);
  assert.match(sql, /'[0-9a-f]{64}'/);
  assert.match(sql, /manifest\s*=\s*excluded\.manifest\b/);
  assert.match(sql, /manifest_hash\s*=\s*excluded\.manifest_hash\b/);
  // status is deliberately excluded from the conflict update -- re-registering
  // must never overwrite an independent lifecycle transition applied after
  // this row first existed (matches every hand-written precedent's own rule).
  assert.doesNotMatch(sql, /status\s*=\s*excluded\.status/);
  assert.doesNotMatch(sql, /raise\s+exception/);
  assert.doesNotMatch(sql, /do\s+nothing/);
});

test("buildRegistrationUpSql sets route to a SQL NULL literal for a cli tool (no route)", () => {
  const manifest = buildManifest(CASES[1].opts);
  const sql = buildRegistrationUpSql({ manifest, id: manifest.id, name: manifest.name, schema: "scratch_cli", kind: manifest.kind, route: null });
  assert.match(sql, /'scratch-cli',\s*\n\s*'Scratch CLI',\s*\n\s*'scratch_cli',\s*\n\s*'building',\s*\n\s*'cli',\s*\n\s*null,/);
});

test("buildRegistrationUpSql emits SQL NULL, not the string 'null', for a no-schema tool", () => {
  const manifest = buildManifest(CASES[2].opts);
  const sql = buildRegistrationUpSql({ manifest, id: manifest.id, name: manifest.name, schema: null, kind: manifest.kind, route: null });
  assert.match(sql, /'scratch-noschema',\s*\n\s*'Scratch No Schema',\s*\n\s*null,\s*\n\s*'building'/);
  assert.doesNotMatch(sql, /\n\s*'null',\s*\n\s*'building'/);
});

test("buildRegistrationUpSql for a SCHEMA-OWNING tool is unaffected: schema_name is still the tool's real schema, not derived from id", () => {
  const manifest = buildManifest(CASES[0].opts);
  const sql = buildRegistrationUpSql({
    manifest,
    id: manifest.id,
    name: manifest.name,
    schema: "scratch_ui",
    kind: manifest.kind,
    route: "/scratch-ui",
  });
  assert.match(sql, /'scratch-ui',\s*\n\s*'Scratch UI',\s*\n\s*'scratch_ui',/);
});

test("buildRegistrationUpSql escapes an embedded single quote in --name safely", () => {
  const manifest = buildManifest({ ...CASES[1].opts, name: "Kyle's Tool" });
  const sql = buildRegistrationUpSql({ manifest, id: manifest.id, name: manifest.name, schema: "scratch_cli", kind: manifest.kind, route: null });
  assert.ok(sql.includes("'Kyle''s Tool'"), "expected the single quote to be doubled per SQL escaping convention");
  // And the string must still be syntactically well-formed enough that no
  // stray unescaped quote breaks out of the literal early.
  assert.doesNotMatch(sql, /Kyle's Tool/); // the RAW (unescaped) form must not appear anywhere
});

test("buildRegistrationUpSql never deletes a core.app row (m3-02 invariant)", () => {
  const manifest = buildManifest(CASES[0].opts);
  const sql = buildRegistrationUpSql({ manifest, id: manifest.id, name: manifest.name, schema: "scratch_ui", kind: manifest.kind, route: "/scratch-ui" }).toLowerCase();
  assert.doesNotMatch(sql, /delete\s+from\s+core\.app/);
});

test("buildRegistrationDownSql never deletes a core.app row and resets to the registry-extension bare defaults", () => {
  const sql = buildRegistrationDownSql({ id: "scratch-ui" }).toLowerCase();
  assert.doesNotMatch(sql, /delete\s+from\s+core\.app/);
  assert.match(sql, /set\s+status\s*=\s*'idea'/);
  assert.match(sql, /kind\s*=\s*'ui'/);
  assert.match(sql, /route\s*=\s*null/);
  assert.match(sql, /version\s*=\s*'0\.0\.0'/);
  assert.match(sql, /where\s+id\s*=\s*'scratch-ui'/);
});

// --- other generated files, sanity-checked for the values that matter ----

test("buildAgentsMd mentions the schema when the tool owns one", () => {
  const md = buildAgentsMd({ id: "scratch-ui", name: "Scratch UI", hasSchema: true, schema: "scratch_ui" });
  assert.match(md, /Owns the `scratch_ui` schema/);
});

test("buildAgentsMd notes no schema for a --no-schema tool", () => {
  const md = buildAgentsMd({ id: "scratch-noschema", name: "Scratch No Schema", hasSchema: false, schema: null });
  assert.match(md, /Owns no database schema/);
});

// Finding 26 (independent security review of this repo, re-verified against
// current HEAD): the scaffold CLI's OWN generated docs used to tell every
// tool author to manually edit validate-migrations.mjs's MIGRATION_DIRS and
// platform-migrations.yml -- exactly the "no outside edits" promise the
// finding says this contradicted. Now that discovery is automatic, this
// generated text must say so, not still ask for the manual edit.
test("buildAgentsMd's Next Steps never tells the operator to manually edit MIGRATION_DIRS or platform-migrations.yml (Finding 26: that manual edit is no longer needed)", () => {
  const md = buildAgentsMd({ id: "scratch-ui", name: "Scratch UI", hasSchema: true, schema: "scratch_ui" });
  assert.doesNotMatch(md, /MIGRATION_DIRS/);
  assert.doesNotMatch(md, /add .* to that workflow/);
  assert.doesNotMatch(md, /Run `supabase db push` from this tool/i);
  assert.match(md, /picked up automatically/);
  assert.match(md, /paired down files never enter the Supabase CLI ledger/);
});

test("buildAgentsMd's Next Steps omits the schema-discovery note entirely for a --no-schema tool (it has no migrations directory to be discovered)", () => {
  const md = buildAgentsMd({ id: "scratch-noschema", name: "Scratch No Schema", hasSchema: false, schema: null });
  assert.doesNotMatch(md, /picked up automatically/);
});

test("buildWebIndexHtml includes the tool's name and id", () => {
  const html = buildWebIndexHtml({ id: "scratch-ui", name: "Scratch UI" });
  assert.match(html, /<title>Scratch UI<\/title>/);
  assert.match(html, /apps\/toolbelt\/apps\/scratch-ui/);
});

// --- Finding 90 (P2, security-severity, independent security review of this
// repo, re-verified against current HEAD): buildWebIndexHtml used to
// interpolate `name` raw into both <title> and <h1> with no escaping
// function anywhere in templates.mjs. `id` is already ID_PATTERN-restricted
// and so cannot carry this payload, but is escaped defensively anyway. ---

test("escapeHtml escapes all five HTML-significant characters, & first so it cannot double-escape the others' output", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(escapeHtml("plain text"), "plain text");
});

test("buildWebIndexHtml HTML-escapes a --name containing a markup-injection payload: the raw <script> tag never appears in the emitted HTML", () => {
  const evilName = `</title><script>alert(1)</script>`;
  const html = buildWebIndexHtml({ id: "scratch-ui", name: evilName });

  // The literal, unescaped payload must not appear anywhere in the output.
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<\/title><script>/);

  // The escaped form must appear instead, in both interpolation sites
  // (<title> and <h1>). Plain substring checks (not a dynamically-built
  // RegExp) deliberately, since the payload's own `(` `)` characters would
  // otherwise be reinterpreted as regex grouping metacharacters.
  const escaped = "&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;";
  assert.ok(html.includes(`<title>${escaped}</title>`), "expected the escaped payload inside <title>");
  assert.ok(html.includes(`<h1>${escaped}</h1>`), "expected the escaped payload inside <h1>");

  // And the whole document must still be well-formed enough that exactly
  // ONE real <title> element exists and NO real <script> element exists
  // anywhere in the byte stream -- i.e. the payload did not manage to open a
  // second real <title> or inject a real <script> element.
  assert.equal((html.match(/<title>/g) ?? []).length, 1);
  assert.ok(!html.includes("<script"), "expected no literal <script substring anywhere in the emitted HTML");
});

test("buildWebIndexHtml HTML-escapes double and single quotes in --name (defense against a future attribute-context interpolation site)", () => {
  const html = buildWebIndexHtml({ id: "scratch-ui", name: `"onmouseover="alert(1)` });
  assert.doesNotMatch(html, /"onmouseover="alert\(1\)/);
  assert.match(html, /&quot;onmouseover=&quot;alert\(1\)/);
});

test("buildSchemaCreateSql creates exactly the given schema (double-quoted identifier) and grants usage to anon/authenticated/service_role", () => {
  const sql = buildSchemaCreateSql({ id: "scratch-ui", schema: "scratch_ui" });
  assert.match(sql, /create schema "scratch_ui";/);
  assert.match(sql, /grant usage on schema "scratch_ui" to anon, authenticated, service_role;/);
});

// Finding 89 (P2, independent security review of this repo, re-verified
// against current HEAD): SCHEMA_PATTERN's charset permits exact matches for
// fully-reserved Postgres keywords (order, user, group, table, ...), which
// would previously produce a syntax error only at `supabase db push` time,
// opaquely. Double-quoting the identifier everywhere it is interpolated
// into DDL sidesteps the whole category instead of maintaining a
// reserved-word blocklist.
test("buildSchemaCreateSql double-quotes a reserved-word schema name (--schema order) so every DDL statement stays syntactically valid", () => {
  const sql = buildSchemaCreateSql({ id: "order-tool", schema: "order" });
  assert.match(sql, /create schema "order";/);
  assert.match(sql, /grant usage on schema "order" to anon, authenticated, service_role;/);
  assert.match(sql, /alter default privileges in schema "order" grant all on tables to anon, authenticated, service_role;/);
  assert.match(sql, /alter default privileges in schema "order" grant all on sequences to anon, authenticated, service_role;/);
  // Never an UNQUOTED bare `order` immediately after `schema ` in a real
  // (non-comment) statement -- a bare match would be exactly the
  // reserved-word syntax-error case this fix exists to prevent.
  const codeLines = sql.split("\n").filter((line) => !line.trim().startsWith("--"));
  for (const line of codeLines) {
    assert.doesNotMatch(line, /schema order\b/i, `unexpected unquoted reserved-word schema reference: ${line}`);
  }
});

test("buildSchemaCreateSql never creates the reserved brain schema", () => {
  const sql = buildSchemaCreateSql({ id: "x", schema: "x" });
  assert.doesNotMatch(sql.toLowerCase(), /create\s+schema\s+(if\s+not\s+exists\s+)?brain\b/);
});

test("buildSchemaCreateSql's only platform.owner() mentions are inside line comments (never a bare call)", () => {
  const sql = buildSchemaCreateSql({ id: "x", schema: "x" });
  const codeLines = sql.split("\n").filter((line) => !line.trim().startsWith("--"));
  for (const line of codeLines) {
    assert.doesNotMatch(line, /platform\s*\.\s*owner\s*\(\s*\)/, `unexpected non-comment platform.owner() reference: ${line}`);
  }
});

test("buildSchemaCreateDownSql drops exactly the given schema (double-quoted identifier) and never touches core.app", () => {
  const sql = buildSchemaCreateDownSql({ id: "x", schema: "scratch_ui" });
  assert.match(sql, /drop schema if exists "scratch_ui" cascade;/);
  assert.doesNotMatch(sql.toLowerCase(), /core\.app/);
});

test("buildSchemaCreateDownSql double-quotes a reserved-word schema name (--schema order)", () => {
  const sql = buildSchemaCreateDownSql({ id: "order-tool", schema: "order" });
  assert.match(sql, /drop schema if exists "order" cascade;/);
});

test("buildRegistrationTestMjs embeds the given registration basename and is syntactically valid JS", () => {
  const content = buildRegistrationTestMjs({ registerBasename: "20260101000000_register_scratch-ui.sql" });
  assert.ok(content.includes("20260101000000_register_scratch-ui.sql"));
  // Syntax-check with `node --check` against a real temp .mjs file: ES module
  // import syntax needs module-aware parsing, which a bare vm.Script (classic
  // script parsing) does not do.
  const dir = mkdtempSync(join(tmpdir(), "toolbelt-cli-templates-test-"));
  try {
    const path = join(dir, "registration.test.mjs");
    writeFileSync(path, content);
    const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
