Title: FEAT(network-checker): device and configuration inventory
Type: FEAT
Component: Network Checker
Milestone: M5 Component upgrades
Depends on: none
Blocks: m5-04-feat-nc-change-lifecycle.md

## Problem
Every device fact is trapped inside env_scans JSON payloads; nothing answers what devices exist or what changed on the router since last week (05-f-network-checker.md section 3). NC-3 selects the inventory as the V1 feature; the DDL, population contract, and CLI spec are 05-f section 3.

## Scope
In scope:
- device, interface, config_item tables and the config_current view per the 05-f section 3 DDL, mirrored to the optional Supabase mirror with the existing synced discipline
- record_inventory pure mapper fed by existing scan payloads inside existing tier budgets; no new collectors
- netcheck inventory subcommand (list, per-device config, diff since timestamp)
Out of scope:
- New measurement classes (DHCP and ethernet stay in the post-V1 queue per 05-f section 7)

## Acceptance criteria
When a standard or deep scan completes, the system shall persist one device row per neighbor-table entry and config_item rows for every measured property, within the tier budget (NC-3.1).
The operator shall be able to list devices and each device's current configuration from the store (NC-3.2).
When the same property is observed with a new value, the system shall append a new config_item row and config_current shall return only the newest value (NC-3.3).
The inventory render shall complete under 500 ms against a year of scans.

## Verification
python3 -m unittest tests.test_inventory (fixture payload in, row counts equal fixture device and property counts)
python -m netcheck inventory against a seeded NETCHECK_DB prints one row per fixture device; exit 0
History-and-view case in tests.test_inventory
Timed render case against the large seeded fixture

## Estimated LOC delta
Added: 455  Deleted: 0  Net: +455

## Risk
Low; persistence of already-collected data through a pure mapper.
