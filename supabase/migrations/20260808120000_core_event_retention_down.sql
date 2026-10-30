select cron.unschedule('core-purge-old-events');
drop function core.purge_old_events();
drop table core.event_monthly_agg;
