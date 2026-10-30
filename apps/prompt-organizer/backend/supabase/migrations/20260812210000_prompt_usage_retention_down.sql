-- Down migration for 20260812210000_prompt_usage_retention.sql.
select cron.unschedule('test-purge-scratch');
select cron.unschedule('prompt-purge-old-usage');
drop function if exists prompt.purge_old_usage();
drop policy if exists owner_rw on prompt.usage_monthly_agg;
drop table if exists prompt.usage_monthly_agg;
