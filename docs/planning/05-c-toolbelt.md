# 05-c. Toolbelt as a Real Platform

Component plan for Toolbelt, realizing TB-1 through TB-4 of `03-v1-definition.md`. Names per `00-canonical-names.md`. Decisions here stay inside the ADR-04 complexity budget and the ADR-01 topology (`apps/toolbelt/apps/` for sub-apps, `packages/` for shared clients, `services/llm-handler` reserved for Handler A). Evidence labels per the engagement charter.

## 1. Current state summary

The health audit's Section 5 diagnosis is adopted verbatim as the problem statement [VERIFIED: docs/planning/02-health-audit.md section 5]. Toolbelt is a data spine without a platform layer:

| # | Missing element | Evidence |
| --- | --- | --- |
| 1 | Tool contract: no manifest, no declared inputs/outputs, no permissions model, no lifecycle hooks; `core.app` is a bare row (id, name, schema_name, status idea/building/live/retired, created_at) | [VERIFIED: apps/toolbelt/supabase/migrations/20260806190000_core_create_schema.sql lines 12-19] |
| 2 | Registry mechanics: exactly one app ever registered, by a hand-written migration; 32 of 33 seeded ideas never left status `idea` | [VERIFIED: migrations 20260807040000_register_prompt_organizer.sql; 20260806190300_seed_idea.sql] |
| 3 | Discovery and navigation: the root client is a single-file read-only backlog table; Prompt Organizer and the Network Checker dashboard live on separate ports with separate sign-ins; nothing enumerates or launches tools | [VERIFIED: apps/toolbelt/web/index.html, 161 lines; apps/toolbelt/AGENTS.md commands] |
| 4 | Lifecycle: adding a tool is roughly 8 manual steps touching 3+ files outside the new app plus out-of-band SQL | [VERIFIED: 02-health-audit.md section 5 item 4, reconstructed in the toolbelt inventory] |
| 5 | Shared runtime: every client hand-rolls its own Supabase fetch wrapper; no package manifest exists anywhere in the toolbelt tree | [VERIFIED: file scan; apps/toolbelt/README.md "no package manifest" posture] |

Open defect owned here: D-05, the root idea client's browser logic is untested [VERIFIED: 02-health-audit.md D-05]. Resolution in Section 9: the file is deleted, not tested.

## 2. V1 target state

Toolbelt becomes the platform layer of hyperbolic-core: a formal tool contract (`tool.json`), a registry that is the single source of discovery truth (`core.app`, extended), a 3-step new-tool lifecycle, and shared client packages so no tool hand-rolls Supabase or LLM access again. The conclusion of the audit stands: the fix is not more tools, it is contract + registry + Shell integration, after which tools become cheap [VERIFIED: 02-health-audit.md section 5 conclusion].

Feature list with value and cost (estimates in engineer-hours for the implementation engagement; LOC in Section 12):

| # | Feature | Value statement | Cost estimate |
| --- | --- | --- | --- |
| F1 | Tool contract (`tool.json` + JSON Schema + validator) | Every tool becomes self-describing; permissions and lifecycle stop being tribal knowledge; TB-1 becomes checkable in CI | 8-12 h |
| F2 | Registry extension + generated registration | Discovery moves from hardcoded lists to one queryable table; TB-2 | 6-8 h |
| F3 | Scaffold CLI (3-step lifecycle) | New-tool cost drops from ~8 manual steps to 3; TB-3 | 10-14 h |
| F4 | Registry client in `packages/platform-client` | Shell and tools consume one typed client; kills per-app fetch wrappers over time | 4-6 h |
| F5 | Idea Intake sub-app | Flagship proof of F1-F4; full plan in `05-h-idea-intake.md` | see 05-h |
| F6 | Root idea-client deletion | Removes an untested, superseded surface (D-05) with negative LOC | 1 h |

ROI ranking (value per unit cost, highest first): F6, F2, F1, F4, F3, F5. F5 ranks last only because its cost is the largest; it is still mandatory (TB-4). All six ship in V1.

## 3. The tool contract: `tool.json`

### 3.1 Placement and rule

Every directory under `apps/toolbelt/apps/<id>/` carries a `tool.json` at its root, plus one at `apps/toolbelt/tool.json` for the root spine itself [VERIFIED: ADR-01 target tree shows per-tool `tool.json` manifests]. A tool without a valid manifest fails the Toolbelt PR Gate (TB-1).

