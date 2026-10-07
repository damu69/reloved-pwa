-- 0008 finance: commission rules, commission frozen on every order line, a double-entry ledger
-- that can only be appended to, and seller balances (on hold / available / paid out).
--
-- Rules decided by the owner (2026-10-07):
--  - Default commission 5% of the item price (before any coupon; the platform pays for coupons).
--  - Most specific rule wins: product > seller > category (deepest category first) > default.
--  - The delivery fee for a package goes to its seller, with no commission on it.
--  - No GST is charged on commission for now.
--  - Seller earnings are held for 14 days from payment, then become available for payout.
--  - On a refund (step 11) the seller's earning is reversed but the commission is NOT reversed;
--    the platform bears that cost. The seller is not charged anything extra.

create extension if not exists btree_gist;

-- ---------------- commission rules ----------------

create table commission_rules (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null check (scope in ('default', 'category', 'seller', 'product')),
  category_id uuid references categories(id),
  seller_id   uuid references sellers(id),
  product_id  uuid references products(id),
  rate_bp     integer not null check (rate_bp between 0 and 5000),     -- 500 = 5%; 50% is a sanity cap
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  note        text check (length(note) <= 300),
  created_by  uuid references users(id),
  ended_by    uuid references users(id),
  created_at  timestamptz not null default now(),
  target_key  text generated always as (scope || ':' || coalesce(product_id::text, seller_id::text, category_id::text, '')) stored,
  check (ends_at is null or ends_at >= starts_at),   -- equal = a scheduled rule that was called off
  check (
    (scope = 'default'  and category_id is null and seller_id is null and product_id is null) or
    (scope = 'category' and category_id is not null and seller_id is null and product_id is null) or
    (scope = 'seller'   and seller_id is not null and category_id is null and product_id is null) or
    (scope = 'product'  and product_id is not null and category_id is null and seller_id is null)
  ),
  -- Two rules for the same target can never be in force at the same moment.
  constraint commission_rules_no_overlap exclude using gist (
    target_key with =, tstzrange(starts_at, coalesce(ends_at, 'infinity'::timestamptz)) with &&)
);
create index commission_rules_seller_idx on commission_rules (seller_id) where seller_id is not null;
create index commission_rules_product_idx on commission_rules (product_id) where product_id is not null;
create index commission_rules_category_idx on commission_rules (category_id) where category_id is not null;

-- A rule's rate and target never change; it can only be ended (not earlier than now), so the
-- history of which rate applied when is always true.
create or replace function guard_commission_rule() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'commission rules cannot be deleted; end them instead' using errcode = 'insufficient_privilege';
  end if;
  if (new.scope, new.category_id, new.seller_id, new.product_id, new.rate_bp, new.starts_at, new.created_by, new.created_at)
     is distinct from (old.scope, old.category_id, old.seller_id, old.product_id, old.rate_bp, old.starts_at, old.created_by, old.created_at) then
    raise exception 'a commission rule cannot be changed; end it and create a new one' using errcode = 'insufficient_privilege';
  end if;
  if new.ends_at is distinct from old.ends_at then
    if old.ends_at is not null and old.ends_at <= now() then
      raise exception 'this commission rule has already ended' using errcode = 'insufficient_privilege';
    end if;
    if new.ends_at is null or new.ends_at < now() - interval '1 minute' then
      raise exception 'a commission rule can only be ended from now on' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
create trigger commission_rules_guard before update or delete on commission_rules for each row execute function guard_commission_rule();

insert into commission_rules (scope, rate_bp, starts_at, note) values ('default', 500, '2026-01-01T00:00:00Z', 'Launch default: 5% of the item price');

-- ---------------- finance settings ----------------

create table finance_settings (
  id                integer primary key default 1 check (id = 1),
  payout_hold_days  integer not null default 14 check (payout_hold_days between 0 and 90),
  updated_by        uuid references users(id),
  updated_at        timestamptz not null default now()
);
insert into finance_settings (id) values (1);

-- ---------------- commission frozen on orders ----------------
-- Nullable so the migration can run on a database that already has orders; every NEW line must
-- carry them (the NOT VALID checks still apply to every insert), and payment refuses an order
-- that has none.

alter table order_items
  add column commission_rule_id  uuid references commission_rules(id),
  add column commission_rate_bp  integer,
  add column commission_paise    bigint,
  add column seller_earning_paise bigint;
alter table order_items add constraint order_items_commission_set check (
  commission_rate_bp is not null and commission_paise is not null and seller_earning_paise is not null
  and commission_rate_bp between 0 and 5000
  -- half-up rounding of subtotal × rate, the same rule the code uses
  and commission_paise = (subtotal_paise * commission_rate_bp * 2 + 10000) / 20000
  and seller_earning_paise = subtotal_paise - commission_paise) not valid;

alter table seller_orders
  add column commission_paise     bigint,
  add column seller_earning_paise bigint,     -- items subtotal − commission + delivery fee
  add column funds_available_at   timestamptz,
  add column funds_released_at    timestamptz;
