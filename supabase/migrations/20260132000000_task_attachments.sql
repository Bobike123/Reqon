-- =============================================================================
--  Ultraplan Phase 1: task attachments (photos, documents, videos) — METADATA ONLY.
--  The bytes live in a private Cloudflare R2 bucket (docs/ultraplan/DECISIONS.md D-02);
--  this migration adds the rows that describe them, the rules that decide who may
--  attach / see / remove them, and the queue that makes sure the bytes are deleted
--  from R2 later. Nothing here talks to R2: the Edge Functions of Phase 2 do.
--
--  WHAT WAS MISSING. A task could carry text only. A motorcycle build is documented
--  with pictures and short clips.
--
--  AFTER.
--   * task_attachments(task_id, kind, object_key, ...): one row per file.
--       - kind: photo | document | video. Allowed MIME types per kind and the size
--         limit per kind (video 100 MiB, photo/document 10 MiB) are CHECKed, so no
--         writer can bypass them.
--       - status: pending (a signed upload URL was issued) -> ready (the bytes were
--         verified) | failed (timeout / size or type mismatch) | deleted (soft).
--       - A video that the browser could not compress is stored with playable=false
--         (download only); a playable video must be video/mp4 and at most 3 minutes
--         (+5 s encoder rounding).
--   * Who may do what (docs/ultraplan/ARCHITECTURE.md section 3):
--       - view    every member (same rule as tasks.member_read);
--       - upload  whoever can_edit_task() the (non-archived) task;
--       - delete  the uploader, or has_department_authority() of the task's
--                 department (Head, parent Head, President, Vice President, Developer);
--       - caption the same people as delete.
--   * Nothing writes the table directly. request_attachment_upload(),
--     delete_attachment() and set_attachment_caption() run as the caller (SECURITY
--     DEFINER, auth.uid() is the caller). confirm_attachment() is SERVICE-ONLY: it
--     is given the size/type that the Edge Function measured on R2 itself, which a
--     browser must never be able to claim.
--   * Limits that are checked BEFORE an upload URL exists: per-file size, MIME type,
--     video length, at most 10 unfinished uploads per member, and a club-wide
--     storage quota per kind group (video 7 GB, photo+document 2 GB; R2 free tier is
--     10 GB-month, 1 GB is left as reserve). Bytes of deleted files still count until
--     they are really purged from R2 (30 days), because they still occupy R2.
--   * attachment_purge_queue: every file that stops being referenced (deleted,
--     failed, or removed together with its task) is queued with its object keys and
--     size. list_due_attachment_purges() / mark_attachment_purged() (service-only)
--     let the scheduled backup workflow delete the objects from R2.
--   * fail_stale_attachment_uploads(): marks uploads still pending after 1 hour as
--     failed and queues them (service-only; scheduler file
--     supabase/scheduler/install_attachment_sweep_job.sql).
--   * attachment_usage(): usage per quota group for the Board (President, Vice
--     President, Developer) — the Settings usage bar.
--   * Every upload / removal writes an `activity` row on the task.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Describe, authorise and account for task attachments.
--    Existing data  None touched. Only new tables, functions, policies, one trigger on
--                   a NEW table, one realtime publication entry.
--    Locking        CREATE TABLE / CREATE FUNCTION: no lock on existing tables.
--                   ALTER PUBLICATION takes a short lock on the publication.
--    Authorization  RLS on every new table. Table grants: authenticated gets SELECT on
--                   task_attachments only; anon gets nothing; everything else is
--                   reached through the functions below, each with an explicit EXECUTE
--                   list (default privileges would otherwise give anon/authenticated
--                   EXECUTE on every new function).
--    Rollback       docs/ultraplan/rollbacks/20260132000000_task_attachments_down.sql
--                   (refuses to run while attachment rows exist). The objects in R2 are
--                   not touched by any database rollback.
--    Deploy order   Any time after 20260131000000. No data dependency.
-- =============================================================================

