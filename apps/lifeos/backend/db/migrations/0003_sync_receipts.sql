-- Reconciliation receipts for source-sync planning (#572). Kernel infrastructure,
-- not a life-domain schema (invariant 1); receipts preserve plan metadata only.

create table sync_receipt (
    id integer primary key,
    created_at timestamptz not null,
    counts jsonb not null check (json_valid(counts))
);

create table sync_receipt_item (
    receipt_id integer not null references sync_receipt (id),
    ordinal integer not null check (ordinal >= 0),
    source text not null,
    external_id text not null,
    action text not null check (action in ('create', 'update', 'skip', 'stale', 'conflict')),
    source_updated_at timestamptz not null,
    previous_applied_at timestamptz null,
    primary key (receipt_id, ordinal)
);
