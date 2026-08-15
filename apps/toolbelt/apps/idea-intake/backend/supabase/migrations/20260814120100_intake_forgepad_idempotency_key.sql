-- Reconcile the existing generic idempotency key into a stable Forgepad
-- provenance identity. `if not exists` keeps this forward-safe for a database
-- created by an older intake migration that lacked the column, while preserving
-- the immutable 20260813002605 migration for databases that already applied it.
alter table intake.idea
  add column if not exists idempotency_key uuid;

with forgepad_rows as (
  select
    id,
    md5(
      'hyperbolic-core/forgepad/' ||
      substring(source from '^forgepad:(f-[0-9a-f]{8})')
    ) as digest
  from intake.idea
  where source ~ '^forgepad:f-[0-9a-f]{8}(;|$)'
)
update intake.idea as idea
set idempotency_key = (
  substring(forgepad_rows.digest, 1, 8) || '-' ||
  substring(forgepad_rows.digest, 9, 4) || '-' ||
  '3' || substring(forgepad_rows.digest, 14, 3) || '-' ||
  '8' || substring(forgepad_rows.digest, 18, 3) || '-' ||
  substring(forgepad_rows.digest, 21, 12)
)::uuid
from forgepad_rows
where idea.id = forgepad_rows.id;

update intake.idea
set idempotency_key = gen_random_uuid()
where idempotency_key is null;

alter table intake.idea alter column idempotency_key set default gen_random_uuid();
alter table intake.idea alter column idempotency_key set not null;
create unique index if not exists intake_idea_idempotency_key
  on intake.idea (idempotency_key);

-- The API must never choose or mutate an import/reconciliation identity.
revoke insert (idempotency_key), update (idempotency_key)
  on intake.idea from anon, authenticated;
