drop index if exists intake.intake_idea_idempotency_key;

-- 20260813002605 already owns this column. Rollback removes only the stable
-- Forgepad mapping and leaves the original random unique identity intact.
update intake.idea
set idempotency_key = gen_random_uuid()
where source ~ '^forgepad:f-[0-9a-f]{8}(;|$)';
