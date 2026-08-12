-- 0002 kernel: the erasure path invariant 9 requires. Kernel-only DDL; no
-- domain tables or columns are added (invariant 1).
--
-- Append-only still holds: event rows are never deleted, and the log's shape
-- (id, entity_id, event_type, valid_time, recorded_at, actor) is immutable.
-- The single exception is payload redaction inside a transaction that has
-- explicitly set lifeos.redacting, which only kernel.services.privacy does.
-- See docs/adr/007-pii-erasure-by-redaction.md.

create or replace function event_append_only() returns trigger language plpgsql as $$
begin
    if tg_op = 'UPDATE' then
        if coalesce(current_setting('lifeos.redacting', true), 'off') = 'on'
           and new.id = old.id
           and new.entity_id is not distinct from old.entity_id
           and new.event_type = old.event_type
           and new.valid_time = old.valid_time
           and new.recorded_at = old.recorded_at
           and new.actor = old.actor then
            return new;
        end if;
    end if;
    raise exception 'event log is append-only (invariant 2): % rejected', tg_op;
end;
$$;

-- create or replace drops the function's SET clauses, and on databases where
-- 20260726004147_security_lockdown already ran this file is applied afterwards
-- (db push --include-all) — so the pin must be restated here to survive.
alter function public.event_append_only() set search_path = '';