-- ---------------------------------------------------------------- rule helpers
-- MIME type -> file extension, or null when the type is not allowed for the kind.
create or replace function attachment_mime_extension(p_kind text, p_mime text) returns text
language sql immutable set search_path = public as $fn$
  select case
    when p_kind = 'photo'    and p_mime = 'image/webp'      then 'webp'
    when p_kind = 'photo'    and p_mime = 'image/jpeg'      then 'jpg'
    when p_kind = 'photo'    and p_mime = 'image/png'       then 'png'
    when p_kind = 'document' and p_mime = 'application/pdf' then 'pdf'
    when p_kind = 'video'    and p_mime = 'video/mp4'       then 'mp4'
    when p_kind = 'video'    and p_mime = 'video/quicktime' then 'mov'
    when p_kind = 'video'    and p_mime = 'video/webm'      then 'webm'
  end;
$fn$;

-- Largest accepted file per kind, in bytes (after the browser compressed it).
create or replace function attachment_size_limit(p_kind text) returns bigint
language sql immutable set search_path = public as $fn$
  select case p_kind
    when 'video' then 104857600::bigint   -- 100 MiB
    when 'photo' then 10485760::bigint    -- 10 MiB
    when 'document' then 10485760::bigint -- 10 MiB
  end;
$fn$;

-- Quota group of a kind: videos are budgeted separately from photos + documents.
create or replace function attachment_quota_group(p_kind text) returns text
language sql immutable set search_path = public as $fn$
  select case when p_kind = 'video' then 'video' else 'photo_document' end;
$fn$;

