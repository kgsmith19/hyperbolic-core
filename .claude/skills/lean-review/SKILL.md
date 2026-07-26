---
name: lean-review
description: Review the codebase (or given paths) against AGENTS.md engineering standards — simplicity, clean code, security, tests, size/structure. Reports findings, applies only clear wins, verifies with the full gate.
---

# Lean review

Review `src/`, `tests/`, and `scripts/` (or the paths passed as arguments) against
the Engineering standards in AGENTS.md and the rules in `.agents/`. Same
functionality, better code. Work in the main thread; declare the owning cell in
`.agents/task.json` before editing.

Pass every file through five lenses:

1. **Simplicity (KISS)** — can the same behavior ship with less? Dead code,
   needless abstraction or indirection, speculative generality, duplication to merge.
2. **Clean code** — names say what things are; each function does one thing;
   comments state only what code cannot; idiomatic Python 3.12 / FastAPI / Pydantic v2.
3. **Security** — invariants 5/7/8/9 hold; input validated at the boundary;
   expected client errors are 4xx, never 500; no secrets or PII in logs, errors,
   or fixtures.
4. **Tests** — every behavior has a test at the right tier (unit / integration
   `tests/kernel/` / e2e `tests/api/`); tests assert behavior, not implementation;
   no dead fixtures.
5. **Size & structure** — small functions, files under ~150 lines, no new file
   whose job two existing files already cover.

Rules of engagement:
- List findings first (`file:line` — what, why, fix), ranked by value; state
  clean files as clean.
- Apply only clear wins. Skip churn: renames without payoff, style-only diffs,
  micro-optimizations at personal scale.
- Never trade functionality for brevity. Kernel DDL is off limits (invariant 1).
- Gate before any commit: `.venv\Scripts\python -m ruff check .`, `-m mypy`,
  `-m pytest` — all green, then PR; merge only on green CI.
