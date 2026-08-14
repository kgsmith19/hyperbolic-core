select cron.unschedule('core-purge-old-llm-calls');
drop function core.purge_old_llm_calls();
drop table core.llm_call_monthly_agg;

drop function core.log_llm_call(text, text, text, text, text, text, integer, integer, integer, numeric, integer, text);
drop table core.llm_call;
