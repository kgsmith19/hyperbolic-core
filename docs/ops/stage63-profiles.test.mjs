// node --test docs/ops/stage63-profiles.test.mjs (run from the repo root)
//
// S6 RED characterization (Issue #424): v5 extension-profile semantics from
// agent-engineering-standard @ 9e50c9c3518e5bed2ba93e194cb157a78ee0278d —
// tools/mcp_profile.py (Stage 21b MCP/connector profile + activation gate),
// tools/extensions_registry.py (catalog/profile/lock consistency, reserved
// keys, supply boundary) and tools/profile_compiler.py (Stage 20b
// metadata-first candidate selection; JIT body activation stays in
// agent-extensions, which owns the bodies).
//
// The oracle is stage63-profiles-golden.json, computed by the upstream Python
// at the pinned commit. The live half binds the contract to hyperbolic-core's
// real extension surface: the LifeOS read-only stdio MCP server, the root
// project.yaml, the tracked tree, and the SessionStart provisioning hook.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ADOPTION, FROZEN, GAP_SLICES, checkCapabilityExists, checkRegistrySet, checkReservedKeys,
  checkSupplyBoundary, provenance, selectCandidates, validateActivation, validateDescriptor,
  validateMcpProfile,
} from "./stage63-adoption-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const golden = JSON.parse(readFileSync(path.join(here, "stage63-profiles-golden.json"), "utf8"));

// --- Frozen contract shape ---------------------------------------------------

test("S6 · MCP profile contract is frozen: fields, transports, keys, allowlist, markers, limits", () => {
  const mcp = FROZEN.mcp_profile;
  assert.equal(mcp.SIBLING_CONTRACT_VERSION, "1.0.0");
  assert.deepEqual([...mcp.SERVER_FIELDS], [
    "name", "transport", "endpoint", "capabilities", "kind", "schema_bytes", "idempotent",
    "activated_at", "ttl_seconds",
  ]);
  assert.deepEqual([...mcp.TRANSPORTS], ["stdio", "http"]);
  assert.deepEqual([...mcp.KINDS], ["read", "write"]);
  assert.deepEqual([...mcp.PHASES], ["research", "task"]);
  assert.deepEqual({ ...mcp.TRANSPORT_KEYS }, { claude: "url", codex: "serverUrl", antigravity: "serverUrl", local: "url" });
  assert.deepEqual([...mcp.EGRESS_ALLOWLIST], ["localhost", "127.0.0.1", "github.com", "api.anthropic.com"]);
  assert.deepEqual(mcp.SECRET_MARKERS.map(([marker]) => marker), ["sk-ant-", "sk-", "xoxb-", "xoxp-", "ghp_", "AKIA", "AIza"]);
  assert.deepEqual({ ...mcp.ADVISORY_LIMITS }, { active_max: 2, candidate_max: 5, pilot_cap: 12, schema_bytes_max: 64 * 1024 });
});

test("S6 · registry and profile-compiler contracts are frozen", () => {
  assert.deepEqual([...FROZEN.extensions_registry.RESERVED_KEYS], ["adapters", "profile"]);
  assert.deepEqual([...FROZEN.extensions_registry.REGISTRY_REQUIRED], ["catalog", "profile", "lock"]);
  assert.equal(FROZEN.profile_compiler.CONTRACT_VERSION, "1.0.0");
  assert.deepEqual([...FROZEN.profile_compiler.DESCRIPTOR_FIELDS], [
    "name", "semantic_id", "description", "body_bytes", "body_tokens_est", "dependencies",
    "body_digest", "source_path",
  ]);
  assert.equal(FROZEN.profile_compiler.PROCESS_PLUS_DOMAIN_BUDGET, 2);
});

