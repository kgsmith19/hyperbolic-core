# 04. Cross-Cutting Architecture Decision Records

Seven ADRs. Format per ADR: context, options (minimum three), decision with cost stated plainly, consequences, reversal trigger. Technology picks name maturity cost, migration cost, lock-in, and ecosystem gaps. Scores reference the Section 4 global constraints of the brief. Names per `00-canonical-names.md`. Evidence cites `01-inventory.md` and `02-health-audit.md`.

## Complexity budget declaration (binding for every later artifact)

| Dimension | V1 hard ceiling | Today | Headroom for V1 additions |
| --- | --- | --- | --- |
| Deployable units | 4 | 1 (LifeOS VPS stack) | Shell/gateway serving, Brain daemon, and nothing else |
| Distinct runtimes | 3 (Node 22, Python, browser) | 4 (adds PowerShell, operator-machine only) | PowerShell stays operator-local, outside deployables |
| Databases | 2 Supabase projects + SQLite (netcheck) + ACC local JSON stores | same | zero new database systems |
| Separate auth flows | 1 (plus documented break-glass) | 3 disjoint | consolidation is ADR-03's whole job |

Any proposal that breaches a ceiling must displace something and say so inline.

---

## ADR-01: Repository and folder topology

**Context.** The brief proposes splitting hyperbolic-core into a `backend` folder and a `UI` folder. Current state: an `apps/` monorepo with three subtree-imported apps, CI path-scoped at the root, zero root app code [VERIFIED: 01-inventory section 1]. LifeOS deploys from its standalone repo; that pipeline is live and load-bearing [VERIFIED: 01-inventory section 5].

**Options.**

| Option | Net LOC | Friction | Notes |
| --- | --- | --- | --- |
| A. backend/ + UI/ split (brief) | high churn: every app splits across two trees | breaks subtree provenance, breaks `apps/lifeos` mirror of the standalone repo, forces every CI path filter to change | organizes by technical layer, not by product; contradicts the brief's own "organize by sub-app" constraint |
| B. Keep `apps/` per-product layout; add `apps/shell/` and `packages/` for shared code | near zero churn; additions only | matches existing CI scoping; each app stays coherent and deletable | the incumbent, extended |
| C. Per-domain vertical slices across apps | massive reorganization | destroys app boundaries that currently map 1:1 to deploy and CI units | justified only at team scale; fails the single-reader test |

**Decision: Option B.** The backend/UI split is rejected; the brief's deeper constraint ("organize by sub-app unless a feature is global, and make it obvious what everything is") is exactly what the current layout does. Global features get `packages/`; the Shell is just another app. Cost of B: shared code in `packages/` introduces the repo's first workspace tooling (one root `package.json` with npm workspaces), an addition of roughly 30 lines of config. Score: minimal LOC wins outright; friction unchanged for existing apps.

**Target tree (to leaf level for new paths; existing app internals unchanged):**

```
hyperbolic-core/
  apps/
    agentic-command-center/      (unchanged internally; ui/ pages absorbed by shell over time)
    lifeos/                      (unchanged; standalone repo remains deploy source)
    shell/                       (NEW: React 19 + Vite 8 + Tailwind 4)
      src/
        main.tsx                 (route groups: /, /acc/*, /tools/*, /prompts/*, /ideas/*)
        auth/                    (single Supabase Auth session, ADR-03)
        nav/                     (chrome, command palette, ADR-02/09)
        pages/                   (shell-owned pages only)
      e2e/
      package.json
    toolbelt/
      guards/                    (unchanged)
      apps/
        prompt-organizer/        (unchanged location; UI reached through shell)
        network-checker/         (unchanged)
        idea-intake/             (NEW, 05-h)
          web/  supabase/migrations/  tests/  tool.json
      tool.json                  (NEW per-tool manifests, 05-c)
  packages/                      (NEW: shared, versionless workspace packages)
    ui/                          (design tokens + components, 09)
    llm/                         (general-purpose handler client contract, 08)
    platform-client/             (Supabase client + auth session helper, ADR-03)
  services/
    brain/                       (NEW: the Brain daemon, 07; deliberately not under apps/)
    llm-handler/                 (Handler A if 08 decides to build; else absent)
  docs/  TEMPLATES/  .github/workflows/  (as today, plus new scoped workflows per 10)
```

