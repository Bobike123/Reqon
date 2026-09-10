-- =============================================================================
--  Local-only stand-in for the parts of Supabase that live outside `public`.
--
--  You do NOT need this against a real Supabase project — Supabase provides
--  `auth.users`, `auth.uid()` and the `anon` / `authenticated` roles already.
--  This file exists so the schema, the reference data and the row-level
--  security policies can be installed and tested against a plain Postgres
--  container, with no Supabase account and no network access.
--
--  It mirrors only the columns GoTrue actually uses that our seed touches.
--  See scripts/verify_db.sh for how it is applied.
-- =============================================================================

create extension if not exists "pgcrypto";
create schema if not exists auth;

-- The roles PostgREST hands a request to. RLS policies are granted `to
-- authenticated`, so the role has to exist before the policies are created.
do $$ begin create role anon nologin;               exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin;      exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;

create table if not exists auth.users (
  instance_id       uuid,
  id                uuid primary key,
  aud               text,
  role              text,
  email             text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data  jsonb,
  raw_user_meta_data jsonb,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create table if not exists auth.identities (
  provider_id     text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  identity_data   jsonb not null,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  primary key (provider, provider_id)
);

-- Supabase derives the caller's id from the request JWT. Locally we read the
-- same GUC PostgREST sets, so `set local request.jwt.claim.sub = '<uuid>'`
-- impersonates a signed-in member and RLS behaves exactly as in production.
create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$fn$;

create or replace function auth.role() returns text
language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$fn$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- Realtime publication: schema.sql adds tables to it inside an exception
-- handler, so creating it here means that code path is actually exercised.
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
