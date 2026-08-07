---
title: Restore a prior version as the new current version
spec_id: SPEC-0005-version-restore
slice: SL-008
status: active
created: 2026-08-07
updated: 2026-08-07
completed:
owner: Kyle
traces: [FR-009]
---

# SPEC-0005: Restore a prior version as the new current version

## 1. In one sentence

Every prior version of a prompt is listed with its timestamp, and restoring one writes its body as a brand-new current version — the old version stays exactly as it was.

## 2. Why this, why now

FR-009 (Should), UC-004. Depends only on SL-004 (versioning must exist to restore from); independent of SL-002/003/005/006/007/009's files. `prompt.prompt_version` already exists and is already immutable (SL-004's NFR-005 mechanism) — restore only ever produces a *new* row via the existing trigger, so it needs no schema change and cannot violate immutability by construction.

## 3. Scope

**In:** a version-history panel per prompt (timestamp + a preview of each version's body); a restore control per listed version that `PATCH`es the prompt's `body` to that version's stored `body` (reusing SL-004's existing `UPDATE (title, body)` grant and the existing trigger — no new grant, no new endpoint).

**Out (three-plus per S4):** version diffing UI (PRD OOS-008); deleting a version (no `DELETE` grant exists on `prompt_version`, by design, and no AC asks for one); restoring into a *different* prompt (FR-009's AC is single-prompt: "version 4 is created holding version 1's body" of the *same* prompt).

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | A prompt at version 3 (versions 1, 2, 3 all distinct bodies) | The page loads that prompt | All three versions are listed with distinct creation timestamps, newest first | FR-009 |
| AC-002 | A prompt at version 3 | Version 1 is restored | Version 4 is created holding version 1's body; version 1 remains byte-identical to before; `max(version_no)` is now 4 | FR-009 |
| AC-003 | A prompt at version 2, where version 2's body already equals version 1's body (a prior restore) | Version 1 is restored again | SL-004's distinct-body guard (T-I-007's invariant) means a same-value `PATCH` here still counts as a body *change* relative to the row's current value only if version 2 ≠ version 1 — this AC's Given is constructed so they ARE equal, so no new version is written and `max(version_no)` stays 2 (PROP-003's boundary, not a defect: the guard compares against the *current* row, not the whole history) | FR-009, PROP-003 |
| AC-004 | A prompt at version 1 (never edited) | The page loads it | Version history shows exactly one entry, and no restore control is shown for the current version itself (restoring version 1 onto version 1 is a same-value update — SL-004's guard already makes this a no-op; the UI does not offer to restore the version already current) | FR-009 |
| AC-005 | User A owns a prompt at version 2; user B is a different authenticated user | User B attempts to restore (PATCH the body to) user A's version 1 | The request affects 0 rows (RLS `owner_all` blocks it — the same mechanism SL-000/SL-004 already proved, exercised here through the restore call path specifically); `max(version_no)` for user A's prompt stays 2 | FR-009, NFR-003 |

AC-005 is the failure case.

AC-003 is the boundary/failure-adjacent case: it proves the feature composes correctly with SL-004's existing guard rather than fighting it.

## 5. Properties (all nine walked)

| ID | Property | Kind | Domain | Traces |
|---|---|---|---|---|
| PROP-001 | Every restore ends in a new version row or a documented no-op (AC-003) — never a crash, never a modification of an existing version row (NFR-005 still holds, unchanged mechanism). | Error totality / invariant | Restoring the current version, an old version, into an already-matching state | FR-009 |
| PROP-002 | Round-trip: the restored prompt's current body equals the source version's stored body, exactly. | Round-trip | AC-002's fixture | FR-009 |
| PROP-003 | Invariant: restoring never decreases `max(version_no)` and never rewrites an existing `(prompt_id, version_no, body)` triple — inherited unchanged from SL-004's PROP-002/PROP-003, exercised here through a new call site (restore), not a new mechanism. | Invariant | n restores in sequence | FR-009, NFR-005 |
| PROP-004 | Idempotence: restoring the same already-current version twice in a row is a no-op the second time (SL-004's guard), never two new versions for one logical restore. | Idempotence | AC-003 | FR-009 |
| Others | Conservation (version count only ever grows or holds, covered by PROP-003); order independence n/a (single writer, CON-002); monotonicity n/a (no ranking); oracle beyond the literal ACs n/a; metamorphic n/a. | — | — | — |

## 6. Budget declaration (standard ceilings)

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~40 (`web/index.html` delta only — no new module, no new endpoint) | 300 | within |
| Test LOC | ~90 | 200 | within |
| New modules | 0 | 2 | within |
| Source files touched | 1 (`web/index.html`) | 3 | within |
| Test files touched | 1 (`tests/restore.test.mjs`) | 3 | within |
| New tables/columns/endpoints/libraries/third-party | 0 (reuses SL-004's table, grant, and trigger entirely) | — | within |
| User stories | 1 (U-001, UC-004) | 1 | within |
| New tests | 5 | 8 | within |

## 7. Changes

**Data: none.** No migration. This is the cleanest possible slice: pure reuse of SL-004's existing mechanism through a new UI path and a `PATCH` call already legal under the existing grant.

| Path | Action | Why |
|---|---|---|
| `web/index.html` | edit | Version history panel, restore control |
| `tests/restore.test.mjs` | create | AC-001..004 |

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper | Why not duplicate | Deletion criterion |
|---|---|---|---|---|---|---|
| T-I-012 | integration | AC-001 | Version history is missing an entry or timestamps are wrong | Needs real trigger-written rows | No other test lists a full history for display | FR-009 changes |
| T-A-004 | acceptance | AC-002, PROP-002, PROP-003 | A restore loses the old version, or the new version doesn't match the source | End-to-end through the real API, the AC as written | Only restore-into-new-version test | Never; this is UC-004's exact guarantee |
| T-I-013 | integration | AC-003, PROP-004 | A same-value restore spuriously creates a new version | Real trigger behavior; this proves the two features compose | No other test restores an already-current value | Never; documents the guard's exact boundary |
| T-U-015 | unit | AC-004 | The UI offers to restore the already-current version | Pure function: `isCurrentVersion(version, currentBody)` — cheap, no DOM needed for the decision logic itself | Only this decision's logic | FR-009 changes |
| T-I-015 | integration | AC-005, NFR-003 | A restore reaches across ownership and modifies another user's prompt | RLS is database-level; only a real second identity proves it holds on this specific call path | No other test in this file uses two identities; SL-000's T-I-003 proves the general case, this proves restore composes with it | Never while ownership is per-row |

**Red first:** T-I-012, T-A-004, T-I-013, T-I-015 red against the real API before the page wiring exists (their assertions target `PATCH`/`GET` responses, not DOM); T-U-015 red against an R2 stub. Ledger rows before tests.

## 9. Risks

None beyond SL-004's already-recorded RISK-001 (single-writer `max+1`), inherited unchanged.

## 10. Rollback

Revert the slice's commits; no schema to roll back.

## 11. Assumptions made during implementation

(Implementer fills.)

## 12. Definition of Done

- [ ] T-I-012, T-A-004, T-I-013, T-U-015, T-I-015 green; red output recorded first.
- [ ] Ledger rows predate tests; mutation-verified dates recorded.
- [ ] Browser drill: AC-001 (history shown), AC-002 (restore creates new version, visible), AC-004 (no self-restore control) on the real page.
- [ ] PRD FR-009 → `done`; change-log entry — integrator applies.
- [ ] Spec moved to `done/`, dates set.
