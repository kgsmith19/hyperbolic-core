# money cell

Owns: `src/domains/money/**`, `tests/money/**`.

## Purpose

C0 slice: transaction ingestion with source receipts. Two sources, both
read/ingest only — **no transfer, payment, or other outward-facing capability
exists anywhere in this cell** (invariant 8; matches ADR 018's
draft-then-approve authority-receipt model already shipped for bills, which
this domain does not touch or need):

1. **SimpleFIN Bridge access-URL pull** (`domains.money.simplefin_ingest`) —
   explicitly **user-triggered only**, run as
   `python -m domains.money.simplefin_ingest`. It is never added to the
   scheduled trio in `AGENTS.md` (`calendar.ingest`/`autolink`,
   `cpap.ingest`, `ops.briefing`) and never invoked by a cron, webhook, or
   any other unattended trigger — the roadmap's own acceptance criterion.
2. **Bank CSV import** (`domains.money.csv_import`) — operator-run over a
   local file path, `python -m domains.money.csv_import <path> [account_label]`,
   mirroring `domains.bills.extract`'s "operator-run, not scheduled"
   precedent. The file never enters the repo.

## Types

- **account** — `account_key` (identity, sha256 of `source|external_ref`,
  lowercased) so the raw provider account id or a CSV-supplied label is never
  itself the identity value (the cpap `session_date`-is-identity precedent,
  applied to something that unlike a date IS sensitive). `name` is `x-pii`
  and optional (forget()-erasable, re-ingest never fabricates it back once
  erased); `source` (`simplefin`|`csv`) and `currency` are not PII.
- **transaction** — `transaction_key` (identity, sha256 of
  `account_key|posted_date|amount:.2f|normalized_desc`) is the
  roadmap-specified idempotency hash: **(account, posted_date, amount,
  normalized_desc)**. `account_key`, `posted_date` and `source` are required
  and not PII (needed to compute/re-derive the identity and to run per-date
  spend queries); `amount`, `description`, `normalized_desc`, `currency`,
  `pending` and `external_id` are `x-pii` and deliberately **not required** —
  the calendar `title` / cpap `usage_min` precedent: `forget()` removes them,
  and a re-import of the same statement window must still resolve onto the
  same entity by its untouched identity hash rather than minting a duplicate
  or silently re-materializing what was erased.
- **money_source_receipt** — hash-plus-metadata receipt of one pull/import
  (`receipt_key` identity, `sha256` over the normalized payload,
  `window_start`/`window_end`, `transaction_count`, `source`). Never the
  verbatim SimpleFIN response or CSV bytes — that is the source's own
  financial-data-shaped payload and cannot be erased per-subject (invariant
  9, the calendar/cpap `source_receipt` precedent). Every `transaction` a
  pull or import writes or updates links to its receipt via a `derived_from`
  edge carrying `{method, confidence}` (ADR 010).

Identity field names (`account_key`, `transaction_key`, `receipt_key`) are
new and do not collide with any identity field name another domain already
declares (`ExactIdentityResolver` matches by field name across every type,
not just within a domain).

## Credentials

`LIFEOS_SIMPLEFIN_ACCESS_URL`, read via `kernel.env.read_env` — the SleepHQ
client-id/secret convention, provisioned through the guards vault. **A
SimpleFIN access URL is itself a bearer credential** (SimpleFIN Bridge embeds
HTTP Basic Auth username:password directly in the URL, unlike a typical
client_id/secret pair) and is treated accordingly: never logged, never
stored on any entity, event, receipt, or execution-receipt summary, and never
present verbatim in an exception message. `domains.money.simplefin_client`
parses the URL once at the single call site that uses it, extracts the
userinfo into an `Authorization: Basic` header, and every downstream error
path is exception-class-name-only (the SleepHQ/bills precedent) — the
network layer never even constructs a string containing the full URL after
that point; log lines cite the host only (`urlsplit(...).hostname`), never
the path or userinfo. Missing `LIFEOS_SIMPLEFIN_ACCESS_URL` is a `skipped`
execution receipt, never a crash (ADR 014, the SleepHQ/calendar precedent).

Bank CSV import takes no credential; the file path is a local operator
argument that never enters the repo (the `intentions.import_priorities`
precedent) and the file's bytes are hashed into the receipt, never stored
verbatim.

## Idempotency Contract

Two layers, mirroring `domains.cpap.ingest` / `domains.calendar.ingest`:

1. **Receipt short-circuit.** `receipt_key` hashes the normalized payload
   (SimpleFIN response JSON, or CSV file bytes) plus the pull/import window
   and source; an unchanged payload for the same window emits nothing beyond
   finding the existing receipt.
2. **Per-transaction dedup inside a changed payload.** Even when the payload
   changed, each parsed row is compared against its stored `transaction` (by
   `transaction_key`) before writing; an unchanged row emits no
   `entity.updated` and no new `derived_from` edge. A changed row never
   writes back a field `forget()` has redacted on that entity (durable
   erasure, ADR 012). Reimporting an overlapping CSV date range, or
   re-running the SimpleFIN pull over an overlapping window, is therefore a
   no-op for every transaction already on record.

## Bank CSV minimum fields

Documented minimum columns (header row required, case-insensitive):
`date` (ISO `YYYY-MM-DD` or `MM/DD/YYYY`), `amount` (signed decimal; `(123.45)`
accounting-negative form accepted), `description`. Optional: `currency`
(defaults `USD`). A row missing a required field, an unparseable date, or an
unparseable amount is **dropped and counted**, never guessed at — the bills
`extract._amount`/`_date` precedent (drop, don't fabricate a zero or a
default date).

## Access Control

`money_context()` = `AccessContext.of("money:read", "money:write",
"ops:read", "ops:write")` — narrow by construction, never
`AccessContext.all()` (ADR 012/014 precedent). Both entry points run inside
`ops.receipts.run_job`, so every run leaves an `execution_receipt` and only
`ok` exits 0.

## No outward-facing capability

Invariant 8: this cell has broad-ish read access to financial history and an
external credentialed connection (SimpleFIN), so it must not also gain
high-consequence write capability. It doesn't: there is no transfer, payment,
transaction-initiation, or any other outward call anywhere in this cell's
code, and none is planned here (recurring-charge detection is C0.5,
unstarted; any future write-capable feature is a separately reviewed slice
under ADR 018's draft-then-approve model, not an extension of this one).

## Risk

R3 — financial data plus an external credentialed integration (the C0
roadmap entry's own risk rating; same class as C0/CPAP's health data).
`/security-review` runs before merge.

Behavior changes land with tests in `tests/money/` (unit for CSV row
parsing, the SimpleFIN client's redirect guard, and hash/normalize helpers;
integration for both ingestion paths' idempotency, malformed-row handling,
credential/source failure, and provenance).
