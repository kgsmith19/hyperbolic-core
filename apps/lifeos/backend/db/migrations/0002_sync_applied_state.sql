-- Last applied source timestamp per source identifier (#572). Written only by
-- the owner-approved apply step; the dry-run planner reads it and never writes.
-- The composite key is the source system plus its identifier, so one external
-- id in two sources is two rows (the same rule as the identity crosswalk).

create table sync_applied_state (
    source text not null,
    external_id text not null,
    applied_at timestamptz not null,
    primary key (source, external_id)
);
