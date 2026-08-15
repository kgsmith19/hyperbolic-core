-- Independent security review, Finding 36 and Finding 49 (re-verified
-- against current HEAD), addressed together as one small coherent slice
-- since both concern the exact same two foreign keys.
--
-- Finding 36: intake.optimization.input_idea_id and .output_idea_id
-- (20260813002605_intake_create_schema.sql) both default to `ON DELETE NO
-- ACTION` (Postgres's implicit default when a REFERENCES clause names no
-- explicit ON DELETE behavior). intake.guard_idea_delete
-- (that same migration) allows deleting any non-submitted idea outright
-- ("if old.status = 'submitted_to_github' then raise exception ... II-3:
-- submitted ideas cannot be deleted; return old" -- silently permitting
-- every other status), and intake.idea's own grants
-- ("grant delete on intake.idea to authenticated") hand that DELETE
-- capability to the owner directly. The two guarantees conflict the moment
-- an optimization row references a draft or 'idea'-state idea: deleting
-- that idea is a documented, guard-permitted action, yet Postgres will
-- refuse it outright with a foreign-key violation
-- ("update or delete on table \"idea\" violates foreign key constraint...
-- still referenced from table \"optimization\"") because NO ACTION leaves
-- nothing to resolve the reference. A user who ran an LLM optimization pass
-- over a draft (intake.optimization.input_idea_id pointing at it) and then
-- tried to delete that still-unsubmitted draft -- an explicitly guard-
-- permitted operation -- would hit a database error the application layer
-- never anticipated.
--
-- Fix (the review's own first suggested option, and the most consistent
-- choice given this schema's shape): ON DELETE CASCADE on both FKs.
-- intake.optimization is disposable telemetry -- an append-only log of LLM
-- optimization attempts (id, input_idea_id, output_idea_id, prompt_name,
-- model, handler_run_id, cost_usd, created_at), not a durable record
-- anything else references or relies on surviving independently of the
-- ideas it was run against. Once the idea it was performed on/for is gone,
-- the optimization row has no remaining referent worth keeping around as an
-- orphan (input_idea_id nullable-if-orphaned would just accumulate
-- meaningless rows over time, and SET NULL would silently corrupt the
-- append-only log's own historical meaning -- "this optimization produced
-- THAT output idea" stops being true information once output_idea_id is
-- nulled out). Deleting the optimization rows alongside their referenced
-- idea keeps the invariant simple and matches how this schema already
-- treats idea deletion for draft/idea-state rows: a real, permitted,
-- destructive action, not something guarded by soft-delete or archival.
--
-- Finding 49: intake.optimization.input_idea_id and .output_idea_id carry
-- no supporting index. Every foreign key column that is ever the target of
-- an UPDATE/DELETE on its referenced table benefits from an index on the
-- referencing side (Postgres does not create one automatically for FK
-- columns, unlike the referenced side's own primary key) -- without one,
-- deleting a row from intake.idea forces a sequential scan of
-- intake.optimization to find and cascade-delete every row that references
-- it, on every single idea delete. This pairs naturally with the CASCADE
-- fix above: CASCADE is exactly the operation this index makes cheap.
create index optimization_input_idea on intake.optimization (input_idea_id);
create index optimization_output_idea on intake.optimization (output_idea_id);

alter table intake.optimization
  drop constraint optimization_input_idea_id_fkey,
  add constraint optimization_input_idea_id_fkey
    foreign key (input_idea_id) references intake.idea(id) on delete cascade;

alter table intake.optimization
  drop constraint optimization_output_idea_id_fkey,
  add constraint optimization_output_idea_id_fkey
    foreign key (output_idea_id) references intake.idea(id) on delete cascade;
