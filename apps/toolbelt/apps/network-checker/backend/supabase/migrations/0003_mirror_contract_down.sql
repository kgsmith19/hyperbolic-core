drop index if exists config_item_observation_key;
drop index if exists interface_observation_key;
drop index if exists device_host_identity_key;
alter table device drop column if exists identity;
alter table samples drop column if exists label;
