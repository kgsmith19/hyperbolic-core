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
its test in the right tier?

Rules of engagement:
- Findings first (`file:line` — what, why, fix), ranked; a clean diff is
  stated as clean in one line.
- Apply only clear wins inside the diff's blast radius; never grow the
  change's scope. Declare the owning cell in `.agents/task.json` before editing.
- Gate before any commit: `.venv\Scripts\python -m ruff check .`, `-m mypy`,
  `-m pytest` — all green; merge only on green CI.
