---
name: diff-review
description: Lean review of just the recent change — the working diff, or the current branch vs main — through the lean-review lenses, scoped to touched code only. The default check before any PR; faster sibling of lean-review.
---

# Diff review

Scope: the working diff (staged + unstaged); if the tree is clean, the current
branch vs main (`git diff main...HEAD`). Review only changed hunks and their
immediate context — do not expand into a codebase pass; `/lean-review` exists
for that and is manual-only.

## The five lenses, scoped to the diff

1. **Simplicity (KISS)** — can this behavior ship with less? Dead code, needless
   indirection, speculative generality, duplication the diff introduces.
2. **Clean code** — names say what things are; one job per function; comments
   state only what code cannot; idiomatic Python 3.12 / FastAPI / Pydantic v2.
3. **Security** — invariants 5/7/8/9 hold; input validated at the boundary;
   expected client errors are 4xx, never 500; no secrets or PII in logs, errors,
   or fixtures. (Security-sensitive diff? `/sec-diff`, and `/security-review`
   before merge.)
4. **Tests** — does THIS change ship with its test, at the right tier (unit /
   integration `tests/kernel/` / e2e `tests/api/`)? Tests assert behavior, not
   implementation.
5. **Size & structure** — small functions, files under ~150 lines, no new file
   whose job two existing files already cover.

## Budget

- **Main thread only. No subagents, no extended thinking.**
- `git diff --stat` first, then `-U3` on changed files. Never open an unchanged
  file "for context"; if a finding needs one, read only that function.
- **≤15 lines of output.** Detail to a scratchpad file; cite the path.

## Rules of engagement

- Findings first (`file:line` — what, why, fix), ranked; a clean diff is stated
  as clean in one line.
- Apply only clear wins inside the diff's blast radius; never grow the change's
  scope. Declare the owning cell in `.agents/task.json` before editing.
- Kernel DDL is off limits (invariant 1).
- **Gate proportional to what you changed.** If you applied a fix:
  `.venv\Scripts\python -m ruff check .`, `-m mypy`, and the touched test files
  only. Do NOT run the full suite here — CI runs it and merge is already gated
  on green CI. If you changed nothing, run nothing.