test("S6 · provenance names all three profile modules at the pinned SHA", () => {
  for (const module of ["mcp_profile", "extensions_registry", "profile_compiler"]) {
    assert.match(provenance(), new RegExp(`tools/${module}\\.py`));
    assert.match(golden._provenance, new RegExp(`tools/${module}\\.py`));
  }
  assert.match(golden._provenance, /9e50c9c3518e5bed2ba93e194cb157a78ee0278d/);
});

// --- Differential characterization against the upstream Python ----------------

for (const c of golden.mcp.activations) {
  test(`S6 · validateActivation matches upstream: ${c.label}`, () => {
    assert.deepEqual(validateActivation(c.server, c.profile), c.result);
  });
}

for (const c of golden.mcp.profiles) {
  test(`S6 · validateMcpProfile matches upstream: ${c.label}`, () => {
    assert.deepEqual(validateMcpProfile(c.profile), c.result);
  });
}

for (const c of golden.registry.sets) {
  test(`S6 · checkRegistrySet matches upstream: ${c.label}`, () => {
    assert.deepEqual(checkRegistrySet(c.record), c.violations);
  });
}

for (const c of golden.registry.capabilities) {
  test(`S6 · checkCapabilityExists matches upstream: ${c.label}`, () => {
    assert.deepEqual(checkCapabilityExists(c.selection, c.registry), c.violations);
  });
}

// The golden file is written with sorted keys, so JSON.parse hands the ports
// already-sorted objects. Replaying each mapping with reversed insertion order
// proves the ports sort like Python's sorted() instead of trusting key order.
const reversedKeys = (value) => (value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]))
  : value);

test("S6 · registry checks sort like Python, independent of key insertion order", () => {
  for (const c of golden.registry.sets) {
    assert.deepEqual(checkRegistrySet(reversedKeys(c.record)), c.violations, c.label);
  }
  for (const c of golden.registry.capabilities) {
    assert.deepEqual(checkCapabilityExists(reversedKeys(c.selection), c.registry), c.violations, c.label);
  }
});

for (const c of golden.registry.reserved) {
  test(`S6 · checkReservedKeys matches upstream: ${c.label}`, () => {
    assert.deepEqual(checkReservedKeys(c.config), c.violations);
  });
}

for (const c of golden.registry.supply) {
  test(`S6 · checkSupplyBoundary matches upstream: ${c.label}`, () => {
    assert.deepEqual(checkSupplyBoundary(c.files), c.violations);
  });
}

for (const c of golden.compiler.descriptors) {
  test(`S6 · validateDescriptor matches upstream: ${c.label}`, () => {
    assert.deepEqual(validateDescriptor(c.record), c.repairs);
  });
}

for (const c of golden.compiler.selections) {
  test(`S6 · selectCandidates matches upstream: ${c.label}`, () => {
    const options = { budgetTokens: c.budget, provider: c.provider };
    if (c.error !== undefined) {
      assert.throws(() => selectCandidates(c.descriptors, c.requests, options), (e) => e.message === c.error);
      return;
    }
    const result = selectCandidates(golden.compiler.catalog, c.requests, options);
    assert.deepEqual(
      { selected: result.selected, findings: result.findings, discovery_tokens: result.discovery_tokens,
        body_tokens_est: result.body_tokens_est, ok: result.ok },
      { selected: c.selected, findings: c.findings, discovery_tokens: c.discovery_tokens,
        body_tokens_est: c.body_tokens_est, ok: c.ok },
    );
    assert.equal(result.provider, c.provider, "the provider label is recorded for audit");
  });
}

test("S6 · golden corpus exercises every fail-closed class", () => {
  const findings = golden.mcp.activations.flatMap((c) => c.result.findings).join("\n");
  for (const fragment of ["missing required field", "transport must be", "kind must be", "schema_bytes",
    "secret exposure", "egress violation", "research phase", "idempotency", "stale session",
    "unparseable activated_at", "native tool wins", "no MCP transport key"]) {
    assert.ok(findings.includes(fragment), `no golden activation case exercises "${fragment}"`);
  }
  const selections = golden.compiler.selections.flatMap((c) => c.findings ?? [c.error]).join("\n");
  for (const fragment of ["ambiguous descriptor", "absent from discovery index", "one-process-plus-one-domain",
    "dependency cycle", "over budget", "duplicate capability"]) {
    assert.ok(selections.includes(fragment), `no golden selection case exercises "${fragment}"`);
  }
});

