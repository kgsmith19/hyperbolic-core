---
title: The repo references prompts/ and templates/ that are not in it
status: done
scope: repo
created: 2026-08-07
updated: 2026-08-08
owner: Kyle
traces: [NFR-003]
---

## Resolved 2026-08-08

Option 3 chosen: the SDD pack is now `kgsmith19/agent-engineering-standard`, a real published repo, pinned by commit SHA in `.agent/standard.lock`. `CLAUDE.md` was slimmed to a two-line pointer at `AGENTS.md`, which is the new operational map; `rules/00-CORE.md` now carries a superseded notice at its top rather than pretending to be the active source of truth. The `prompts/`/`templates/` references inside `rules/*.md` are not individually rewritten -- the superseded notice on `rules/00-CORE.md` is the redirect an agent hits before it would ever follow one of those paths. Self-containment now holds via a stable, pinned URL rather than a path that only resolved on Kyle's own machine.

# The repo references `prompts/` and `templates/` that are not in it

Found during SPEC-0000's close-out, while checking GATE-DOC D3 ("zero broken internal links"). Recorded rather than fixed: SPEC-0000 is the core and idea spine, and repairing the scaffold is not what that slice is for. `rules/00-CORE.md` says a discovery becomes an entry, not more code.

## What is wrong

`rules/04-DOCS.md` states the self-containment rule plainly:

> a repo never references a path outside itself, never assumes a parent folder, never depends on which machine it sits on.

Four files break it. Every path below is referenced from this repo and does not exist in it:

| File | Line | Reference |
|---|---|---|
| `CLAUDE.md` | 52-59 | `prompts/10-research.md`, `prompts/11-prd-create.md`, `12-prd-update.md`, `prompts/20-spec-write.md`, `prompts/31-implement-green.md`, `prompts/33-integrate-merge.md` |
| `rules/01-BUDGETS.md` | 97 | `prompts/44-process-review.md` |
| `rules/04-DOCS.md` | 114-118 | `prompts/40-lean-review.md` through `prompts/44-process-review.md` |
| `rules/05-SPECS.md` | 25 | `templates/SPEC.md` |
| `rules/07-SKILLS.md` | 16-17 | `prompts/10-research.md`, `prompts/11-prd-create.md` |

These resolve on Kyle's machine, inside the SDD pack the repo was scaffolded from. They resolve nowhere else, including in this remote session and in any fresh clone.

## Why it matters

`CLAUDE.md` sends an agent to `prompts/20-spec-write.md` before writing a spec, and `rules/05-SPECS.md` names `templates/SPEC.md` as the source of a spec's required sections. An agent working from a clean clone cannot read either. It will either halt or, worse, improvise the procedure and produce a spec that looks right and skips a gate. The second outcome is the dangerous one, because nothing catches it.

`rules/05-SPECS.md` also says a spec "describes this repo only" and never references a path outside it. The rule cards themselves do not currently meet that bar.

## What is not wrong

Three things the same check flagged are correct as written and need no action:

- `package.json` in `README.md`, `docs/SYSTEM-REQUIREMENTS.md`, and SPEC-0000 — each is a deliberate statement that no such file exists, which is the point being made (`MAX_NEW_LIBRARIES: 0`, no build step).
- `2026-08-06-webhook-retries-were-doubling.md`, `ADR-0003-postgres-over-dynamodb.md`, `SPEC-0007-reject-expired-sessions.md`, `2026-08-06-notes.md` in `rules/04-DOCS.md` — illustrative naming examples in prose, not links.
- `20260806143000_prompt_create_prompt_version.sql` in the topology note — a filename-convention example.

## Options

| Option | Cost | Consequence |
|---|---|---|
| Vendor `prompts/` and `templates/` into this repo | One commit; they then need to stay in sync with the SDD pack | The repo becomes self-contained and the rule cards become true. Duplication is the price, and `rules/04-DOCS.md` bans duplicated facts, so the pack would need to become the copy or the repo the source. |
| Reword the references to name the pack as an external source | Small edit | Honest, and the paths stop pretending to resolve. An agent still cannot read the procedure from a clean clone. |
| Publish the SDD pack as its own repo and link to it | Depends on whether Kyle wants it public | Self-containment holds via a stable URL rather than a path, and one copy stays canonical. |

Not recommending one here. The choice depends on whether the SDD pack is meant to be shared across Kyle's other tool repos, which is a question this note cannot answer.

## Next

Decide the option, then fix it in its own slice. Until then, GATE-DOC D3 does not fully pass in this repo, and SPEC-0000's Definition of Done says so rather than claiming otherwise.