**File-move migration plan:** no existing file moves in V1. Additions only: `apps/shell/`, `packages/*`, `services/brain/`, `apps/toolbelt/apps/idea-intake/`, per-tool `tool.json` manifests. ACC's `ui/` pages migrate into the Shell as a later, mechanical port (each page is one file plus `api.ts` client calls [VERIFIED: acc inventory section 2]); until then the Shell links to them.

**Consequences.** Subtree provenance intact; `git log -- apps/<x>` keeps working; deletion stays cheap per app. **Reversal trigger:** if two or more apps need to share server-side code (not just clients), revisit with a `services/` consolidation ADR; the backend/UI split never becomes correct at single-operator scale.

---

## ADR-02: UI composition strategy (forced decision 2)

**Context.** One coherent product must present LifeOS, ACC, and Toolbelt. Existing UIs: LifeOS React app (7 pages, its own deploy), ACC React app (4 pages, loopback-served), three vanilla-HTML tool clients [VERIFIED: 01-inventory].

**Options scored** (navigation coherence / shared session / bundle size / build time / deploy independence / local dev friction / total LOC; + good, 0 neutral, - bad):

| Option | Nav | Session | Bundle | Build | Deploy indep. | Dev friction | LOC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A. Single app, route groups + shared library | + | + | 0 | - | - (LifeOS pipeline must merge) | + | + |
| B. Multi-zone: independent apps behind one origin | + (shared chrome via packages/ui) | + (same origin, same IdP) | + | + | + | 0 | 0 |
| C. Module federation | + | + | - | - | + | - | - |
| D. Web components | 0 | 0 | 0 | - | + | - | - |
| E. Iframes | - | - | + | + | + | 0 | + |

**Decision: Option B, multi-zone routing behind one origin, converging toward A.** Concretely: one origin (ADR-06/07) path-routes `/life/*` to the deployed LifeOS frontend and everything else to the Shell app; the Shell absorbs ACC's four pages and the Toolbelt tool UIs (they are small [VERIFIED: acc ui page list; toolbelt client inventory]); visual coherence comes from `packages/ui` consumed by both React apps. Tiebreaker over A: LifeOS's deploy pipeline lives in the standalone repo and is the only working production deployment in the system; merging it into a single-app build is rework the foundation does not need, and B leaves a mechanical later path to A (port pages, delete zone). Cost of B stated plainly: two React bundles, two builds, and a nav chrome that must be kept identical through the shared package; drift between zones is a real risk accepted in exchange for not touching the one working pipeline.

Technology named (Shell stack): React 19 + Vite 8 + Tailwind 4, matching both existing React apps [VERIFIED: package.json files]. Maturity cost: none, both stacks already in production here. Migration cost: near zero (same stack). Lock-in: React ecosystem, already committed. Ecosystem gaps: none relevant at this scale.

**Reversal trigger:** if zone drift produces two visibly different products despite `packages/ui` (operator judgment at first V1 review), collapse to Option A by porting LifeOS pages into the Shell.

---

## ADR-03: Authentication and authorization (forced decision 3)

**Context.** Non-negotiables from the brief: one session across every application; login at the Shell level; exactly one authorized principal (`kylegsmith19@gmail.com`); enforcement at every layer. Today: three disjoint models [VERIFIED: 01-inventory section 5]; LifeOS already implements the strongest pattern: Supabase Auth JWT, ES256 JWKS local verification, subject must equal the owner user id, fail closed [VERIFIED: src/api/auth.py].

**Options.**

