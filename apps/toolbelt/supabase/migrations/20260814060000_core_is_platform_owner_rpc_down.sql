-- Down migration for 20260814060000_core_is_platform_owner_rpc.sql.
drop function if exists core.is_platform_owner();
