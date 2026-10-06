-- 0002 sellers: seller applications (KYC), documents, bank accounts, status history.

create table sellers (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references users(id),
  status           text not null default 'draft'
                   check (status in ('draft', 'submitted', 'changes_requested', 'approved', 'rejected', 'suspended')),
  display_name     citext not null unique check (length(display_name) between 2 and 60),
  business_name    text not null check (length(business_name) between 2 and 160),
  business_type    text not null check (business_type in ('individual', 'proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'other')),
  -- PAN is encrypted at rest; only the last 4 characters are kept in clear for display.
  pan_encrypted    text not null,
  pan_last4        text not null check (pan_last4 ~ '^[A-Z0-9]{4}$'),
  -- GSTIN is a public business registration number, so it is stored in clear (and unique).
  gstin            text unique check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  address_line1    text not null check (length(address_line1) between 3 and 200),
  address_line2    text check (length(address_line2) <= 200),
  city             text not null check (length(city) between 2 and 80),
  state            text not null check (length(state) between 2 and 80),
  pincode          text not null check (pincode ~ '^[1-9][0-9]{5}$'),
  contact_phone    text not null check (contact_phone ~ '^\+?[0-9]{10,15}$'),
  submitted_at     timestamptz,
  approved_at      timestamptz,
  approved_by      uuid references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index sellers_status_idx on sellers (status, created_at desc, id desc);
create index sellers_created_idx on sellers (created_at desc, id desc);
create trigger sellers_updated before update on sellers for each row execute function set_updated_at();

create table seller_documents (
  id            uuid primary key default gen_random_uuid(),
  seller_id     uuid not null references sellers(id),
  doc_type      text not null check (doc_type in ('pan_card', 'gst_certificate', 'address_proof', 'bank_proof', 'other')),
  storage_key   text not null unique,
  original_name text not null check (length(original_name) <= 200),
  mime_type     text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes    integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  review_note   text check (length(review_note) <= 500),
  reviewed_by   uuid references users(id),
  reviewed_at   timestamptz,
  removed_at    timestamptz,  -- seller removed it while editing; kept for the audit trail
  created_at    timestamptz not null default now()
);
create index seller_documents_seller_idx on seller_documents (seller_id) where removed_at is null;

-- Bank details are encrypted. Changes after approval create a new pending row; payouts may
-- only ever use a verified row, so a hijacked account cannot redirect money without review.
create table seller_bank_accounts (
  id                       uuid primary key default gen_random_uuid(),
  seller_id                uuid not null references sellers(id),
  account_holder_name      text not null check (length(account_holder_name) between 2 and 120),
  account_number_encrypted text not null,
  account_last4            text not null check (account_last4 ~ '^[0-9]{4}$'),
  ifsc                     text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  status                   text not null default 'pending' check (status in ('pending', 'verified', 'rejected', 'replaced')),
  review_note              text check (length(review_note) <= 500),
  verified_by              uuid references users(id),
  verified_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index seller_bank_accounts_seller_idx on seller_bank_accounts (seller_id, created_at desc);
-- At most one verified and one pending account per seller at any time.
create unique index seller_bank_one_verified on seller_bank_accounts (seller_id) where status = 'verified';
create unique index seller_bank_one_pending on seller_bank_accounts (seller_id) where status = 'pending';
create trigger seller_bank_accounts_updated before update on seller_bank_accounts for each row execute function set_updated_at();

create table seller_status_history (
  id          bigint generated always as identity primary key,
  seller_id   uuid not null references sellers(id),
  from_status text,
  to_status   text not null,
  actor_id    uuid references users(id),
  reason      text check (length(reason) <= 500),
  created_at  timestamptz not null default now()
);
create index seller_status_history_seller_idx on seller_status_history (seller_id, created_at);
create trigger seller_status_history_append_only before update or delete on seller_status_history
  for each row execute function reject_modification();
create trigger seller_status_history_no_truncate before truncate on seller_status_history
  for each statement execute function reject_modification();

insert into permissions (key, description) values
  ('admin.sellers.read',      'List and view seller applications, with masked identifiers'),
  ('admin.sellers.manage',    'Approve, reject, request changes, suspend and reinstate sellers; review documents and bank accounts'),
  ('admin.sellers.documents', 'Open seller KYC documents (every view is audited)');

insert into role_permissions (role_key, permission_key) values
  ('admin', 'admin.sellers.read'),
  ('admin', 'admin.sellers.manage'),
  ('admin', 'admin.sellers.documents');
