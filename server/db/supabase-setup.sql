-- One-time setup of the Reloved API inside an existing Supabase project.
-- Run in Supabase → SQL Editor (as the default "postgres" user). Safe to run again.
--
-- Why a separate schema and roles:
--  * Supabase publishes every table in the "public" schema through its auto-generated REST API,
--    reachable with the anon key that sits in the live app's code. The API's tables (users,
--    password hashes, orders, money records) must never be there, so they live in the private
--    schema "reloved", which the REST API does not expose and anon/authenticated cannot read.
--  * reloved_owner owns the tables and runs migrations (at deploy time only).
--  * reloved_app is what the running API uses: it can read and write rows but cannot change tables,
--    disable triggers or drop anything, so the append-only and money guards cannot be bypassed.
--
-- BEFORE RUNNING: replace both CHANGE_ME_... passwords with long random values (letters and digits
-- only, 32+ characters), and keep them for the Vercel settings.

-- Extensions the migrations use (Supabase keeps them in the "extensions" schema).
create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists btree_gist with schema extensions;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'reloved_owner') then
    create role reloved_owner login password 'CHANGE_ME_OWNER_PASSWORD';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'reloved_app') then
    create role reloved_app login password 'CHANGE_ME_APP_PASSWORD';
  end if;
end $$;

create schema if not exists reloved authorization reloved_owner;
revoke all on schema reloved from public;
revoke all on schema reloved from anon, authenticated;
grant usage on schema reloved to reloved_app;
grant usage on schema extensions to reloved_owner, reloved_app;

-- Both roles find the API tables first, then the extensions.
alter role reloved_owner set search_path = reloved, extensions;
alter role reloved_app set search_path = reloved, extensions;
-- Long queries are cut off instead of piling up.
alter role reloved_app set statement_timeout = '15s';

-- Everything the owner creates in the schema (now and in future migrations) is usable by the app:
-- rows only, never table changes.
alter default privileges for role reloved_owner in schema reloved grant select, insert, update, delete on tables to reloved_app;
alter default privileges for role reloved_owner in schema reloved grant usage, select on sequences to reloved_app;
alter default privileges for role reloved_owner in schema reloved grant execute on functions to reloved_app;
-- Tables that already exist (when re-running after migrations).
grant select, insert, update, delete on all tables in schema reloved to reloved_app;
grant usage, select on all sequences in schema reloved to reloved_app;

-- ---------------------------------------------------------------------------------------------
-- After the first successful deploy, run the part below ONCE (replace the URL and the secret):
-- background housekeeping every minute (expire unpaid orders, refresh search, return deadlines…).
-- Needs the pg_cron and pg_net extensions (Database → Extensions, or the two lines below).
--
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
-- select cron.schedule('reloved-sweep', '* * * * *', $job$
--   select net.http_post(
--     url := 'https://YOUR-API.vercel.app/internal/sweep',
--     headers := jsonb_build_object('authorization', 'Bearer YOUR_CRON_SECRET', 'content-type', 'application/json'),
--     body := '{}'::jsonb,
--     timeout_milliseconds := 55000);
-- $job$);
--
-- To stop it later:  select cron.unschedule('reloved-sweep');
--
-- Make the first admin (after registering that account through the API):
-- insert into reloved.user_roles (user_id, role_key)
--   select id, 'admin' from reloved.users where email = 'you@example.com' on conflict do nothing;