### 3.2 JSON Schema (full, normative)

Stored at `apps/toolbelt/tool.schema.json`. Draft 2020-12.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://hyperbolic-core.invalid/schemas/tool.schema.json",
  "title": "Toolbelt tool manifest",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "name", "kind", "version", "ownership", "entry", "schemas", "permissions", "lifecycle"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,62}[a-z0-9]$",
      "description": "Registry key; equals core.app.id and the directory name under apps/toolbelt/apps/."
    },
    "name": { "type": "string", "minLength": 1, "maxLength": 100 },
    "kind": {
      "enum": ["ui", "cli", "headless", "hybrid"],
      "description": "ui: Shell-routed web surface. cli: operator-invoked command. headless: no human surface (see 3.3). hybrid: ui plus cli."
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Semver of the manifest's tool; bumped on any contract-visible change."
    },
    "description": { "type": "string", "maxLength": 500 },
    "ownership": {
      "type": "object",
      "additionalProperties": false,
      "required": ["owner", "path"],
      "properties": {
        "owner": { "const": "kylegsmith19@gmail.com" },
        "path": { "type": "string", "pattern": "^apps/toolbelt(/apps/[a-z0-9-]+)?$" }
      }
    },
    "entry": {
      "type": "object",
      "additionalProperties": false,
      "minProperties": 1,
      "properties": {
        "ui": {
          "type": "object",
          "additionalProperties": false,
          "required": ["route"],
          "properties": {
            "route": { "type": "string", "pattern": "^/[a-z0-9/-]*$", "description": "Shell route prefix, e.g. /ideas" },
            "dist": { "type": "string", "description": "Build output dir relative to the tool root; omitted for tools rendered by Shell pages" }
          }
        },
        "cli": {
          "type": "object",
          "additionalProperties": false,
          "required": ["command"],
          "properties": { "command": { "type": "string", "description": "Documented invocation, e.g. python3 -m netcheck" } }
        },
        "headless": {
          "type": "object",
          "additionalProperties": false,
          "required": ["command"],
          "properties": {
            "command": { "type": "string" },
            "schedule": { "type": "string", "description": "cron expression when the tool is timer-driven; absent for event-driven" }
          }
        }
      }
    },
    "schemas": {
      "type": "array",
      "items": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
      "uniqueItems": true,
      "description": "Database schemas this tool OWNS (writes DDL for). Exactly one writer per schema across all manifests; the validator enforces global uniqueness except for the root spine's core/idea ownership."
    },
    "permissions": {
      "type": "object",
      "additionalProperties": false,
      "required": ["db", "networkEgress", "llmHandler"],
      "properties": {
        "db": {
          "type": "object",
          "additionalProperties": false,
          "required": ["read", "write"],
          "properties": {
            "read": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
            "write": { "type": "array", "items": { "type": "string" }, "uniqueItems": true }
          }
        },
        "networkEgress": {
          "type": "array",
          "items": { "type": "string", "format": "hostname" },
          "uniqueItems": true,
          "description": "Exact hosts the tool contacts beyond the platform Supabase project. Empty array means no egress."
        },
        "llmHandler": {
          "type": "object",
          "additionalProperties": false,
          "required": ["access"],
          "properties": {
            "access": { "type": "boolean", "description": "Whether the tool may call the general-purpose LLM handler via packages/llm. Never grants Brain key access; see ADR-05." },
            "maxUsdPerDay": { "type": "number", "exclusiveMinimum": 0 }
          }
        }
      }
    },
    "lifecycle": {
      "type": "object",
      "additionalProperties": false,
      "required": ["migrate", "health", "register"],
      "properties": {
        "migrate": { "type": "string", "description": "Command applying this tool's supabase/migrations, or 'none' for schema-less tools" },
        "health": { "type": "string", "description": "Command or URL path that exits 0 / returns 200 when the tool is healthy (system-wide observability rule, 03-v1-definition.md)" },
        "register": { "type": "string", "description": "Path of the generated registration migration relative to apps/toolbelt/supabase/migrations/" }
      }
    }
  }
}
```

Declared-permission enforcement level, stated plainly: in V1 the manifest permissions are validated for shape and consistency (a schema listed in `permissions.db.write` must exist; egress hosts must be exact hostnames) and are enforced by review plus the registry parity check, not by a runtime sandbox [INFERRED: ADR-06 defers structural egress control past V1; RLS remains the actual data boundary per apps/toolbelt/AGENTS.md]. The manifest makes drift visible and auditable; it does not yet make it impossible.

### 3.3 May a tool be headless? Yes

A headless tool is a registered tool with `kind: "headless"`: no Shell route, no operator CLI ergonomics. Definition:

- It has no `entry.ui`; the Shell renders it on the tools status page (name, status, last health result), never in navigation.
- It runs either on a schedule (`entry.headless.schedule`, executed by the platform's existing scheduling surface: pg_cron inside the toolbelt Supabase project, the pattern already used by core event retention [VERIFIED: migration 20260808120000_core_event_retention.sql]) or event-driven as a subscriber/writer against the core spine.
- It must still declare `lifecycle.health` and write `core.run` rows for every execution so cost and outcome attribution work (system-wide observability definition [VERIFIED: 03-v1-definition.md]).
- It is registered in `core.app` exactly like a ui tool; headless is a presentation property, not a registry exemption.

## 4. Registry and discovery

### 4.1 Extending `core.app`

Current shape: `id text pk, name text, schema_name text, status text check (idea|building|live|retired), created_at` [VERIFIED: 20260806190000_core_create_schema.sql lines 12-19]. One migration pair extends it (DDL is the contract; the implementation engagement writes the paired down migration per toolbelt rules [VERIFIED: apps/toolbelt/AGENTS.md migration pairing rule]):

```sql
alter table core.app
  add column kind          text not null default 'ui'
             check (kind in ('ui','cli','headless','hybrid')),
  add column route         text,
  add column version       text not null default '0.0.0',
  add column description   text,
  add column manifest      jsonb,
  add column manifest_hash text,
  add column registered_at timestamptz;

