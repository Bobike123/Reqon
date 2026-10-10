-- =============================================================================
--  Contacts: who can help with what, and how to reach them.
--
--  A directory grouped into categories ("Administration", "Mechanical design",
--  …). Each contact says what they can help with and how to contact them: an
--  email, a phone number, a website, or any mix — at least one. Contacts are
--  often people outside the club (lecturers, the university's student
--  services), so they are free text, not roster members.
--
--  Not season-scoped: the people you can ask outlive any one season.
--
--    read   -> is_member()          everyone on the roster, alumni included
--    write  -> can_edit_contacts()  any active department Head, the President,
--                                   the Vice President or a Developer
--
--  Additive. Safe to run twice.
-- =============================================================================

-- A Head is the lead of an ACTIVE department, judged from the current roster
-- status at call time like is_department_head() — a Head who retires or whose
-- department is archived stops editing at once.
create or replace function can_edit_contacts() returns boolean
language sql stable security definer set search_path = public as $fn$
  select is_admin() or (
    is_active_member() and exists (
      select 1 from subteams s where s.lead_id = auth.uid() and s.archived_at is null
    )
  );
$fn$;

revoke all on function can_edit_contacts() from public, anon;
grant execute on function can_edit_contacts() to authenticated, service_role;

create table if not exists contact_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 80),
  description text check (description is null or length(btrim(description)) between 1 and 300),
  created_by  uuid references members(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- "Finance" and "finance " are the same category.
create unique index if not exists contact_categories_name_key
  on contact_categories (lower(btrim(name)));

create table if not exists contacts (
  id          uuid primary key default gen_random_uuid(),
  -- Deleting a category deletes its contacts; the screen says so first.
  category_id uuid not null references contact_categories(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  -- "Lecturer", "Student services", "Team alumnus" …
  title       text check (title is null or length(btrim(title)) between 1 and 120),
  help        text not null check (length(btrim(help)) between 1 and 1000),
  email       text check (email is null or (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone       text check (phone is null or phone ~ '^\+?[0-9 ()./-]{4,30}$'),
  website     text check (website is null or (length(website) <= 300 and website !~ '\s')),
  created_by  uuid references members(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint contacts_reachable check (email is not null or phone is not null or website is not null)
);

create index if not exists contacts_category on contacts (category_id);

-- Who added a row is stamped by the database, never taken from the browser.
drop trigger if exists trg_stamp_actor on contact_categories;
create trigger trg_stamp_actor before insert or update on contact_categories
  for each row execute function stamp_actor_columns('created_by');
drop trigger if exists trg_stamp_actor on contacts;
create trigger trg_stamp_actor before insert or update on contacts
  for each row execute function stamp_actor_columns('created_by');

drop trigger if exists trg_touch on contact_categories;
create trigger trg_touch before update on contact_categories
  for each row execute function touch_updated_at();
drop trigger if exists trg_touch on contacts;
create trigger trg_touch before update on contacts
  for each row execute function touch_updated_at();

alter table contact_categories enable row level security;
alter table contacts enable row level security;

-- Only the four row operations RLS can police (TRUNCATE bypasses it).
revoke all on contact_categories, contacts from anon, authenticated;
grant select, insert, update, delete on contact_categories, contacts to authenticated;

drop policy if exists contact_categories_read  on contact_categories;
drop policy if exists contact_categories_write on contact_categories;
create policy contact_categories_read on contact_categories for select to authenticated
  using (is_member());
create policy contact_categories_write on contact_categories for all to authenticated
  using (can_edit_contacts()) with check (can_edit_contacts());

drop policy if exists contacts_read  on contacts;
drop policy if exists contacts_write on contacts;
create policy contacts_read on contacts for select to authenticated
  using (is_member());
create policy contacts_write on contacts for all to authenticated
  using (can_edit_contacts()) with check (can_edit_contacts());

comment on table contact_categories is
  'Contacts directory categories (Administration, Mechanical design, …). Read by every member; written by department Heads, the President, Vice President or a Developer.';
comment on table contacts is
  'Who can help with what, and how to reach them. At least one of email, phone, website. Not season-scoped.';
