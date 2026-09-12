-- =============================================================================
--  Three concepts, one per table: proposals, board tasks, real meetings.
--
--  WHAT WAS WRONG. The screen called "Meetings" never showed a meeting. It
--  showed `topics`: work a member suggests, which leadership may later put on
--  the Board. Meanwhile the real `meetings` table (held_on, attendees,
--  summary) existed from the first migration and no screen ever used it.
--
--  AFTER:
--    task_proposals   suggested work. Any member may suggest; only an
--                     administrator may decide or promote it.
--    tasks            official board work. Created by promotion, moved by
--                     anyone on the roster, deleted only by president/developer.
--    meetings         an actual meeting: a date, a time, a place, an agenda
--                     and minutes. Created by administrators.
--    meeting_template one row. The default agenda a new meeting starts from.
--
--  NOTHING IS DELETED. `topics` is renamed, not recreated, so every suggestion,
--  decision and provenance link survives. `meetings` keeps its rows and gains
--  columns.
--
--  STATE MAPPING (topic_state is kept, so no row changes value):
--    open    -> "Suggested"     waiting for someone to look at it
--    agenda  -> "Under review"  leadership is considering it
--    decided -> "Decided"       promoted to a board task, or answered
--    parked  -> "Parked"        set aside, not deleted
--  AMBIGUITY, RECORDED: the old data cannot say whether a 'decided' topic was
--  approved or refused. `decision` holds the club's own words, and a promoted
--  proposal is identifiable by the task that points at it. No row is guessed.
--
--  Run AFTER 20260107. Idempotent: safe to run twice.
-- =============================================================================

-- ------------------------------------------------------- 1. proposals, renamed
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'topics') then
    alter table topics rename to task_proposals;
    alter table tasks rename column source_topic to source_proposal;
  end if;
end $$;

comment on table task_proposals is
  'Work a member suggests. Only an administrator may decide or promote one. '
  'Was called "topics"; the screen that showed it was mislabelled "Meetings".';
comment on column tasks.source_proposal is
  'The proposal this task was promoted from, if any. Provenance, not a copy.';

-- --------------------------------------------------- 2. meetings, made real
alter table meetings add column if not exists title      text;
alter table meetings add column if not exists starts_at  time;
alter table meetings add column if not exists ends_at    time;
alter table meetings add column if not exists location   text;
alter table meetings add column if not exists agenda     text;
alter table meetings add column if not exists notes      text;
alter table meetings add column if not exists created_by uuid references members(id) on delete set null;
alter table meetings add column if not exists updated_at timestamptz not null default now();

-- The existing rows keep their words: `summary` was whatever was written about
-- the meeting, which is what `notes` means now.
update meetings set notes = summary where notes is null and summary is not null;
update meetings set title = 'Club meeting ' || held_on where title is null;

alter table meetings alter column title set not null;
-- held_on was already `date not null`: a meeting without a date is not a
-- meeting, and nothing here stores a date as text.
do $$ begin
  alter table meetings add constraint meetings_title_not_blank
    check (length(btrim(title)) between 1 and 200);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table meetings add constraint meetings_ends_after_starts
    check (ends_at is null or starts_at is null or ends_at > starts_at);
exception when duplicate_object then null; end $$;

comment on column meetings.summary is
  'Superseded by notes (20260108). Kept so the old text is never lost.';

-- --------------------------------------------- 3. the default agenda template
create table if not exists meeting_template (
  -- One row, forever: this is club configuration, not a list.
  id         boolean primary key default true check (id),
  body       text not null,
  updated_by uuid references members(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into meeting_template (id, body) values (true,
E'## Agenda\n\n- \n\n## Action items from last time\n\n- \n\n## Blockers\n\n- \n\n## Decisions\n\n- \n\n## New actions\n\n- who does what, by when\n\n## Notes\n\n')
on conflict (id) do nothing;

comment on table meeting_template is
  'The agenda a new meeting starts from. One row. President or developer only.';

-- ------------------------------------------------------------- 4. authority
-- Deleting is the one thing a vice-president may not do: a removed task or
-- meeting takes its history with it, and there is no undo.
create or replace function can_delete_records() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('developer');
$fn$;

-- Promoting a proposal, assigning the resulting task, and calling a meeting:
-- president, vice-president or developer. is_admin() is already exactly that
-- set (20260105, widened by 20260107), so it is reused rather than copied.

-- ------------------------------------------------------------- 5. policies
-- The blanket `member_write` FOR ALL from the first migration let any member
-- delete any task, proposal or meeting. Replaced, per table, per operation.
do $$
declare t text;
begin
  foreach t in array array['tasks', 'meetings', 'task_proposals'] loop
    execute format('drop policy if exists member_write on %I', t);
  end loop;
end $$;

-- Proposals: anyone on the roster suggests one and reads all of them. Only an
-- administrator may change one, which is what stops a member approving their
-- own suggestion straight through the API.
drop policy if exists proposal_insert on task_proposals;
drop policy if exists proposal_update on task_proposals;
drop policy if exists proposal_delete on task_proposals;
create policy proposal_insert on task_proposals for insert to authenticated
  with check (is_member() and raised_by = auth.uid());
create policy proposal_update on task_proposals for update to authenticated
  using (is_admin()) with check (is_admin());
create policy proposal_delete on task_proposals for delete to authenticated
  using (can_delete_records());

-- Tasks: only promotion creates one (administrators). Everyone on the roster
-- still moves cards and picks owners — that is the Board's daily use. Deleting
-- belongs to the president or a developer.
drop policy if exists task_insert on tasks;
drop policy if exists task_update on tasks;
drop policy if exists task_delete on tasks;
create policy task_insert on tasks for insert to authenticated
  with check (is_admin());
create policy task_update on tasks for update to authenticated
  using (is_member()) with check (is_member());
create policy task_delete on tasks for delete to authenticated
  using (can_delete_records());

-- Meetings: administrators call them and write the minutes; everyone reads.
drop policy if exists meeting_insert on meetings;
drop policy if exists meeting_update on meetings;
drop policy if exists meeting_delete on meetings;
create policy meeting_insert on meetings for insert to authenticated
  with check (is_admin());
create policy meeting_update on meetings for update to authenticated
  using (is_admin()) with check (is_admin());
create policy meeting_delete on meetings for delete to authenticated
  using (can_delete_records());

-- The template is club configuration: president or developer. A vice-president
-- may still write any individual meeting's agenda and notes (meeting_update).
alter table meeting_template enable row level security;
revoke truncate on meeting_template from anon, authenticated;
grant select, insert, update, delete on meeting_template to authenticated;
drop policy if exists template_read on meeting_template;
drop policy if exists template_write on meeting_template;
create policy template_read on meeting_template for select to authenticated
  using (is_member());
create policy template_write on meeting_template for all to authenticated
  using (can_delete_records()) with check (can_delete_records());

-- ------------------------------------------------------------- 6. timestamps
-- meetings.updated_at must move on its own; nothing trusts the browser for it.
create or replace function touch_updated_at() returns trigger
language plpgsql set search_path = public as $fn$
begin
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists trg_meetings_touch on meetings;
create trigger trg_meetings_touch before update on meetings
  for each row execute function touch_updated_at();

drop trigger if exists trg_template_touch on meeting_template;
create trigger trg_template_touch before update on meeting_template
  for each row execute function touch_updated_at();

create index if not exists meetings_created_by on meetings (created_by);
