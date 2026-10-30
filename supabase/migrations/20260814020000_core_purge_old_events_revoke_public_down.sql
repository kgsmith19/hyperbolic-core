-- Down migration for 20260814020000_core_purge_old_events_revoke_public.sql.
-- Restores exactly what that migration changed: PUBLIC's EXECUTE grant
-- (implicitly covering `anon`). Does not re-grant `authenticated` --
-- that grant was already revoked by the earlier
-- 20260812160000_core_idea_owner_pin.sql migration, which this down
-- migration does not own and must not re-open. Deliberately restores the
-- vulnerable state -- a mechanical reversal, not a security recommendation
-- to ever run it for real.
grant execute on function core.purge_old_events() to public;
