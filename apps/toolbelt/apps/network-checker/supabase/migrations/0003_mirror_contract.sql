-- Additive mirror upgrade for clients that already applied 0001/0002.
-- Keep numbered migrations immutable: this file brings both old projects and
-- fresh installs to the natural-key contract used by netcheck/store.py.

alter table samples add column if not exists label text;

alter table device add column if not exists identity text;
do $$
begin
  if exists (select 1 from device where mac is null and ip is null) then
    raise exception 'cannot derive mirror device identity: both mac and ip are null';
  end if;
end;
$$;
update device
set identity = case when mac is not null then 'mac:' || lower(mac)
                    else 'ip:' || ip end
where identity is null;
alter table device alter column identity set not null;
create unique index if not exists device_host_identity_key
  on device (host, identity);

create unique index if not exists interface_observation_key
  on interface (host, device_mac, device_ip, name, observed_at) nulls not distinct;
create unique index if not exists config_item_observation_key
  on config_item (host, device_mac, device_ip, key, observed_at) nulls not distinct;
