import { test } from "node:test";
import assert from "node:assert/strict";
import { ArgError, parseArgs, validateOptions, defaultSchemaName, resolveSchema } from "../src/args.mjs";

// --- parseArgs (syntax only) ---------------------------------------------

test("parseArgs collects value flags and boolean flags", () => {
  const options = parseArgs(["--id", "foo-tool", "--name", "Foo Tool", "--kind", "ui", "--route", "/foo", "--llm"]);
  assert.equal(options.id, "foo-tool");
  assert.equal(options.name, "Foo Tool");
  assert.equal(options.kind, "ui");
  assert.equal(options.route, "/foo");
  assert.equal(options.llm, true);
  assert.equal(options.dryRun, false);
  assert.equal(options.noSchema, false);
});

test("parseArgs throws ArgError for an unrecognized flag", () => {
  assert.throws(() => parseArgs(["--bogus"]), ArgError);
});

test("parseArgs throws ArgError when a value flag is missing its value", () => {
  assert.throws(() => parseArgs(["--id"]), ArgError);
});

test("parseArgs recognizes --dry-run and --no-schema as booleans with no value consumed", () => {
  const options = parseArgs(["--id", "x", "--dry-run", "--no-schema"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.noSchema, true);
});

// --- validateOptions (semantics) ------------------------------------------

function validOptions(overrides = {}) {
  return {
    id: "scratch-tool",
    name: "Scratch",
    kind: "ui",
    route: "/scratch",
    schema: undefined,
    noSchema: false,
    llm: false,
    dryRun: false,
    ...overrides,
  };
}

test("validateOptions accepts a well-formed ui invocation", () => {
  assert.deepEqual(validateOptions(validOptions()), []);
});

test("validateOptions accepts a well-formed cli invocation with no route", () => {
  assert.deepEqual(validateOptions(validOptions({ kind: "cli", route: undefined })), []);
});

test("validateOptions requires --id", () => {
  const errors = validateOptions(validOptions({ id: undefined }));
  assert.ok(errors.some((e) => e.includes("--id is required")));
});

for (const badId of ["Not-Valid", "-leading-dash", "trailing-dash-", "ab", "UPPER", "has_underscore"]) {
  test(`validateOptions rejects a malformed --id: "${badId}"`, () => {
    const errors = validateOptions(validOptions({ id: badId }));
    assert.ok(errors.some((e) => e.includes("--id")), `expected an --id error for "${badId}", got: ${JSON.stringify(errors)}`);
  });
}

test("validateOptions requires --name", () => {
  const errors = validateOptions(validOptions({ name: undefined }));
  assert.ok(errors.some((e) => e.includes("--name is required")));
});

// Finding 90 (P2, security-severity, independent security review of this
// repo, re-verified against current HEAD): validateOptions previously only
// checked options.name.length, with no character-class or control-character
// restriction. A --name that is all-whitespace, or that contains a raw
// control character, is not a meaningful display name and must be rejected
// here -- independent of whatever HTML-escaping templates.mjs now also does
// at the point `name` is interpolated into generated markup.
test("validateOptions rejects a --name that is all whitespace (passes the length check but is not a meaningful name)", () => {
  const errors = validateOptions(validOptions({ name: "   " }));
  assert.ok(errors.some((e) => e.includes("whitespace")), `expected a whitespace-only --name error, got: ${JSON.stringify(errors)}`);
});

test("validateOptions rejects a --name containing a raw control character (tab)", () => {
  const errors = validateOptions(validOptions({ name: "Foo\tBar" }));
  assert.ok(errors.some((e) => e.includes("control character")), `expected a control-character --name error, got: ${JSON.stringify(errors)}`);
});

test("validateOptions rejects a --name containing a raw control character (embedded NUL byte)", () => {
  const errors = validateOptions(validOptions({ name: `Foo${String.fromCharCode(0)}Bar` }));
  assert.ok(errors.some((e) => e.includes("control character")), `expected a control-character --name error, got: ${JSON.stringify(errors)}`);
});

test("validateOptions rejects a --name containing a raw control character (embedded newline)", () => {
  const errors = validateOptions(validOptions({ name: "Foo\nBar" }));
  assert.ok(errors.some((e) => e.includes("control character")));
});

test("validateOptions accepts an ordinary --name containing punctuation and non-ASCII characters (control-char check does not over-reject)", () => {
  assert.deepEqual(validateOptions(validOptions({ name: "Kyle's Café Tool!" })), []);
});

test("validateOptions accepts a --name that merely CONTAINS an HTML-markup-shaped payload (this is a validation boundary, not an escaping boundary -- templates.mjs's escapeHtml is what actually neutralizes it)", () => {
  assert.deepEqual(validateOptions(validOptions({ name: "</title><script>alert(1)</script>" })), []);
});

test("validateOptions requires --kind and rejects an unknown kind", () => {
  assert.ok(validateOptions(validOptions({ kind: undefined })).some((e) => e.includes("--kind is required")));
  assert.ok(validateOptions(validOptions({ kind: "bogus" })).some((e) => e.includes("--kind must be one of")));
});

test("validateOptions requires --route when --kind is ui", () => {
  const errors = validateOptions(validOptions({ kind: "ui", route: undefined }));
  assert.ok(errors.some((e) => e.includes("--route is required")));
});

test("validateOptions requires --route when --kind is hybrid", () => {
  const errors = validateOptions(validOptions({ kind: "hybrid", route: undefined }));
  assert.ok(errors.some((e) => e.includes("--route is required")));
});

test("validateOptions rejects --route when --kind is cli (bad flag combination)", () => {
  const errors = validateOptions(validOptions({ kind: "cli", route: "/nope" }));
  assert.ok(errors.some((e) => e.includes("not applicable") && e.includes("bad flag combination")));
});

test("validateOptions rejects --route when --kind is headless (bad flag combination)", () => {
  const errors = validateOptions(validOptions({ kind: "headless", route: "/nope" }));
  assert.ok(errors.some((e) => e.includes("not applicable")));
});

test("validateOptions rejects a malformed --route", () => {
  const errors = validateOptions(validOptions({ route: "no-leading-slash" }));
  assert.ok(errors.some((e) => e.includes("--route")));
});

test("validateOptions rejects --schema together with --no-schema (bad flag combination)", () => {
  const errors = validateOptions(validOptions({ kind: "cli", route: undefined, schema: "widget", noSchema: true }));
  assert.ok(errors.some((e) => e.includes("mutually exclusive")));
});

test("validateOptions rejects a malformed --schema", () => {
  const errors = validateOptions(validOptions({ kind: "cli", route: undefined, schema: "Not_Valid!" }));
  assert.ok(errors.some((e) => e.includes("--schema")));
});

// Finding 89 (P2, independent security review of this repo, re-verified
// against current HEAD): both an explicit --schema and a --schema DEFAULTED
// from --id must be capped at Postgres's 63-byte NAMEDATALEN identifier
// limit -- Postgres silently TRUNCATES an over-limit identifier rather than
// erroring, so an uncapped name here could make the schema this CLI
// actually creates silently diverge from what its own generated
// tool.json/migration comments claim.

test("validateOptions accepts an explicit --schema of exactly 63 characters", () => {
  const schema63 = "s" + "c".repeat(62);
  assert.equal(schema63.length, 63);
  const errors = validateOptions(validOptions({ kind: "cli", route: undefined, schema: schema63 }));
  assert.deepEqual(errors, []);
});

test("validateOptions rejects an explicit --schema of 64 characters with a clear, specific error message", () => {
  const schema64 = "s" + "c".repeat(63);
  assert.equal(schema64.length, 64);
  const errors = validateOptions(validOptions({ kind: "cli", route: undefined, schema: schema64 }));
  assert.ok(
    errors.some((e) => e.includes("--schema") && e.includes("63") && /byte/i.test(e)),
    `expected a clear 63-byte-limit --schema error, got: ${JSON.stringify(errors)}`,
  );
});

test("validateOptions accepts a --schema that is an exact match for a reserved Postgres keyword (charset alone cannot forbid it; templates.mjs double-quotes the identifier in generated DDL instead)", () => {
  const errors = validateOptions(validOptions({ kind: "cli", route: undefined, schema: "order" }));
  assert.deepEqual(errors, []);
});

test("validateOptions accepts a 63-character --id whose DEFAULTED schema name (dash->underscore, same length) is exactly 63 characters", () => {
  const id63 = "a" + "b".repeat(61) + "c"; // 63 chars, matches ID_PATTERN
  assert.equal(id63.length, 63);
  const errors = validateOptions(validOptions({ id: id63, kind: "cli", route: undefined, schema: undefined }));
  assert.deepEqual(errors, []);
});

test("validateOptions rejects a 64-character --id whose DEFAULTED schema name would be 64 characters, with a clear error message, even though --id's own pattern permits 64 characters", () => {
  const id64 = "a" + "b".repeat(62) + "c"; // 64 chars, still matches ID_PATTERN
  assert.equal(id64.length, 64);
  const errors = validateOptions(validOptions({ id: id64, kind: "cli", route: undefined, schema: undefined }));
  assert.ok(
    errors.some((e) => e.includes(id64) && e.includes("63") && /byte/i.test(e)),
    `expected a clear default-schema-too-long error for a 64-char --id, got: ${JSON.stringify(errors)}`,
  );
});

test("validateOptions does NOT apply the defaulted-schema length check when an explicit --schema is given (the explicit-schema check above is what applies instead)", () => {
  const id64 = "a" + "b".repeat(62) + "c";
  const errors = validateOptions(validOptions({ id: id64, kind: "cli", route: undefined, schema: "short_schema" }));
  assert.deepEqual(errors, []);
});

test("validateOptions does NOT apply the defaulted-schema length check for --no-schema (no schema name is ever derived)", () => {
  const id64 = "a" + "b".repeat(62) + "c";
  const errors = validateOptions(validOptions({ id: id64, kind: "cli", route: undefined, schema: undefined, noSchema: true }));
  assert.deepEqual(errors, []);
});

test("validateOptions is silent (empty array) for every valid combination across all four kinds", () => {
  assert.deepEqual(validateOptions(validOptions({ kind: "ui", route: "/a" })), []);
  assert.deepEqual(validateOptions(validOptions({ kind: "cli", route: undefined })), []);
  assert.deepEqual(validateOptions(validOptions({ kind: "headless", route: undefined })), []);
  assert.deepEqual(validateOptions(validOptions({ kind: "hybrid", route: "/a" })), []);
});

// --- schema name defaulting -------------------------------------------

test("defaultSchemaName replaces every dash with an underscore", () => {
  assert.equal(defaultSchemaName("scratch-tool"), "scratch_tool");
  assert.equal(defaultSchemaName("a-b-c"), "a_b_c");
  assert.equal(defaultSchemaName("noop"), "noop");
});

test("resolveSchema uses the default schema name when --schema is not given", () => {
  assert.deepEqual(resolveSchema({ id: "scratch-tool", noSchema: false, schema: undefined }), {
    hasSchema: true,
    schema: "scratch_tool",
  });
});

test("resolveSchema honors an explicit --schema override", () => {
  assert.deepEqual(resolveSchema({ id: "scratch-tool", noSchema: false, schema: "custom" }), {
    hasSchema: true,
    schema: "custom",
  });
});

test("resolveSchema returns hasSchema:false for --no-schema", () => {
  assert.deepEqual(resolveSchema({ id: "scratch-tool", noSchema: true, schema: undefined }), {
    hasSchema: false,
    schema: null,
  });
});
