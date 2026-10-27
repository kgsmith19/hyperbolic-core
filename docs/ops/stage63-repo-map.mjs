// Owning tool of hyperbolic-core's bounded repository map (Stage 63,
// docs:bounded-map-artifact).
//
//   node docs/ops/stage63-repo-map.mjs           print the map
//   node docs/ops/stage63-repo-map.mjs --write   regenerate docs/repo-map.json
//   node docs/ops/stage63-repo-map.mjs --check   exit 1 if the artifact is stale
//                                    (--check <file> checks that file instead)
//
// Edit docs/ops/repo-map-source.json (plane bindings and entries), never the
// artifact: docs/repo-map.json sits in the generated plane. The map orients an
// agent without loading the tree; it is never authoritative, the files are.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRepoMap } from "./stage63-adoption-lib.mjs";

export const MAP_SOURCE = "docs/ops/repo-map-source.json";
export const MAP_ARTIFACT = "docs/repo-map.json";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The artifact text, formatted as Python's json.dumps(map, indent=2) plus a newline.
export function renderRepoMap(source) {
  return `${JSON.stringify(buildRepoMap(source.entries, source.patterns), null, 2)}\n`;
}

// null when the committed artifact is current, else the repair message.
export function staleness(source, committed) {
  return committed === renderRepoMap(source)
    ? null
    : `repo-map: ${MAP_ARTIFACT} is stale; run node docs/ops/stage63-repo-map.mjs --write`;
}

function main(args) {
  const source = JSON.parse(readFileSync(path.join(root, MAP_SOURCE), "utf8"));
  const rendered = renderRepoMap(source);
  const target = path.join(root, MAP_ARTIFACT);
  if (args.includes("--write")) {
    writeFileSync(target, rendered);
    console.log(`repo-map: wrote ${MAP_ARTIFACT} (${source.entries.length} entries)`);
    return 0;
  }
  if (args.includes("--check")) {
    const named = args[args.indexOf("--check") + 1];
    const checked = named && !named.startsWith("--") ? path.resolve(named) : target;
    let committed = "";
    try {
      committed = readFileSync(checked, "utf8");
    } catch {
      committed = "";
    }
    const stale = staleness(source, committed);
    if (stale) {
      console.error(stale);
      return 1;
    }
    console.log(`repo-map: ${MAP_ARTIFACT} is current`);
    return 0;
  }
  process.stdout.write(rendered);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
