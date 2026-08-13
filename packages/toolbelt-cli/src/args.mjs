// Argument parsing and validation for `tool:new`, per
// docs/planning/05-c-toolbelt.md section 5.1's usage spec (quoted here so the
// two never drift silently):
//
//   Usage: npm run tool:new -- --id <tool-id> --name <display-name> --kind ui|cli|headless|hybrid
//                              [--schema <schema-name>]   default: <tool-id> with - replaced by _
//                              [--route /<path>]          required when kind is ui|hybrid
//                              [--no-schema]              tool owns no database schema
//                              [--llm]                    sets permissions.llmHandler.access = true
//                              [--dry-run]                print the plan, write nothing
//
//   Exit codes: 0 generated; 2 validation failure (id taken in core.app or on
//   disk, schema collision across manifests, bad flag combination); no
//   partial writes on failure.
//
// `--toolbelt-root <dir>` is an additional, UNDOCUMENTED flag not part of the
// public 5.1 usage spec above -- it exists purely so this package's own tests
// can exercise the real CLI binary end-to-end against a disposable fixture
// tree instead of the real apps/toolbelt/ (mirrors
// apps/toolbelt/scripts/validate-manifests.mjs's own `--root` flag and its
// stated reason). Never advertised in --help output or the usage string.
export const USAGE = `Usage: npm run tool:new -- --id <tool-id> --name <display-name> --kind ui|cli|headless|hybrid
                           [--schema <schema-name>]   default: <tool-id> with - replaced by _
                           [--route /<path>]          required when kind is ui|hybrid
                           [--no-schema]              tool owns no database schema
                           [--llm]                    sets permissions.llmHandler.access = true
                           [--dry-run]                print the plan, write nothing

Exit codes: 0 generated; 2 validation failure (id taken in core.app or on disk,
schema collision across manifests, bad flag combination); no partial writes on failure.`;

export const ID_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
export const SCHEMA_PATTERN = /^[a-z][a-z0-9_]*$/;
export const ROUTE_PATTERN = /^\/[a-z0-9/-]*$/;
export const KINDS = ["ui", "cli", "headless", "hybrid"];

export class ArgError extends Error {}

const FLAGS_WITH_VALUE = new Set(["--id", "--name", "--kind", "--schema", "--route", "--toolbelt-root"]);
const BOOLEAN_FLAGS = new Set(["--no-schema", "--llm", "--dry-run"]);

// Pure syntactic parse: recognizes flags and collects their values. Does not
// judge whether values are semantically valid (id shape, kind enum, route
// requirement) -- that is validateOptions's job, kept separate so a caller
// can parse once and validate against different rules if ever needed, and so
// tests can exercise each half independently.
export function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAGS_WITH_VALUE.has(arg)) {
      i += 1;
      if (i >= argv.length) throw new ArgError(`${arg} requires a value`);
      raw[arg] = argv[i];
    } else if (BOOLEAN_FLAGS.has(arg)) {
      raw[arg] = true;
    } else {
      throw new ArgError(`unrecognized argument: ${arg}`);
    }
  }

  return {
    id: raw["--id"],
    name: raw["--name"],
    kind: raw["--kind"],
    schema: raw["--schema"],
    route: raw["--route"],
    noSchema: raw["--no-schema"] === true,
    llm: raw["--llm"] === true,
    dryRun: raw["--dry-run"] === true,
    toolbeltRootOverride: raw["--toolbelt-root"],
  };
}

// Semantic validation. Returns an array of human-readable error strings
// (empty when options are valid). Never throws -- the caller decides what to
// do with a non-empty list (print + exit 2).
export function validateOptions(options) {
  const errors = [];

  if (!options.id) {
    errors.push("--id is required");
  } else if (!ID_PATTERN.test(options.id)) {
    errors.push(`--id "${options.id}" must match ${ID_PATTERN} (lowercase, digits, dashes; 3-64 chars; no leading/trailing dash)`);
  }

  if (!options.name) {
    errors.push("--name is required");
  } else if (options.name.length < 1 || options.name.length > 100) {
    errors.push("--name must be 1-100 characters (tool.schema.json name field)");
  }

  if (!options.kind) {
    errors.push("--kind is required");
  } else if (!KINDS.includes(options.kind)) {
    errors.push(`--kind must be one of ${KINDS.join("|")}, got "${options.kind}"`);
  }

  const kindNeedsRoute = options.kind === "ui" || options.kind === "hybrid";
  const kindForbidsRoute = options.kind === "cli" || options.kind === "headless";
  if (kindNeedsRoute && !options.route) {
    errors.push(`--route is required when --kind is ${options.kind}`);
  }
  if (kindForbidsRoute && options.route) {
    errors.push(`--route is not applicable when --kind is ${options.kind} (bad flag combination)`);
  }
  if (options.route && !ROUTE_PATTERN.test(options.route)) {
    errors.push(`--route "${options.route}" must match ${ROUTE_PATTERN}`);
  }

  if (options.schema && options.noSchema) {
    errors.push("--schema and --no-schema are mutually exclusive (bad flag combination)");
  }
  if (options.schema && !SCHEMA_PATTERN.test(options.schema)) {
    errors.push(`--schema "${options.schema}" must match ${SCHEMA_PATTERN}`);
  }

  return errors;
}

// Default schema name per the usage spec's own documented default: "<tool-id>
// with - replaced by _".
export function defaultSchemaName(id) {
  return id.replaceAll("-", "_");
}

export function resolveSchema(options) {
  if (options.noSchema) return { hasSchema: false, schema: null };
  const schema = options.schema || defaultSchemaName(options.id);
  return { hasSchema: true, schema };
}
