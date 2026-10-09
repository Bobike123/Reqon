-- Recoverable scheduler removal. The database function remains; only the periodic
-- invocation is removed. Zero rows means it was absent.
select cron.unschedule(jobid)
  from cron.job
 where jobname = 'paddock-control-fail-stale-attachment-uploads';
