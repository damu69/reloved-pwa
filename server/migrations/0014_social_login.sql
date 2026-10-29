-- 0014 social login: Google and Facebook identities linked to a Reloved account.
-- A person who signs up only with Google/Facebook has no password: users.password_hash holds the marker '!social'
-- (never a valid argon2 hash, so password login always fails for them; same idea as '!deleted').
-- They can add a password later with "Forgot your password?", which proves they own the email.

create table user_identities (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id),
  provider         text not null check (provider in ('google', 'facebook')),
  provider_user_id text not null check (length(provider_user_id) between 1 and 200),
  email            citext,
  created_at       timestamptz not null default now(),
  last_login_at    timestamptz not null default now()
);
-- One provider account belongs to one Reloved account, and an account has at most one identity per provider.
create unique index user_identities_provider_subject on user_identities (provider, provider_user_id);
create unique index user_identities_user_provider on user_identities (user_id, provider);
