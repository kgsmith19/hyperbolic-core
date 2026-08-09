---
title: "Forgepad: shape and placement decision"
date: 2026-08-09
issue: "#57"
status: concluded
---

# Forgepad shape conclusion

## Decision

Build Forgepad **inside ACC** as a new `forgepad/` module plus a `/forgepad`
page in the existing `gui/server.mjs`. No new app, no new process, no new
dependency.

## Rationale

| Question | Answer |
|---|---|
| Placement | Inside ACC. The existing loopback server, vault, and guard machinery already exist and give exactly what Forgepad needs. A sibling app adds operational surface for zero gain on a single-user machine. |
| Auth | Loopback + X-ACC header (same as every other mutating ACC route). No extra auth layer needed for a single-user machine; the threat model has not changed. |
| GitHub permissions | `issues:write` only — a Personal Access Token (classic) or fine-grained token scoped to the target repos. Token stored in vault under `GITHUB_TOKEN`. Repo-creation (`new app`) is out of scope for MVP and requires `repo` (classic) or `administration:write` (fine-grained); escalation is explicit and user-initiated. |
| Storage | One JSON file per idea under `<acc_root>/forgepad/ideas/`. Same pattern as the directive store. |
| GitHub promotion | Built-in `node:https` POST to GitHub REST API (`/repos/{owner}/{repo}/issues`). No library needed. The `.github/ISSUE_TEMPLATE/work_item.md` front-matter drives the body template so ideas promote into the existing work-item shape. |
| UX target | Capture + promote in under 30 seconds: a short form, one-click state transition, one-click promote. |

## MVP slices (≤3)

| Slice | What ships | Independent |
|---|---|---|
| 1 (this PR) | Idea store (`forgepad/store.mjs`) + `/forgepad` page (create, list, filter, edit state, delete) | yes |
| 2 | Promote definite idea → GitHub Issue (needs `GITHUB_TOKEN` in vault) | yes — store is the only dep |
| 3 | Source provenance field surfaced in UI; tag-based search | yes |

Slice 1 is the entire SPEC-0007 scope. Slices 2–3 follow their own specs.

## What is explicitly deferred

- `new app` bootstrap (requires repo-creation permission escalation)
- Duplicate/similar-idea detection
- Shape/research assistant
- Portfolio-level launch status
