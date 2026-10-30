-- Down migration for 20260806190000_core_create_schema.sql (AC-007 pattern, applied to core).
drop table if exists core.intervention;
drop table if exists core.assumption;
drop table if exists core.metric_value;
drop table if exists core.metric_def;
drop table if exists core.run_outcome;
drop table if exists core.outcome;
drop table if exists core.cost;
drop table if exists core.event;
drop table if exists core.run;
drop table if exists core.app;
drop schema if exists core;