-- ------------------------------------------------------------------- the tables
create table if not exists task_attachments (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references tasks(id) on delete cascade,
  kind           text not null check (kind in ('photo', 'document', 'video')),
  -- Bucket-relative object keys, generated by request_attachment_upload() from uuids only
  -- (a user's file name never reaches a key).
  object_key     text not null unique,
  thumb_key      text unique,                       -- photo thumbnail / video poster (WebP)
  original_name  text not null,
  mime_type      text not null,
  size_bytes     bigint not null check (size_bytes > 0),
  width          integer check (width is null or width between 1 and 20000),
  height         integer check (height is null or height between 1 and 20000),
  duration_ms    integer check (duration_ms is null or duration_ms > 0),
  playable       boolean not null default true,     -- false: stored as received, download only
  caption        text,
  status         text not null default 'pending' check (status in ('pending', 'ready', 'failed', 'deleted')),
  failure_reason text,
  uploaded_by    uuid references members(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint task_attachments_name_valid
    check (original_name = btrim(original_name)
           and char_length(original_name) between 1 and 255
           and original_name !~ '[[:cntrl:]]'),
  constraint task_attachments_mime_for_kind
    check (attachment_mime_extension(kind, mime_type) is not null),
  constraint task_attachments_size_for_kind
    check (size_bytes <= attachment_size_limit(kind)),
  constraint task_attachments_thumb_for_kind
    check ((kind = 'document') = (thumb_key is null)),
  constraint task_attachments_duration_only_video
    check (kind = 'video' or duration_ms is null),
  -- A playable video is an MP4 of at most 3 minutes (+5 s rounding of the encoder).
  constraint task_attachments_playable_video
    check (kind <> 'video' or not playable or (mime_type = 'video/mp4' and duration_ms is not null and duration_ms <= 185000)),
  constraint task_attachments_playable_only_video
    check (kind = 'video' or playable),
  constraint task_attachments_caption_length
    check (caption is null or char_length(caption) between 1 and 500),
  constraint task_attachments_deleted_consistent
    check ((status = 'deleted') = (deleted_at is not null)),
  constraint task_attachments_failed_consistent
    check ((status = 'failed') = (failure_reason is not null))
);
create index if not exists task_attachments_task      on task_attachments (task_id, created_at) where status in ('ready', 'deleted');
create index if not exists task_attachments_pending   on task_attachments (created_at) where status = 'pending';
create index if not exists task_attachments_uploader  on task_attachments (uploaded_by) where status = 'pending';

drop trigger if exists trg_touch_task_attachments on task_attachments;
create trigger trg_touch_task_attachments before update on task_attachments
  for each row execute function touch_updated_at();

comment on table task_attachments is
  'One row per file attached to a task. The bytes are in the private R2 bucket under object_key; clients read ready/deleted rows only and write through request_attachment_upload / delete_attachment / set_attachment_caption.';

-- Files that must be deleted from R2: queued when an attachment is deleted, fails, or is
-- removed together with its task. No foreign key on purpose — the row it describes may already be gone.
create table if not exists attachment_purge_queue (
  id            bigint generated always as identity primary key,
  attachment_id uuid,
  task_id       uuid,
  kind          text not null check (kind in ('photo', 'document', 'video')),
  object_keys   text[] not null check (cardinality(object_keys) between 1 and 2),
  size_bytes    bigint not null check (size_bytes > 0),
  reason        text not null check (reason in ('deleted', 'failed', 'task_removed')),
  queued_at     timestamptz not null default now(),
  purge_after   timestamptz not null,
  purged_at     timestamptz
);
create index if not exists attachment_purge_due on attachment_purge_queue (purge_after) where purged_at is null;

-- Storage budget per quota group. Decimal gigabytes on purpose (7e9 + 2e9 <= 10 GB either way
-- Cloudflare counts a gigabyte).
create table if not exists attachment_quotas (
  quota_group text primary key check (quota_group in ('video', 'photo_document')),
  quota_bytes bigint not null check (quota_bytes > 0)
);
insert into attachment_quotas (quota_group, quota_bytes)
values ('video', 7000000000), ('photo_document', 2000000000)
on conflict (quota_group) do nothing;

-- ------------------------------------------------------------------- row security
alter table task_attachments enable row level security;
alter table task_attachments replica identity full;
drop policy if exists member_read on task_attachments;
-- Pending and failed uploads are nobody's business; 'deleted' stays readable so every open
-- screen can learn about a removal through realtime (clients filter on status = 'ready').
create policy member_read on task_attachments for select to authenticated
  using (is_member() and status in ('ready', 'deleted'));
revoke all on task_attachments from anon, authenticated;
grant select on task_attachments to authenticated;
grant all on task_attachments to service_role;

alter table attachment_purge_queue enable row level security;
revoke all on attachment_purge_queue from anon, authenticated;
grant all on attachment_purge_queue to service_role;

alter table attachment_quotas enable row level security;
revoke all on attachment_quotas from anon, authenticated;
grant all on attachment_quotas to service_role;

do $pub$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_attachments') then
    alter publication supabase_realtime add table task_attachments;
  end if;
end
$pub$;

-- ----------------------------------------------------------------- internal helpers
-- Queue the objects of one attachment for deletion from R2.
create or replace function enqueue_attachment_purge(p_row task_attachments, p_reason text, p_after timestamptz)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  insert into attachment_purge_queue (attachment_id, task_id, kind, object_keys, size_bytes, reason, purge_after)
  values (p_row.id, p_row.task_id, p_row.kind,
          array_remove(array[p_row.object_key, p_row.thumb_key], null),
          p_row.size_bytes, p_reason, p_after);
end $fn$;
revoke all on function enqueue_attachment_purge(task_attachments, text, timestamptz) from public, anon, authenticated;

-- Bytes held in R2 for a quota group: live uploads plus queued-but-not-yet-purged objects.
create or replace function attachment_used_bytes(p_group text) returns bigint
language sql stable security definer set search_path = public as $fn$
  select coalesce((select sum(size_bytes) from task_attachments
                    where status in ('pending', 'ready') and attachment_quota_group(kind) = p_group), 0)
       + coalesce((select sum(size_bytes) from attachment_purge_queue
                    where purged_at is null and attachment_quota_group(kind) = p_group), 0);
$fn$;
revoke all on function attachment_used_bytes(text) from public, anon, authenticated;

-- A task removed together with its season takes its attachments along (ON DELETE CASCADE).
-- Their objects are queued first, with the same 30-day grace as a deletion, so a database
-- restore can still find the files.
create or replace function queue_attachment_on_row_delete() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if old.status in ('pending', 'ready') then
    perform enqueue_attachment_purge(old, 'task_removed', now() + interval '30 days');
  end if;
  return old;
end $fn$;
revoke all on function queue_attachment_on_row_delete() from public, anon, authenticated;

drop trigger if exists trg_queue_attachment_on_delete on task_attachments;
create trigger trg_queue_attachment_on_delete before delete on task_attachments
  for each row execute function queue_attachment_on_row_delete();

-- ---------------------------------------------------------- commands (the caller)
-- Reserves an attachment row and returns the keys the Edge Function signs URLs for.
create or replace function request_attachment_upload(
  p_task_id uuid, p_kind text, p_mime_type text, p_size_bytes bigint, p_original_name text,
  p_width integer default null, p_height integer default null,
  p_duration_ms integer default null, p_playable boolean default true)
returns table (attachment_id uuid, object_key text, thumb_key text)
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_id uuid := gen_random_uuid();
  v_name text := btrim(coalesce(p_original_name, ''));
  v_ext text;
  v_playable boolean := coalesce(p_playable, true);
  v_group text;
  v_quota bigint;
  v_task tasks%rowtype;
  v_obj text;
  v_thumb text;
begin
  if v_uid is null or not is_active_member() then
    raise exception 'Only an active member can attach files.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('photo', 'document', 'video') then
    raise exception 'The kind of file must be photo, document or video.' using errcode = '22023';
  end if;
  v_ext := attachment_mime_extension(p_kind, p_mime_type);
  if v_ext is null then
    raise exception 'A % can''t be stored as %.', p_kind, coalesce(p_mime_type, 'an unknown type')
      using errcode = '23514';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 then
    raise exception 'The file is empty.' using errcode = '23514';
  end if;
  if p_size_bytes > attachment_size_limit(p_kind) then
    raise exception 'That % is %, the largest allowed is %. Compress or trim it first.',
      p_kind, pg_size_pretty(p_size_bytes), pg_size_pretty(attachment_size_limit(p_kind))
      using errcode = '23514';
  end if;
  if v_name = '' or char_length(v_name) > 255 or v_name ~ '[[:cntrl:]]' then
    raise exception 'The file name must be 1 to 255 characters without control characters.' using errcode = '23514';
  end if;
  if p_kind <> 'video' and (p_duration_ms is not null or not v_playable) then
    raise exception 'Only a video has a duration or can be download-only.' using errcode = '22023';
  end if;
  if p_kind = 'video' and v_playable and (p_duration_ms is null or p_duration_ms < 1 or p_duration_ms > 185000) then
    raise exception 'A video can be at most 3 minutes long. Trim it first.' using errcode = '23514';
  end if;
  if p_kind = 'video' and v_playable and p_mime_type <> 'video/mp4' then
    raise exception 'Only an MP4 video can be played in the app; the original is stored download-only.'
      using errcode = '23514';
  end if;
  if p_duration_ms is not null and p_duration_ms < 1 then
    raise exception 'The duration must be positive.' using errcode = '23514';
  end if;
  if (p_width is not null and p_width not between 1 and 20000)
     or (p_height is not null and p_height not between 1 and 20000) then
    raise exception 'The picture size is out of range.' using errcode = '23514';
  end if;

  -- Serialise with anything else changing the task, then check it may be changed.
  select * into v_task from tasks where id = p_task_id for share;
  if not found then
    raise exception 'That task does not exist.' using errcode = 'P0002';
  end if;
  if v_task.archived_at is not null then
    raise exception 'An archived task can''t take new files. Restore it first.' using errcode = '23514';
  end if;
  if not can_edit_task(p_task_id) then
    raise exception 'You can''t attach files to this task. Its owner, its department''s Head or a Developer can.'
      using errcode = '42501';
  end if;

  -- Abuse guard: unfinished reservations count against the shared quota, so one member
  -- may not hold more than ten of them.
  if (select count(*) from task_attachments where uploaded_by = v_uid and status = 'pending') >= 10 then
    raise exception 'You already have 10 uploads in progress. Wait for them to finish.' using errcode = '54000';
  end if;

  -- The quota is checked under one lock per group, so two concurrent requests cannot both
  -- squeeze into the last bytes.
  v_group := attachment_quota_group(p_kind);
  perform pg_advisory_xact_lock(hashtextextended('task_attachments:quota:' || v_group, 0));
  select quota_bytes into v_quota from attachment_quotas where quota_group = v_group;
  if attachment_used_bytes(v_group) + p_size_bytes > v_quota then
    raise exception 'The club''s storage for % is full. Delete something first or ask a Developer.',
      case v_group when 'video' then 'videos' else 'photos and documents' end
      using errcode = '54000';
  end if;

  v_obj := 'tasks/' || p_task_id::text || '/' || v_id::text || '.' || v_ext;
  v_thumb := case when p_kind = 'document' then null
                  else 'tasks/' || p_task_id::text || '/' || v_id::text || '.thumb.webp' end;

  insert into task_attachments (id, task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes,
                                width, height, duration_ms, playable, uploaded_by)
  values (v_id, p_task_id, p_kind, v_obj, v_thumb, v_name, p_mime_type, p_size_bytes,
          p_width, p_height, p_duration_ms, v_playable, v_uid);

  return query select v_id, v_obj, v_thumb;
end $fn$;

-- Soft-deletes an attachment (uploader, or department authority over the task). Returns true when
-- something was deleted, false when it was already gone (a retry).
create or replace function delete_attachment(p_attachment_id uuid) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_att task_attachments%rowtype;
  v_task tasks%rowtype;
begin
  if v_uid is null or not is_active_member() then
    raise exception 'Only an active member can delete files.' using errcode = '42501';
  end if;
  select * into v_att from task_attachments where id = p_attachment_id for update;
  if not found then
    raise exception 'That file does not exist.' using errcode = 'P0002';
  end if;
  select * into v_task from tasks where id = v_att.task_id;
  if v_att.uploaded_by is distinct from v_uid and not has_department_authority(v_task.subteam_key) then
    raise exception 'You can''t delete this file. Who uploaded it, the department''s Head or a Developer can.'
      using errcode = '42501';
  end if;
  if v_att.status not in ('pending', 'ready') then
    return false;
  end if;

  update task_attachments set status = 'deleted', deleted_at = now() where id = v_att.id;
  -- A finished file keeps 30 days of grace (a restored backup still finds it); an unfinished
  -- upload has nothing worth keeping.
  perform enqueue_attachment_purge(v_att, 'deleted',
    case when v_att.status = 'ready' then now() + interval '30 days' else now() end);
  if v_att.status = 'ready' then
    insert into activity (actor_id, season_id, entity, entity_id, action, detail)
    values (v_uid, v_task.season_id, 'task', v_task.id::text, 'attachment_deleted',
            jsonb_build_object('attachment_id', v_att.id, 'kind', v_att.kind, 'name', v_att.original_name,
                               'title', v_task.title));
  end if;
  return true;
end $fn$;

-- Sets or clears the caption (same people as delete). Returns true when it changed.
create or replace function set_attachment_caption(p_attachment_id uuid, p_caption text) returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_att task_attachments%rowtype;
  v_subteam text;
  v_caption text := nullif(btrim(coalesce(p_caption, '')), '');
begin
  if v_uid is null or not is_active_member() then
    raise exception 'Only an active member can edit a caption.' using errcode = '42501';
  end if;
  if v_caption is not null and char_length(v_caption) > 500 then
    raise exception 'A caption can have at most 500 characters.' using errcode = '23514';
  end if;
  select * into v_att from task_attachments where id = p_attachment_id for update;
  if not found then
    raise exception 'That file does not exist.' using errcode = 'P0002';
  end if;
  select subteam_key into v_subteam from tasks where id = v_att.task_id;
  if v_att.uploaded_by is distinct from v_uid and not has_department_authority(v_subteam) then
    raise exception 'You can''t edit this caption. Who uploaded the file, the department''s Head or a Developer can.'
      using errcode = '42501';
  end if;
  if v_att.status <> 'ready' then
    raise exception 'Only a finished upload has a caption.' using errcode = '22023';
  end if;
  if v_att.caption is not distinct from v_caption then
    return false;
  end if;
  update task_attachments set caption = v_caption where id = v_att.id;
  return true;
end $fn$;

-- Usage per quota group for the Settings bar (President, Vice President, Developer).
create or replace function attachment_usage() returns table (quota_group text, used_bytes bigint, quota_bytes bigint)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if auth.uid() is null or not is_admin() then
    raise exception 'Only the President, the Vice President or a Developer can see storage usage.'
      using errcode = '42501';
  end if;
  return query
    select q.quota_group, attachment_used_bytes(q.quota_group), q.quota_bytes
    from attachment_quotas q order by q.quota_group;
end $fn$;

-- ------------------------------------------------------ service-only (Edge Functions, scheduler)
-- Called by the attachment-confirm Edge Function with what IT measured on R2 (HEAD request).
-- Returns the resulting status: 'ready', or 'failed' (size/type mismatch or missing thumbnail),
-- or the current 'deleted' / 'failed'. A repeated call on a ready file returns 'ready'.
create or replace function confirm_attachment(
  p_attachment_id uuid, p_uploader uuid, p_actual_size bigint, p_actual_mime text, p_thumb_present boolean)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  v_att task_attachments%rowtype;
  v_task tasks%rowtype;
  v_reason text;
begin
  select * into v_att from task_attachments where id = p_attachment_id for update;
  if not found then
    raise exception 'That file does not exist.' using errcode = 'P0002';
  end if;
  if v_att.uploaded_by is distinct from p_uploader then
    raise exception 'Only who started an upload can finish it.' using errcode = '42501';
  end if;
  if v_att.status <> 'pending' then
    return v_att.status;
  end if;

  v_reason := case
    when p_actual_size is distinct from v_att.size_bytes then 'size_mismatch'
    when p_actual_mime is distinct from v_att.mime_type then 'type_mismatch'
    when v_att.thumb_key is not null and not coalesce(p_thumb_present, false) then 'thumbnail_missing'
  end;
  if v_reason is not null then
    update task_attachments set status = 'failed', failure_reason = v_reason where id = v_att.id;
    perform enqueue_attachment_purge(v_att, 'failed', now());
    return 'failed';
  end if;

  update task_attachments set status = 'ready' where id = v_att.id;
  select * into v_task from tasks where id = v_att.task_id;
  insert into activity (actor_id, season_id, entity, entity_id, action, detail)
  values (v_att.uploaded_by, v_task.season_id, 'task', v_task.id::text, 'attachment_added',
          jsonb_build_object('attachment_id', v_att.id, 'kind', v_att.kind, 'name', v_att.original_name,
                             'size_bytes', v_att.size_bytes, 'title', v_task.title));
  return 'ready';
end $fn$;

-- Uploads still pending after an hour never finished: mark them failed and queue their objects.
create or replace function fail_stale_attachment_uploads(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  v_row task_attachments%rowtype;
  v_n integer := 0;
begin
  for v_row in
    select * from task_attachments
     where status = 'pending' and created_at < p_now - interval '1 hour'
     order by created_at for update skip locked
  loop
    update task_attachments set status = 'failed', failure_reason = 'upload_timeout' where id = v_row.id;
    perform enqueue_attachment_purge(v_row, 'failed', p_now);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $fn$;

-- The purge job: what is due for deletion from R2, then what was deleted.
create or replace function list_due_attachment_purges(p_limit integer default 100, p_now timestamptz default now())
returns table (id bigint, object_keys text[], size_bytes bigint)
language sql stable security definer set search_path = public as $fn$
  select q.id, q.object_keys, q.size_bytes
    from attachment_purge_queue q
   where q.purged_at is null and q.purge_after <= p_now
   order by q.purge_after, q.id
   limit greatest(1, least(coalesce(p_limit, 100), 1000));
$fn$;

create or replace function mark_attachment_purged(p_ids bigint[]) returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  v_n integer;
begin
  update attachment_purge_queue set purged_at = now()
   where id = any(coalesce(p_ids, '{}')) and purged_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

-- ------------------------------------------------------------------- EXECUTE surface
-- New functions get EXECUTE for PUBLIC and, through Supabase's default privileges, anon and
-- authenticated. Spell out exactly who may call what.
revoke all on function attachment_mime_extension(text, text), attachment_size_limit(text),
  attachment_quota_group(text) from public, anon;
grant execute on function attachment_mime_extension(text, text), attachment_size_limit(text),
  attachment_quota_group(text) to authenticated, service_role;

revoke all on function request_attachment_upload(uuid, text, text, bigint, text, integer, integer, integer, boolean),
  delete_attachment(uuid), set_attachment_caption(uuid, text), attachment_usage() from public, anon;
grant execute on function request_attachment_upload(uuid, text, text, bigint, text, integer, integer, integer, boolean),
  delete_attachment(uuid), set_attachment_caption(uuid, text), attachment_usage() to authenticated, service_role;

revoke all on function confirm_attachment(uuid, uuid, bigint, text, boolean),
  fail_stale_attachment_uploads(timestamptz), list_due_attachment_purges(integer, timestamptz),
  mark_attachment_purged(bigint[]) from public, anon, authenticated;
grant execute on function confirm_attachment(uuid, uuid, bigint, text, boolean),
  fail_stale_attachment_uploads(timestamptz), list_due_attachment_purges(integer, timestamptz),
  mark_attachment_purged(bigint[]) to service_role;
