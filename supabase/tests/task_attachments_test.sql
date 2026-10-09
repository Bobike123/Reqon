-- =============================================================================
--  Task attachments (Ultraplan Phase 1): docs/ultraplan/ARCHITECTURE.md sections 2-3;
--  migration 20260132000000_task_attachments.sql.
--
--  SAFE TO RUN AGAINST THE REAL PROJECT: one DO block that always raises, so every
--  fixture rolls back. Fixture people are new @attach.test identities. No bytes are
--  involved: this file tests the rows, rules and queues only.
--
--  Result: ATTACHMENT CHECKS PASSED / FAILED.
--
--  Covers: grants (nothing writable directly, service-only functions closed to browsers);
--  who may upload (owner, department Head, parent Head, President, Vice President, Developer)
--  and who may not; refusals for archived / unknown tasks; every size, type, name, duration
--  and picture limit; object keys; visibility of pending / ready / failed / deleted rows;
--  confirm_attachment (service-only, mismatches fail the upload and queue the objects);
--  delete (uploader, Head, parent Head, governance; not other departments, Treasurer,
--  retired members; idempotent; 30-day grace in the purge queue; audit rows); captions;
--  attachment_usage (Board only); the per-member pending cap and the per-group quota
--  (pending and not-yet-purged bytes count; boundaries exact); the stale-upload sweep;
--  the purge queue API; the cascade when a task is removed; and the table's own CHECK
--  constraints as the last line of defence.
-- =============================================================================

create or replace function pg_temp.attempt(who uuid, stmt text) returns text language plpgsql as $fn$
declare n bigint; result text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', who::text, true);
  begin
    execute stmt;
    get diagnostics n = row_count;
    result := case when n > 0 then 'ALLOWED' else 'DENIED' end;
  exception
    when insufficient_privilege then result := 'DENIED';
    when others then result := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return result;
end $fn$;

-- Runs a statement that returns ONE value as role r (authenticated as `who`, or anon / service_role
-- with who null) and returns that value as text; a privilege error is 'DENIED', anything else
-- 'ERROR <sqlstate>: <message>'.
create or replace function pg_temp.scalar_as(r text, who uuid, stmt text) returns text language plpgsql as $fn$
declare v text;
begin
  perform set_config('role', r, true);
  if who is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', r)::text, true);
    perform set_config('request.jwt.claim.sub', who::text, true);
  end if;
  begin
    execute stmt into v;
  exception
    when insufficient_privilege then v := 'DENIED';
    when others then v := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $fn$;

-- Runs a statement as the table owner (the fixture level) and returns 'OK' or the SQLSTATE.
create or replace function pg_temp.try_sql(stmt text) returns text language plpgsql as $fn$
begin
  execute stmt;
  return 'OK';
exception when others then return sqlstate;
end $fn$;

-- The upload request as a one-value statement.
create or replace function pg_temp.q(task uuid, kind text default 'photo', mime text default 'image/jpeg',
  size bigint default 5000, nm text default 'p.jpg') returns text language sql as $fn$
  select format('select attachment_id::text from request_attachment_upload(%L, %L, %L, %L, %L)', task, kind, mime, size, nm);
$fn$;

-- The upload request with every parameter, as `who`; returns the new id or the error text.
create or replace function pg_temp.rq(who uuid, task uuid, kind text, mime text, size bigint, nm text,
  w integer default null, h integer default null, dur integer default null, play boolean default true)
returns text language sql as $fn$
  select pg_temp.scalar_as('authenticated', who,
    format('select attachment_id::text from request_attachment_upload(%L, %L, %L, %L, %L, %L, %L, %L, %L)',
           task, kind, mime, size, nm, w, h, dur, play));
$fn$;

