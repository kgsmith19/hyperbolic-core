#!/usr/bin/env node
// Aggregates every discovered tool.json manifest into broker-policy.json:
// the deny-by-default policy document services/broker/ (issue #185) will
// load at startup. Reuses validate-manifests.mjs's own manifest discovery
// (findManifestPaths) AND its schema validator (checkManifestShape)
// rather than re-walking the tree or re-validating -- every manifest is
// confirmed to conform to tool.schema.json (valid hostnames, a
// well-formed vaultKeys pattern, etc.) before any of it is aggregated,
// since this generator has no enforced ordering against `manifests:check`
// running first and must not trust unvalidated input on its own. Also
// validates its own final output against @hyperbolic/broker-contract's
// shape (issue #183) as defense in depth -- the same contract the broker
// itself checks proxied requests against.
//
// Deny-by-default lives one level up from here, in the broker itself
// (contract.mjs's isKnownCaller): a manifest absent from this document has
// no policy entry to be checked against at all. This generator's own job
// is narrower -- every DISCOVERED manifest gets an entry, even one that
// currently has zero egress hosts, zero vault keys, and no budget, because
// "discovered but declares nothing" and "never discovered" are different
// facts the broker should be able to tell apart later.
import { readFileSync, writeFileSync } from "node:fs";
import { findManifestPaths, checkManifestShape, checkManifestIdUniqueness } from "./validate-manifests.mjs";
import { validatePolicyDocument } from "@hyperbolic/broker-contract";

function loadJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// permissions.llmHandler.maxUsdPerDay is schema-gated behind access:true,
// but this reads maxUsdPerDay directly regardless of that flag: a caller
// with llmHandler.access:false and a stray maxUsdPerDay would be unusual
// (the schema doesn't forbid it) but should still surface here as-is,
// since it is this generator's job to report what a manifest DECLARES, not
// to second-guess it -- that judgment belongs to whoever reviews the
// generated policy or to the broker's own future enforcement logic.
export function policyEntryFor(manifest) {
  const permissions = manifest?.permissions || {};
  const maxUsdPerDay = permissions?.llmHandler?.maxUsdPerDay;
  return {
    allowedHosts: Array.isArray(permissions.networkEgress) ? [...permissions.networkEgress].sort() : [],
    vaultKeys: Array.isArray(permissions.vaultKeys) ? [...permissions.vaultKeys].sort() : [],
    maxUsdPerDay: typeof maxUsdPerDay === "number" ? maxUsdPerDay : null,
  };
}

// Throws rather than returning a partial document on any problem (unparsable
// JSON, a missing id, an ambiguous duplicate id, a manifest that fails
// tool.schema.json) -- a broker policy that silently dropped, merged, or
// accepted an unvalidated caller would be a deny-by-default failure
// masquerading as success, worse than refusing to generate at all.
export function generateBrokerPolicy(paths) {
  // Validated BEFORE aggregation, not left to whoever happens to run
  // `manifests:check` first: this generator is its own npm script
  // (`broker-policy:generate`), with no ordering dependency enforced
  // against `manifests:check`, so it must not trust that a caller's
  // networkEgress entries are well-formed hostnames, that its vaultKeys
  // entries match the schema's naming pattern, or that no two manifests
  // collide on id just because they parsed as JSON. Both checks are the
  // exact, already-tested validate-manifests.mjs functions manifests:check
  // itself uses (checkManifestShape covers "id" being present as a valid
  // string via tool.schema.json's own required/pattern; a hand-rolled
  // duplicate copy of either check here would be provably dead code once
  // these run first, and worse, an UNTESTED one).
  const failures = [...checkManifestShape(paths), ...checkManifestIdUniqueness(paths)];
  if (failures.length > 0) {
    throw new Error(
      `generate-broker-policy: ${failures.length} problem(s), refusing to generate a policy from unverified input:\n${failures.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  // Safe to load without a try/catch and to key by manifest.id without an
  // existence/type check: checkManifestShape above already proved every
  // path parses as JSON and has a schema-valid string id; checkManifestIdUniqueness
  // already proved no two paths share one.
  const doc = {};
  for (const path of paths) {
    const manifest = loadJSON(path);
    doc[manifest.id] = policyEntryFor(manifest);
  }

  // Sorted caller keys AND sorted array values inside each entry (done in
  // policyEntryFor already): the same manifest set always produces
  // byte-identical JSON regardless of filesystem readdir order or the
  // order hosts/vaultKeys happen to be listed in any one tool.json.
  const sorted = {};
  for (const id of Object.keys(doc).sort()) sorted[id] = doc[id];

  // Defense in depth, not currently reachable through this function's own
  // public API: tool.schema.json's networkEgress/vaultKeys/maxUsdPerDay
  // constraints (enforced above by checkManifestShape) are already at
  // least as strict as validatePolicyDocument's own shape check, so every
  // manifest that reaches this point already produces a valid entry.
  // Kept anyway -- unlike the "root is one of the owners" branch this
  // codebase removed elsewhere after mutation testing proved it dead,
  // this one guards against a FUTURE regression in policyEntryFor itself
  // (e.g. a new field added there without a matching schema constraint),
  // not a present-day possibility this diff's own fixtures can reach.
  const validation = validatePolicyDocument(sorted);
  if (!validation.ok) {
    throw new Error(`generate-broker-policy: generated an invalid policy document:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return sorted;
}

function parseArgs(argv) {
  const args = { out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      i += 1;
      if (i >= argv.length) throw new Error("--out requires a file path argument");
      args.out = argv[i];
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`generate-broker-policy: ${err.message}`);
    process.exit(2);
  }

  let policy;
  try {
    policy = generateBrokerPolicy(findManifestPaths());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const json = `${JSON.stringify(policy, null, 2)}\n`;
  if (args.out) {
    writeFileSync(args.out, json);
    console.log(`Wrote broker-policy.json for ${Object.keys(policy).length} caller(s) to ${args.out}`);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
