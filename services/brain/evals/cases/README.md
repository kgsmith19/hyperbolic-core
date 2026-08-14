# Brain eval corpus

Frozen regression cases for the Brain's dispatch pipeline
(07-brain-architecture.md section 7.11). Each `*.case.json` file validates
against `src/schemas/brain.eval-case.v1.schema.json` and is re-dispatched
by `brain eval run` through the real pipeline, then graded
deterministically against its recorded expectation.

```
brain eval run                      # exit 0 when every case passes, 1 on any regression
brain eval run --json               # the same report as a single JSON document
brain eval run --cases <dir>        # run a corpus from somewhere else
brain eval run --persist            # write into the configured store instead of a scratch one
brain eval capture <run_id> --name <case_id>
```

## The seed corpus

Five cases, the minimum 07 section 7.11 requires before V1 ships.

| Case | What it pins |
| --- | --- |
| `plan-only` | A `report` deliverable that changes nothing still ends `succeeded`. A verifier keyed on "did anything happen" would get this wrong. |
| `single-task-success` | The full `succeeded` definition of section 7.5: every verdict passes **and** the worktree is clean or committed. |
| `verify-failure` | The harness reports success and the Brain overrules it on its own verification. BR-2 in executable form. |
| `approval-park` | An approximation, not a literal approval park. See below. |
| `transport-retry` | Two transport failures on the preferred harness are retried, then rerouted to a fallback, and the rerouted task is held to the same verification bar. |

## Why the harness outcome is scripted

`brain eval run` is a PR gate, and the PR gate has no production secrets by
design (10-cicd-deployment.md section 6). A case that reached a genuine
`accepted` outcome through `adapters/claude-code.ts` would need a live
provider credential in CI, so without scripting, the corpus could never
contain a single passing case.

The scripting is deliberately as thin as it can be. `adapters/fixture.ts`
supplies the **harness-level outcome only** -- whether the session came
back `accepted`, `aborted-by-budget`, `failed-to-start`, and so on. It
reports no verdicts of its own, which is exactly what makes `dispatch.ts`
fall through to the Brain's real `verify.ts` and actually spawn each case's
`acceptance[].verify.command` against the real worktree. Everything below
the harness boundary is unmocked:

- the git worktree is a real worktree created by `worktree.ts`
- the acceptance commands are really executed, and really pass or fail
- the worktree-clean check really runs `git status --porcelain`
- routing, retry, fallback, status mapping, and cost accounting are the
  production code paths

A case selects its scripted outcome with a `[[fixture:<outcome>]]` marker
in its contract's `title` (the one field `runEvalCase()` passes through
untouched), or by naming `codex` (always transport-fails) or `gemini`
(always succeeds) as its preferred harness. An unrecognized marker throws
rather than defaulting, so a typo cannot turn into a case that passes for
the wrong reason.

These adapters are **never reachable from a real `brain run`**. The
production daemon's adapter registry is built in `src/index.ts`; the eval
registry is constructed in exactly one place, the `eval` branch of
`bin/brain.mjs`. `HarnessId` also stays frozen at `claude-code | codex |
gemini` -- these are alternate adapter objects registered under the
existing three ids, not a fourth harness.

## The approval-park approximation

`approval-park.case.json` does **not** exercise a real approval park, and
its own `description` field says so. Two independent reasons:

1. `runEvalCase()` calls `dispatch()` directly. Approval parking happens in
   `scheduler.ts` / `approval-gate.ts`, above dispatch, so no case file can
   drive a task into `awaiting_approval` through this path at all.
2. `brain.result.v1`'s `status` enum has no awaiting-approval member, and
   correctly so: a parked task has no terminal result to record. The eval
   case schema cannot express the expectation even if the harness could
   produce it.

What the case pins instead is the nearest behavior the pipeline really
does reach: a task that stops before finishing ends terminal-but-not-
succeeded (`timeout`) with no verdicts, because a run that never completed
has nothing to verify. The genuine approval gate is covered by unit tests
over `approval-gate.ts` and `autonomy.ts`. Closing this gap for real needs
an eval entry point above the scheduler rather than below it, which is
larger than m6-01's scope.

## Fixtures

Every seed case uses `fixture.kind: "repo_files"`: an inline map of path to
contents, materialized into a throwaway local git repo with one commit on
`main`. That keeps a case a single reviewable JSON file, commits no binary
blob to git, and lets the whole corpus run with no network access.

The schema also accepts `repo_tar` (an extracted archive, section 7.11's
literal wording) and `git_ref` (a real upstream repo and ref, which is what
`brain eval capture` writes for a captured real run).

## The capture process rule

07 section 7.11 makes this a process rule, not a suggestion: **every S1/S2
Brain failure must produce a case before its fix merges.** The workflow is

1. `brain eval capture <run_id> --name <case-id>` freezes the failing run's
   contract, its repo reference, and an expected block derived from what
   actually happened.
2. Edit the expected block. Capture records what the run **did**, which is
   not automatically what it **should** do -- for a bug capture it is
   usually the opposite. The generated `description` says so, and capture
   refuses to overwrite an existing case file.
3. Land the case in the same PR as the fix. The case should fail before the
   fix and pass after it.

## Grading

The deterministic grader (07's primary grader) compares three things and
has no partial credit:

- terminal `status`
- `verdicts`, matched by id in **both** directions -- an unexpected extra
  verdict fails the case just as a missing one does, because ignoring
  extras would let a case keep passing after the behavior it pins changed
- `cost.usd_estimate` against the case's `max_cost_usd` ceiling (a null
  estimate counts as zero)

The secondary LLM rubric grader (07: report-type deliverables only, Handler
B, pinned `brain/eval-rubric@1` prompt) is deferred behind the
`RubricGrader` interface in `src/evals.ts`, per that section's own cut line.
V1's implementation never fails a case, so a grader that does not exist
cannot become a silent gate.

## Where this runs

- **Brain PR Gate** (`.github/workflows/brain-ci.yml`) runs the corpus on
  every PR touching `services/brain/**`. A regression fails the gate.
- **Brain Eval Nightly** (`.github/workflows/brain-eval-nightly.yml`) runs
  the same corpus on a schedule. It is deliberately the same deterministic
  fixture-based run, not a credentialed one: no provider secret is
  provisioned for it, so the nightly catches drift in the pipeline rather
  than in a live model. A nightly that exercises real harnesses needs a
  credential decision that V1 has not made.

`brain eval run` defaults to a scratch SQLite store and workspace root, so
running the gate never accumulates synthetic runs in an operator's real
history and needs no writable `/data`. Pass `--persist` to record into the
configured store's `eval_case` / `eval_result` tables instead.

The `evals/` directory is not copied into the production Docker image (the
Dockerfile copies `services/brain/src`): the corpus is a development and CI
artifact, and the daemon never reads it at runtime.
