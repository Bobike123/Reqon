-- Deployment-time operation: this file is NOT a migration.
-- Run only after 20260132000000_task_attachments.sql and after enabling
-- Supabase Cron / pg_cron in the target environment.
--
-- Every 10 minutes, uploads that are still `pending` after one hour are marked failed and
-- their objects are queued for deletion from R2 (fail_stale_attachment_uploads()).

do $check$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not installed. Enable Supabase Cron explicitly, then rerun this file.';
  end if;
  if has_function_privilege('authenticated', 'public.fail_stale_attachment_uploads(timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.fail_stale_attachment_uploads(timestamptz)', 'execute') then
    raise exception 'fail_stale_attachment_uploads() is exposed to an API user; refusing to schedule it';
  end if;
end
$check$;

-- A second schedule call with the same case-sensitive name updates the job, so re-running is safe.
select cron.schedule(
  'paddock-control-fail-stale-attachment-uploads',
  '*/10 * * * *',
  $job$select public.fail_stale_attachment_uploads();$job$
);

-- Installation evidence: one active job, its owner, cadence and exact command.
select jobid, jobname, schedule, command, database, username, active
  from cron.job
 where jobname = 'paddock-control-fail-stale-attachment-uploads';
