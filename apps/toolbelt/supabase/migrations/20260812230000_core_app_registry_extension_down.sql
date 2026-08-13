-- Reverts 20260812230000_core_app_registry_extension.sql. Dropping the
-- columns discards the backfilled kind/route values along with them, so no
-- separate data-revert step is needed.
alter table core.app
  drop column kind,
  drop column route,
  drop column version,
  drop column description,
  drop column manifest,
  drop column manifest_hash,
  drop column registered_at;
