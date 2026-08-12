# 00. Canonical Names

Status: authoritative. Every later artifact in `docs/planning/` uses these names exclusively. Deviating names in quotes refer to historical or brief-side aliases and appear only in this file.

Evidence base: repo-wide case-insensitive sweeps run 2026-08-12 on branch `claude/agentic-engineering-restructure-bujav1` (equal to `origin/main` plus the Phase 0 charter commit), excluding `node_modules` and `.git`.

## Canonical naming table

| Canonical name | Short code | Aliases seen (source) | Resolution and evidence |
| --- | --- | --- | --- |
| hyperbolic-core | `hyperbolic-core` | "hyperbolic-os" (brief only) | One entity, not a pair. `hyperbolic-os` has zero occurrences in the repository [VERIFIED: repo-wide grep for `hyperbolic-os`, `hyperbolic os`, `hyperbolicos`: zero hits]. `hyperbolic-core` is the umbrella monorepo and the product name [VERIFIED: /home/user/hyperbolic-core/README.md line 1; project.yaml `name: hyperbolic-core`]. No shell UI exists today; the repo root contains no application code [VERIFIED: root listing contains only docs, config, CI, and `apps/`]. |
| Shell | `shell` | "hyperbolic-os", "the UI", "shell UI" (brief) | The Shell is the to-be-built unified web front end that composes LifeOS, ACC, and Toolbelt surfaces. It is a component of hyperbolic-core, not a separate product. Its repository location is decided in ADR-01; its composition strategy in ADR-02. Today it does not exist [VERIFIED: no root app code; `apps/` contains exactly agentic-command-center, lifeos, toolbelt]. |
| Agentic Command Center | `acc` | "Agent Command Center" (brief), "Command Center" (UI display) | Canonical long name "Agentic Command Center", short code ACC. The exact phrase "Agent Command Center" has zero occurrences [VERIFIED: case-insensitive grep]. The long name appears 13 times in committed files [VERIFIED: apps/agentic-command-center/README.md:1, AGENTS.md:1, policy.json:2, ui/package.json:5, and 9 more]. The browser-visible display name is "Command Center" [VERIFIED: apps/agentic-command-center/ui/src/main.tsx:44]; display names are presentation, not identity. Canonical code location: `apps/agentic-command-center/` in hyperbolic-core. The standalone GitHub repo is no longer resolvable via the GitHub API [VERIFIED: `list_issues` on kgsmith19/agentic-command-center returned "Could not resolve to a Repository", 2026-08-12] and the subtree carries the post-restructure state. |
| Prompt Organizer | `prompt-organizer` | "prompt-layer", "prompt layer" (brief only) | Same component. `prompt-layer` has zero occurrences in the repository [VERIFIED: repo-wide grep]. The component names itself Prompt Organizer [VERIFIED: apps/toolbelt/apps/prompt-organizer/AGENTS.md line 1; web/index.html `<title>Prompt Organizer</title>`] and the root README calls it "a prompt-library client" [VERIFIED: README.md line 6]. There is no separate "prompt-layer" boundary to define; the alias is retired. |
| The Brain | `brain` | "Brain", "meta-harness" (brief) | Proper noun, fixed definition: The Brain is the ACC meta-harness service that orchestrates coding harnesses (Claude Code, Codex CLI, Gemini CLI). It plans, dispatches, and verifies harness tasks; it is not itself a coding harness and does not edit repositories directly. It holds one dedicated frontier-provider API key used by nothing else. The Brain does not exist in any repository today [VERIFIED: zero occurrences of "Brain" as a product name; only hits are this engagement's own artifact index and external-project citations in apps/lifeos/backend/docs/research/]. Full architecture: `07-brain-architecture.md`. |
| Guards | `guards` | "guards" (brief, undefined role) | Guards is a standalone runtime policy module at `apps/toolbelt/guards/`: a Claude Code `PreToolUse` hook (`guard.mjs`) that blocks secret-file reads and protected-path writes and enforces per-repo ownership cells, plus a config CLI (`cli.mjs`) that mutates its `config.json` [VERIFIED: apps/toolbelt/guards/ file list; apps/toolbelt/AGENTS.md "Repository purpose" paragraph]. It is not a CI gate, not a package registry, and not a linter; enforcement runs at agent tool-call time. It was extracted from ACC on 2026-08-12 with a strict no-import boundary; ACC shells its CLI as a subprocess [VERIFIED: apps/agentic-command-center/gui/server.mjs lines 153-163]. V1 scope definition: `05-g-guards.md`. |
| LifeOS | `lifeos` | none | Unambiguous. Personal life-management product, FastAPI backend plus React frontend, at `apps/lifeos/` [VERIFIED: apps/lifeos/AGENTS.md]. Its live CI and deployment run from the standalone `kgsmith19/lifeos` repo; the monorepo copy's workflows are inert by design [VERIFIED: root AGENTS.md "Workflow safety invariant"]. |
| Network Checker | `network-checker` | "netcheck" (its own CLI name) | Unambiguous. Local-first network diagnostics at `apps/toolbelt/apps/network-checker/`, CLI module name `netcheck` [VERIFIED: apps/toolbelt/apps/network-checker/AGENTS.md line 1]. Both names refer to one component; `netcheck` is the executable name, Network Checker the product name. |
| Toolbelt | `toolbelt` | none | Unambiguous. Monorepo of small portfolio tools at `apps/toolbelt/` owning the shared `core` and `idea` Supabase schemas [VERIFIED: apps/toolbelt/AGENTS.md "Repository purpose"]. |
| Idea Intake | `idea-intake` | "Forgepad" (ACC's prior partial implementation) | The new Toolbelt sub-app specified in `05-h-idea-intake.md`. Related prior art: ACC contains a complete but orphaned idea store (`forgepad/store.mjs`, states draft/definite/research-needed/rejected, a reserved `githubIssue` field) and an unreachable HTML page [VERIFIED: apps/agentic-command-center/forgepad/store.mjs; gui/server.mjs has no /api/forgepad route]. Whether Idea Intake supersedes Forgepad is resolved in `05-h`; the canonical name for the new sub-app is Idea Intake. |

## Usage rules

1. Artifacts use the canonical name on first reference per section, the short code thereafter.
2. "ACC" is acceptable in prose everywhere; "Agentic Command Center" appears at least once per artifact.
3. "The Brain" always takes the definite article and always capitalizes Brain.
4. No artifact may introduce "hyperbolic-os", "prompt-layer", or "Agent Command Center" except when quoting the brief.

## Self-check (Section 10)

- Every factual claim labeled with VERIFIED or explicit absence evidence: PASS
- No implementation code produced: PASS
- Canonical names used exclusively: PASS
- Maturity/migration/lock-in/ecosystem costs: N/A (no technology recommendation in this artifact)
- Machine-verifiable acceptance criteria: N/A (naming artifact)
- LOC delta: this artifact adds one documentation file; no code
- Deletion list: none required for this phase artifact
- Latency budgets: N/A (no new paths)
- Questions batched at gate: none required; all five ambiguities resolved from evidence
- Zero em dashes: PASS
- Complexity budget breaches: none
