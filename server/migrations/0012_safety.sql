-- 0012 safety: reports (listings, users, conversations) and user blocks. Required by app stores for
-- apps with user-generated content. Account deletion needs no table: it anonymises the users row.

create table user_blocks (
  blocker_id uuid not null references users(id),
  blocked_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);
create index user_blocks_blocked_idx on user_blocks (blocked_id);

create table reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references users(id),
  target_type  text not null check (target_type in ('product', 'user', 'conversation')),
  target_id    uuid not null,
  reason       text not null check (reason in ('counterfeit', 'prohibited', 'misleading', 'abusive', 'spam', 'scam', 'other')),
  details      text check (length(details) <= 1000),
  status       text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  admin_note   text check (length(admin_note) <= 500),
  resolved_by  uuid references users(id),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index reports_status_idx on reports (status, created_at desc);
-- One open report per person per target, so repeated taps do not flood the queue.
create unique index reports_one_open on reports (reporter_id, target_type, target_id) where status = 'open';

insert into permissions (key, description) values
  ('admin.reports.manage', 'View and resolve user reports, suspend reported users');
insert into role_permissions (role_key, permission_key) values ('admin', 'admin.reports.manage');
