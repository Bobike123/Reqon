-- =============================================================================
--  Requirements Book: which document a season reads, and which page a clause
--  starts on (Phase 7, ADR-0009).
--
--  Three facts, kept apart:
--    * regulation_documents  one row per regulations EDITION (regs_ref), naming
--                            where its document lives. Reference data, managed
--                            by administrators. Nothing season-shaped in it.
--    * clauses.regs_ref      which edition a clause's numbering and page belong
--                            to. Stable source identity: clause_key never
--                            changes and is never re-used for another edition.
--    * clauses.source_page   the printed page the clause starts on, in THAT
--                            edition's document. NULL means "not recorded" and
--                            is never guessed.
--  A season selects its document through seasons.regs_ref; season progress
--  (clause_status, task_requirements) stays keyed by clause_key and is untouched.
--
--  Edition isolation. A page number only means something for the edition it was
--  read from, so it is stored with that edition (clauses.regs_ref) and the
--  association cannot be re-pointed once set (guard below). A new edition
--  therefore adds NEW clause rows under its own regs_ref; it never rewrites the
--  mapping the current edition's rows carry. The old advice to "truncate and
--  re-import" a live clauses table is withdrawn: it would erase clause_status
--  and orphan every task link. clause_status.clause_key was ON DELETE CASCADE,
--  which made deleting a clause silently delete the team's recorded status; it
--  is now RESTRICT, like the task and proposal links.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        regulation_documents, clauses.regs_ref / source_page,
--                   RESTRICT on clause_status.clause_key, task_requirements in
--                   the realtime publication, a private storage bucket and read
--                   policy where Supabase Storage exists.
--    Existing data  Every existing clause is stamped with the edition it was
--                   imported from, 'MS2627 Rev.01' (schema header, seasons
--                   default). One document row is created for it with NO
--                   source: an administrator supplies the URL or object. No
--                   page is invented; source_page is NULL everywhere.
--    Authorization  regulation_documents: any roster member reads (is_member(),
--                   as for every reference table); is_admin() writes. Storage
--                   bucket 'regulations' is private; members read, administrators
--                   write.
--    Locking        ALTER TABLE ... ADD COLUMN (nullable, no rewrite), one
--                   short-lived constraint swap on clause_status.
--    Rollback       Forward recovery: drop the columns/table; nothing else
--                   depends on them. Restoring CASCADE is not advised.
--    Deploy order   After 20260119. The client tolerates a missing document
--                   row ("no Requirements Book configured").
-- =============================================================================

-- ----------------------------------------------------------------- documents
create table if not exists regulation_documents (
  regs_ref     text primary key check (length(btrim(regs_ref)) between 1 and 80),
  edition      text check (edition is null or length(edition) <= 120),
  title        text check (title is null or length(title) <= 200),
  -- At most one of these: an external https document, or an object in the
  -- private 'regulations' bucket. Neither means "not configured yet".
  url          text check (url is null or (url ~ '^https://[^[:space:]]+$' and length(url) <= 2000)),
  storage_path text check (
    storage_path is null or (
      length(storage_path) between 1 and 500
      and storage_path !~ '^/'
      and storage_path !~ '(^|/)\.\.(/|$)'
      and storage_path !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
      and storage_path !~ '[\\[:cntrl:]]'
    )
  ),
  -- printed page + page_offset = the PDF's own page index (covers, roman-numbered
  -- front matter). 0 when the printed and PDF numbering agree.
  page_offset  int not null default 0 check (page_offset between -500 and 500),
  page_count   int check (page_count is null or page_count > 0),
  updated_by   uuid references members(id) on delete set null,
  updated_at   timestamptz not null default now(),
  constraint regulation_documents_one_source check (num_nonnulls(url, storage_path) <= 1)
);

comment on table regulation_documents is
  'Where each regulations edition''s document lives (an https URL or an object in
   the private "regulations" bucket). Reference data, managed by administrators.
   seasons.regs_ref selects the row. No local paths, no signed URLs are ever stored.';

