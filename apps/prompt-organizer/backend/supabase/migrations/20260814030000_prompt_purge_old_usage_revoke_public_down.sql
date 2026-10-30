-- Down migration for 20260814030000_prompt_purge_old_usage_revoke_public.sql.
-- Restores exactly what that migration changed: PUBLIC's EXECUTE grant
-- (implicitly covering `anon` and `authenticated`, neither of which ever
-- had an explicit grant of their own -- 20260812210000 never granted
-- anything). Deliberately restores the vulnerable state -- a mechanical
-- reversal, not a security recommendation to ever run it for real.
grant execute on function prompt.purge_old_usage() to public;
