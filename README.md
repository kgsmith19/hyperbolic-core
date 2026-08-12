# hyperbolic-core
A suite of all of my agentic work.

## Components

- `apps/toolbelt/` — a monorepo of small portfolio tools (a prompt-library
  client and a local-first network diagnostic CLI/dashboard). Imported via
  `git subtree add --prefix=apps/toolbelt` from
  `https://github.com/kgsmith19/toolbelt.git` (merge commit `8af33c8`). See
  `apps/toolbelt/README.md` and `apps/toolbelt/AGENTS.md` for details.

- `apps/lifeos/` — a personal life-management system (FastAPI backend +
  React/TypeScript frontend: calendar, bills, health tracking). Imported via
  `git subtree add --prefix=apps/lifeos` from
  `https://github.com/kgsmith19/lifeos.git` (merge commit `a740c6e`).
  **Its CI (`apps/lifeos/.github/workflows/`: `ci.yml`, `backup.yml`,
  `ops.yml`, `release-smoke.yml`) is intentionally inert here** — those
  workflows include real production deploy/backup/ops automation and
  continue running from the standalone `lifeos` repo, not from this one.
  See `apps/lifeos/README.md` and `apps/lifeos/AGENTS.md` for details.

- `apps/agentic-command-center/` — the local coding-agent guard rail,
  control panel, and bounded task runner (Node.js core, no runtime
  dependencies, React UI). Imported via `git subtree
  add --prefix=apps/agentic-command-center` from
  `https://github.com/kgsmith19/agentic-command-center`. Unlike `lifeos`,
  its CI is **not** meant to stay inert: a root-level, path-scoped
  `acc-ci.yml` (mirroring `toolbelt-ci.yml`'s pattern) makes it a real,
  active check here. See `apps/agentic-command-center/README.md` and
  `apps/agentic-command-center/AGENTS.md` for details, and
  `docs/superpowers/specs/2026-08-12-acc-migration-design.md` for the
  migration record.
