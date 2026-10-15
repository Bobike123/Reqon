-- =============================================================================
--  Club accounts, part 2: the President or a Developer can add a service to the list
--  (GitHub, Google Drive, a domain registrar, ...). Migration 20260136000000 seeded
--  Cloudflare, Supabase and Vercel only.
--
--  AFTER.
--   * add_club_credential(service, login, password): creates the row and, when a password is
--     given, stores it in Supabase Vault exactly like save_club_credential does. Same gate as
--     everything else here (President or Developer; Vice President excluded). Browsers still
--     cannot write the table directly.
--   * The checks come BEFORE the password is stored, so a refused add never leaves an orphan in
--     Vault: a name of 1-60 characters, a unique name (compared without regard to capitals),
--     a login of at most 200, a password of at most 500, and at most 30 accounts in total.
--     Adds are serialised with an advisory lock so two at once cannot slip past the cap or the
--     duplicate check.
--
--  IMPLEMENTATION NOTE (migration policy)
--    Purpose        Let the President extend the list of club accounts without a developer.
--    Existing data  None touched. One new function; the table is unchanged.
--    Locking        CREATE FUNCTION only.
--    Authorization  can_view_club_credentials() inside the function; EXECUTE for authenticated
--                   only (not anon, not public).
--    Rollback       docs/ultraplan/rollbacks/20260137000000_club_credentials_add_down.sql
--    Deploy order   After 20260136000000. Hosted: only via `supabase db push --linked`, BEFORE
--                   the frontend that shows "Add an account" is deployed.
-- =============================================================================

create or replace function add_club_credential(p_service text, p_login text default '', p_secret text default null)
returns uuid
language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_service   text := btrim(coalesce(p_service, ''));
  v_login     text := btrim(coalesce(p_login, ''));
  v_id        uuid := gen_random_uuid();
  v_secret_id uuid;
  v_count     integer;
  v_next      integer;
begin
  if auth.uid() is null or not can_view_club_credentials() then
    raise exception 'Only the President and Developers can add club accounts.' using errcode = '42501';
  end if;
  if length(v_service) < 1 or length(v_service) > 60 then
    raise exception 'Give the account a name of 1 to 60 characters.' using errcode = '22023';
  end if;
  if length(v_login) > 200 then
    raise exception 'The login is too long (200 characters at most).' using errcode = '22023';
  end if;
  if p_secret is not null and length(p_secret) > 500 then
    raise exception 'The password is too long (500 characters at most).' using errcode = '22023';
  end if;

  -- One add at a time, so the duplicate check and the cap below cannot be raced past.
  perform pg_advisory_xact_lock(hashtext('club_credentials_add'));

  if exists (select 1 from club_credentials where lower(service) = lower(v_service)) then
    raise exception 'There is already an account called %.', v_service using errcode = '23505';
  end if;
  select count(*), coalesce(max(sort_order), 0) + 10 into v_count, v_next from club_credentials;
  if v_count >= 30 then
    raise exception 'The list is full (30 accounts).' using errcode = '54000';
  end if;

  -- Only after every check: nothing is left behind in Vault by a refused add.
  if p_secret is not null and p_secret <> '' then
    v_secret_id := vault.create_secret(p_secret, 'club_credential:' || v_id::text, 'Club account: ' || v_service);
  end if;

  insert into club_credentials (id, service, login, secret_id, sort_order, updated_at, updated_by)
  values (v_id, v_service, v_login, v_secret_id, v_next, now(), auth.uid());
  return v_id;
end
$fn$;

revoke all on function add_club_credential(text, text, text) from public, anon;
grant execute on function add_club_credential(text, text, text) to authenticated;
