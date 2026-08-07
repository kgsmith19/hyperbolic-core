# RULE 04: DOCS

**Governing rule:** every file answers *what breaks if this is deleted?* No answer means it is deleted at the next doc refresh.

**Self-containment:** a repo never references a path outside itself, never assumes a parent folder, never depends on which machine it sits on.

## Folder contract

```
<repo-root>/
  README.md                     how to run it, in plain language
  CLAUDE.md                     how agents work in this repo
  AGENTS.md                     subagent roles + tool permissions (multi-agent repos only)
  docs/
    PRD.md                      <- source of truth
    SYSTEM-REQUIREMENTS.md
    DATA-FLOW-DIAGRAM.md
    adr/     ADR-0001-<kebab>.md
    notes/   2026-08-06-<kebab>.md
  specs/
    active/  SPEC-0007-<kebab>.md
    done/    SPEC-0006-<kebab>.md
    TEST-LEDGER.md
  src/ | app/                   language convention
  tests/
```

**`docs/` root holds exactly three `.md` files.** That is the entire reason the subfolders exist: the canonical three must never be crowded out. Checked by GATE-DOC D7.

## Where each thing goes

| Content | Location | Filename |
|---|---|---|
| A decision with trade-offs, expensive to reverse | `docs/adr/` | `ADR-NNNN-kebab-title.md` |
| Investigation, runbook, benchmark, findings, research output | `docs/notes/` | `YYYY-MM-DD-kebab-title.md` |
| Docs about one subsystem only | `<subsystem>/docs/` | `YYYY-MM-DD-kebab-title.md` |
| Spec in progress | `specs/active/` | `SPEC-NNNN-kebab-title.md` |
| Completed spec | `specs/done/` | same name, `git mv`d |
| Test justifications | `specs/TEST-LEDGER.md` | fixed |
| Anything else | nowhere | it does not go in the repo |

Nested `docs/` folders are correct when only that subsystem cares. When in doubt use `docs/notes/`; the next refresh pushes it down.

## Naming

| Type | Pattern | Example |
|---|---|---|
| Note | `YYYY-MM-DD-kebab-title.md` | `2026-08-06-webhook-retries-were-doubling.md` |
| ADR | `ADR-NNNN-kebab-title.md` | `ADR-0003-postgres-over-dynamodb.md` |
| Spec | `SPEC-NNNN-kebab-title.md` | `SPEC-0007-reject-expired-sessions.md` |
| Canonical | `SCREAMING-KEBAB.md` | `SYSTEM-REQUIREMENTS.md` |

- **Date leads on notes** so chronology and staleness are visible in a plain `ls`.
- **The title alone must tell a stranger what the file is.** `2026-08-06-notes.md` is a violation.
- Numbers are zero-padded to four digits and never reused, even after deletion.
- Banned filenames: `notes`, `misc`, `temp`, `scratch`, `old`, `wip`, `untitled`, `new`, `final`, `v2`.

## Front matter

Required on every file in `docs/` and `specs/`. `README.md`, `CLAUDE.md`, `AGENTS.md` are exempt.

```yaml
---
title: <plain-language title>
status: draft | active | superseded | done
scope: repo | subsystem:<name> | slice:SL-NNN
created: YYYY-MM-DD
updated: YYYY-MM-DD
owner: <name>
traces: [FR-001, NFR-003]
---
```

`scope` is what makes a note's reach obvious without opening it.

## Content rules

1. **One purpose per document.** A doc explaining a decision *and* documenting an API *and* recording a meeting is three documents.
2. **No duplication.** A fact lives in exactly one document; everywhere else links to it. Duplicated facts diverge, always.
3. **Link, do not summarize.** Summaries of other docs go stale silently.
4. **No aspirational content.** Docs describe what is true now. Intentions go in the PRD slice plan or a spec.
5. Plus everything in `rules/03-WRITING.md`.

## Lifecycle

| Transition | Trigger | Action |
|---|---|---|
| Spec active -> done | Passes its Definition of Done | `git mv` to `specs/done/`, set `completed` |
| Note -> superseded | A newer note contradicts it | Set `status: superseded`, link to the replacement at the top, keep the file |
| Note -> deleted | Describes something that no longer exists | Delete. Git history is the archive. |
| ADR -> superseded | A later ADR reverses it | Never edit the original. Write a new ADR, link both ways. |
| Any doc -> deleted | Fails "what breaks if deleted" | Delete, and record it in the refresh report |

**Never create `archive/`, `old/`, or `_backup/`.** Git is the archive.

## README contents, and nothing more

| Section | Content |
|---|---|
| What this is | 2-4 sentences, plain language, same as PRD section 1 |
| Prerequisites | Exact versions of every tool |
| Run it | Literal copy-pasteable commands, in order |
| Test it | The literal command |
| Where things are | Table pointing at the three canonical docs and `specs/` |
| Workflow | The slice loop in five lines, linking to `prompts/` |

A README duplicating the PRD is a maintenance burden and a contradiction source. Link to it.

## Cadence

| Every | Run |
|---|---|
| Slice | Update PRD status column (part of GATE-GREEN G9) |
| `{{DOC_REFRESH_EVERY}}` slices | `prompts/43-doc-refresh.md` |
| `{{LEAN_REVIEW_EVERY}}` slices | `prompts/40-lean-review.md` |
| `{{SECURITY_REVIEW_EVERY}}` slices | `prompts/41-security-review.md` |
| `{{TEST_REVIEW_EVERY}}` slices | `prompts/42-test-review.md` |
| `{{PROCESS_REVIEW_EVERY}}` slices | `prompts/44-process-review.md` |
