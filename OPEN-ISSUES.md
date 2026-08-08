# Open issues — lifeos

Historical ledger of things raised and fixed before this repo adopted GitHub
Issues as the durable work-item source (2026-08-08 migration). New work is a
GitHub Issue (`.github/ISSUE_TEMPLATE/work-item.md`), not an entry here.

Not for this file (unchanged): roadmap slices and event-triggered gates (they
live in `docs/roadmap.md` with explicit triggers), and ADR "revisit when"
clauses.

---

## Open

_(none — the one open entry, OI-006, is now [Issue #64](https://github.com/kgsmith19/lifeos/issues/64))_

## Resolved

- 2026-07-30 — OI-005 deployed-DB `$` ref pattern (moved here from the
  ecosystem ledger — the whole fix is in this repo) — FIXED.
  `scripts/migrate_document_ref_anchor.py` rewrites the stored `document`
  json_schema to the `\Z`-anchored `storage_ref` pattern FIX-1 (`d9d81ac`)
  shipped in code, plus a `type.redefined` audit event; `ops.yml` gains the
  `migrate-document-ref-anchor` task. Idempotent, no backfill possible to need
  (the tightening only rejects a trailing newline, which `blob.put` cannot
  emit). Two tests in `tests/documents/test_migrate_ref_anchor.py` — one
  proving the old stored pattern accepted `...bin\n` and the shipped one does
  not. tests/documents 43 passed; full suite 449 passed.
- 2026-07-30 — OI-001 domain-scoped identity-field guards — RETIRED, closed
  generically by #57 before this entry was written. `capture()` now requires
  `{domain}:write` on every domain of the record a MATCH lands on
  (`kernel/services/capture.py`), which is precedent 4 applied in the kernel
  rather than per-cell — so `wellbeing`, `relationships`, `ops` and `calendar`
  are covered by construction, as is every domain added later. The entry was
  seeded from the QE2-A review text, which predates the fix.
  `tests/kernel/test_scope.py` — 6 passed.
- 2026-07-30 — OI-003 chat error frames leak raw exception text — RETIRED,
  premise wrong. `src/api/chat.py` yields a static `ERROR_MSG`; the exception
  goes to `log.exception` only, with a comment saying why. Verified by
  `tests/api/test_chat.py::test_chat_mid_stream_failure_emits_error_frame` —
  1 passed. No correlation id was added: nothing asked for one, and the leak
  the entry described does not exist.
- 2026-07-30 — OI-004 test-DB pool saturation — FIXED, and the real defect was
  worse than the entry said. Every local run points at the one shared
  lifeos-test database and `clean_database` wipes it on start, so two
  concurrent runs delete each other's rows mid-test; exhausted pooler
  connections were the symptom, silent cross-run corruption the cause. The
  session now holds a Postgres advisory lock (`tests/conftest.py`,
  `exclusive_database`): the second run waits, then says plainly what holds the
  database. Free in CI, where `DATABASE_URL` is an ephemeral Postgres. No
  xdist, no pool tuning — neither would have helped, since xdist workers each
  wipe too. Verified: with the lock held externally a second `pytest` produced
  no output and hit the 12s kill (exit 124); the same suite ran 9 passed the
  moment it released.
- 2026-07-30 — OI-002 `lines.py` size — RETIRED as churn, deliberately not
  split. Measured: 288 total lines is 193 code, 58 docstring, 9 comment, 28
  blank — the excess over the ~150 guideline is largely the constitutional
  documentation this x-sensitive cell requires. The one honest seam
  (`usual_present`, which only `ops/briefing.py` imports) is ~29 lines and
  would leave the file at ~165 code, still over; reaching 150 needs a
  three-way fragmentation of a cohesive module, for no correctness gain, in a
  security-sensitive domain. Same conclusion the EP1 adjudication reached. If
  a later slice touches this file for a real reason, split it then.