| Option | Notes |
| --- | --- |
| A. Supabase Auth as platform IdP (one project's Auth is authoritative) | already proven in LifeOS; zero new services; password + TOTP available |
| B. Self-hosted IdP (Keycloak/Authentik) | new deployable unit, breaches the complexity budget for zero single-user gain |
| C. Tailscale identity only (no app login) | elegant for tailnet browsers, but no session for RLS, no CLI story against Supabase, and CI/programmatic callers are not tailnet users; also couples all authorization to network membership |

**Decision: Option A.** The toolbelt Supabase project (`woltgcggxaehtuypkxqk`) becomes the platform IdP: it already fronts the schemas the Shell's tools use, and Phase 6 consolidates new platform tables there. Design:

- One owner user in platform Auth whose email is `kylegsmith19@gmail.com`; sign-ups disabled (mirrors the LifeOS runbook procedure [VERIFIED: runbook one-time setup]).
- Session propagation: the Shell performs the single login; the session JWT is attached by `packages/platform-client` to every API call. Same origin (ADR-02) means one storage context; the LifeOS zone reads the same session via the shared package.
- Server-side enforcement points: LifeOS backend keeps its existing verifier but points `LIFEOS_SUPABASE_URL` (JWKS) and `LIFEOS_OWNER_USER_ID` at the platform project [VERIFIED: both are env-configurable, auth.py]. The Brain and Handler A verify the same JWKS and the same single subject. PostgREST enforces RLS with policies pinned to the owner UUID (not `authenticated`), which retires SEC-03's fixture-write exposure: fixture users keep rows only in a dedicated test schema (Phase 6).
- Single-principal simplification, stated per the brief: no roles, no orgs, no user tables, no invitation flows, no per-user RLS templates; every policy is `user_id = '<owner-uuid>'` or `auth.uid() = '<owner-uuid>'`; deny lists are unnecessary because no second principal can exist.
- Service-to-service: internal calls (Shell zone to LifeOS API, Brain programmatic surface) ride the tailnet and present either the operator session JWT or a scoped self-issued agent token following LifeOS's existing mint pattern [VERIFIED: mcp_server/tokens.py]; read-only scopes for anything automated.
- CLI auth: `brain` and tool CLIs read a pre-minted refresh token from the secrets backend (ADR-05) and exchange it locally; no password in argv or env.
- Failure mode: when the IdP is unreachable, everything fails closed except a documented break-glass: LifeOS `LIFEOS_AUTH_MODE=disabled` on localhost only, already implemented and logged [VERIFIED: auth.py], answering gate question 2 of `03-v1-definition.md`.

Cost stated plainly: LifeOS re-points identity to a different Supabase project, which invalidates existing sessions once and couples platform login availability to the toolbelt project's Auth uptime. Maturity cost: none (both projects already run Auth). Migration cost: one env change + owner-user creation + frontend login removal. Lock-in: Supabase Auth JWT format; mitigated by standard JWKS verification. Ecosystem gap: no first-class machine-to-machine tokens; covered by the self-issued agent-token pattern.

**Reversal trigger:** a second human principal ever needs access; that day, the single-UUID policies become a real IdP evaluation.

---

## ADR-04: Shared platform resources

**Context.** The brief requires reusing LifeOS-proven resources at the Shell level. Table is the deliverable.

| Resource | Owner | Global or per-app | Current location | Target location | Migration risk |
| --- | --- | --- | --- | --- | --- |
| Tailscale tailnet | platform (infra) | global | LifeOS deploy/ops/backup + VPS serve [VERIFIED: workflows] | unchanged; Shell and Brain surfaces join the same tailnet | low; additive serve routes |
| VPS + Docker Compose | platform | global | LifeOS `api` container + static frontend | same VPS gains the Shell static zone and the Brain container (within the 4-unit ceiling) | medium: one host hosts everything; backup/rollback procedures extend per 10 |
| Secrets backend (Infisical) | platform | global | LifeOS CI only [VERIFIED: ci.yml OIDC] | all CI and deploy-time injection for every unit | low; add machine identities |
| ACC vault (`vault.json`) | ACC | per-app, operator machine | plaintext local JSON | narrowed to operator-machine convenience values; never API keys after ADR-05 | low |
| Key storage for LLM keys | platform | global with hard Brain exception | LifeOS env via Infisical | Infisical paths per ADR-05, Brain path isolated | low |
| Deployment pipeline pattern (Infisical OIDC + tailnet join + docker save/ssh + compose) | platform | global | lifeos standalone ci.yml | copied as the template for Brain and Shell deploy jobs in hyperbolic-core (10) | low; proven pattern |
| Backups (age-encrypted artifacts) | platform | global | lifeos backup.yml | extended to Brain state store; toolbelt data lives in Supabase (its own backups) | low |
| GitHub Issues | platform | global | all repos | unchanged; Idea Intake writes here (05-h) | none |
| Postgres (Supabase lifeos project) | LifeOS | per-app | Supabase `vhbzblllaohuljtareza` | unchanged; LifeOS keeps its own database | none |
| Postgres (Supabase toolbelt project) | platform | global | `woltgcggxaehtuypkxqk` (core/idea/prompt) | platform database: adds Auth-as-IdP role and Phase 6 platform schemas | medium: becomes the availability keystone; accepted, it already is for toolbelt |

Per-app override mechanism: env-var indirection, the pattern every component already uses (`ACC_*`, `LIFEOS_*`, `GUARDS_CONFIG`, `SUPABASE_URL`) [VERIFIED: inventory]; no new mechanism invented.

**Reversal trigger:** VPS resource exhaustion (Brain + Shell + LifeOS on one host); the split-out order is Brain first (stateless against its store), Shell second.

---

## ADR-05: Secrets and key management

**Context.** SEC-01 (plaintext vault) and the hard requirement: the Brain key is never readable by any other component, enforced by mechanism, not convention.

**Options.**

| Option | Notes |
| --- | --- |
| A. Infisical everywhere (CI + runtime), OS-user isolation for the Brain key | extends the working pattern; no new services |
| B. HashiCorp Vault self-hosted | new deployable + operational burden; breaches complexity budget |
| C. SOPS/age files in-repo | encrypted-at-rest but keys-in-repo workflow, rotation is manual, no audit |

**Decision: Option A.** Mechanics:

- Storage backend: Infisical project, environment `prod`, path convention `/platform/*` (shared), `/lifeos/*`, `/brain/*` (the isolated path), `/toolbelt/*`.
- Local dev injection: Infisical CLI (`infisical run`) wrapping the dev command; no `.env` files committed, existing gitignore patterns stand [VERIFIED: root and app .gitignore].
- Containers: deploy job renders env at deploy time exactly as LifeOS does today [VERIFIED: ci.yml:187-188]; no secrets in images or compose files.
- CI: GitHub OIDC to Infisical machine identities, one identity per pipeline, scoped to its path only.
- Rotation: rotate in Infisical, redeploy the affected unit; the runbook gains a per-secret rotation row (10).
- Brain key isolation, structural: (1) its own Infisical path `/brain/` readable by exactly one machine identity; (2) on the VPS the Brain runs as a dedicated OS user `brain` in its own container with the key injected only into that container's env; (3) no other unit's identity can read `/brain/`; (4) Handler A (08) has no code path accepting the Brain key name; (5) the GU/BR acceptance checks in `03-v1-definition.md` (BR-3, II-4) verify a non-Brain process context cannot obtain the key. Convention is replaced by identity-scoped ACLs plus OS/container boundaries.
- ACC vault: demoted to operator-machine convenience values (non-API-key), documented in `05-b`; API keys never enter `vault.json` again.

Cost: Infisical becomes a hard dependency for deploys (it already is for LifeOS). Maturity cost: low, in production here today. Migration cost: create paths + identities, one-time. Lock-in: Infisical API shape; mitigated by env-var indirection at every consumer. Ecosystem gaps: no OS-keychain integration for the operator's Windows machine; ACC-local values stay in the demoted vault with filesystem protection, accepted for non-key material.

**Reversal trigger:** Infisical outage blocking two consecutive deploys, or pricing/licensing change; fallback is SOPS/age with the same path layout.

---

## ADR-06: Networking and access

**Context.** Everything user-facing is tailnet-only today; nothing public [VERIFIED: 01-inventory section 5]. The release-smoke reachability mechanism is unresolved [UNKNOWN, gate question].

**Options considered:** (A) keep single tailnet, everything private, one serve entry per surface; (B) public exposure behind an auth proxy; (C) split tailnets per trust zone.

**Decision: Option A.** Topology:

- Exposed surfaces (tailnet only): the one origin (ADR-07) fronting Shell + zones; nothing else listens beyond loopback.
- Internal-only: LifeOS API upstream (127.0.0.1:8000), Brain daemon socket, netcheck dashboard (stays operator-local), ACC loopback API on the operator machine.
- Egress policy for agents: V1 documents and monitors rather than firewalling: harness egress rides Claude Code's own sandbox/proxy behavior; the Brain's own egress is exactly one provider API endpoint (07); Handler A's is the three provider endpoints (08). Structural egress control (per-container network policy) is deferred past V1 and listed in the risk register: at single-operator scale the marginal risk does not buy a new enforcement layer yet.
- Reachability matrix: operator devices reach the origin via tailnet; CI runners join with the existing tag pattern for deploys; nothing reaches ACC's operator machine from the network.
- Resolve the release-smoke [UNKNOWN]: if it relies on Tailscale Funnel, that is a public exposure and must be either documented and health-limited or replaced with a tailnet-joining smoke job (10 carries the issue).

**Reversal trigger:** any requirement to share a surface with a second person; that surface gets an explicit exposure ADR.

---

## ADR-07: Gateway

**Context.** ADR-02 needs one origin with path routing. Candidates must not breach the 4-unit ceiling.

**Options.**

| Option | Cost |
| --- | --- |
| A. `tailscale serve` path routing (already terminating TLS for LifeOS) | zero new units; config lines only |
| B. Caddy container as origin router | +1 deployable unit; more routing power (rewrites, headers, auth hooks) |
| C. nginx/Traefik | same +1 unit with heavier config surface |
| D. No gateway (status quo ports) | fails ADR-02's one-origin requirement outright |

**Decision: Option A, rejecting a dedicated gateway for V1.** `tailscale serve` already terminates TLS on the tailnet and can path-route to local upstreams; it carries the Shell static zone, `/life/*` to the LifeOS upstreams, and the Brain's UI stream endpoint. It terminates TLS; it enforces network-level access (tailnet membership + device approval); it does not enforce app auth, which stays server-side per ADR-03 (SH-4). Cost stated plainly: no header rewriting, no response transformation, no rate limiting at the edge; if a zone needs path-prefix awareness, the zone's own base-path config handles it (Vite `base`, FastAPI `root_path`).

**Reversal trigger:** the first concrete need for edge logic that serve cannot express (rewrite, auth callback multiplexing, websocket fan-out). The named successor is Caddy (Option B), displacing one unit of headroom in the complexity budget.

---

## Gate questions (batched, non-blocking)

1. ADR-03 re-points LifeOS identity to the platform project. If the operator prefers the inverse (LifeOS project as IdP), the design is symmetric; the tiebreaker was that the Shell's tools already live on the toolbelt project. Say so before Phase 11 issues are cut if reversed.
2. ADR-04 concentrates Shell + Brain + LifeOS on the existing single VPS. Confirm the host has capacity headroom (RAM/CPU are [UNKNOWN] from this tree).
3. ADR-06 defers structural egress control. If the operator wants harness egress firewalled in V1, it displaces the Brain UI polish line in the cut (07 section 7.13).

## Self-check (Section 10)

- Every factual claim labeled: PASS
- No implementation code produced: PASS (trees and config names are contracts)
- Canonical names used exclusively: PASS
- Every recommendation names maturity, migration, lock-in, ecosystem gaps: PASS (ADR-02, 03, 05; ADR-01/06/07 pick structure, with costs stated inline)
- Acceptance criteria: N/A here; enforced via 03 and per-component artifacts
- LOC delta: documentation only; ADR-01 adds ~30 lines workspace config when implemented
- Deletion list: LifeOS-local login page (ADR-03), status-quo port sprawl (ADR-07 D)
- Latency budgets: inherited from 03 (SH-4); no new network hops introduced beyond serve routing
- Questions batched: PASS (3)
- Zero em dashes: PASS
- Complexity budget: declared at top; all decisions fit within it; breaches: none
