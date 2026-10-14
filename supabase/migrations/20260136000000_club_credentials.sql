-- =============================================================================
--  Club accounts: the logins the President needs to take over the club's cloud services
--  (Cloudflare, Supabase, Vercel), shown in Settings behind a masked overlay with a Copy button.
--
--  WHAT WAS MISSING. These passwords lived only with the person who set the services up. If that
--  person is unreachable, the club cannot reach its own database, hosting or file storage.
--
--  AFTER.
--   * club_credentials: one row per service with its login (an e-mail or username - not secret)
--     and a pointer to the password. THE PASSWORD IS NOT IN THIS TABLE: it is stored with
--     Supabase Vault, which encrypts it with a key that never appears in the database, in a dump
--     or in the daily backups. The row only knows the Vault id (secret_id), and browsers cannot
--     even read that column.
--   * reveal_club_credential(id): the ONLY way to get a password out. It checks the caller is the
--     President or a Developer, records who asked and when, and returns the password for the
--     browser to put on the clipboard. The app never renders it.
--   * save_club_credential(id, login, secret): the same two people can change the login and
--     replace the password (for example after rotating it). A blank secret keeps the old one.
--   * Three rows are seeded without passwords: Cloudflare, Supabase, Vercel. THE MIGRATION CONTAINS
--     NO PASSWORD: the President or a Developer types each one into Settings -> Club accounts.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Hand the President the logins needed to run the club's services.
--    Existing data  None touched. One new table (3 rows), three new functions.
--    Locking        CREATE TABLE / FUNCTION: no lock on existing tables.
--    Authorization  can_view_club_credentials() = President or Developer (active members, like
--                   has_role()). Vice President is NOT included. RLS: SELECT for that gate only,
--                   no write policy; browsers have column-level SELECT without secret_id; both
--                   RPCs are closed to anon and re-check the gate themselves.
--    Rollback       docs/ultraplan/rollbacks/20260136000000_club_credentials_down.sql (also
--                   deletes the stored passwords from Vault).
--    Deploy order   Any time after 20260135000000. Hosted: only via `supabase db push --linked`,
--                   BEFORE the frontend that shows the overlay is deployed. Needs the
--                   supabase_vault extension (installed on every Supabase project).
-- =============================================================================

create or replace function can_view_club_credentials() returns boolean
language sql stable security definer set search_path = public as $fn$
  select has_role('president') or has_role('developer');
$fn$;

revoke all on function can_view_club_credentials() from public, anon;
grant execute on function can_view_club_credentials() to authenticated, service_role;

-- ---------------------------------------------------------------------- the table
create table if not exists club_credentials (
  id                uuid primary key default gen_random_uuid(),
  -- What the service is called on screen, e.g. 'Cloudflare'.
  service           text not null unique check (length(btrim(service)) between 1 and 60),
  -- The e-mail or username to sign in with. Not secret; may be empty until someone fills it in.
  login             text not null default '' check (length(login) <= 200),
  -- vault.secrets.id of the password; null until a password was saved. Never granted to browsers.
  secret_id         uuid,
  has_secret        boolean generated always as (secret_id is not null) stored,
  sort_order        integer not null default 0,
  updated_at        timestamptz,
  updated_by        uuid,
  last_revealed_at  timestamptz,
  last_revealed_by  uuid
);

alter table club_credentials enable row level security;

drop policy if exists club_credentials_select on club_credentials;
create policy club_credentials_select on club_credentials
  for select to authenticated using (can_view_club_credentials());

-- Browsers read the row, never secret_id; nothing is writable directly (the functions below write).
revoke all on club_credentials from public, anon, authenticated;
grant select (id, service, login, has_secret, sort_order, updated_at, updated_by, last_revealed_at, last_revealed_by)
  on club_credentials to authenticated;
grant all on club_credentials to service_role;

insert into club_credentials (service, sort_order) values
  ('Cloudflare', 10),
  ('Supabase', 20),
  ('Vercel', 30)
on conflict (service) do nothing;

-- ---------------------------------------------------------------------- reveal a password
create or replace function reveal_club_credential(p_id uuid) returns text
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_secret_id uuid;
  v_secret    text;
begin
  if auth.uid() is null or not can_view_club_credentials() then
    raise exception 'Only the President and Developers can open the club accounts.' using errcode = '42501';
  end if;

  select secret_id into v_secret_id from club_credentials where id = p_id;
  if not found then
    raise exception 'That account does not exist.' using errcode = 'P0002';
  end if;
  if v_secret_id is null then
    raise exception 'No password has been saved for this account yet.' using errcode = 'P0002';
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    raise exception 'The saved password could not be read. Save it again.' using errcode = 'P0002';
  end if;

  update club_credentials
     set last_revealed_at = now(), last_revealed_by = auth.uid()
   where id = p_id;
  return v_secret;
end
$fn$;

-- ---------------------------------------------------------------------- change login / password
create or replace function save_club_credential(p_id uuid, p_login text, p_secret text default null)
returns void
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_service   text;
  v_secret_id uuid;
  v_login     text := btrim(coalesce(p_login, ''));
begin
  if auth.uid() is null or not can_view_club_credentials() then
    raise exception 'Only the President and Developers can change the club accounts.' using errcode = '42501';
  end if;
  if length(v_login) > 200 then
    raise exception 'The login is too long (200 characters at most).' using errcode = '22023';
  end if;
  if p_secret is not null and length(p_secret) > 500 then
    raise exception 'The password is too long (500 characters at most).' using errcode = '22023';
  end if;

  select service, secret_id into v_service, v_secret_id from club_credentials where id = p_id for update;
  if not found then
    raise exception 'That account does not exist.' using errcode = 'P0002';
  end if;

  -- A blank secret means "leave the password as it is" (only the login was edited).
  if p_secret is not null and p_secret <> '' then
    if v_secret_id is null then
      v_secret_id := vault.create_secret(p_secret, 'club_credential:' || p_id::text, 'Club account: ' || v_service);
    else
      perform vault.update_secret(v_secret_id, p_secret);
    end if;
  end if;

  update club_credentials
     set login = v_login, secret_id = v_secret_id, updated_at = now(), updated_by = auth.uid()
   where id = p_id;
end
$fn$;

revoke all on function reveal_club_credential(uuid) from public, anon;
revoke all on function save_club_credential(uuid, text, text) from public, anon;
grant execute on function reveal_club_credential(uuid) to authenticated;
grant execute on function save_club_credential(uuid, text, text) to authenticated;

-- Every public table carries the restore tombstone trigger (20260134000000; a SQL test enforces it). It records
-- only the table name, the primary key and who deleted a row - never the row - so no pointer or password is copied.
-- NOTE FOR RESTORES: the passwords themselves live in Vault, which is per project and is not part of a backup.
-- After restoring into a NEW project the rows come back without a readable password and reveal_club_credential
-- says "Save it again": the President or a Developer types the passwords in once more.
select restore.install_tombstone_triggers();
