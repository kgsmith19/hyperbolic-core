# ADR-0002: "Delete" is a display flag, never a real DELETE

## Context

CRUD needs a delete path (`FR-014`). This schema already refuses to run real `DELETE`s against anything version-shaped: `prompt.prompt_version` and `prompt.usage` have no `UPDATE`/`DELETE` grant at all, by design, because DR-002 requires every version kept forever and NFR-005 requires a stored version never modified or deleted. A real `DELETE` on `prompt.prompt` would cascade through `prompt_version` via its foreign key and erase exactly the history those requirements protect.

## Decision

"Deleting" any row in this schema means flipping a boolean display flag (`prompt.prompt.is_active`), never issuing `DELETE`. No `DELETE` grant exists anywhere in schema `prompt`, on any table, for any role, ever.

## Why

The two requirements (durability of `prompt_version`/`usage`, and a working delete UX for `prompt`) only look like they conflict if "delete" is read literally. A display flag gives the same everyday result — the row disappears from the default view — without touching a single byte of history. It's also the cheaper mechanism: a boolean column and an `UPDATE` grant, versus a cascade-aware soft-delete framework. `SPEC-0010` §3.2 records the one deliberate limit this creates: archiving doesn't free a title for reuse, since the uniqueness index has no `where is_active` predicate — accepted as out of scope until something actually needs it.

## Consequences

- Any future entity that wants "delete" (tags, configurations, a future table) gets a flag, not a grant, by default. Adding a real `DELETE` grant anywhere in this schema is an `R4` action per `AGENTS.md` and needs explicit authority beyond a normal slice — it isn't a thing an implementing agent decides on its own.
- `is_active` (and any future flag like it) is a display filter, not a security boundary: RLS/ownership is unchanged by it, and an owner can always read her own "deleted" row directly by id (`SR-28`).
- Storage grows without bound for anything soft-deleted. Accepted; no retention/purge job exists or is planned unless real usage demands one.
