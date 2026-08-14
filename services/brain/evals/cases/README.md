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

## The seed corpus (m6-01)

Five named cases, matching 07 section 7.11's own list: `plan-only.case.json`,
`single-task-success.case.json`, `verify-failure.case.json`,
`approval-park.case.json`, `transport-retry.case.json`.

`brain-ci.yml`'s eval step (and the new nightly workflow,
`.github/workflows/brain-eval-nightly.yml`) run this corpus on a runner
with **zero production secrets** (10-cicd-deployment.md section 6) -- no
live Anthropic credential, no real `claude` CLI invocation. A genuinely
succeeding `ClaudeCodeAdapter` dispatch needs both, so this corpus does
not use the real harness adapters at all: `bin/brain.mjs`'s `evalAdapters()`
wires in `src/adapters/fixture.ts`'s `ScriptedFixtureAdapter` instead,
scoped to the `brain eval` CLI path only -- `brain run`'s real production
dispatch (`src/index.ts`) never imports that file and is unaffected.

The fixture adapter scripts only the **harness-level outcome**
(accepted / rejected / aborted-by-budget / failed-to-start), read from a
`[[fixture:<outcome>]]` marker in each case's own `contract.title` (or
fixed per-instance for the `codex`/`gemini` slots `transport-retry` needs).
It never sets `raw.criteria`, so `dispatch.ts`'s own `extractRawVerdicts()`
always falls through to running the case's real `acceptance[].verify`
command against the real worktree (`verify.ts`) -- acceptance checking
itself is never mocked, only "did the harness run" is scripted.
`adapters/types.ts`'s `HarnessId` stays frozen at exactly
`"claude-code" | "codex" | "gemini"`; the fixture supplies alternate
adapter *objects* under those three existing ids, never a fourth id.

Each seed case's `contract.repo.url` is the literal string `"self"`, not
a real remote URL: `worktree.ts`'s `createWorktree()` still does a real
`git clone --bare` (never mocked), but a bare PR-gate runner has no
credential for this repo's own remote even when the clone target is
itself, and a shallow `actions/checkout` never fetches `main` as a local
ref either -- both were caught by this corpus's own first real CI run
(see git history for the fix). `evals.ts`'s `runEvalCase` resolves
`"self"` to the actual on-disk root of the checkout currently running the
code (three levels up from `services/brain/src`, mirroring `config.ts`'s
own `repoRoot`) before dispatch, and every case's `repo.ref` is `"HEAD"`,
not `"main"` -- both resolve correctly against a shallow, detached-HEAD
checkout with zero network dependency.

**Known, documented approximation**: `approval-park` cannot be
represented literally. `runEvalCase` dispatches by calling `dispatch()`
directly, bypassing the scheduler entirely, and approval-gating
(`approval-gate.ts`) only runs inside the scheduler -- there is no
dispatch-level way to produce a genuinely awaiting-approval session.
`brain.eval-case.v1`'s own `expected.status` enum
(`succeeded`/`failed`/`timeout`/`cancelled`/`interrupted`) has no
approval-pending value to assert against even if there were. The seed
case approximates "a task that stops short of completing because a
human-relevant ceiling was hit" with the closest real terminal status the
pipeline can produce (`aborted-by-budget` -> `status: "timeout"`); see
the case file's own `description` field for the full reasoning. It is not
a test of the approval-gate autonomy logic itself (m4-12 owns that, with
its own unit tests) -- only a placeholder filling the named slot in 07
section 7.11's five-case list, kept honest about its limits rather than
silently passed off as the real thing.
