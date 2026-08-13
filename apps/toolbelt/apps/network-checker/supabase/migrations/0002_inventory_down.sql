-- Reverts 0002_inventory.sql: removes exactly what it added, in dependency
-- order (the view first, since it selects from config_item; the index
-- would be dropped implicitly with its table regardless, but is named here
-- for symmetry with the up migration).
drop view if exists config_current;
drop index if exists config_item_device_key_idx;
drop table if exists config_item;
drop table if exists interface;
drop table if exists device;