comment on column core.app.manifest is
  'Verbatim tool.json at registration time; the file in the repo is authoritative, this copy serves discovery.';
```

Existing rows need one data migration line setting `kind`/`route` for `prompt-organizer` (the single registered app [VERIFIED: 20260807040000_register_prompt_organizer.sql]). RLS on `core.app` is already enabled and forced [VERIFIED: 20260806190200_rls_baseline.sql]; ADR-03 later pins policies to the owner UUID, which changes policies, not this table shape.

### 4.2 Registration mechanism: generated migration, not hand SQL

Registration is a generated migration pair, produced by the scaffold CLI (Section 5), never hand-written:

- File name contract: `apps/toolbelt/supabase/migrations/<utc-ts>_register_<tool-id>.sql` plus `_down.sql`.
- Content contract: exactly one idempotent upsert of the `core.app` row from `tool.json` fields (`insert ... on conflict (id) do update set name, schema_name, kind, route, version, description, manifest, manifest_hash, registered_at = excluded...`), mirroring the seed file's idempotency posture [VERIFIED: 20260806190300_seed_idea.sql "re-running leaves the table at 33 rows"].
- `manifest_hash` is the sha256 of the canonicalized `tool.json`; CI recomputes it and fails on mismatch, so the registry can never silently lag the manifest (TB-1 parity).
- Version bumps regenerate the registration migration; retirement is a generated migration setting `status = 'retired'`, never a delete (runs and costs reference `core.app.id` [VERIFIED: core schema FKs]).

### 4.3 Shell discovery contract

What the Shell queries: `core.app` through PostgREST, filtered to `status in ('building','live')`; rows with a non-null `route` render as navigation entries, rows without render on the tools status page. The Shell holds zero hardcoded tool lists (TB-2). The query rides the single ADR-03 session via `packages/platform-client`.

Registry client interface (TypeScript signatures only, per the style contract):

```ts
// packages/platform-client/src/registry.ts
export type ToolKind = "ui" | "cli" | "headless" | "hybrid";
export type ToolStatus = "idea" | "building" | "live" | "retired";

export interface RegisteredTool {
  id: string;
  name: string;
  schemaName: string;
  status: ToolStatus;
  kind: ToolKind;
  route: string | null;        // Shell route prefix; null for cli/headless
  version: string;
  description: string | null;
  manifestHash: string | null;
  registeredAt: string | null; // ISO timestamptz
}

export interface RegistryFilter {
  status?: ToolStatus[];
  kind?: ToolKind[];
}

export interface RegistryClient {
  listTools(filter?: RegistryFilter): Promise<RegisteredTool[]>;
  getTool(id: string): Promise<RegisteredTool | null>;
}

