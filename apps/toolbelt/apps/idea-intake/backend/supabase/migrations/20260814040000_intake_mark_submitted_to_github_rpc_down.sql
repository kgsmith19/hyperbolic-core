-- Down migration for 20260814040000_intake_mark_submitted_to_github_rpc.sql.
-- Drops the RPC and restores authenticated's original direct UPDATE grant
-- on the three github_* columns exactly as
-- 20260813002605_intake_create_schema.sql first granted it. Deliberately
-- restores the vulnerable state -- a mechanical reversal of exactly what
-- the paired up migration changed, not a security recommendation to ever
-- run it for real.
drop function if exists intake.mark_submitted_to_github(uuid, integer, text);
grant update (github_issue_number, github_issue_url, submitted_at) on intake.idea to authenticated;
