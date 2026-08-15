-- Reverts 20260813002605_intake_create_schema.sql: drops the intake schema
-- (cascade removes intake.idea, intake.optimization, the three guard
-- trigger functions and their triggers, the two RLS policies, and both
-- indexes along with it) and restores pgrst.db_schemas to its prior
-- recorded value (same posture as
-- apps/toolbelt/apps/prompt-organizer/backend/supabase/migrations/20260807020000_prompt_create_prompt_down.sql).
drop schema if exists intake cascade;
alter role authenticator set pgrst.db_schemas = 'public, core, idea, prompt, test';
notify pgrst, 'reload config';