create or replace function pg_temp.is_uuid(x text) returns text language sql as $fn$
  select (x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::text;
$fn$;

create or replace function pg_temp.as_uuid(x text) returns uuid language plpgsql as $fn$
begin return x::uuid; exception when others then return null; end $fn$;

create or replace function pg_temp.confirm(id uuid, uploader uuid, size bigint, mime text, thumb boolean)
returns text language sql as $fn$
  select pg_temp.scalar_as('service_role', null, format('select confirm_attachment(%L, %L, %L, %L, %L)', id, uploader, size, mime, thumb));
$fn$;

-- A request plus a matching confirmation: a finished (ready) attachment. Null when anything failed.
create or replace function pg_temp.mk(who uuid, task uuid, kind text, mime text, size bigint,
  nm text default 'f', dur integer default null) returns uuid language plpgsql as $fn$
declare v uuid;
begin
  v := pg_temp.as_uuid(pg_temp.rq(who, task, kind, mime, size, nm, null, null, dur));
  if v is null then return null; end if;
  if pg_temp.confirm(v, who, size, mime, kind <> 'document') <> 'ready' then return null; end if;
  return v;
end $fn$;

create temp table results (n serial, label text, got text, expected text);
create or replace function pg_temp.expect(label text, got text, expected text) returns void
language sql as $fn$ insert into pg_temp.results (label, got, expected) values (label, got, expected); $fn$;

do $test$
declare
  season uuid;
  pre uuid := gen_random_uuid(); vp uuid := gen_random_uuid(); dev uuid := gen_random_uuid();
  tre uuid := gen_random_uuid(); own uuid := gen_random_uuid(); oth uuid := gen_random_uuid();
  ha uuid := gen_random_uuid(); hb uuid := gen_random_uuid(); hs uuid := gen_random_uuid();
  alum uuid := gen_random_uuid(); alum_dev uuid := gen_random_uuid(); outs uuid := gen_random_uuid();
  capper uuid := gen_random_uuid();
  pa text; pb text;
  t1 uuid; t_sub uuid; t_un uuid; t_arch uuid; t_cap uuid; t_casc uuid;
  a_id uuid; b_id uuid; c_id uuid; d_id uuid; e_id uuid;
  f1 uuid; f2 uuid; f3 uuid; f4 uuid; f5 uuid; f6 uuid; f7 uuid; f8 uuid; f9 uuid; fp uuid; p2 uuid;
  k1 uuid; k2 uuid; k3 uuid; kv uuid;
  r text; i int; q_id bigint;
  u0 bigint; u1 bigint; u2 bigint; used_pd bigint;
  total int; bad int; report text;
begin
  select id into season from seasons where is_current limit 1;
  select key into pa from subteams where archived_at is null and parent_key is null order by sort_order, key limit 1;
  select key into pb from subteams where archived_at is null and parent_key is null and key <> pa order by sort_order, key limit 1;

  insert into auth.users (id, email)
  select id, k || '@attach.test' from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (own, 'own'),
    (oth, 'oth'), (ha, 'ha'), (hb, 'hb'), (hs, 'hs'), (alum, 'alum'), (alum_dev, 'alumdev'), (outs, 'outs'),
    (capper, 'capper')) v(id, k);
  -- 'outs' has an auth login but is not a member of the club.
  insert into members (id, full_name, role, status)
  select id, 'T ' || k, 'Member', case when k in ('alum', 'alumdev') then 'alumni' else 'active' end::member_state
  from (values (pre, 'pre'), (vp, 'vp'), (dev, 'dev'), (tre, 'tre'), (own, 'own'), (oth, 'oth'), (ha, 'ha'),
    (hb, 'hb'), (hs, 'hs'), (alum, 'alum'), (alum_dev, 'alumdev'), (capper, 'capper')) v(id, k);
  insert into member_roles (member_id, role) values (pre, 'president'), (vp, 'vicepresident'), (dev, 'developer'),
    (tre, 'treasurer'), (alum_dev, 'developer');
  update subteams set lead_id = ha where key = pa;
  update subteams set lead_id = hb where key = pb;
  insert into subteams (key, name, parent_key, lead_id) values ('TA_SUB', 'Attach sub', pa, hs);

  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'TA one', pa, own) returning id into t1;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'TA sub', 'TA_SUB', own) returning id into t_sub;
  insert into tasks (season_id, title, owner_id) values (season, 'TA unassigned', own) returning id into t_un;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'TA archived', pa, own) returning id into t_arch;
  perform set_config('reqon.task_lifecycle_write', 'on', true);
  update tasks set archived_at = now(), archive_reason = 'manual' where id = t_arch;
  perform set_config('reqon.task_lifecycle_write', 'off', true);
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'TA cap', pa, capper) returning id into t_cap;
  insert into tasks (season_id, title, subteam_key, owner_id) values (season, 'TA cascade', pa, own) returning id into t_casc;

  -- ============================================================ structure and grants
  perform pg_temp.expect('RLS is on for the attachment table', (select relrowsecurity::text from pg_class where oid = 'task_attachments'::regclass), 'true');
  perform pg_temp.expect('RLS is on for the purge queue', (select relrowsecurity::text from pg_class where oid = 'attachment_purge_queue'::regclass), 'true');
  perform pg_temp.expect('RLS is on for the quotas', (select relrowsecurity::text from pg_class where oid = 'attachment_quotas'::regclass), 'true');
  perform pg_temp.expect('the table is in the realtime publication', (select count(*)::text from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_attachments'), '1');
  perform pg_temp.expect('anon cannot read attachments', pg_temp.scalar_as('anon', null, 'select count(*) from task_attachments'), 'DENIED');
  perform pg_temp.expect('a member cannot insert a row directly', pg_temp.attempt(own, format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes) values (%L, ''photo'', ''x/1.jpg'', ''x/1.thumb.webp'', ''a'', ''image/jpeg'', 10)', t1)), 'DENIED');
  perform pg_temp.expect('not even a Developer can update a row directly', pg_temp.attempt(dev, 'update task_attachments set caption = ''x'''), 'DENIED');
  perform pg_temp.expect('not even a Developer can delete a row directly', pg_temp.attempt(dev, 'delete from task_attachments'), 'DENIED');
  perform pg_temp.expect('the purge queue is closed to members', pg_temp.scalar_as('authenticated', pre, 'select count(*) from attachment_purge_queue'), 'DENIED');
  perform pg_temp.expect('the quotas are closed to members', pg_temp.scalar_as('authenticated', pre, 'select count(*) from attachment_quotas'), 'DENIED');
  perform pg_temp.expect('the service role can read the table', (pg_temp.scalar_as('service_role', null, 'select count(*) from task_attachments') ~ '^[0-9]+$')::text, 'true');
  perform pg_temp.expect('anon cannot request an upload', pg_temp.scalar_as('anon', null, pg_temp.q(t1)), 'DENIED');
  perform pg_temp.expect('anon cannot read the usage', pg_temp.scalar_as('anon', null, 'select count(*) from attachment_usage()'), 'DENIED');
  perform pg_temp.expect('a member cannot call confirm_attachment', pg_temp.scalar_as('authenticated', own, format('select confirm_attachment(%L, %L, 1, ''image/jpeg'', true)', gen_random_uuid(), own)), 'DENIED');
  perform pg_temp.expect('a member cannot run the stale sweep', pg_temp.scalar_as('authenticated', dev, 'select fail_stale_attachment_uploads()'), 'DENIED');
  perform pg_temp.expect('a member cannot list the purge queue', pg_temp.scalar_as('authenticated', dev, 'select count(*) from list_due_attachment_purges()'), 'DENIED');
  perform pg_temp.expect('a member cannot mark objects purged', pg_temp.scalar_as('authenticated', dev, 'select mark_attachment_purged(array[1]::bigint[])'), 'DENIED');
  perform pg_temp.expect('a member cannot call the quota accounting helper', pg_temp.scalar_as('authenticated', dev, 'select attachment_used_bytes(''video'')'), 'DENIED');
  perform pg_temp.expect('a member cannot call the queue helper', pg_temp.scalar_as('authenticated', dev, 'select enqueue_attachment_purge(null::task_attachments, ''deleted'', now())::text'), 'DENIED');

  -- ======================================================== who may upload (photo, 5000 bytes)
  perform pg_temp.expect('the task owner may attach', pg_temp.attempt(own, pg_temp.q(t1)), 'ALLOWED');
  perform pg_temp.expect('the department Head may attach', pg_temp.attempt(ha, pg_temp.q(t1)), 'ALLOWED');
  perform pg_temp.expect('the President may attach', pg_temp.attempt(pre, pg_temp.q(t1)), 'ALLOWED');
  perform pg_temp.expect('the Vice President may attach', pg_temp.attempt(vp, pg_temp.q(t1)), 'ALLOWED');
  perform pg_temp.expect('a Developer may attach', pg_temp.attempt(dev, pg_temp.q(t1)), 'ALLOWED');
  perform pg_temp.expect('another member may not', pg_temp.attempt(oth, pg_temp.q(t1)), 'DENIED');
  perform pg_temp.expect('the Treasurer may not', pg_temp.attempt(tre, pg_temp.q(t1)), 'DENIED');
  perform pg_temp.expect('the Head of another department may not', pg_temp.attempt(hb, pg_temp.q(t1)), 'DENIED');
  perform pg_temp.expect('a subdepartment Head may not reach up to the parent''s task', pg_temp.attempt(hs, pg_temp.q(t1)), 'DENIED');
  perform pg_temp.expect('an alumnus may not', pg_temp.attempt(alum, pg_temp.q(t1)), 'DENIED');
  perform pg_temp.expect('a retired Developer may not', pg_temp.attempt(alum_dev, pg_temp.q(t1)), 'DENIED');
  perform pg_temp.expect('someone who is not a member may not', pg_temp.attempt(outs, pg_temp.q(t1)), 'DENIED');
  perform pg_temp.expect('a subdepartment Head may attach to the subdepartment''s task', pg_temp.attempt(hs, pg_temp.q(t_sub)), 'ALLOWED');
  perform pg_temp.expect('the parent department''s Head may attach to the subdepartment''s task', pg_temp.attempt(ha, pg_temp.q(t_sub)), 'ALLOWED');
  perform pg_temp.expect('the Head of an unrelated department may not', pg_temp.attempt(hb, pg_temp.q(t_sub)), 'DENIED');
  perform pg_temp.expect('the owner of an unassigned task may attach', pg_temp.attempt(own, pg_temp.q(t_un)), 'ALLOWED');
  perform pg_temp.expect('a Head may not attach to unassigned work', pg_temp.attempt(ha, pg_temp.q(t_un)), 'DENIED');
  perform pg_temp.expect('another member may not attach to unassigned work', pg_temp.attempt(oth, pg_temp.q(t_un)), 'DENIED');
  perform pg_temp.expect('the President may attach to unassigned work', pg_temp.attempt(pre, pg_temp.q(t_un)), 'ALLOWED');
  perform pg_temp.expect('an archived task takes no new file', pg_temp.scalar_as('authenticated', pre, pg_temp.q(t_arch)), 'ERROR 23514%');
  perform pg_temp.expect('an unknown task is refused', pg_temp.scalar_as('authenticated', pre, pg_temp.q(gen_random_uuid())), 'ERROR P0002%');

  -- ============================================================== limits (as the Vice President)
  perform pg_temp.expect('an unknown kind is refused', pg_temp.rq(vp, t1, 'audio', 'audio/mpeg', 100, 'a.mp3'), 'ERROR 22023%');
  perform pg_temp.expect('a missing kind is refused', pg_temp.rq(vp, t1, null, 'image/jpeg', 100, 'a.jpg'), 'ERROR 22023%');
  perform pg_temp.expect('a photo cannot be an MP4', pg_temp.rq(vp, t1, 'photo', 'video/mp4', 100, 'a.mp4'), 'ERROR 23514%');
  perform pg_temp.expect('a document must be a PDF', pg_temp.rq(vp, t1, 'document', 'image/jpeg', 100, 'a.jpg'), 'ERROR 23514%');
  perform pg_temp.expect('a video cannot be a PDF', pg_temp.rq(vp, t1, 'video', 'application/pdf', 100, 'a.pdf'), 'ERROR 23514%');
  perform pg_temp.expect('a missing type is refused', pg_temp.rq(vp, t1, 'photo', null, 100, 'a.jpg'), 'ERROR 23514%');
  perform pg_temp.expect('an empty file is refused', pg_temp.rq(vp, t1, 'photo', 'image/jpeg', 0, 'a.jpg'), 'ERROR 23514%');
  perform pg_temp.expect('a photo over 10 MiB is refused', pg_temp.rq(vp, t1, 'photo', 'image/jpeg', 10485761, 'a.jpg'), 'ERROR 23514%');
  perform pg_temp.expect('a photo of exactly 10 MiB is accepted', pg_temp.is_uuid(pg_temp.rq(vp, t1, 'photo', 'image/jpeg', 10485760, 'a.jpg')), 'true');
  perform pg_temp.expect('a document over 10 MiB is refused', pg_temp.rq(vp, t1, 'document', 'application/pdf', 10485761, 'a.pdf'), 'ERROR 23514%');
  perform pg_temp.expect('a video over 100 MiB is refused', pg_temp.rq(vp, t1, 'video', 'video/mp4', 104857601, 'a.mp4', null, null, 60000), 'ERROR 23514%');
  perform pg_temp.expect('a video of exactly 100 MiB is accepted', pg_temp.is_uuid(pg_temp.rq(vp, t1, 'video', 'video/mp4', 104857600, 'a.mp4', null, null, 60000)), 'true');
  perform pg_temp.expect('a blank file name is refused', pg_temp.rq(vp, t1, 'photo', 'image/jpeg', 100, '   '), 'ERROR 23514%');
  perform pg_temp.expect('a file name with a line break is refused', pg_temp.rq(vp, t1, 'photo', 'image/jpeg', 100, E'a\nb.jpg'), 'ERROR 23514%');
  perform pg_temp.expect('a 256-character file name is refused', pg_temp.rq(vp, t1, 'photo', 'image/jpeg', 100, repeat('x', 256)), 'ERROR 23514%');
  perform pg_temp.expect('a playable video needs a duration', pg_temp.rq(vp, t1, 'video', 'video/mp4', 1000, 'a.mp4'), 'ERROR 23514%');
  perform pg_temp.expect('a playable video over 3 minutes (+5 s) is refused', pg_temp.rq(vp, t1, 'video', 'video/mp4', 1000, 'a.mp4', null, null, 185001), 'ERROR 23514%');
  perform pg_temp.expect('a playable video of exactly 185 s is accepted', pg_temp.is_uuid(pg_temp.rq(vp, t1, 'video', 'video/mp4', 1000, 'a.mp4', null, null, 185000)), 'true');
  perform pg_temp.expect('a QuickTime original cannot be marked playable', pg_temp.rq(vp, t1, 'video', 'video/quicktime', 1000, 'a.mov', null, null, 5000), 'ERROR 23514%');
  perform pg_temp.expect('a QuickTime original is accepted as download-only', pg_temp.is_uuid(pg_temp.rq(vp, t1, 'video', 'video/quicktime', 1000, 'a.mov', null, null, null, false)), 'true');
  perform pg_temp.expect('a download-only video may not claim a negative duration', pg_temp.rq(vp, t1, 'video', 'video/quicktime', 1000, 'a.mov', null, null, -5, false), 'ERROR 23514%');
  perform pg_temp.expect('a photo has no duration', pg_temp.rq(vp, t1, 'photo', 'image/jpeg', 100, 'a.jpg', null, null, 1000), 'ERROR 22023%');
  perform pg_temp.expect('a document cannot be download-only', pg_temp.rq(vp, t1, 'document', 'application/pdf', 100, 'a.pdf', null, null, null, false), 'ERROR 22023%');
  perform pg_temp.expect('a picture wider than 20000 px is refused', pg_temp.rq(vp, t1, 'photo', 'image/jpeg', 100, 'a.jpg', 20001, 100), 'ERROR 23514%');
  perform pg_temp.expect('the file name is stored trimmed', (select original_name from task_attachments where id = pg_temp.as_uuid(pg_temp.rq(vp, t1, 'photo', 'image/png', 100, '  engine.png  '))), 'engine.png');

  -- ======================================================================= object keys
  a_id := pg_temp.as_uuid(pg_temp.rq(dev, t1, 'photo', 'image/jpeg', 100, '../../etc/passwd.jpg'));
  perform pg_temp.expect('a photo key is built from the task and attachment ids only',
    (select (object_key = 'tasks/' || t1 || '/' || a_id || '.jpg' and thumb_key = 'tasks/' || t1 || '/' || a_id || '.thumb.webp')::text from task_attachments where id = a_id), 'true');
  perform pg_temp.expect('... and the user''s file name never reaches a key', (select (object_key !~ 'passwd' and thumb_key !~ 'passwd')::text from task_attachments where id = a_id), 'true');
  b_id := pg_temp.as_uuid(pg_temp.rq(dev, t1, 'document', 'application/pdf', 100, 'sheet.pdf'));
  perform pg_temp.expect('a document has a PDF key and no thumbnail', (select (object_key = 'tasks/' || t1 || '/' || b_id || '.pdf' and thumb_key is null)::text from task_attachments where id = b_id), 'true');
  c_id := pg_temp.as_uuid(pg_temp.rq(dev, t1, 'video', 'video/mp4', 100, 'ride.mp4', 1280, 720, 30000));
  perform pg_temp.expect('a video has an MP4 key and a poster key', (select (object_key = 'tasks/' || t1 || '/' || c_id || '.mp4' and thumb_key = 'tasks/' || t1 || '/' || c_id || '.thumb.webp')::text from task_attachments where id = c_id), 'true');
  perform pg_temp.expect('a new row starts pending, playable, uploaded by the caller',
    (select (status = 'pending' and playable and uploaded_by = dev and width = 1280 and height = 720 and duration_ms = 30000)::text from task_attachments where id = c_id), 'true');

  -- ============================================== confirm_attachment and visibility (the owner uploads)
  a_id := pg_temp.as_uuid(pg_temp.rq(own, t1, 'photo', 'image/jpeg', 5000, 'front.jpg', 800, 600));
  perform pg_temp.expect('a pending upload is invisible to its own uploader', pg_temp.scalar_as('authenticated', own, format('select count(*) from task_attachments where id = %L', a_id)), '0');
  perform pg_temp.expect('... and to the President', pg_temp.scalar_as('authenticated', pre, format('select count(*) from task_attachments where id = %L', a_id)), '0');
  perform pg_temp.expect('someone else cannot finish an upload', pg_temp.confirm(a_id, oth, 5000, 'image/jpeg', true), 'DENIED');
  perform pg_temp.expect('an unknown attachment cannot be confirmed', pg_temp.confirm(gen_random_uuid(), own, 5000, 'image/jpeg', true), 'ERROR P0002%');

  b_id := pg_temp.as_uuid(pg_temp.rq(own, t1, 'photo', 'image/jpeg', 5000, 'size.jpg'));
  perform pg_temp.expect('a size that differs from the request fails the upload', pg_temp.confirm(b_id, own, 4999, 'image/jpeg', true), 'failed');
  perform pg_temp.expect('... recording why', (select status || '/' || failure_reason from task_attachments where id = b_id), 'failed/size_mismatch');
  perform pg_temp.expect('... and queueing the object and thumbnail for deletion now',
    (select reason || '/' || cardinality(object_keys)::text || '/' || size_bytes::text || '/' || (purge_after <= now())::text from attachment_purge_queue where attachment_id = b_id), 'failed/2/5000/true');
  perform pg_temp.expect('... a failed row is invisible', pg_temp.scalar_as('authenticated', pre, format('select count(*) from task_attachments where id = %L', b_id)), '0');
  perform pg_temp.expect('... and confirming again changes nothing', pg_temp.confirm(b_id, own, 5000, 'image/jpeg', true), 'failed');
  perform pg_temp.expect('... nor queues it twice', (select count(*)::text from attachment_purge_queue where attachment_id = b_id), '1');

  c_id := pg_temp.as_uuid(pg_temp.rq(own, t1, 'photo', 'image/jpeg', 5000, 'type.jpg'));
  perform pg_temp.expect('a different content type fails the upload', pg_temp.confirm(c_id, own, 5000, 'image/png', true), 'failed');
  perform pg_temp.expect('... as type_mismatch', (select failure_reason from task_attachments where id = c_id), 'type_mismatch');
  d_id := pg_temp.as_uuid(pg_temp.rq(own, t1, 'photo', 'image/jpeg', 5000, 'nothumb.jpg'));
  perform pg_temp.expect('a missing thumbnail fails the upload', pg_temp.confirm(d_id, own, 5000, 'image/jpeg', false), 'failed');
  perform pg_temp.expect('... as thumbnail_missing', (select failure_reason from task_attachments where id = d_id), 'thumbnail_missing');
  e_id := pg_temp.as_uuid(pg_temp.rq(own, t1, 'document', 'application/pdf', 2000, 'manual.pdf'));
  perform pg_temp.expect('a document needs no thumbnail', pg_temp.confirm(e_id, own, 2000, 'application/pdf', false), 'ready');

  perform pg_temp.expect('a matching upload becomes ready', pg_temp.confirm(a_id, own, 5000, 'image/jpeg', true), 'ready');
  perform pg_temp.expect('a ready file is visible to another member', pg_temp.scalar_as('authenticated', oth, format('select count(*) from task_attachments where id = %L', a_id)), '1');
  perform pg_temp.expect('... to the Treasurer', pg_temp.scalar_as('authenticated', tre, format('select count(*) from task_attachments where id = %L', a_id)), '1');
  perform pg_temp.expect('... to an alumnus (same rule as tasks)', pg_temp.scalar_as('authenticated', alum, format('select count(*) from task_attachments where id = %L', a_id)), '1');
  perform pg_temp.expect('... but not to someone who is not a member', pg_temp.scalar_as('authenticated', outs, format('select count(*) from task_attachments where id = %L', a_id)), '0');
  perform pg_temp.expect('... nor to anon', pg_temp.scalar_as('anon', null, format('select count(*) from task_attachments where id = %L', a_id)), 'DENIED');
  perform pg_temp.expect('confirming wrote one attachment_added row, by the uploader',
    (select count(*)::text || '/' || bool_and(actor_id = own)::text || '/' || bool_and(season_id = season)::text
       from activity where entity = 'task' and entity_id = t1::text and action = 'attachment_added' and detail ->> 'attachment_id' = a_id::text), '1/true/true');
  perform pg_temp.expect('confirming again is a no-op that still answers ready', pg_temp.confirm(a_id, own, 5000, 'image/jpeg', true), 'ready');
  perform pg_temp.expect('... and writes no second audit row', (select count(*)::text from activity where entity = 'task' and entity_id = t1::text and action = 'attachment_added' and detail ->> 'attachment_id' = a_id::text), '1');

  -- ============================================================================= delete
  f1 := pg_temp.mk(own, t1, 'photo', 'image/jpeg', 3000, 'f1.jpg');
  perform pg_temp.expect('fixture f1 is ready', (f1 is not null)::text, 'true');
  perform pg_temp.expect('another member cannot delete it', pg_temp.scalar_as('authenticated', oth, format('select delete_attachment(%L)', f1)), 'DENIED');
  perform pg_temp.expect('the Head of another department cannot', pg_temp.scalar_as('authenticated', hb, format('select delete_attachment(%L)', f1)), 'DENIED');
  perform pg_temp.expect('a subdepartment Head cannot delete from the parent''s task', pg_temp.scalar_as('authenticated', hs, format('select delete_attachment(%L)', f1)), 'DENIED');
  perform pg_temp.expect('the Treasurer cannot', pg_temp.scalar_as('authenticated', tre, format('select delete_attachment(%L)', f1)), 'DENIED');
  perform pg_temp.expect('an alumnus cannot', pg_temp.scalar_as('authenticated', alum, format('select delete_attachment(%L)', f1)), 'DENIED');
  perform pg_temp.expect('a retired Developer cannot', pg_temp.scalar_as('authenticated', alum_dev, format('select delete_attachment(%L)', f1)), 'DENIED');
  perform pg_temp.expect('someone who is not a member cannot', pg_temp.scalar_as('authenticated', outs, format('select delete_attachment(%L)', f1)), 'DENIED');
  perform pg_temp.expect('anon cannot', pg_temp.scalar_as('anon', null, format('select delete_attachment(%L)', f1)), 'DENIED');
  perform pg_temp.expect('after every refusal the file is still ready', (select status from task_attachments where id = f1), 'ready');
  perform pg_temp.expect('the uploader deletes their own file', pg_temp.scalar_as('authenticated', own, format('select delete_attachment(%L)', f1)), 'true');
  perform pg_temp.expect('... it is soft-deleted with a timestamp', (select (status = 'deleted' and deleted_at is not null)::text from task_attachments where id = f1), 'true');
  perform pg_temp.expect('... its objects wait 30 days in the purge queue',
    (select (reason = 'deleted' and purge_after between now() + interval '29 days' and now() + interval '31 days' and purged_at is null)::text from attachment_purge_queue where attachment_id = f1), 'true');
  perform pg_temp.expect('... one audit row records it', (select count(*)::text from activity where entity = 'task' and entity_id = t1::text and action = 'attachment_deleted' and detail ->> 'attachment_id' = f1::text), '1');
  perform pg_temp.expect('... other members still see the row, as deleted (so screens can drop it)', pg_temp.scalar_as('authenticated', oth, format('select status from task_attachments where id = %L', f1)), 'deleted');
  perform pg_temp.expect('deleting twice answers false', pg_temp.scalar_as('authenticated', own, format('select delete_attachment(%L)', f1)), 'false');
  perform pg_temp.expect('... and queues nothing more', (select count(*)::text from attachment_purge_queue where attachment_id = f1), '1');
  perform pg_temp.expect('... nor writes a second audit row', (select count(*)::text from activity where action = 'attachment_deleted' and detail ->> 'attachment_id' = f1::text), '1');

  f2 := pg_temp.mk(own, t1, 'photo', 'image/jpeg', 1000, 'f2.jpg');
  perform pg_temp.expect('the department Head deletes someone else''s file', pg_temp.scalar_as('authenticated', ha, format('select delete_attachment(%L)', f2)), 'true');
  f3 := pg_temp.mk(own, t1, 'photo', 'image/jpeg', 1000, 'f3.jpg');
  perform pg_temp.expect('the President deletes it', pg_temp.scalar_as('authenticated', pre, format('select delete_attachment(%L)', f3)), 'true');
  f4 := pg_temp.mk(own, t1, 'photo', 'image/jpeg', 1000, 'f4.jpg');
  perform pg_temp.expect('the Vice President deletes it', pg_temp.scalar_as('authenticated', vp, format('select delete_attachment(%L)', f4)), 'true');
  f5 := pg_temp.mk(own, t1, 'photo', 'image/jpeg', 1000, 'f5.jpg');
  perform pg_temp.expect('a Developer deletes it', pg_temp.scalar_as('authenticated', dev, format('select delete_attachment(%L)', f5)), 'true');
  f6 := pg_temp.mk(own, t_sub, 'photo', 'image/jpeg', 1000, 'f6.jpg');
  perform pg_temp.expect('the parent department''s Head deletes a file on a subdepartment task', pg_temp.scalar_as('authenticated', ha, format('select delete_attachment(%L)', f6)), 'true');
  f7 := pg_temp.mk(own, t_sub, 'photo', 'image/jpeg', 1000, 'f7.jpg');
  perform pg_temp.expect('the subdepartment Head deletes a file on their task', pg_temp.scalar_as('authenticated', hs, format('select delete_attachment(%L)', f7)), 'true');
  f8 := pg_temp.mk(ha, t1, 'photo', 'image/jpeg', 1000, 'f8.jpg');
  update subteams set lead_id = null where key = pa;
  perform pg_temp.expect('an uploader who is no longer Head can still delete their own file', pg_temp.scalar_as('authenticated', ha, format('select delete_attachment(%L)', f8)), 'true');
  update subteams set lead_id = ha where key = pa;
  fp := pg_temp.as_uuid(pg_temp.rq(own, t1, 'photo', 'image/jpeg', 1000, 'pending.jpg'));
  perform pg_temp.expect('an unfinished upload can be cancelled', pg_temp.scalar_as('authenticated', own, format('select delete_attachment(%L)', fp)), 'true');
  perform pg_temp.expect('... its objects are queued immediately', (select (purge_after <= now())::text from attachment_purge_queue where attachment_id = fp), 'true');
  perform pg_temp.expect('... without an audit row (it was never visible)', (select count(*)::text from activity where action in ('attachment_deleted', 'attachment_added') and detail ->> 'attachment_id' = fp::text), '0');
  perform pg_temp.expect('deleting an unknown file is refused', pg_temp.scalar_as('authenticated', pre, format('select delete_attachment(%L)', gen_random_uuid())), 'ERROR P0002%');
  perform pg_temp.expect('deleting a failed upload answers false', pg_temp.scalar_as('authenticated', own, format('select delete_attachment(%L)', b_id)), 'false');

  -- ================================================================================ caption
  f9 := pg_temp.mk(own, t1, 'photo', 'image/jpeg', 1000, 'f9.jpg');
  perform pg_temp.expect('another member cannot caption', pg_temp.scalar_as('authenticated', oth, format('select set_attachment_caption(%L, ''x'')', f9)), 'DENIED');
  perform pg_temp.expect('the uploader sets a caption', pg_temp.scalar_as('authenticated', own, format('select set_attachment_caption(%L, ''  engine out  '')', f9)), 'true');
  perform pg_temp.expect('... stored trimmed', (select caption from task_attachments where id = f9), 'engine out');
  perform pg_temp.expect('the same caption again changes nothing', pg_temp.scalar_as('authenticated', own, format('select set_attachment_caption(%L, ''engine out'')', f9)), 'false');
  perform pg_temp.expect('the department Head changes it', pg_temp.scalar_as('authenticated', ha, format('select set_attachment_caption(%L, ''engine in'')', f9)), 'true');
  perform pg_temp.expect('a blank caption clears it', pg_temp.scalar_as('authenticated', own, format('select set_attachment_caption(%L, ''   '')', f9)), 'true');
  perform pg_temp.expect('... to null', (select (caption is null)::text from task_attachments where id = f9), 'true');
  perform pg_temp.expect('a caption over 500 characters is refused', pg_temp.scalar_as('authenticated', own, format('select set_attachment_caption(%L, %L)', f9, repeat('x', 501))), 'ERROR 23514%');
  p2 := pg_temp.as_uuid(pg_temp.rq(own, t1, 'photo', 'image/jpeg', 1000, 'p2.jpg'));
  perform pg_temp.expect('an unfinished upload has no caption', pg_temp.scalar_as('authenticated', own, format('select set_attachment_caption(%L, ''x'')', p2)), 'ERROR 22023%');
  perform pg_temp.expect('a deleted file has no caption', pg_temp.scalar_as('authenticated', own, format('select set_attachment_caption(%L, ''x'')', f1)), 'ERROR 22023%');
  perform pg_temp.expect('an unknown file is refused', pg_temp.scalar_as('authenticated', own, format('select set_attachment_caption(%L, ''x'')', gen_random_uuid())), 'ERROR P0002%');

  -- ============================================================== usage and accounting
  perform pg_temp.expect('the President sees the usage of both groups', pg_temp.scalar_as('authenticated', pre, 'select count(*) from attachment_usage()'), '2');
  perform pg_temp.expect('the Vice President sees it', pg_temp.scalar_as('authenticated', vp, 'select count(*) from attachment_usage()'), '2');
  perform pg_temp.expect('a Developer sees it', pg_temp.scalar_as('authenticated', dev, 'select count(*) from attachment_usage()'), '2');
  perform pg_temp.expect('a Head does not', pg_temp.scalar_as('authenticated', ha, 'select count(*) from attachment_usage()'), 'DENIED');
  perform pg_temp.expect('the Treasurer does not', pg_temp.scalar_as('authenticated', tre, 'select count(*) from attachment_usage()'), 'DENIED');
  perform pg_temp.expect('a retired Developer does not', pg_temp.scalar_as('authenticated', alum_dev, 'select count(*) from attachment_usage()'), 'DENIED');
  perform pg_temp.expect('the default quotas are 7 GB of video and 2 GB of photos and documents',
    (select string_agg(quota_group || '=' || quota_bytes, ',' order by quota_group) from attachment_quotas), 'photo_document=2000000000,video=7000000000');

  u0 := attachment_used_bytes('video');
  kv := pg_temp.mk(pre, t1, 'video', 'video/mp4', 3000000, 'clip.mp4', 30000);
  u1 := attachment_used_bytes('video');
  perform pg_temp.expect('a finished video adds its bytes to the video group', (u1 - u0)::text, '3000000');
  r := pg_temp.scalar_as('authenticated', pre, format('select delete_attachment(%L)', kv));
  u2 := attachment_used_bytes('video');
  perform pg_temp.expect('deleting it frees nothing yet (the object is still in R2)', r || '/' || (u2 = u1)::text, 'true/true');
  select id into q_id from attachment_purge_queue where attachment_id = kv;
  r := pg_temp.scalar_as('service_role', null, format('select mark_attachment_purged(array[%s]::bigint[])', q_id));
  u2 := attachment_used_bytes('video');
  perform pg_temp.expect('marking the objects purged frees them', r || '/' || (u2 = u0)::text, '1/true');
  perform pg_temp.expect('marking them again changes nothing', pg_temp.scalar_as('service_role', null, format('select mark_attachment_purged(array[%s]::bigint[])', q_id)), '0');
  perform pg_temp.expect('photos and documents are counted in their own group', (attachment_used_bytes('photo_document') > 0)::text, 'true');

  -- =============================================================== the per-member pending cap
  for i in 1..10 loop
    r := pg_temp.rq(capper, t_cap, 'photo', 'image/jpeg', 10, 'cap' || i || '.jpg');
    if pg_temp.is_uuid(r) <> 'true' then
      perform pg_temp.expect('pending request ' || i || ' of 10 is accepted', r, 'a uuid');
    end if;
  end loop;
  perform pg_temp.expect('ten unfinished uploads are accepted', (select count(*)::text from task_attachments where uploaded_by = capper and status = 'pending'), '10');
  perform pg_temp.expect('the eleventh is refused', pg_temp.rq(capper, t_cap, 'photo', 'image/jpeg', 10, 'cap11.jpg'), 'ERROR 54000%');

  -- ============================================================================ stale sweep
  update task_attachments set created_at = now() - interval '2 hours'
   where id in (select id from task_attachments where uploaded_by = capper and status = 'pending' order by id limit 2);
  perform pg_temp.expect('a member cannot run the sweep', pg_temp.scalar_as('authenticated', capper, 'select fail_stale_attachment_uploads()'), 'DENIED');
  perform pg_temp.expect('the sweep fails the two uploads older than an hour', pg_temp.scalar_as('service_role', null, 'select fail_stale_attachment_uploads()'), '2');
  perform pg_temp.expect('... as upload_timeout', (select count(*)::text from task_attachments where uploaded_by = capper and status = 'failed' and failure_reason = 'upload_timeout'), '2');
  perform pg_temp.expect('... queueing their objects', (select count(*)::text from attachment_purge_queue q join task_attachments t on t.id = q.attachment_id where t.uploaded_by = capper and q.reason = 'failed'), '2');
  perform pg_temp.expect('the fresh uploads are left alone', (select count(*)::text from task_attachments where uploaded_by = capper and status = 'pending'), '8');
  perform pg_temp.expect('a second sweep finds nothing', pg_temp.scalar_as('service_role', null, 'select fail_stale_attachment_uploads()'), '0');
  select count(*) into i from task_attachments where status = 'pending';
  perform pg_temp.expect('the sweep takes the clock as a parameter: three hours on, every unfinished upload is stale',
    pg_temp.scalar_as('service_role', null, 'select fail_stale_attachment_uploads(now() + interval ''3 hours'')'), i::text);
  perform pg_temp.expect('... leaving none pending', (select count(*)::text from task_attachments where status = 'pending'), '0');
  perform pg_temp.expect('the member can upload again', pg_temp.is_uuid(pg_temp.rq(capper, t_cap, 'photo', 'image/jpeg', 10, 'again.jpg')), 'true');

  -- ========================================================================== purge queue API
  perform pg_temp.expect('nothing listed is in the future',
    pg_temp.scalar_as('service_role', null, 'select count(*) from list_due_attachment_purges(1000) l join attachment_purge_queue q on q.id = l.id where q.purge_after > now()'), '0');
  perform pg_temp.expect('a deleted file within its 30 days is not listed yet',
    pg_temp.scalar_as('service_role', null, format('select count(*) from list_due_attachment_purges(1000) l join attachment_purge_queue q on q.id = l.id where q.attachment_id = %L', f2)), '0');
  perform pg_temp.expect('... but is listed once its time has come',
    pg_temp.scalar_as('service_role', null, format('select count(*) from list_due_attachment_purges(1000, now() + interval ''31 days'') l join attachment_purge_queue q on q.id = l.id where q.attachment_id = %L', f2)), '1');
  perform pg_temp.expect('the limit is honoured', pg_temp.scalar_as('service_role', null, 'select count(*) from list_due_attachment_purges(1)'), '1');
  perform pg_temp.expect('a failed upload is listed with both keys', pg_temp.scalar_as('service_role', null, format('select cardinality(l.object_keys) from list_due_attachment_purges(1000) l join attachment_purge_queue q on q.id = l.id where q.attachment_id = %L', b_id)), '2');
  select id into q_id from attachment_purge_queue where attachment_id = b_id;
  perform pg_temp.expect('marking it purged', pg_temp.scalar_as('service_role', null, format('select mark_attachment_purged(array[%s]::bigint[])', q_id)), '1');
  perform pg_temp.expect('... removes it from the list', pg_temp.scalar_as('service_role', null, format('select count(*) from list_due_attachment_purges(1000) where id = %s', q_id)), '0');

  -- ========================================================== a task removed takes its files along
  k1 := pg_temp.mk(own, t_casc, 'photo', 'image/jpeg', 700, 'k1.jpg');
  k2 := pg_temp.mk(own, t_casc, 'document', 'application/pdf', 800, 'k2.pdf');
  perform pg_temp.scalar_as('authenticated', own, format('select delete_attachment(%L)', k2));
  k3 := pg_temp.as_uuid(pg_temp.rq(dev, t_casc, 'photo', 'image/jpeg', 900, 'k3.jpg'));
  perform pg_temp.expect('fixtures for the cascade exist', (k1 is not null and k2 is not null and k3 is not null)::text, 'true');
  delete from tasks where id = t_casc;
  perform pg_temp.expect('removing the task removes its attachment rows', (select count(*)::text from task_attachments where task_id = t_casc), '0');
  perform pg_temp.expect('... a ready file is queued for deletion with 30 days of grace',
    (select (reason = 'task_removed' and purge_after > now() + interval '29 days')::text from attachment_purge_queue where attachment_id = k1), 'true');
  perform pg_temp.expect('... an unfinished upload is queued too', (select reason from attachment_purge_queue where attachment_id = k3), 'task_removed');
  perform pg_temp.expect('... a file that was already deleted is not queued a second time', (select count(*)::text || '/' || min(reason) from attachment_purge_queue where attachment_id = k2), '1/deleted');

  -- ====================================================== the table's own constraints (as owner)
  perform pg_temp.expect('baseline: a valid row can be inserted',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes) values (%L, ''photo'', ''bk/ok.jpg'', ''bk/ok.thumb.webp'', ''ok.jpg'', ''image/jpeg'', 10)', t1)), 'OK');
  perform pg_temp.expect('a duplicate object key is refused',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes) values (%L, ''photo'', ''bk/ok.jpg'', ''bk/dup.thumb.webp'', ''ok.jpg'', ''image/jpeg'', 10)', t1)), '23505');
  perform pg_temp.expect('a photo cannot carry an MP4 type',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes) values (%L, ''photo'', ''bk/1'', ''bk/1t'', ''a'', ''video/mp4'', 10)', t1)), '23514');
  perform pg_temp.expect('a document cannot have a thumbnail',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes) values (%L, ''document'', ''bk/2'', ''bk/2t'', ''a'', ''application/pdf'', 10)', t1)), '23514');
  perform pg_temp.expect('a photo must have a thumbnail',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, original_name, mime_type, size_bytes) values (%L, ''photo'', ''bk/3'', ''a'', ''image/jpeg'', 10)', t1)), '23514');
  perform pg_temp.expect('a photo has no duration',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, duration_ms) values (%L, ''photo'', ''bk/4'', ''bk/4t'', ''a'', ''image/jpeg'', 10, 5)', t1)), '23514');
  perform pg_temp.expect('a photo over its size limit',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes) values (%L, ''photo'', ''bk/5'', ''bk/5t'', ''a'', ''image/jpeg'', 10485761)', t1)), '23514');
  perform pg_temp.expect('a playable video over 185 s',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, duration_ms) values (%L, ''video'', ''bk/6'', ''bk/6t'', ''a'', ''video/mp4'', 10, 185001)', t1)), '23514');
  perform pg_temp.expect('a playable video must be an MP4',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, duration_ms) values (%L, ''video'', ''bk/7'', ''bk/7t'', ''a'', ''video/webm'', 10, 5000)', t1)), '23514');
  perform pg_temp.expect('only a video can be download-only',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, playable) values (%L, ''photo'', ''bk/8'', ''bk/8t'', ''a'', ''image/jpeg'', 10, false)', t1)), '23514');
  perform pg_temp.expect('an empty caption',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, caption) values (%L, ''photo'', ''bk/9'', ''bk/9t'', ''a'', ''image/jpeg'', 10, '''')', t1)), '23514');
  perform pg_temp.expect('a padded file name',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes) values (%L, ''photo'', ''bk/10'', ''bk/10t'', '' a'', ''image/jpeg'', 10)', t1)), '23514');
  perform pg_temp.expect('deleted without a deletion time',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, status) values (%L, ''photo'', ''bk/11'', ''bk/11t'', ''a'', ''image/jpeg'', 10, ''deleted'')', t1)), '23514');
  perform pg_temp.expect('failed without a reason',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, status) values (%L, ''photo'', ''bk/12'', ''bk/12t'', ''a'', ''image/jpeg'', 10, ''failed'')', t1)), '23514');
  perform pg_temp.expect('a status outside the four',
    pg_temp.try_sql(format('insert into task_attachments (task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, status) values (%L, ''photo'', ''bk/13'', ''bk/13t'', ''a'', ''image/jpeg'', 10, ''lost'')', t1)), '23514');
  perform pg_temp.expect('a purge-queue entry needs one or two keys',
    pg_temp.try_sql('insert into attachment_purge_queue (kind, object_keys, size_bytes, reason, purge_after) values (''photo'', ''{}'', 10, ''deleted'', now())'), '23514');

  -- ===================================================== the quota boundary (last: it fills a group)
  select attachment_used_bytes('photo_document') into used_pd;
  update attachment_quotas set quota_bytes = used_pd + 1000 where quota_group = 'photo_document';
  perform pg_temp.expect('one byte over the photo/document quota is refused', pg_temp.rq(dev, t1, 'photo', 'image/jpeg', 1001, 'big.jpg'), 'ERROR 54000%');
  perform pg_temp.expect('a request that exactly fills the quota is accepted', pg_temp.is_uuid(pg_temp.rq(dev, t1, 'photo', 'image/jpeg', 1000, 'fill.jpg')), 'true');
  perform pg_temp.expect('afterwards even one byte is refused (unfinished uploads count)', pg_temp.rq(dev, t1, 'document', 'application/pdf', 1, 'one.pdf'), 'ERROR 54000%');
  perform pg_temp.expect('the video group is budgeted separately', pg_temp.is_uuid(pg_temp.rq(dev, t1, 'video', 'video/mp4', 1000, 'v.mp4', null, null, 5000)), 'true');
  update attachment_quotas set quota_bytes = attachment_used_bytes('video') where quota_group = 'video';
  perform pg_temp.expect('a full video group refuses a video', pg_temp.rq(dev, t1, 'video', 'video/mp4', 1, 'v2.mp4', null, null, 5000), 'ERROR 54000%');

  -- ================================================================================ verdict
  select count(*), count(*) filter (where not (got like expected)),
         string_agg(case when not (got like expected) then format('  FAIL  %s — expected %s, got %s', label, expected, got) end, E'\n' order by n)
    into total, bad, report from pg_temp.results;
  if bad > 0 then
    raise exception E'ATTACHMENT CHECKS FAILED — % of % checks did not behave as expected.\n%', bad, total, report;
  end if;
  raise exception 'ATTACHMENT CHECKS PASSED — all % checks', total;
end
$test$;
