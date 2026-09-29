-- Deployment-time operation: this file is NOT a migration.
-- Run only after 20260123000000_automation_audit_realtime_export.sql and after
-- enabling Supabase Cron / pg_cron in the target environment.

do $check$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not installed. Enable Supabase Cron explicitly, then rerun this file.';
  end if;
  if has_function_privilege('authenticated', 'public.archive_stale_done_tasks()', 'execute')
     or has_function_privilege('anon', 'public.archive_stale_done_tasks()', 'execute') then
    raise exception 'archive_stale_done_tasks() is exposed to an API user; refusing to schedule it';
  end if;
end
$check$;

-- pg_cron treats a second schedule call with the same case-sensitive name as
-- an update. The stable name therefore makes cadence/command changes
-- idempotent across deployments.
select cron.schedule(
  'paddock-control-archive-stale-done',
  '*/5 * * * *',
  $job$select public.archive_stale_done_tasks();$job$
);

-- Installation evidence: one active job, its owner, cadence and exact command.
select jobid, jobname, schedule, command, database, username, active
  from cron.job
 where jobname = 'paddock-control-archive-stale-done';

-- Last-run/failure visibility. A new installation legitimately has no rows.
select d.jobid, d.status, d.return_message, d.start_time, d.end_time
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 where j.jobname = 'paddock-control-archive-stale-done'
 order by d.start_time desc
 limit 20;
