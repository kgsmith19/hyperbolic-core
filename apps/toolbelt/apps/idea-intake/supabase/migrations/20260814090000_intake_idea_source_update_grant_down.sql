-- Reverts 20260814090000_intake_idea_source_update_grant.sql.
revoke update (source) on intake.idea from authenticated;
