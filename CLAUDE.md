Read AGENTS.md first — it is the front door for this repo.
Then load `.agents/invariants.md` and the constitution in `.agents/domains/` for the cell you are working in.
Declare the owning cell in `.agents/task.json` before editing — a machine-level guard blocks writes to cell-owned paths otherwise.
For GitHub PRs, list every touched owned cell on the PR body `Cells:` line; PR Gate enforces it (ADR 020).