alter table regulation_documents enable row level security;
revoke all on regulation_documents from anon;
revoke truncate, trigger, references on regulation_documents from authenticated;
grant select, insert, update, delete on regulation_documents to authenticated;

drop policy if exists member_read on regulation_documents;
create policy member_read on regulation_documents for select to authenticated using (is_member());
drop policy if exists admin_write on regulation_documents;
create policy admin_write on regulation_documents for all to authenticated
  using (is_admin()) with check (is_admin());

-- Attribution and the timestamp come from the session, never from the payload.
create or replace function stamp_regulation_document()
returns trigger language plpgsql set search_path = public as $fn$
begin
  new.updated_at := now();
  new.updated_by := (select m.id from members m where m.id = auth.uid());
  return new;
end $fn$;

drop trigger if exists trg_stamp_regulation_document on regulation_documents;
create trigger trg_stamp_regulation_document before insert or update on regulation_documents
  for each row execute function stamp_regulation_document();

-- The edition every clause imported so far came from.
insert into regulation_documents (regs_ref, edition, title)
values ('MS2627 Rev.01', 'MotoStudent IX', 'MotoStudent IX Competition Regulations')
on conflict (regs_ref) do nothing;

-- ------------------------------------------------------------------- clauses
alter table clauses
  add column if not exists regs_ref    text references regulation_documents(regs_ref) on delete restrict,
  add column if not exists source_page int;

-- Stamp the existing rows once (only rows without an edition, so a re-run or a
-- later edition is never overwritten).
update clauses set regs_ref = 'MS2627 Rev.01' where regs_ref is null;

alter table clauses drop constraint if exists clauses_source_page_valid;
alter table clauses add constraint clauses_source_page_valid
  check (source_page is null or (source_page > 0 and regs_ref is not null));

create index if not exists clauses_regs_ref on clauses (regs_ref);

comment on column clauses.regs_ref is
  'The regulations edition this clause (and its printed numbering and page) belongs to.';
comment on column clauses.source_page is
  'Printed page the clause starts on in the document of regs_ref. NULL = not recorded; never guessed.';
comment on table clauses is
  'Reference data: the regulations book, one row per numbered clause, tied to its
   edition by regs_ref. Never edited by the team. NEVER truncate or bulk-replace
   it: clause_status, task_requirements and proposal_requirements all reference
   clause_key, and a replacement would erase or orphan the team''s work. A new
   edition ADDS rows under its own regs_ref.';

-- Once a clause is tied to an edition, that association is permanent, so a
-- recorded page number cannot follow a clause into another edition.
create or replace function guard_clause_source()
returns trigger language plpgsql set search_path = public as $fn$
begin
  if old.regs_ref is not null and new.regs_ref is distinct from old.regs_ref then
    raise exception 'a clause cannot move to another regulations edition (clause_key %)', old.clause_key
      using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_guard_clause_source on clauses;
create trigger trg_guard_clause_source before update on clauses
  for each row execute function guard_clause_source();

-- Deleting a clause must never erase what the team recorded about it.
alter table clause_status drop constraint if exists clause_status_clause_key_fkey;
alter table clause_status add constraint clause_status_clause_key_fkey
  foreign key (clause_key) references clauses(clause_key) on delete restrict;

-- --------------------------------------- realtime for requirement links
-- task_requirements changes must reach other people's open Register.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_requirements'
     ) then
    alter publication supabase_realtime add table public.task_requirements;
  end if;
end $$;

-- ------------------------------------------------------------ private storage
-- Only where Supabase Storage exists (the disposable test database has none).
do $$
begin
  if to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public)
    values ('regulations', 'regulations', false)
    on conflict (id) do update set public = false;

    execute 'drop policy if exists regulations_member_read on storage.objects';
    execute $p$create policy regulations_member_read on storage.objects for select to authenticated
      using (bucket_id = 'regulations' and public.is_member())$p$;
    execute 'drop policy if exists regulations_admin_write on storage.objects';
    execute $p$create policy regulations_admin_write on storage.objects for all to authenticated
      using (bucket_id = 'regulations' and public.is_admin())
      with check (bucket_id = 'regulations' and public.is_admin())$p$;
  end if;
end $$;
