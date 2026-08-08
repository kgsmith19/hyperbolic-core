# ADR 020: Enforce declared cell scope on cloud-agent pull requests

## Status

Accepted, 2026-08-08.

## Context

LifeOS already has a cell ownership model. Each `.agents/domains/<cell>/CONSTITUTION.md`
declares its owned paths on an `Owns:` line, and local agent work declares a cell in
`.agents/task.json`. The local machine guard blocks edits outside that declaration.

That guard intentionally lives outside this repository, so GitHub-hosted/headless agents
cannot be mechanically checked before they write. CODEOWNERS is advisory on the current
personal-repository setup and does not close this gap.

CI cannot read the gitignored `.agents/task.json`, but every pull request has a durable body
and a concrete diff. That is enough to enforce the same ownership intent at integration time.

## Decision

1. A pull request that changes any cell-owned path declares its intended cells in one PR-body
   line: `Cells: kernel` or `Cells: kernel, bills`.
2. Cell names and ownership patterns are derived from
   `.agents/domains/*/CONSTITUTION.md`; CI does not maintain a second ownership map. For a PR,
   the effective map is the union of the base and head revisions so a PR cannot unprotect its
   own code by deleting or narrowing an `Owns:` pattern in the same change.
3. Every changed cell-owned path must belong to a declared cell. A declared cell that does not
   exist is an error. A path matching more than one cell is a configuration error.
4. Cross-cell pull requests are allowed only when every touched cell is explicitly declared.
   This preserves atomic changes when they are genuinely required while making scope widening
   visible and mechanically checkable.
5. Pull requests touching no cell-owned paths do not need a `Cells:` declaration.
6. The check runs on `pull_request`, not `merge_group`: individual PRs are the unit that carries
   the declaration, while a merge group may legitimately combine already-verified PRs from
   different cells.
7. Ownership patterns currently use simple repository-relative `/**` prefixes. Unsupported or
   malformed `Owns:` declarations fail closed rather than being guessed at.
8. The local pre-tool guard remains useful and stricter because it can stop a bad edit before it
   happens. The CI check is an independent integration boundary for cloud/headless work, not a
   sandbox or security boundary.

## Consequences

- Cloud agents cannot merge a wandering change into an undeclared cell merely because they did
  not have the local hook.
- Legitimate cross-cell changes need only one explicit PR-body line; no new label taxonomy,
  task database, or persistent scope file is introduced.
- Constitutions remain the single ownership source of truth, and changing them cannot weaken
  protection for another file in that same PR.
- A new cell is automatically enforced once its constitution has a valid `Owns:` declaration.
- PRs created before this ADR that touch owned paths must add `Cells:` before they can merge.

## Revisit when

GitHub provides a stronger native per-agent capability boundary that can enforce repository
write scopes before changes are made, or the constitution ownership syntax grows beyond simple
prefix globs.
