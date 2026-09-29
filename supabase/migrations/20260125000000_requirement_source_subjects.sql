-- =============================================================================
--  Requirement source subjects: keep the rulebook classification apart from
--  team ownership.
--
--  Until now clauses.subteam_key did two jobs at once: it was the regulation
--  subject the seed filed each clause under (the 14 subsystem keys: ADMIN,
--  GEOM, CHASSIS, …) AND the department that owns the requirement for the
--  team. The 2026/27 organisation replaces those 14 departments with five
--  (20260125000100), so the two meanings have to separate before any
--  department is remapped:
--
--    * regulation_subjects        the 14 original subject definitions,
--                                 reference data, never edited by the team;
--    * clauses.source_subject_key the subject each clause was classified
--                                 under, copied once from subteam_key and
--                                 immutable after that;
--    * clauses.subteam_key        keeps meaning "which department owns this
--                                 requirement" and may be NULL (unassigned).
--
--  Schema only, plus a one-time backfill. Must run BEFORE 20260125000100.
-- =============================================================================

create table if not exists regulation_subjects (
  key          text primary key,
  name         text not null,
  book_section text,
  description  text,
  sort_order   int not null default 0,
  is_parked    boolean not null default false
);

comment on table regulation_subjects is
  'The rulebook subject classification each clause was originally filed under
   (the 14 legacy subsystem keys). Reference data: kept for history and
   filtering, never a department and never a permission.';

alter table regulation_subjects enable row level security;
revoke all on regulation_subjects from anon;
revoke insert, update, delete, truncate, trigger, references on regulation_subjects from authenticated;
grant select on regulation_subjects to authenticated;

drop policy if exists member_read on regulation_subjects;
create policy member_read on regulation_subjects for select to authenticated using (is_member());

-- The 14 definitions exactly as the seed (20260101000001) created them.
-- Source: SMC_Data_Rebuild_Pack data/legacy_subject_taxonomy.json
-- (sha256 c931f7e45c136fc167bbb9d621b55dd762a2d89de41a3e1ff19a02e78297c4b3).
insert into regulation_subjects (key, name, book_section, description, sort_order, is_parked) values
  ('ADMIN',   'Admin & Registration',    'A',  'Entry, fees, insurance, eligibility, tutors, comms',         0,  false),
  ('GEOM',    'Design Envelope',         'B',  'Dimensions, weight, ballast — the numbers CAD must respect', 1,  false),
  ('CHASSIS', 'Chassis & Structure',     'B',  'Frame, subframe, swingarm, welds, crash protectors',        2,  false),
  ('BODY',    'Bodywork & Aero',         'B',  'Fairing, aero devices, mudguards, seat/tail',               3,  false),
  ('CONTROL', 'Controls & Ergonomics',   'B',  'Handlebars, footrests, suspension, steering',               4,  false),
  ('BRAKES',  'Brake System',            'B',  'Discs, calipers, levers, lines, minimum forces',            5,  false),
  ('WHEELS',  'Wheels & Tyres',          'B',  'Rims, tyres, spindles, supplier terms',                     6,  false),
  ('ELEC',    'Electronics & Safety',    'B',  'ECU, dash, sensors, kill switch, lighting',                 7,  false),
  ('LIVERY',  'Livery & Identification', 'B',  'Numbers, mandatory advertising, team branding',             8,  false),
  ('RIDER',   'Rider Equipment',         'B',  'Helmet, suit, protectors, licence-linked kit',              9,  false),
  ('PWR_EF',  'Powertrain — eFuel',      'C',  'Engine, intake, fuel, exhaust, cooling, transmission',      10, false),
  ('SCRUT',   'Scrutineering',           'E',  'Administrative check, static, dynamic safety check',        11, false),
  ('DOCS',    'Deliverables & Jury',     'F',  'MS1 milestones, jury rubrics, formats, penalties',          12, false),
  ('RACEOP',  'Race Operations',         'GH', 'Sporting rules and Final Event conduct',                    13, true)
on conflict (key) do nothing;

alter table clauses
  add column if not exists source_subject_key text references regulation_subjects(key) on delete restrict;

comment on column clauses.source_subject_key is
  'The rulebook subject this clause was originally classified under. Set once,
   never changed. Independent of subteam_key, which is the owning department
   and may be NULL (unassigned).';

create index if not exists clauses_source_subject_key on clauses (source_subject_key);

-- One-time copy, only where nothing is recorded yet and the current value is
-- one of the 14 subjects (so a department created later is never mistaken for
-- a rulebook subject).
update clauses c
set source_subject_key = c.subteam_key
where c.source_subject_key is null
  and c.subteam_key in (select key from regulation_subjects);

-- Once recorded, the classification is history: an administrator editing a
-- clause (admin_write policy) can reassign its department but not rewrite
-- where the rulebook filed it.
create or replace function guard_clause_subject()
returns trigger language plpgsql set search_path = public as $fn$
begin
  if old.source_subject_key is not null
     and new.source_subject_key is distinct from old.source_subject_key then
    raise exception 'a clause''s source subject cannot be changed (clause_key %)', old.clause_key
      using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_guard_clause_subject on clauses;
create trigger trg_guard_clause_subject before update of source_subject_key on clauses
  for each row execute function guard_clause_subject();
