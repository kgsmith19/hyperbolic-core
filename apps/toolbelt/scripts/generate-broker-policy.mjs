#!/usr/bin/env node
// Aggregates every discovered tool.json manifest into broker-policy.json:
// the deny-by-default policy document services/broker/ (issue #185) will
// load at startup. Reuses validate-manifests.mjs's own manifest discovery
// (findManifestPaths) rather than re-walking the tree, and validates its
// own output against @hyperbolic/broker-contract's shape (issue #183) --
// the same contract the broker itself checks proxied requests against.
//
// Deny-by-default lives one level up from here, in the broker itself
// (contract.mjs's isKnownCaller): a manifest absent from this document has
// no policy entry to be checked against at all. This generator's own job
// is narrower -- every DISCOVERED manifest gets an entry, even one that
// currently has zero egress hosts, zero vault keys, and no budget, because
// "discovered but declares nothing" and "never discovered" are different
// facts the broker should be able to tell apart later.
import { readFileSync, writeFileSync } from "node:fs";
import { findManifestPaths } from "./validate-manifests.mjs";
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
// JSON, a missing id, a ambiguous duplicate id) -- a broker policy that
// silently dropped or merged a caller would be a deny-by-default failure
// masquerading as success, worse than refusing to generate at all.
export function generateBrokerPolicy(paths) {
  const doc = {};
  const errors = [];
  for (const path of paths) {
    let manifest;
    try {
      manifest = loadJSON(path);
    } catch (err) {
      errors.push(`${path}: invalid JSON (${err.message})`);
      continue;
    }
    if (typeof manifest.id !== "string" || manifest.id.length === 0) {
      errors.push(`${path}: missing a string "id" -- cannot become a policy caller key`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(doc, manifest.id)) {
      errors.push(`${path}: manifest id "${manifest.id}" is already claimed by another manifest -- refusing an ambiguous policy`);
      continue;
    }
    doc[manifest.id] = policyEntryFor(manifest);
  }
  if (errors.length > 0) {
    throw new Error(`generate-broker-policy: ${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  // Sorted caller keys AND sorted array values inside each entry (done in
  // policyEntryFor already): the same manifest set always produces
  // byte-identical JSON regardless of filesystem readdir order or the
  // order hosts/vaultKeys happen to be listed in any one tool.json.
  const sorted = {};
  for (const id of Object.keys(doc).sort()) sorted[id] = doc[id];

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