export declare function createRegistryClient(
  supabaseUrl: string,
  getAccessToken: () => Promise<string>
): RegistryClient;
```

## 5. New-tool lifecycle (TB-3): exactly 3 steps

| Step | Command | Effect |
| --- | --- | --- |
| 1. scaffold | `npm run tool:new -- --id <id> --name "<Name>" --kind <kind> [flags]` | Generates the tool directory, `tool.json`, schema-migration skeleton, and the registration migration pair. All writes land under the new tool directory plus the generated registration files, satisfying TB-3's edit boundary. |
| 2. migrate | `supabase db push` (from `apps/toolbelt/`) | Applies the new schema migration(s) to the platform Supabase project. |
| 3. register | same `supabase db push` batch applies the generated `register_<id>` migration; verification: `RegistryClient.getTool(id)` returns the row | The tool appears in Shell discovery with no Shell code change (TB-2). |

Steps 2 and 3 are separate migrations applied by one push; they remain distinct steps because register may be deferred (a tool can be built and tested before its row goes to `building`).

### 5.1 Scaffold CLI usage spec

Lives at `packages/toolbelt-cli/` (workspace bin `tool`, wired as the root `tool:new` script; ADR-01 already budgets the ~30-line workspace config [VERIFIED: 04-adrs.md ADR-01 decision]).

```
Usage: npm run tool:new -- --id <tool-id> --name <display-name> --kind ui|cli|headless|hybrid
                           [--schema <schema-name>]   default: <tool-id> with - replaced by _
                           [--route /<path>]          required when kind is ui|hybrid
                           [--no-schema]              tool owns no database schema
                           [--llm]                    sets permissions.llmHandler.access = true
                           [--dry-run]                print the plan, write nothing

Exit codes: 0 generated; 2 validation failure (id taken in core.app or on disk,
schema collision across manifests, bad flag combination); no partial writes on failure.
```

Generated layout (kind `ui` shown; `cli`/`headless` omit `web/`):

```
apps/toolbelt/apps/<id>/
  tool.json                                   (passes tool.schema.json)
  AGENTS.md                                   (boundary stub: schema ownership, commands)
  web/                                        (empty page shell consuming packages/ui)
  supabase/migrations/
    <ts>_<schema>_create_schema.sql           (schema skeleton: create schema, grants, RLS enable+force, owner policy per ADR-03)
    <ts>_<schema>_create_schema_down.sql
  tests/
    registration.test.mjs                     (asserts manifest validity and registry row parity)
apps/toolbelt/supabase/migrations/
  <ts>_register_<id>.sql                      (generated, Section 4.2)
  <ts>_register_<id>_down.sql
