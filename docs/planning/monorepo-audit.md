# Monorepo audit (Phase 0 of #450, queue Q35)

Status: Phase 0 audit (sections 1-6, kept as recorded at the snapshot below) plus the #450 closeout
(section 7). The audit counts describe the tree before the lift; section 7 describes the tree after it.
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

## 7. Closeout (#450, 2026-11-03)

Every phase is complete or owner-excluded. Each claim is checked by a script that runs in the root PR
Gate's Repository Standards lane (`.github/actions/verify-repo-policy`) and in `make test`.

| AC | State | Proof |
|---|---|---|
| AC1: no app inside another app | Met. The three nested apps were lifted to `apps/<name>/`. `apps/lifeos/{backend,frontend}`, `apps/agentic-command-center/frontend` and `apps/shell/frontend` are components, per section 1 | `ops/check_app_metadata.py` |
| AC2: `apps/toolbelt` gone | Met. The lift and the dissolution landed in #520 and #523; the directory does not exist, and its return fails the gate | `ops/check_app_metadata.py` (`DISSOLVED`) |
| AC3: no `.github/` below the root | Met | `ops/check_app_metadata.py` |
| AC4: stale references are history only | Met. The allowed hits are listed below | `ops/check_stale_paths.py`, mutation-tested by `ops/test_check_stale_paths.py` |
| AC5: every app passes its own tests on its moved paths | Met. This fixed a gap left by the lift: the Toolbelt lane ran Idea Intake's tests from `tests/*.test.mjs`, which matched 0 files after the move, so the lane passed with 0 of 88 tests. It now runs `backend/tests/*.test.mjs` | `.github/actions/verify-tests-toolbelt` |
| AC6: each app has `project.yaml`, `AGENTS.md`, `CLAUDE.md` and README with real paths | Met. `project.yaml` was added for network-checker, prompt-organizer and idea-intake, and a README for idea-intake. LifeOS `project.yaml` no longer describes app-local workflows | `ops/check_app_metadata.py` |
| AC7: registry rows, `tool.json` and deploy targets read back live | Owner-excluded. Under the local-only decision (2026-10-29) no live Supabase registry or deploy target exists to read back, and #503 removed the cloud deploy. `tool.json` paths are validated by `npm run manifests:check`. Moving the Supabase migrations to per-app SQLite is Phase 2 of the std queue, not a layout change | `npm run manifests:check -- --registry` |
| AC8: leanness record per app | Met. Each finding carries a decision | `docs/planning/leanness.md`, `python3 ops/leanness.py --check` |
| AC9: CI parity and auto-merge on affected paths | Met. Every app runs in a root PR Gate lane | `.github/workflows/pr-verify.yml` |

### Allowed stale-path hits

These are history, never edited to the new layout:

- `docs/archived/**`: archived documents.
- `supabase/migrations/**` and `apps/*/backend/supabase/migrations/**`: applied SQL migrations. They are immutable, so their comments keep the paths they were written against.
- `docs/planning/0*.md`, `docs/planning/1*.md`, `docs/planning/issues/**`: the frozen pre-#450 planning record (2026-08). Its `[VERIFIED: path]` labels cite the tree as it was then.
- `docs/planning/monorepo-audit.md`: this audit, whose sections 1-6 describe the old layout.
- `ops/check_stale_paths.py`, `ops/check_app_metadata.py` and their tests: they name the patterns and the dissolved path they guard against.

### Other repoints in the closeout

- The LifeOS `gen:api` script reads the local backend (`http://127.0.0.1:8000/openapi.json`), not the retired Tailscale production host.
- The LifeOS README says SQLite migrations, not Postgres.
- The `stage63-standards.test.mjs` fixture uses `apps/network-checker` as its write root.
