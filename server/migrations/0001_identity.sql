-- 0001 identity: users, roles, permissions, sessions, password resets, audit log.
-- Forward-only. Applied by `npm run migrate`, which records it in schema_migrations.

create extension if not exists citext;
create extension if not exists pgcrypto;

-- Keeps updated_at current on every table that has it.
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create table users (
  id                uuid primary key default gen_random_uuid(),
  email             citext not null unique,
  phone             text unique,
  password_hash     text not null,
  full_name         text not null check (length(full_name) between 1 and 120),
  status            text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  email_verified_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index users_created_idx on users (created_at desc, id desc);
create trigger users_updated before update on users for each row execute function set_updated_at();

create table roles (
  key         text primary key check (key ~ '^[a-z_]+$'),
  name        text not null,
  description text not null default '',
  created_at  timestamptz not null default now()
);

create table permissions (
  key         text primary key check (key ~ '^[a-z_.]+$'),
  description text not null default '',
  created_at  timestamptz not null default now()
);

create table role_permissions (
  role_key       text not null references roles(key) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  primary key (role_key, permission_key)
);

create table user_roles (
  user_id    uuid not null references users(id) on delete cascade,
  role_key   text not null references roles(key),
  granted_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (user_id, role_key)
);
create index user_roles_role_idx on user_roles (role_key);

-- One row per issued refresh token. Rows in the same family_id belong to one login.
-- Rotation revokes the old row; presenting a revoked token revokes the whole family.
create table sessions (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null,
  user_id            uuid not null references users(id) on delete cascade,
  refresh_token_hash text not null unique,
  user_agent         text,
  ip                 inet,
  expires_at         timestamptz not null,
  family_expires_at  timestamptz not null,  -- absolute end of this login; carried to every rotated token
  revoked_at         timestamptz,
  revoked_reason     text check (revoked_reason in ('rotated', 'logout', 'reuse_detected', 'password_reset', 'suspended', 'admin', 'logout_all')),
  created_at         timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);
create index sessions_family_active_idx on sessions (family_id) where revoked_at is null;

create table password_resets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index password_resets_user_idx on password_resets (user_id);

-- Append-only record of important actions. Updates and deletes are rejected for everyone.
create table audit_logs (
  id            bigint generated always as identity primary key,
  actor_user_id uuid references users(id),
  action        text not null,
  entity        text not null,
  entity_id     text,
  old_value     jsonb,
  new_value     jsonb,
  ip            inet,
  request_id    text,
  created_at    timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs (entity, entity_id, created_at desc);
create index audit_logs_actor_idx on audit_logs (actor_user_id, created_at desc);
create index audit_logs_created_idx on audit_logs (created_at desc, id desc);

create or replace function reject_modification() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;
create trigger audit_logs_append_only before update or delete on audit_logs
  for each row execute function reject_modification();
create trigger audit_logs_no_truncate before truncate on audit_logs
  for each statement execute function reject_modification();

-- Seed roles and permissions. New permissions arrive in later migrations with their modules.
insert into roles (key, name, description) values
  ('customer', 'Customer', 'Buys products'),
  ('seller',   'Seller',   'Approved seller; sells products'),
  ('admin',    'Admin',    'Full marketplace administration');

insert into permissions (key, description) values
  ('admin.users.read',   'List and view users'),
  ('admin.users.manage', 'Suspend and reactivate users'),
  ('admin.roles.manage', 'Grant and revoke roles, including admin'),
  ('admin.audit.read',   'Read the audit log');

insert into role_permissions (role_key, permission_key)
  select 'admin', key from permissions where key like 'admin.%';
