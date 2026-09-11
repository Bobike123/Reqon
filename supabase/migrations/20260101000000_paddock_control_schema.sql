-- =============================================================================
--  Reqon — database schema
--  Postgres / Supabase.  Paste the whole file into the Supabase SQL editor
--  and run it once.  It is idempotent: running it twice is harmless.
--
--  Design notes for whoever maintains this next:
--   * `clauses` is REFERENCE data — the regulations book, imported once per
--     edition.  Nobody edits it; it is what the rules actually say.
--   * `clause_status` is TEAM data, scoped to a season.  A new season starts
--     with an empty clause_status and the book untouched, which is exactly
--     what "new bike, same rules" means.
--   * Everything a team types hangs off `season_id`, so a graduating year's
--     work is archived rather than deleted.
--   * Row Level Security is ON everywhere.  Only signed-in members of the
--     club can read or write anything.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------- enums
do $$ begin
  create type clause_state as enum
    ('open','wip','compliant','verified','blocked','na');
exception when duplicate_object then null; end $$;

do $$ begin
  create type task_state as enum
    ('urgent','todo','wip','blocked','done','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type topic_state as enum ('open','agenda','decided','parked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type member_state as enum ('active','alumni');
exception when duplicate_object then null; end $$;

-- ================================================================== 1. PEOPLE
create table if not exists members (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text not null,
  initials     text,
  role         text not null default 'Member',
  study_year   text,
  skills       text,
  phone        text,
  status       member_state not null default 'active',
  is_board     boolean not null default false,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table members is
  'Club roster. Retiring someone (status=alumni) keeps all their history but
   removes them from assignment pickers.';

-- ================================================================= 2. SEASONS
create table if not exists seasons (
  id           uuid primary key default gen_random_uuid(),
  label        text not null unique,
  edition      text not null default 'MotoStudent IX',
  regs_ref     text not null default 'MS2627 Rev.01',
  category     text not null default 'eFuel',
  bike_number  int check (bike_number between 1 and 99),
  club_name    text not null default 'SDU Motorbike Club',
  university   text not null default 'University of Southern Denmark',
  is_current   boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index if not exists seasons_one_current
  on seasons (is_current) where is_current;

-- ================================================================ 3. SUBTEAMS
create table if not exists subteams (
  key          text primary key,
  name         text not null,
  book_section text not null,
  description  text,
  lead_id      uuid references members(id) on delete set null,
  is_parked    boolean not null default false,
  sort_order   int not null default 0
);

-- ================================================== 4. THE REGULATIONS (fixed)
create table if not exists clauses (
  -- clause_key is unique; printed_ref is what the book actually prints.
  -- They differ for the handful of clauses the Organization numbered twice
  -- (E.5.4.5 and F.5.2.3 in MS2627 Rev.01 — genuine errors in the PDF).
  clause_key    text primary key,
  printed_ref   text not null,
  section       text not null,
  article       int  not null,
  article_title text,
  group_title   text,
  subteam_key   text references subteams(key) on delete set null,
  body          text not null,
  obligation    text not null,
  criticality   text not null,
  phase         text,
  milestone_key text,
  is_team_duty  boolean not null default false,
  specs         jsonb not null default '[]'::jsonb
);
comment on table clauses is
  'Reference data: the regulations book, one row per numbered clause. Imported
   from seed_clauses.csv. Never edited by the team — if the edition changes,
   truncate and re-import.';

create index if not exists clauses_printed on clauses (printed_ref);
create index if not exists clauses_subteam on clauses (subteam_key);
create index if not exists clauses_duty    on clauses (is_team_duty) where is_team_duty;
create index if not exists clauses_oblig   on clauses (obligation);
create index if not exists clauses_ms      on clauses (milestone_key);
create index if not exists clauses_body_fts
  on clauses using gin (to_tsvector('english', body));

-- ======================================== 5. WHAT THE TEAM DID ABOUT EACH RULE
create table if not exists clause_status (
  id          uuid primary key default gen_random_uuid(),
  season_id   uuid not null references seasons(id) on delete cascade,
  clause_key  text not null references clauses(clause_key) on delete cascade,
  state       clause_state not null default 'open',
  owner_id    uuid references members(id) on delete set null,
  evidence    text,
  starred     boolean not null default false,
  updated_by  uuid references members(id) on delete set null,
  updated_at  timestamptz not null default now(),
  unique (season_id, clause_key)
);
create index if not exists clause_status_season on clause_status (season_id);
create index if not exists clause_status_owner  on clause_status (owner_id);
create index if not exists clause_status_state  on clause_status (season_id, state);

-- ================================================================== 6. TASKS
create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  season_id    uuid not null references seasons(id) on delete cascade,
  title        text not null,
  detail       text,
  owner_id     uuid references members(id) on delete set null,
  subteam_key  text references subteams(key) on delete set null,
  due_date     date,
  state        task_state not null default 'todo',
  starred      boolean not null default false,
  source_topic uuid,
  created_by   uuid references members(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists tasks_season on tasks (season_id, state);
create index if not exists tasks_owner  on tasks (owner_id);
create index if not exists tasks_due    on tasks (due_date) where due_date is not null;

-- =============================================== 7. MEETINGS AND WHAT WAS SAID
create table if not exists meetings (
  id         uuid primary key default gen_random_uuid(),
  season_id  uuid not null references seasons(id) on delete cascade,
  held_on    date not null,
  attendees  text,
  summary    text,
  created_at timestamptz not null default now()
);
create index if not exists meetings_season on meetings (season_id, held_on desc);

create table if not exists topics (
  id          uuid primary key default gen_random_uuid(),
  season_id   uuid not null references seasons(id) on delete cascade,
  title       text not null,
  context     text,
  state       topic_state not null default 'open',
  owner_id    uuid references members(id) on delete set null,
  decision    text,
  decided_at  timestamptz,
  meeting_id  uuid references meetings(id) on delete set null,
  starred     boolean not null default false,
  raised_by   uuid references members(id) on delete set null,
  raised_on   date not null default current_date,
  updated_at  timestamptz not null default now()
);
create index if not exists topics_season on topics (season_id, state);

alter table tasks drop constraint if exists tasks_source_topic_fkey;
alter table tasks add constraint tasks_source_topic_fkey
  foreign key (source_topic) references topics(id) on delete set null;

-- ============================================================= 8. DELIVERABLES
create table if not exists milestones (
  key         text primary key,
  season_id   uuid not null references seasons(id) on delete cascade,
  ordinal     int  not null,
  name        text not null,
  aim         text,
  article_ref text,
  opens_on    date,
  due_on      date,
  max_points  int  not null default 0,
  is_blocking boolean not null default false,
  notes       text
);
create index if not exists milestones_season on milestones (season_id, ordinal);

create table if not exists milestone_sections (
  id            uuid primary key default gen_random_uuid(),
  milestone_key text not null references milestones(key) on delete cascade,
  ordinal       int not null,
  name          text not null,
  is_drafted    boolean not null default false,
  owner_id      uuid references members(id) on delete set null,
  updated_at    timestamptz not null default now(),
  unique (milestone_key, ordinal)
);

-- =============================================================== 9. SPEC SHEET
create table if not exists specs (
  id          uuid primary key default gen_random_uuid(),
  season_id   uuid not null references seasons(id) on delete cascade,
  parameter   text not null,
  comparator  text not null check (comparator in ('min','max','eq','range')),
  target      numeric,
  target_text text,
  unit        text,
  clause_key  text references clauses(clause_key) on delete set null,
  condition   text,
  measured    numeric,
  measured_by uuid references members(id) on delete set null,
  measured_at timestamptz,
  sort_order  int not null default 0
);
create index if not exists specs_season on specs (season_id, sort_order);

-- Pass/fail is derived, never stored — the rule is the source of truth.
create or replace view spec_verdicts as
select s.*,
       case
         when s.measured is null or s.comparator = 'range' then 'unmeasured'
         when s.comparator = 'min' and s.measured >= s.target then 'pass'
         when s.comparator = 'max' and s.measured <= s.target then 'pass'
         when s.comparator = 'eq'  and s.measured  = s.target then 'pass'
         else 'fail'
       end as verdict
from specs s;

-- ========================================================= 10. HANDOVER NOTES
create table if not exists handover_notes (
  id          uuid primary key default gen_random_uuid(),
  season_id   uuid not null references seasons(id) on delete cascade,
  subteam_key text not null references subteams(key) on delete cascade,
  body        text not null default '',
  updated_by  uuid references members(id) on delete set null,
  updated_at  timestamptz not null default now(),
  unique (season_id, subteam_key)
);
comment on table handover_notes is
  'What the next person will wish you had told them. The highest-value table here.';

-- ============================================================ 11. AUDIT TRAIL
create table if not exists activity (
  id         bigserial primary key,
  season_id  uuid references seasons(id) on delete cascade,
  actor_id   uuid references members(id) on delete set null,
  entity     text not null,
  entity_id  text not null,
  action     text not null,
  detail     jsonb,
  at         timestamptz not null default now()
);
create index if not exists activity_recent on activity (season_id, at desc);

-- =============================================================================
--  TRIGGERS
-- =============================================================================
create or replace function touch_updated_at() returns trigger
language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end $fn$;

do $blk$
declare t text;
begin
  foreach t in array array['members','clause_status','tasks','topics',
                           'milestone_sections','handover_notes']
  loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s', t);
    execute format(
      'create trigger trg_touch_%1$s before update on %1$s
       for each row execute function touch_updated_at()', t);
  end loop;
end $blk$;

create or replace function stamp_decided() returns trigger
language plpgsql as $fn$
begin
  if new.state = 'decided' and (old.state is distinct from 'decided') then
    new.decided_at = now();
  end if;
  return new;
end $fn$;
drop trigger if exists trg_topic_decided on topics;
create trigger trg_topic_decided before update on topics
  for each row execute function stamp_decided();

-- Keep `initials` in step with the name.
create or replace function set_initials() returns trigger
language plpgsql as $fn$
declare parts text[];
begin
  parts := regexp_split_to_array(btrim(new.full_name), '\s+');
  new.initials := upper(left(parts[1],1)) ||
    case when array_length(parts,1) > 1
         then upper(left(parts[array_length(parts,1)],1)) else '' end;
  return new;
end $fn$;
drop trigger if exists trg_member_initials on members;
create trigger trg_member_initials before insert or update of full_name on members
  for each row execute function set_initials();

-- =============================================================================
--  ROW LEVEL SECURITY — everything is private to signed-in club members.
-- =============================================================================
create or replace function is_member() returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from members m where m.id = auth.uid());
$fn$;

create or replace function is_board() returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from members m where m.id = auth.uid() and m.is_board);
$fn$;

do $blk$
declare t text;
begin
  foreach t in array array['members','seasons','subteams','clauses',
                           'clause_status','tasks','meetings','topics',
                           'milestones','milestone_sections','specs',
                           'handover_notes','activity']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists member_read on %I', t);
    execute format('drop policy if exists member_write on %I', t);
    execute format(
      'create policy member_read on %I for select to authenticated
       using (is_member())', t);
  end loop;

  foreach t in array array['seasons','clause_status','tasks','meetings','topics',
                           'milestones','milestone_sections','specs',
                           'handover_notes','activity']
  loop
    execute format(
      'create policy member_write on %I for all to authenticated
       using (is_member()) with check (is_member())', t);
  end loop;
end $blk$;

-- The rulebook and the subteam list are structural: board members only.
drop policy if exists board_write on clauses;
create policy board_write on clauses for all to authenticated
  using (is_board()) with check (is_board());

drop policy if exists board_write on subteams;
create policy board_write on subteams for all to authenticated
  using (is_board()) with check (is_board());

-- You may edit your own profile; the board may edit anyone's.
drop policy if exists member_self on members;
create policy member_self on members for update to authenticated
  using (id = auth.uid() or is_board())
  with check (id = auth.uid() or is_board());

drop policy if exists board_roster on members;
create policy board_roster on members for insert to authenticated
  with check (is_board());

-- =============================================================================
--  REALTIME — so two people editing the same board see each other live
-- =============================================================================
do $blk$ begin
  alter publication supabase_realtime add table clause_status;
  alter publication supabase_realtime add table tasks;
  alter publication supabase_realtime add table topics;
  alter publication supabase_realtime add table specs;
  alter publication supabase_realtime add table milestone_sections;
exception when others then null; end $blk$;

-- =============================================================================
--  CONVENIENCE VIEWS — the dashboard reads these instead of reassembling
--  the same joins in the client.
-- =============================================================================
create or replace view v_current_season as
  select * from seasons where is_current limit 1;

create or replace view v_subteam_progress as
select
  st.key, st.name, st.book_section, st.is_parked, st.lead_id,
  s.id as season_id,
  count(*) filter (where c.is_team_duty)                       as duties,
  count(*) filter (where c.is_team_duty
        and cs.state in ('compliant','verified','na'))         as resolved,
  count(*) filter (where c.is_team_duty and cs.state = 'wip')  as in_progress,
  count(*) filter (where cs.state = 'blocked')                 as blocked,
  count(c.clause_key)                                          as total_rules
from subteams st
cross join (select id from seasons where is_current limit 1) s
left join clauses c        on c.subteam_key = st.key
left join clause_status cs on cs.clause_key = c.clause_key
                          and cs.season_id  = s.id
group by st.key, st.name, st.book_section, st.is_parked, st.lead_id, s.id;

create or replace view v_attention as
select 'clause'::text as kind, c.printed_ref as ref, c.body as title,
       cs.owner_id, cs.season_id,
       case when cs.state = 'blocked' then 'blocked'
            when c.criticality = 'blocking' then 'score-killer'
            when c.criticality = 'penalty' then 'penalty'
            else 'starred' end as reason,
       cs.starred
from clause_status cs
join clauses c on c.clause_key = cs.clause_key
where cs.state not in ('compliant','verified','na')
  and (cs.starred or cs.state = 'blocked'
       or c.criticality in ('blocking','penalty'))
union all
select 'task', t.id::text, t.title, t.owner_id, t.season_id,
       case when t.state = 'blocked' then 'blocked'
            when t.due_date < current_date then 'overdue'
            else 'starred' end,
       t.starred
from tasks t
where t.state not in ('done','cancelled')
  and (t.starred or t.state in ('blocked','urgent') or t.due_date < current_date);

-- =============================================================================
--  DONE. Next: import seed_clauses.csv into `clauses`, then create the first
--  season and the roster. See PROMPT.md.
-- =============================================================================
