# ADR 007: PII erasure by payload redaction, not event deletion

## Decision
`forget(ctx, entity_id, fields=None)` satisfies invariant 9 by removing flagged
values, never rows. It strips `x-pii` keys from every `attributes` object in
every event payload that mentions the entity, and from the entity and edge
projections, leaving id, entity_id, event_type, valid_time, recorded_at and
actor untouched. Migration 0002 rewrites `event_append_only()` to permit an
UPDATE only while `lifeos.redacting` is set in the transaction and only when
every column except `payload` is unchanged; `kernel.services.privacy` is the
only code that sets it. A `pii.redacted` audit event records which fields went
and how many payloads changed — never the values. Fields must be declared in
the type's `x-pii`: passing an unflagged field is a ValueError, so erasure
follows the schema's own declaration instead of becoming a general delete.

## Consequences
- Replay still reconstructs the redacted state by construction: projections are
  written to match what replaying the redacted log produces (ADR 001).
- Invariant 2 keeps its teeth. The log's shape stays immutable; the exception is
  narrow enough that the append-only tests still prove UPDATE and DELETE fail
  outside redaction mode.
- When a redacted field is also the type's `x-identity` — `emails` on person —
  the resolver can never re-match that entity again, and a later capture of the
  same human creates a new one. That is correct erasure, not a defect: the
  identifier is precisely the thing that must disappear.
- Redaction is the one operation replay cannot undo. Pre-redaction values
  survive only in backups taken before the call.
- `forget()` finds events with `payload::text like %entity_id%` — a sequential
  scan, fine at personal scale.

## Revisit when
Event volume makes the payload scan slow, a domain needs masking or hashing
rather than dropping, or a legal hold requires retaining PII while hiding it.
