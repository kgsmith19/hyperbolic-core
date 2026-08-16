# ADR 001: Append-only bi-temporal event log; projections rebuildable

## Decision
The `event` table is the source of truth. Rows are never updated or deleted —
a database trigger raises on UPDATE, DELETE, and TRUNCATE. Events carry both
valid_time (when true in the world) and recorded_at (when we learned it).
entity, entity_type, and edge are projections; `scripts/rebuild_projections.py`
wipes and replays them, and the live write path shares the same `apply_event`
code so replay restores state by construction. Events carry full post-state,
not diffs.

## Consequences
- Any projection bug is repairable by replay; corrections are new events.
- Storage grows monotonically; full post-state payloads are redundant but
  make replay trivial and diff-free.
- Erasure (invariant 9) needs a deliberate redaction path, not row deletes.

## Revisit when
Event volume makes full-payload replay slow (>minutes), or a real need for
retroactive corrections (valid-time updates) appears.
