---
name: diff-review
description: Lean review of just the recent change — the working diff, or the current branch vs main — through the lean-review lenses, scoped to touched code only. Faster sibling of lean-review for small changes.
---

# Diff review

Scope: the working diff (staged + unstaged); if the tree is clean, the current
branch vs main (`git diff main...HEAD`). Review only changed hunks and their
immediate context — do not expand into a codebase pass; `/lean-review` exists
for that.

Apply the five lean-review lenses (`.claude/skills/lean-review/SKILL.md`) to
the changed code only. The tests lens sharpens to: does THIS change ship with
its test at the right tier (Vitest colocated / Playwright e2e)?

Rules of engagement:
- Findings first (`file:line` — what, why, fix), ranked; a clean diff is
  stated as clean in one line.
- Apply only clear wins inside the diff's blast radius; never grow the
  change's scope.
- Gate before any commit: `npm run lint && npm run test && npm run e2e &&
  npm run build` — all green; merge only on green CI.