```

## 6. The general-purpose LLM handler: Toolbelt's relationship

Toolbelt does not host the handler. ADR-01 places it at `services/llm-handler` if `08-llm-handlers.md` decides to build (Handler A), "else absent" [VERIFIED: 04-adrs.md ADR-01 target tree]. The build-vs-adopt decision belongs to 08 and is deferred there in full; this artifact takes no position on it.

Toolbelt's relationship is fixed regardless of 08's outcome: tools consume the handler exclusively through the `packages/llm` client contract, declared per tool via `permissions.llmHandler` in `tool.json`. No tool holds a provider API key, and no tool can name the Brain key (ADR-05 makes that structural: the `/brain/` Infisical path is readable by exactly one machine identity [VERIFIED: 04-adrs.md ADR-05]). Idea Intake is the first consumer (II-4).

## 7. Idea Intake: the flagship sub-app

Idea Intake is the first tool built on the F1-F4 platform and its proof: scaffolded by the CLI, registered by generated migration, discovered by the Shell, consuming `packages/platform-client`, `packages/ui`, and `packages/llm`. It supersedes ACC's Forgepad [VERIFIED: 00-canonical-names.md Idea Intake row]. Everything else, including schema, state machine, GitHub contract, and migration of forgepad JSON, lives in `05-h-idea-intake.md` and is not duplicated here.

## 8. Additional tool candidates (ranked)

Source material: the 33-row seeded backlog [VERIFIED: apps/toolbelt/supabase/migrations/20260806190300_seed_idea.sql]. Ranked by ROI for a single operator; cost assumes the F1-F4 platform exists.

| Rank | Candidate (seed id) | Value statement | Cost estimate | ROI note |
| --- | --- | --- | --- | --- |
| 1 | Golden Goose (`golden-goose`) | Scores backlog ideas to surface the highest-value next build; directly attacks the 32-of-33-stuck-at-idea symptom; `idea.score` and `core.metric_def` already exist so it is mostly UI plus a scoring write path | 12-18 h, ~600 LOC | Highest: existing tables, small surface, compounds every later prioritization |
| 2 | Cost-Per-Outcome Tracker (`cost-per-outcome-tracker`) | Read-only dashboard over `core.cost`/`core.outcome`/`core.run_outcome`; the denominator for every ROI question the operator keeps asking | 8-12 h, ~400 LOC | High value per LOC, but today only Prompt Organizer writes runs [VERIFIED: 02-health-audit.md section 5 item 2], so it renders near-empty until the Brain and Handler A emit cost rows |
| 3 | Assumption Ledger (`assumption-ledger`) | Review UI plus write path for `core.assumption` (table already exists [VERIFIED: core schema DDL]); makes agentic-run assumptions verifiable instead of forgotten | 10-16 h, ~500 LOC | Good, but its writers are Brain-era agents; premature before 07 ships |
| 4 | Instruction Optimizer (`instruction-optimizer`) | Reads Prompt Organizer usage data and suggests prompt improvements via the LLM handler | 16-24 h, ~800 LOC | Depends on 05-d telemetry and 08 handler; the deferred-past-V1 list already parks eval-linked prompt work for the same reason [VERIFIED: 03-v1-definition.md deferred table] |
| 5 | Tiered Error-Logging (`tiered-error-logging`) | Portfolio-wide tiered error event log; highest-write-volume table and raw material for self-healing | 16-24 h, ~700 LOC | Foundational but valueless until multiple producers exist; belongs after the Brain emits events |
| 6 | Agent Provenance Graph (`agent-provenance-graph`) | Visualizes `core.event` lineage, "what led to what" | 20-30 h, ~1,000 LOC | Real value only at event volume; V2 material |

### 8.1 V1 verdict: zero beyond Idea Intake

Recommendation: no additional candidate ships in V1. Justification against the complexity budget and the brief's foundation-over-completeness constraint:

- V1 already spends its Toolbelt capacity on the platform layer (F1-F4) plus Idea Intake; every candidate above is cheaper after that layer exists, which is the point of building it first [INFERRED: audit conclusion that tools become cheap post-platform].
- Ranks 2, 3, 4, and 5 are data-starved until the Brain (07) and the LLM handler (08) produce runs, costs, events, and usage telemetry; shipping them now yields empty dashboards.
- Rank 1 (Golden Goose) is the only candidate whose data exists today, and it is the named first post-V1 build. It stays out of V1 because the complexity budget's headroom is already allocated to the Shell serving unit and the Brain daemon [VERIFIED: 04-adrs.md complexity budget table], and because Idea Intake plus Golden Goose in one cycle doubles the new-UI surface for zero foundation gain.

Condition to reverse: if Idea Intake lands materially under its LOC estimate and the implementation engagement has schedule headroom, Golden Goose is pre-approved as the one addition, capped at its Section 8 estimate.

## 9. Defect fixes and deletions

| Item | Action | LOC delta |
| --- | --- | --- |
| D-05 (root idea client untested) | Resolved by deletion, not by testing: `apps/toolbelt/web/index.html` is a read-only backlog table absorbed by the Shell's registry-driven views and Idea Intake's list surface | -161 [VERIFIED: wc -l apps/toolbelt/web/index.html] |
| Root `python3 -m http.server 8811` workflow | Removed from `apps/toolbelt/AGENTS.md` commands and README once the file is deleted | ~-10 (doc lines) |
| `apps/toolbelt/config.mjs` | Kept: the root Node test suite imports it [VERIFIED: 01-inventory.md; tests are live-Supabase]; it later becomes an input to `packages/platform-client` constants | 0 |
| Forgepad artifacts (ACC side) | Deleted after 05-h migration; owned by `05-b` and counted there, cross-referenced here for completeness | (-611 counted in 05-b/05-h) |

Deletion timing: the root client deletes in the same PR that lands the Shell's registry-driven tool list, never before, so the operator always has one working idea view.

## 10. Latency budgets (new paths)

| Path | Budget | Measurement |
| --- | --- | --- |
| Registry list query (`RegistryClient.listTools`, warm client) | p95 <= 200 ms | performance test over 50 calls, same harness pattern as Prompt Organizer's 100 ms-class read budgets [VERIFIED: apps/toolbelt/apps/prompt-organizer tests, performance suite] |
| Shell nav render from registry (session ready to nav painted) | p95 <= 300 ms | Playwright trace timing in the Shell e2e suite |
| Manifest validation in CI (all manifests) | <= 5 s total | CI step duration |
| Scaffold CLI end-to-end (`tool:new` on a scratch id) | <= 10 s | timed invocation in the CLI's own test |

## 11. Acceptance criteria (EARS, realizing TB-1..TB-4)

| # | Criterion (EARS) | Verification command |
| --- | --- | --- |
| TB-1a | Every tool directory shall carry a `tool.json` conforming to `apps/toolbelt/tool.schema.json`. | `npm run manifests:check` (validator over `apps/toolbelt/tool.json apps/toolbelt/apps/*/tool.json`) exits 0 |
| TB-1b | The registry shall list every registered manifest with a matching hash. | `select count(*) from core.app where status <> 'idea'` equals the manifest count with a generated registration migration; `npm run manifests:check -- --registry` recomputes each sha256 against `core.app.manifest_hash` and exits 0 |
| TB-2 | When a fixture manifest and its generated registration migration are added on a temp branch, the Shell shall list the fixture tool without any Shell code change. | scripted check: add fixture, `supabase db push`, Playwright asserts the nav/status entry, `git diff --stat apps/shell/` is empty |
| TB-3 | Adding a new tool shall require at most 3 steps with no file edits outside the new tool's directory except generated registration files. | run the Section 5 steps for a scratch tool; `git status --porcelain` shows paths only under `apps/toolbelt/apps/<id>/` and `apps/toolbelt/supabase/migrations/*register_<id>*` |
| TB-4 | Idea Intake shall be live per the II rows. | see `05-h-idea-intake.md` Section 12 |
| TB-5 | If a manifest declares a `permissions.db.write` schema owned by another manifest, then the validator shall fail. | `npm run manifests:check` against a deliberately colliding fixture exits non-zero |
| TB-6 | While a tool row has `status = 'retired'`, the Shell shall not render it in navigation. | SQL: set fixture row retired; Playwright asserts absence; SQL down-migration restores |

## 12. LOC delta

| Item | Added | Deleted |
| --- | --- | --- |
| `tool.schema.json` | ~180 | |
| Manifest validator + CI wiring | ~200 | |
| `core.app` extension migration pair | ~60 | |
| Generated registration migrations (4 tools: root spine, prompt-organizer, network-checker, idea-intake) | ~80 | |
| `packages/platform-client` (registry client + auth session helper share) | ~250 | |
| `packages/toolbelt-cli` scaffold | ~350 | |
| Root workspace config (ADR-01) | ~30 | |
| Root idea client + doc lines (Section 9) | | ~171 |
| Total (excluding Idea Intake, counted in 05-h) | ~1,150 | ~171 |

## Gate questions (batched, non-blocking)

1. Section 4.2 registers Network Checker in `core.app` (kind `cli`, no route) even though its data lives outside the platform Supabase project [VERIFIED: 01-inventory.md netcheck mirror row]. Confirm the operator wants it listed for discovery-completeness; excluding it is a one-line change to the plan.
2. The manifest's `permissions` block is review-enforced in V1, not runtime-enforced (Section 3.2). If the operator wants runtime egress enforcement for tools in V1, it displaces headroom per ADR-06's deferral note and must be said now.
3. Golden Goose is pre-approved as the single conditional addition (Section 8.1). Veto here if even the conditional slot should stay closed.

## Self-check (Section 10)

- Every factual claim labeled: PASS
- No implementation code produced: PASS (JSON Schema, DDL, CLI spec, and TS signatures only)
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: PASS (registry stays on the incumbent Supabase project; no new technology introduced; scaffold CLI is workspace-local Node)
- Machine-verifiable acceptance criteria: PASS (Section 11, exact commands)
- LOC delta reported: PASS (Section 12)
- Deletion list present: PASS (Section 9)
- Latency budgets stated for new paths: PASS (Section 10)
- Questions batched at the gate: PASS (3, non-blocking)
- Zero em dashes: PASS
- Complexity budget breaches: none (no new deployable unit, runtime, database, or auth flow; workspace tooling was pre-budgeted in ADR-01)
