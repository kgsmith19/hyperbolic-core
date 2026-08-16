# Templates

Reference material for a repository adopting this standard. Nothing here is enforced automatically — copy what fits, adapt the wording to the repository, and skip what doesn't apply.

## 📋 Contents

| Template | Copy to | Purpose |
| --- | --- | --- |
| [`README.md`](./README.md) | repository root | Starting point for a repository's own root docs |
| [`AGENTS.md`](./AGENTS.md) | repository root | Contributor and coding-agent guidance |
| [`CLAUDE.md`](./CLAUDE.md) | repository root | One-line pointer to `AGENTS.md` |
| [`ISSUE.md`](./ISSUE.md) | `.github/ISSUE_TEMPLATE/work-item.md` | Work-item template |
| [`PULL_REQUEST.md`](./PULL_REQUEST.md) | `.github/PULL_REQUEST_TEMPLATE.md` | Pull request template |
| [`TEST_LEDGER.md`](./TEST_LEDGER.md) | repository root | Running record of what's tested and its last known status — not a gate |
| [`project.yaml`](./project.yaml) | repository root | Repository metadata; fill in the repository's actual facts |

Keep `AGENTS.md` and `CLAUDE.md` in sync with the repository's actual workflow rather than copying this text verbatim.

## 🧭 Adoption

Adoption is deliberate and per-repository. Copying these files into a repository does not create an ongoing dependency on this one; a `standard.lock` file in the consuming repository records which version was used as a reference, informationally only.
