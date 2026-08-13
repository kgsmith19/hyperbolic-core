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
