-- Reverts 20260814050000_intake_forgepad_source_dedup.sql: drops the
-- forgepad-provenance partial unique index, restoring intake.idea.source to
-- its prior fully-unconstrained state.
drop index if exists intake.intake_idea_forgepad_source_ref;
