-- =============================================================================
--  Finance ledger: the club's income and expenses, per season.
--
--  Secured with EXACTLY the finance template from
--  20260105000000_privileged_roles.sql — no new rules:
--    read   -> can_view_finances()    any privileged role (President,
--                                     Vice President, Treasurer, Developer)
--    write  -> can_manage_finances()  the Treasurer only
--  Ordinary members get neither. Deliberately NOT member_read / member_write.
--
--  Run after 20260105. Safe to run twice.
-- =============================================================================

do $$ begin
  create type finance_kind as enum ('income', 'expense');
exception when duplicate_object then null;
end $$;

create table if not exists finance_entries (
  id           uuid primary key default gen_random_uuid(),
  season_id    uuid not null references seasons(id) on delete restrict,
  entry_date   date not null default current_date,
  kind         finance_kind not null,
  description  text not null check (length(btrim(description)) between 1 and 200),
  category     text check (category is null or length(btrim(category)) between 1 and 60),
  -- Whole cents, so nothing is lost to floating point. Always positive: the
  -- kind says which way the money went. MotoStudent's economical plan is in
  -- euros (F.7.1.7), so is this.
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000000),
  created_by   uuid references members(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists finance_entries_season_date
  on finance_entries (season_id, entry_date desc);

-- Who recorded an entry, and when, is stamped by the database — never taken
-- from the browser, and never rewritten by an edit.
create or replace function stamp_finance_entry() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists trg_stamp_finance_entry on finance_entries;
create trigger trg_stamp_finance_entry before insert or update on finance_entries
  for each row execute function stamp_finance_entry();

alter table finance_entries enable row level security;

-- Only the four row operations RLS can police. TRUNCATE in particular bypasses
-- Row Level Security entirely, so nobody on the Data API gets it.
revoke all on finance_entries from anon, authenticated;
grant select, insert, update, delete on finance_entries to authenticated;

drop policy if exists finance_read   on finance_entries;
drop policy if exists finance_insert on finance_entries;
drop policy if exists finance_update on finance_entries;
drop policy if exists finance_delete on finance_entries;
create policy finance_read   on finance_entries for select to authenticated
  using (can_view_finances());
create policy finance_insert on finance_entries for insert to authenticated
  with check (can_manage_finances());
create policy finance_update on finance_entries for update to authenticated
  using (can_manage_finances()) with check (can_manage_finances());
create policy finance_delete on finance_entries for delete to authenticated
  using (can_manage_finances());