-- Packages created before this migration have no commission (both null) and can still be moved
-- or cancelled; payment refuses to book them. Every NEW package must carry both (trigger below).
alter table seller_orders add constraint seller_orders_earning_set check (
  (commission_paise is null and seller_earning_paise is null and funds_available_at is null)
  or (commission_paise >= 0 and seller_earning_paise = items_subtotal_paise - commission_paise + delivery_paise));
create or replace function require_seller_order_commission() returns trigger language plpgsql as $$
begin
  if new.commission_paise is null or new.seller_earning_paise is null then
    raise exception 'a new seller order must carry its commission and earning' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger seller_orders_require_commission before insert on seller_orders for each row execute function require_seller_order_commission();

create or replace function guard_seller_order_money() returns trigger language plpgsql as $$
begin
  if (new.items_subtotal_paise, new.discount_paise, new.items_net_paise, new.delivery_paise, new.order_id, new.seller_id,
      new.delivery_code, new.delivery_label, new.number, new.commission_paise, new.seller_earning_paise)
     is distinct from (old.items_subtotal_paise, old.discount_paise, old.items_net_paise, old.delivery_paise, old.order_id, old.seller_id,
      old.delivery_code, old.delivery_label, old.number, old.commission_paise, old.seller_earning_paise) then
    raise exception 'seller order amounts cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  -- The hold end and release time are set once.
  if old.funds_available_at is not null and new.funds_available_at is distinct from old.funds_available_at then
    raise exception 'the payout date cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  if old.funds_released_at is not null and new.funds_released_at is distinct from old.funds_released_at then
    raise exception 'released funds cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create index seller_orders_release_idx on seller_orders (funds_available_at)
  where funds_available_at is not null and funds_released_at is null;

-- ---------------- ledger ----------------

create table ledger_accounts (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,          -- e.g. platform:commission_revenue, seller:<id>:pending
  kind       text not null check (kind in ('asset', 'liability', 'revenue', 'expense')),
  seller_id  uuid references sellers(id),
  purpose    text check (purpose in ('pending', 'available')),
  name       text not null,
  created_at timestamptz not null default now(),
  check ((seller_id is null) = (purpose is null)),
  unique (seller_id, purpose)
);
insert into ledger_accounts (code, kind, name) values
  ('platform:payments_receivable', 'asset',   'Money collected from buyers (held by the payment provider)'),
  ('platform:commission_revenue',  'revenue', 'Commission earned from sellers'),
  ('platform:buyer_fee_revenue',   'revenue', 'Buyer Protection fees'),
  ('platform:coupon_expense',      'expense', 'Coupon discounts paid by the platform');

create table ledger_transactions (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('order_payment', 'hold_release')),
  reference_type text not null,
  reference_id   uuid not null,
  memo           text not null,
  created_at     timestamptz not null default now(),
  unique (kind, reference_id)                -- each event is posted exactly once
);
create index ledger_transactions_ref_idx on ledger_transactions (reference_type, reference_id);

create table ledger_entries (
  id             bigint generated always as identity primary key,
  transaction_id uuid not null references ledger_transactions(id),
  account_id     uuid not null references ledger_accounts(id),
  direction      text not null check (direction in ('debit', 'credit')),
  amount_paise   bigint not null check (amount_paise > 0),
  created_at     timestamptz not null default now()
);
create index ledger_entries_account_idx on ledger_entries (account_id, direction) include (amount_paise);
create index ledger_entries_tx_idx on ledger_entries (transaction_id);

create trigger ledger_transactions_append_only before update or delete on ledger_transactions
  for each row execute function reject_modification();
create trigger ledger_entries_append_only before update or delete on ledger_entries
  for each row execute function reject_modification();
create trigger ledger_transactions_no_truncate before truncate on ledger_transactions
  for each statement execute function reject_modification();
create trigger ledger_entries_no_truncate before truncate on ledger_entries
  for each statement execute function reject_modification();

-- Checked at commit: every transaction has at least two lines and debits equal credits.
create or replace function check_ledger_balanced() returns trigger language plpgsql as $$
declare d bigint; c bigint; n integer; tid uuid;
begin
  if tg_table_name = 'ledger_transactions' then tid := new.id; else tid := new.transaction_id; end if;
  select coalesce(sum(amount_paise) filter (where direction = 'debit'), 0),
         coalesce(sum(amount_paise) filter (where direction = 'credit'), 0), count(*)
    into d, c, n from ledger_entries where transaction_id = tid;
  if n < 2 or d <> c then
    raise exception 'ledger transaction % is not balanced (debits %, credits %, lines %)', tid, d, c, n using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger ledger_transactions_balanced after insert on ledger_transactions
  deferrable initially deferred for each row execute function check_ledger_balanced();
create constraint trigger ledger_entries_balanced after insert on ledger_entries
  deferrable initially deferred for each row execute function check_ledger_balanced();

insert into permissions (key, description) values
  ('admin.finance.read', 'View commission rules, the ledger and seller balances'),
  ('admin.finance.manage', 'Change commission rules and payout settings');
insert into role_permissions (role_key, permission_key) values
  ('admin', 'admin.finance.read'), ('admin', 'admin.finance.manage');
