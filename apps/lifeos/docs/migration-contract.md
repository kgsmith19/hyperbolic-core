# ChatGPT LifeOS → local LifeOS: inventory, field mapping and migration contract (#535)

Status: first deliverable of #535. It is a bounded, schema-level inventory plus the rules every
later migration slice must follow. **This document holds no personal content.** It names
document sections, field shapes and statuses only. Real items stay in the owner's Google Docs
and local exports, and never enter this repository.

## 1. Source inventory (read 2026-11-03 through the Google Drive connector, read-only)

| Source | Drive id | Role today | Shape (structure only) |
|---|---|---|---|
| LifeOS — Master TODO Tracker | `1JS1XGXpWaFv_V4OCRSLbARcKThWP5EbbDjWLIsUxLOk` | Task system of record for the ChatGPT LifeOS | An `Updated:` date header; a status convention line; sections `OPEN — PRIORITY BACKLOG` (its first three items are the "current top 3"), `NEXT — ACTIVE / WAITING`, `LATER / REVIEW BEFORE REACTIVATING`, `DONE`; one task per line, `[ ] TAG: free text` |
| LifeOS — Control Center & Connection Runbook | `1dDkVKN_o4bI4048yLPG3sUtvVq_exmpIQVv09pXeixA` | Launch links, connection registry, recovery procedures | An `Updated:` header; a security rule (no credentials, only vault item labels); a quick-launch link list; `CONNECTION REGISTRY` rows: `Name \| Purpose \| connector status + last verified \| Login (vault label) \| Owner \| Recovery` |

Tracker status convention: `OPEN / NEXT / LATER / WAITING / DONE`, plus `REVIEW` for older tasks
that have not been re-verified. The tracker itself says those must not be assumed active.

ChatGPT automations named in #535: Email Appointment Sync (hourly), Morning Action Brief,
Afternoon Follow-Through, Connection Audit, Weekly Reconciliation. Schedules, prompts and run
evidence live in ChatGPT and are **not exportable through any documented API**. They are
inventoried by the owner, by hand, in the Control Center (§5). ChatGPT memory is treated as
not exportable.

## 2. Target: the local `intention` entity

`apps/lifeos/backend/src/domains/intentions/types.py`:
- `title` is the identity key.
- `kind` is one of task, project, habit_quota, research_errand, recurring_commitment.
- Other fields: `status`, `focus` (at most three), `floor`, `next_action`, `source`, `done`, and `progress`.
- `progress` is READY / STARTED / BLOCKED / WAITING / DONE (#543).
- `floor`, `next_action` and `source` are x-pii, so `forget()` can erase them.

## 3. Field mapping (Tracker → intention)

| Tracker | Intention | Rule |
|---|---|---|
| `TAG: text` (whole line) | `title` | The identity. A re-import with the same title is skipped. |
| text after `TAG:` | `next_action` | x-pii. The model is never asked to rewrite it. |
| `OPEN` | `progress: READY`, plannable | The first three OPEN items are *proposed* focus. The operator confirms focus; an import never sets it. |
| `NEXT` | `progress: READY`, plannable | |
| `WAITING` | `progress: WAITING`, plannable | |
| `LATER`, `REVIEW` | stays a candidate, not plannable | An unverified task never becomes active by import. |
| `DONE`, `[x]` | skipped and counted | An import never writes DONE, because it has no completion evidence. |
| (every import) | `status: candidate`, `focus: false`, `source: tracker` | The operator confirms by re-capturing. That supersedes by title and keeps history. |
| `kind` | `task` | The operator reclassifies anchors (habit_quota, recurring_commitment) on confirmation. |

Unsupported, recorded rather than invented:
- `Updated:` date. There is no per-item date in the source, so freshness comes from the entity's `updated_at`.
- Inline completion evidence (for example "received Oct 11"). This stays inside the `next_action` text and is not parsed.
- Free-form `REVIEW` notes.

Control Center registry → #534 automation and connection registry:
- `Name` maps to a connection id.
- `Purpose` maps to `purpose`.
- The connector status text plus its last-verified date map to `last_verified_at` and `state`: one of healthy, stale, permission-blocked or unsupported, based on evidence, never optimistic.
- The vault label maps to `credential_ref`, a label only and never a secret.
- `Recovery` maps to a runbook text.

The local mirror is read-only until #534 lands.

## 4. Migration rules (every slice)

1. **Dry-run first.** `domains.intentions.import_tracker.parse_tracker` builds a plan and reports **counts only**: planned, plannable, proposed_focus, skipped_done, skipped_excluded. `apply_plan` writes candidates. Synthetic fixtures only (`tests/intentions/test_import_tracker.py`).
2. **Idempotent.** The title is the identity, and existing titles are never touched. A repeat run appends zero events, and a test proves it.
3. **Append-only rollback.** Events are never edited (invariant 2). Rolling back an import is a re-capture that clears the candidate, or `forget()` for x-pii erasure.
4. **Sensitive categories are opt-in.** `exclude_tags` skips tags the owner marks sensitive (health, financial, legal, identity). Those move only through separately approved narrow pathways, never in bulk.
5. **No scraping, no undocumented APIs.** Reads come through the authorised Drive connector or a local export passed in by the caller. The importer itself never reaches the network.
6. **Dual-run.** ChatGPT LifeOS stays authoritative until cutover. Local outputs (Today view, priorities, reminders) are compared with the ChatGPT outputs, and discrepancies are reported. No reminder is sent from both systems: the local system sends nothing until its channel is approved (#532).
7. **Coverage scorecard.** It lives in the owner's Control Center, never in GitHub. It counts eligible, imported, verified, excluded, conflicts, stale, and awaiting consent. Counts come from `counts()` and `apply_plan`, never estimates.
8. **Cutover gate.** Before any ChatGPT automation is retired: verified data parity, verified notification delivery on the target device, privacy review, backup and restore drill (`make backup && make restore-drill`), and explicit owner approval.
9. **Phone access.** The local stack binds loopback only. Pixel access is an owner decision recorded before it is built. Tailscale or cloud hosting is not reintroduced silently.

## 5. Manual-intervention checklist (owner; record results in the Control Center)

- [ ] Export the Master TODO Tracker as plain text to a local path, and run the dry run: `parse_tracker(text, exclude_tags=[...])`. Record the counts.
- [ ] Choose the `exclude_tags` set for the first import.
- [ ] Inventory each ChatGPT automation: schedule, last run, last verified delivery, and permissions.
- [ ] Decide how the Pixel reaches the local LifeOS (#532).
- [ ] Approve the first apply run after reviewing the dry-run counts.

## 6. Next slices

- **Import CLI:** a local job and receipt around `parse_tracker` / `apply_plan`, in the `import_priorities` pattern.
- **Dual-run diff report:** Today view against Morning Action Brief, counts only.
- **Connection registry mirror:** #534.
- **Reminder parity and delivery proof:** #532.
