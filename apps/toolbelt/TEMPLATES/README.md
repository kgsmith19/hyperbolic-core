# Templates

Reference material for a repository adopting this standard. Nothing here is enforced automatically — copy what fits, adapt the wording to the repository, and skip what doesn't apply.

## Contents

- `README.md` / `CLAUDE.md` / `AGENTS.md` — starting point for a repository's own root docs. `CLAUDE.md` is a one-line pointer to `AGENTS.md`; keep both in sync with the repository's actual workflow rather than copying this text verbatim.
- `PULL_REQUEST.md` — copy to `.github/PULL_REQUEST_TEMPLATE.md`.
- `ISSUE.md` — copy to `.github/ISSUE_TEMPLATE/work-item.md`.
- `TEST_LEDGER.md` — copy to the repository root as `TEST_LEDGER.md`; a running record of what's tested and its last known status, not a gate.
- `project.yaml` — copy to the repository root; fill in the repository's actual facts.

## Adoption

Adoption is deliberate and per-repository. Copying these files into a repository does not create an ongoing dependency on this one; a `standard.lock` file in the consuming repository records which version was used as a reference, informationally only.