// --- hyperbolic-core's live extension surface -----------------------------------

const lifeosServer = path.join(root, "apps/lifeos/backend/src/mcp_server/server.py");

function lifeosDeclaration() {
  const source = readFileSync(lifeosServer, "utf8");
  const registered = source.match(/for _tool in \(([^)]*)\):\s*\n(?:.*\n)*?\s*mcp\.tool\(\)\(_tool\)/);
  assert.ok(registered, "LifeOS MCP tools must be registered through the single read-only tuple loop");
  assert.equal((source.match(/mcp\.tool\(/g) ?? []).length, 1, "a second registration path would bypass this binding");
  return {
    name: "lifeos", transport: "stdio", endpoint: "stdio:python -m mcp_server",
    capabilities: registered[1].split(",").map((name) => name.trim()).filter(Boolean),
    kind: "read", schema_bytes: 0, idempotent: true, activated_at: null, ttl_seconds: null,
  };
}

test("S6 · the LifeOS MCP server is a read-only stdio connector that activates even in research", () => {
  const declaration = lifeosDeclaration();
  assert.deepEqual(declaration.capabilities, ["list_types", "find", "get_entity", "history"],
    "a new LifeOS tool must be classified: a write tool changes kind and is refused during research");
  assert.match(readFileSync(lifeosServer, "utf8"), /mcp\.run\("stdio"\)/, "stdio only: no egress leg");
  for (const phase of ["research", "task"]) {
    assert.deepEqual(validateActivation(declaration, { phase, provider: "claude" }), { findings: [], warnings: [] });
  }
  assert.deepEqual(validateMcpProfile({ standing_servers: [], candidate_servers: [declaration] }),
    { findings: [], warnings: [] }, "zero standing servers: LifeOS is a candidate, activated per task");
  const asWrite = validateActivation({ ...declaration, kind: "write", idempotent: false }, { phase: "research" });
  assert.equal(asWrite.findings.length, 2, "the same server as a write connector is refused twice in research");
});

test("S6 · project.yaml keeps the reserved registry keys free", () => {
  const config = parseYaml(readFileSync(path.join(root, "project.yaml"), "utf8"));
  assert.deepEqual(checkReservedKeys(config), []);
});

test("S6 · the tracked tree holds no supply-side files and no committed capability layer", () => {
  const listing = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  const files = listing.stdout.split("\n").filter(Boolean);
  assert.ok(files.length > 100, "git ls-files must list the real tree");
  assert.deepEqual(checkSupplyBoundary(files), []);
  assert.deepEqual(files.filter((file) => /(^|\/)extensions\.lock$/.test(file)), [],
    "the catalog/profile/lock triple lives in agent-extensions, provisioned machine-globally");
});

test("S6 · extension rows are grounded; provisioning maps to the SessionStart hook", () => {
  const rows = Object.keys(ADOPTION).filter((key) => key.startsWith("extensions:"));
  assert.deepEqual(rows.sort(), [
    "extensions:mcp-activation-gate", "extensions:mcp-zero-standing", "extensions:profile-selection",
    "extensions:provisioning", "extensions:registry-consistency",
  ], "S6 contributes exactly five extension rows");
  assert.deepEqual(ADOPTION["extensions:provisioning"], { mechanism: ".claude/hooks/session-start.sh", gap: null });
  for (const key of rows) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null, `${key} must be mechanism XOR gap`);
    if (entry.mechanism !== null) assert.ok(existsSync(path.join(root, entry.mechanism)), `${key}: ${entry.mechanism}`);
    else assert.ok(GAP_SLICES.includes(entry.gap));
  }
});
