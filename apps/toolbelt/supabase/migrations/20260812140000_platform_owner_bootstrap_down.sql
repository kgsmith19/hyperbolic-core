-- Down migration for 20260812140000_platform_owner_bootstrap.sql.
drop function if exists platform.owner();
drop table if exists platform.config;
drop schema if exists platform;
