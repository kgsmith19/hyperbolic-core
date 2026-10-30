# Monorepo audit (Phase 0 of #450, queue Q35)

Status: audit only. No code, path, workflow or production change is made by this document.
Snapshot: `origin/main` at `b6720f1` (after #513), 2026-10-30. Counts re-run on this tree. Commands are reproducible from the repo root.

## 1. Apps and components

| Path | Own `project.yaml` | Own `AGENTS.md` / `CLAUDE.md` | Own `.github/` | Classification |
|---|---|---|---|---|
| `apps/shell` | yes | yes | no | App (promote as-is) |
| `apps/lifeos` | yes | yes | yes (3 workflows, PR/issue templates) | App. Nested `.github` is dead config (see §3) |
| `apps/lifeos/backend` | no | yes | no | Component of `lifeos` (no own manifest) |
| `apps/lifeos/frontend` | no | yes | no | Component of `lifeos` (no own manifest) |
| `apps/agentic-command-center` | yes | yes | yes (templates only) | App. Nested `.github` is dead config |
| `apps/toolbelt` | yes (declares `apps/` children) | yes | yes (templates only) | Category to dissolve (§2) |
| `apps/toolbelt/apps/idea-intake` | no | yes | no | App to lift to `apps/idea-intake` (has `tool.json`) |
| `apps/toolbelt/apps/network-checker` | no | yes | no | App to lift to `apps/network-checker` (has `tool.json`) |
| `apps/toolbelt/apps/prompt-organizer` | no | yes | no | App to lift to `apps/prompt-organizer` (has `tool.json`) |
| `services/brain`, `services/llm-handler`, `services/broker`, `services/platform-api` | n/a | n/a | n/a | Category `services/`, per the issue. Each has `tool.json` (`platform-api` added since 30891aa) |

Rule applied: a directory with its own `project.yaml` or `AGENTS.md` is an app. `backend/` and `frontend/` inside `lifeos` are components because the issue says `lifeos` is an equal app and its halves share one manifest, but the audit leaves the final call to Phase 1 (decision D1).

## 2. `apps/toolbelt`

- `apps/toolbelt/apps/` holds the three nested apps above. The lift is a `git mv` to `apps/<name>/`.
- Shared root pieces to relocate: `guards/`, `scripts/`, `supabase/`, `tests/`, `tool.schema.json`, `project.yaml`.
- Stale references to `apps/toolbelt` or `toolbelt/apps`: **189 files** (`grep -rIl -E 'apps/toolbelt|toolbelt/apps'`, excluding `node_modules` and `.git`). Largest groups:
  - `apps/toolbelt/supabase/migrations` (20), `docs/planning` and `docs/planning/issues` (28), `apps/toolbelt/tests` (13), `packages/hyp-cli` (14), `apps/shell/frontend` (16), `services/broker` (6), `docs/ops` (5), `.github/workflows` (5).
- Archived history (`docs/archived/**`) stays and is listed as an allowed hit (AC4).

## 3. Nested `.github/` (dead config)

GitHub reads workflows only from the root `.github/`. These directories are not run:

- `apps/lifeos/.github/workflows/{backup,ci,ops}.yml`. Each must be compared with the root workflows before removal (D2).
- `apps/lifeos/.github/{PULL_REQUEST_TEMPLATE.md, ISSUE_TEMPLATE/work-item.md}`, `apps/agentic-command-center/.github/...`, `apps/toolbelt/.github/...`. Templates only. Move to the root or delete (D3).

## 4. Root workflows that reference toolbelt paths

`deploy.yml`, `platform-migrations.yml`, `platform-contract.yml`, `auto-merge-deploy-reconcile.yml`, `toolbelt-network-checker-release.yml`. These are production-affecting. Their path edits are Phase 3 and 4 and each production step waits for owner approval (AC7).

Root workflows: 36 files in `.github/workflows/`. Those with cloud or VPS scope (`deploy`, `ops-*`, `canary-observe`, `lifeos-deploy`, `platform-backup`, `platform-smoke`, `shell-idp-down`) are Q61 (#503) scope, not this issue.

## 5. Decisions and recommendations

Recommendations below are the working decisions. Each is reversible in its phase.

- **D1. `lifeos` backend and frontend: component, not app.** One `lifeos/project.yaml` owns both halves, so there is one manifest and one lane. Splitting them adds a second lane for no gain.
- **D2. Nested `lifeos/.github/workflows/*`: delete in Phase 3.** The root already has `lifeos-ci.yml`, `lifeos-backup.yml` and `lifeos-ops.yml`. GitHub never runs the nested copies, so they are dead config. Delete them in the Phase 3 PR, after a diff confirms no logic is missing from the root copies.
- **D3. Nested `.github` templates: delete, keep the root copies.** The root already has `PULL_REQUEST_TEMPLATE.md` and `ISSUE_TEMPLATE/`. The nested ones are duplicates. Delete them in Phase 3.
- **D4. `packages/toolbelt-cli`: rename to `packages/hyp-cli` in Phase 2.** The category it is named after is dissolved. Keep the `tool:new` root script name, so callers do not change. The rename is a Phase 2 change, not part of the lift.
- **D5. Supabase registry rows: retire, do not repoint.** Q22 and Q60 move each sub-app to SQLite on localhost. Repointing Supabase rows would build on a backend being removed. Phase 4 removes the rows, but only after owner approval, because that step touches production data.

## 6. Verification commands used

```
find apps -mindepth 2 \( -name project.yaml -o -name AGENTS.md -o -name CLAUDE.md \)
find . -path ./node_modules -prune -o -type d -name .github -print
grep -rIl --exclude-dir=node_modules --exclude-dir=.git -E 'apps/toolbelt|toolbelt/apps' . | wc -l
find apps packages services -name tool.json -not -path '*/node_modules/*'   # 8 on this tree
grep -lE 'apps/toolbelt|toolbelt/apps' .github/workflows/*.yml
```

No root `Makefile` or `compose.yaml` exists yet; that is Q59 (#504).
