-- =============================================================================
--  NEW MEMBER — one login plus one roster row, in a single transaction.
--
--  Supabase dashboard -> SQL Editor -> New query -> paste this file -> change
--  the five values under EDIT ME -> Run.
--
--  This is the SQL version of the two-step process in README §7. The APP still
--  cannot create logins, and that has not changed: doing it from a browser
--  would need the service_role key, which bypasses Row Level Security, so
--  anyone could read and rewrite the whole database. The SQL Editor is a
--  different thing — it already runs inside the database as an administrator,
--  so no key is ever shipped anywhere.
--
--  Safe to re-run: it refuses if that email already has a login, and a failure
--  rolls the whole block back, leaving no half-made account behind.
--
--  Afterwards, give the person the password you typed and tell them to change
--  it in Settings -> Your account -> Change your password.
-- =============================================================================

do $$
declare
  -- --------------------------------------------------------------- EDIT ME --
  p_email     text := 'first.last@sdumotorbike.test';  -- what they sign in with
  p_password  text := 'change-me-on-first-sign-in';    -- at least 8 characters
  p_full_name text := 'First Last';                    -- as the roster should show it
  p_job_title text := 'Member';                        -- free text ("Chassis lead"); grants nothing
  p_roles privileged_role[] := '{}';                   -- '{}', or e.g. '{treasurer}' / '{president,developer}'
  -- --------------------------------------------------------------------------
  new_id uuid := gen_random_uuid();
begin
  p_email     := lower(btrim(p_email));
  p_full_name := btrim(p_full_name);

  if p_email = '' or position('@' in p_email) = 0 then
    raise exception 'Give a real email address (got "%").', p_email;
  end if;
  if length(p_password) < 8 then
    raise exception 'The password must be at least 8 characters.';
  end if;
  if p_full_name = '' then
    raise exception 'Give the person a full name — it is what every screen shows.';
  end if;
  if exists (select 1 from auth.users where email = p_email) then
    raise exception 'A login already exists for %. Link it on the roster instead (Settings -> Roster), or use another address.', p_email;
  end if;

  -- 1. The login. email_confirmed_at is set so they can sign in straight away.
  --    The four token columns must be '' and never null, or GoTrue refuses the
  --    sign-in with a 500. If your project keeps pgcrypto in `public` rather
  --    than `extensions`, remove the two `extensions.` prefixes below.
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, recovery_token,
                          email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', new_id, 'authenticated', 'authenticated',
          p_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
          now(), now(), '', '', '', '');

  insert into auth.identities (provider_id, user_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  values (new_id::text, new_id,
          jsonb_build_object('sub', new_id::text, 'email', p_email, 'email_verified', true),
          'email', now(), now(), now());

  -- 2. The roster row. THIS is what grants access: every RLS policy calls
  --    is_member(), which looks for exactly this row. A login without one sees
  --    "Your account is not on the club roster" and no data at all.
  insert into members (id, full_name, role)
  values (new_id, p_full_name, coalesce(nullif(p_job_title, ''), 'Member'));

  -- 3. Privileged roles, if any. Empty is the right default for a new member;
  --    the President can add one later in Settings -> Roster -> Change roles.
  insert into member_roles (member_id, role)
  select new_id, r from unnest(p_roles) as r
  on conflict do nothing;

  raise notice 'Created % (%) — privileged roles: %', p_full_name, p_email,
    case when cardinality(p_roles) = 0 then 'none' else array_to_string(p_roles, ', ') end;
end $$;

-- Check: the three newest people, whether they can sign in, and their roles.
select m.full_name,
       m.role                            as job_title,
       u.email,
       u.email_confirmed_at is not null   as can_sign_in,
       coalesce(string_agg(mr.role::text, ', ' order by mr.role), '-') as privileged_roles
from members m
join auth.users u on u.id = m.id
left join member_roles mr on mr.member_id = m.id
group by m.id, m.full_name, m.role, u.email, u.email_confirmed_at, m.created_at
order by m.created_at desc
limit 3;
