-- Production hardening: run the API as a limited database role instead of the owner.
-- Run once as the database owner (e.g. Supabase "postgres" user) AFTER `npm run migrate`,
-- and again after any migration that adds tables. Replace the password first.
--
-- Why: the owner can disable triggers, so the append-only audit log is only truly protected
-- when the app connects as a role that cannot alter tables or modify audit rows.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'reloved_app') then
    create role reloved_app login password 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD' noinherit;
  end if;
end $$;

grant usage on schema public to reloved_app;
grant select, insert, update, delete on all tables in schema public to reloved_app;
grant usage, select on all sequences in schema public to reloved_app;

-- Audit log: insert and read only.
revoke update, delete, truncate on audit_logs from reloved_app;
-- Migration bookkeeping is the migrator's job, not the app's.
revoke insert, update, delete, truncate on schema_migrations from reloved_app;

-- Then set the API's DATABASE_URL to connect as reloved_app, and keep the owner
-- credentials only for running migrations.
