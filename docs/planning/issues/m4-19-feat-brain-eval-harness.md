Title: FEAT(brain): eval harness with deterministic grading
Type: FEAT
Component: The Brain
Milestone: M4 The Brain
Depends on: m4-11-feat-brain-verification-runner.md
Blocks: m6-01-feat-brain-eval-seed-corpus.md

## Problem
The Brain cannot ship self-modifying orchestration without a regression net; 07-brain-architecture.md section 7.11 specifies the case format, capture flow, deterministic grader, and CI gate.

## Scope
In scope:
- Case format services/brain/evals/cases/*.case.json per 07 section 7.11
- brain eval run and brain eval capture verbs; deterministic grader comparing status, verdicts, and cost ceiling
- brain-ci wiring: corpus runs on every PR touching services/brain/**; regression fails the gate
- Process rule recorded: every S1/S2 Brain failure must produce a case before its fix merges
Out of scope:
- The 5 seed cases (m6-01); the LLM rubric grader (stubbed behind its interface per the 07 cut line)

## Acceptance criteria
When brain eval run executes a passing corpus, it shall exit 0; when any case regresses, it shall exit 1.
When brain eval capture is given a run id, it shall freeze the contract, repo state reference, and operator-edited expected outcome into a case file that validates against the case format.
When a PR touches services/brain/**, the gate shall run the corpus.

## Verification
brain eval run over a passing fixture corpus; echo $? prints 0; over a regressing fixture, prints 1
brain eval capture <run_id> then a schema validation of the produced case file exits 0
gh pr checks on a services/brain PR shows the eval step in Brain PR Gate

## Estimated LOC delta
Added: 600  Deleted: 0  Net: +600

## Risk
Low; deterministic grading only in V1, rubric grader deferred behind a stable interface.
