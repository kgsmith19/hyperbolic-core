# AGENTS.md — Operating map for prompt-organizer

Vendor-neutral map. Details live in the files this points to, not here.

## What this repo is

Prompt Organizer: save AI prompts once, fill in their variables, copy the rendered text. Owns schema `prompt` in the `toolbelt` Supabase project. One tool in Kyle's portfolio.

## Standard

Pinned to `agent-engineering-standard` — exact commit in [`.agent/standard.lock`](.agent/standard.lock). Bumping it is an explicit, reviewed change to that file, never silent drift onto a moving branch.

## Product truth

1. [`docs/PRD.md`](docs/PRD.md) — source of truth for what this tool delivers. Every requirement currently `done`.
2. [`docs/SYSTEM-REQUIREMENTS.md`](docs/SYSTEM-REQUIREMENTS.md), [`docs/DATA-FLOW-DIAGRAM.md`](docs/DATA-FLOW-DIAGRAM.md) — what the system must be, where data flows. Read when work touches architecture, data, or security.
3. [`specs/done/`](specs/done/) — one SPEC per shipped slice; `specs/active/` for one in progress.
4. [`specs/TEST-LEDGER.md`](specs/TEST-LEDGER.md) — every test's justification and mutation-verification record.
5. [`docs/adr/`](docs/adr/) — durable architecture decisions that outlive any one spec.

## Commands (all verified against a clean checkout; see `.agent/project.yaml` for the machine-readable form)

```bash
node --test "tests/*.test.mjs"    # fast-verify == full-verify == CI; there is no separate tier
python3 -m http.server 8812       # serve web/index.html locally
```

No package manager, build step, linter, or type checker exists — deliberately (0 dependencies). Do not add one without an Issue that justifies it.

There is no automated E2E/browser check. Live click-through verification is a manual/agent-driven drill (headless Chromium in some sandboxed environments cannot reach the live Supabase host — a documented, recurring environment limitation, not a defect). Track this gap through its Issue rather than silently skipping it.

## Work model

`GitHub Issue → SPEC only when the Issue can't unambiguously define correct behavior → thin slice → PR → CI → merge.`

- GitHub Issues are the only durable work-item system. Do not create a second one.
- One thin slice at a time, in a short-lived branch. A PR may carry a few tightly related slices, not a sprawling feature.
- `specs/TEST-LEDGER.md` gets a row for a test **before** the test is written. No row, no test.
- RED must fail on a real assertion, missing behavior, or a genuine `40x`/`50x` from the live API — never an import error or broken harness.
- Implement the minimum GREEN. Refactor only after green. No abstraction with one caller.
- Docs update in the same commit as the behavior change.
- No `TODO`/`FIXME`/commented-out code in a green slice.
- Exact per-slice budget ceilings (LOC, files, new tests, etc.) are in `.agent/project.yaml`; a breach means the slice is wrong — stop, report, split. Never self-approve past it.

## STOP conditions

Report and ask instead of proceeding when: the PRD is missing, has an unfilled placeholder, or a requirement without a Status; the work implements something no PRD requirement asks for; a budget ceiling would be breached; a new library, service, or third-party integration is needed; a spec contradicts the PRD.

## Cheapest sufficient mechanism

Prefer, in order: schema constraint → lint → pure function → DB constraint → test → runtime check → network call → LLM call. Reach for the next tier only when the current one can't carry the guarantee.

## Never

- Write to any schema except `prompt` (cross-schema writes belong to the owning repo).
- Commit a service-role key. The anon key is public by design; RLS is the boundary.
- Reference a path outside this repo.
- Create `archive/`, `old/`, or `_backup/`. Git is the archive.
- Add a `DELETE` grant on `prompt.prompt_version` or `prompt.usage` (see `ADR-0002`).

## Risk (R0–R4)

- **R0/R1** — docs, comments, pure-function refactors with unchanged tests: proceed freely.
- **R2** — a normal FR/NFR slice (new column, new UI control, new pure function): default level for feature work here.
- **R3** — anything touching `supabase/migrations/**`, RLS policies, grants, or auth: minimum R3, always. Requires a red-then-green migration with a tested `_down.sql`, live mutation verification of every new test, and a docs update in the same commit.
- **R4** — a real `DELETE` grant, a service-role key anywhere, or anything that could destroy a version row: not permitted by this repo's own architecture (see `ADR-0002`). Escalate rather than build around it.

An agent may raise the risk it declares for its own work; it may never lower it or skip the evidence a higher tier demands.

## Protected boundaries — do not weaken to make something pass

- **RLS and grants in the live `toolbelt` Supabase project** are this repo's real security evaluator. Never loosen a policy or grant to get a test green; if a policy looks wrong, that's an Issue, not a workaround.
- **Mutation verification** in `specs/TEST-LEDGER.md`: every new test gets a live mutation drill proving it actually discriminates the mechanism it claims to test, not a coincidence. Migration-time mutation drills (`mutation_*` migrations) must always be reverted to the real, intended state before the slice is called done.
- **`prompt.prompt_version` and `prompt.usage` immutability** (no `UPDATE`/`DELETE` grant, ever) is a standing invariant, not a per-slice choice.

## Verification before completion

Writing code is not done. A slice is done only when:

1. `node --test "tests/*.test.mjs"` passes, shown, not claimed.
2. Every new test's ledger row has a real mutation-verification record.
3. Any migration was applied to the live project and its down-migration exists.
4. The PRD/spec/docs affected are updated in the same commit.

State exactly what remains unverified when full verification isn't possible (e.g., the sandboxed-browser E2E gap above) — never claim a check passed without its output.
