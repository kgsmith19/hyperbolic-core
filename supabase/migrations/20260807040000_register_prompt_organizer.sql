-- Prompt Organizer's SL-007 (usage tracking, that repo's own SPEC-0007)
-- needs core.run.app_id to reference a real core.app row before it can
-- write anything (FR-002: an unregistered app_id is rejected, 23503).
-- This is that registration -- toolbelt owns core, so the row is written
-- here, not in the prompt-organizer repo.
insert into core.app (id, name, schema_name, status)
values ('prompt-organizer', 'Prompt Organizer', 'prompt', 'building');
