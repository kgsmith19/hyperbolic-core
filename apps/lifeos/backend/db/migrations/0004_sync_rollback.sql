-- Rollback of applied source-sync batches (#589). Kernel infrastructure, not a
-- life-domain schema (invariant 1): it records which receipts were applied and
-- which were rolled back, never life-domain data.
--
-- applied_at is null for a dry-run receipt. Only an applied receipt can be
-- rolled back, so a plan that never wrote anything fails closed.
alter table sync_receipt add column applied_at timestamptz null;

create table sync_receipt_rollback (
    receipt_id integer primary key references sync_receipt (id),
    rolled_back_at timestamptz not null
);
