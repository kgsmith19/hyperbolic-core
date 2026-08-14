# Eval corpus

`*.case.json` files here are the Brain's regression net (07-brain-architecture.md
section 7.11, m4-19). Format: `brain.eval-case.v1`
(`../../src/schemas/brain.eval-case.v1.schema.json`) --
`{case_id, description, contract, fixture, expected}`.

- `brain eval run` re-dispatches every case's contract through the real
  dispatch pipeline and grades the fresh result against `expected`
  (status, verdicts, cost ceiling). Exits 0 iff every case passes.
- `brain eval capture <run_id>` freezes an already-finished run into a
  new case file here, then a human is expected to review/adjust the
  captured `expected` values before committing it (07 section 7.11:
  "operator-edited").

Process rule (07 section 7.11): every S1/S2 Brain failure must produce a
case here before its fix merges.

No seed cases ship in m4-19 -- the 5-case seed corpus is m6-01's own
scope. `brain-ci.yml`'s eval step runs this (empty, for now) corpus on
every PR touching `services/brain/**`; an empty corpus passes vacuously.
