-- 0010 refunds, returns and cancelling paid packages.
--
-- Rules decided by the owner (2026-10-07):
--  - The buyer can cancel a paid package until it ships. The delivery fee is refunded then.
--  - Returns: within 7 days of delivery, only for a damaged or fake item (nothing about size: it is
--    thrift). The seller decides first (3 days; silence = accepted); a rejected buyer can ask an
--    admin, whose decision is final. Photos are required.
--  - The buyer ships the item back; the return shipping is refunded to the buyer at the Home
--    delivery rate (₹99) and charged to the seller. The original delivery fee is not refunded.
--  - Buyer Protection is refunded in proportion to the value refunded.
--  - Commission is never given back to the seller; the platform bears it.
--
-- Defaults chosen here (pending the owner's confirmation): sellers and admins can also cancel a
-- package before it ships; a return covers whole order lines; a coupon use is not given back; the
-- buyer has 7 days to ship an approved return and the seller 7 days to confirm receipt (otherwise it
-- is treated as received, not resellable).

alter table finance_settings
  add column return_window_days    integer not null default 7 check (return_window_days between 1 and 30),
  add column seller_decision_days  integer not null default 3 check (seller_decision_days between 1 and 14),
  add column escalation_days       integer not null default 3 check (escalation_days between 1 and 14),
  add column return_ship_days      integer not null default 7 check (return_ship_days between 1 and 30),
  add column return_receipt_days   integer not null default 7 check (return_receipt_days between 1 and 30),
  add column return_shipping_paise bigint  not null default 9900 check (return_shipping_paise between 0 and 100000);

-- ---------------- returns ----------------

create table returns (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id),
  seller_order_id       uuid not null references seller_orders(id),
  user_id               uuid not null references users(id),
  seller_id             uuid not null references sellers(id),
  reason                text not null check (reason in ('damaged', 'fake')),
  description           text not null check (length(description) between 10 and 1000),
  status                text not null default 'requested' check (status in (
                          'requested', 'approved', 'rejected', 'disputed', 'shipped_back', 'received', 'refunded', 'closed', 'withdrawn')),
  seller_decide_by      timestamptz not null,
  rejection_reason      text check (length(rejection_reason) <= 500),
  escalate_by           timestamptz,
  escalation_note       text check (length(escalation_note) <= 1000),
  admin_note            text check (length(admin_note) <= 500),
  ship_by               timestamptz,
  carrier               text check (length(carrier) <= 60),
  tracking_number       text check (length(tracking_number) <= 60),
  shipped_back_at       timestamptz,
  receive_by            timestamptz,
  received_at           timestamptz,
  received_condition    text check (received_condition in ('good', 'damaged')),
  return_shipping_paise bigint not null check (return_shipping_paise >= 0),   -- frozen when requested
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index returns_user_idx on returns (user_id, created_at desc, id desc);
create index returns_seller_idx on returns (seller_id, status, created_at desc, id desc);
create index returns_status_idx on returns (status, created_at desc, id desc);
create index returns_seller_order_idx on returns (seller_order_id);
create trigger returns_updated before update on returns for each row execute function set_updated_at();
create or replace function guard_return() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'returns cannot be deleted' using errcode = 'insufficient_privilege'; end if;
  if (new.order_id, new.seller_order_id, new.user_id, new.seller_id, new.reason, new.description, new.return_shipping_paise, new.created_at)
     is distinct from (old.order_id, old.seller_order_id, old.user_id, old.seller_id, old.reason, old.description, old.return_shipping_paise, old.created_at) then
    raise exception 'a return request cannot be rewritten' using errcode = 'insufficient_privilege';
  end if;
  if old.status in ('refunded', 'closed', 'withdrawn') and new.status <> old.status then
    raise exception 'a % return is final', old.status using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger returns_guard before update or delete on returns for each row execute function guard_return();

create table return_items (
  return_id     uuid not null references returns(id),
  order_item_id uuid not null references order_items(id),
  primary key (return_id, order_item_id)
);
create index return_items_item_idx on return_items (order_item_id);
create trigger return_items_append_only before update or delete on return_items for each row execute function reject_modification();

-- Photos are uploaded first (owned by the buyer), then attached to one return.
create table return_photos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id),
  return_id  uuid references returns(id),
  key        text not null unique,
  bytes      integer not null,
  created_at timestamptz not null default now()
);
create index return_photos_user_idx on return_photos (user_id) where return_id is null;
create index return_photos_return_idx on return_photos (return_id);

create table return_events (
  id          bigint generated always as identity primary key,
  return_id   uuid not null references returns(id),
  from_status text,
  to_status   text not null,
  actor_id    uuid references users(id),
  actor_role  text not null check (actor_role in ('customer', 'seller', 'admin', 'system')),
  note        text check (length(note) <= 1000),
  created_at  timestamptz not null default now()
);
create index return_events_idx on return_events (return_id, id);
create trigger return_events_append_only before update or delete on return_events for each row execute function reject_modification();

-- ---------------- refunds ----------------

create table refunds (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id),
  payment_id            uuid not null references payments(id),
  seller_order_id       uuid references seller_orders(id),
  return_id             uuid unique references returns(id),
  kind                  text not null check (kind in ('cancellation', 'return', 'unapplied_payment')),
  items_paise           bigint not null default 0 check (items_paise >= 0),          -- what the buyer paid for the lines
  buyer_fee_paise       bigint not null default 0 check (buyer_fee_paise >= 0),      -- share of Buyer Protection
  delivery_paise        bigint not null default 0 check (delivery_paise >= 0),       -- cancellations only
  return_shipping_paise bigint not null default 0 check (return_shipping_paise >= 0),-- returns only
  other_paise           bigint not null default 0 check (other_paise >= 0),          -- unapplied payments
  amount_paise          bigint not null check (amount_paise > 0),
  seller_debit_paise    bigint not null default 0 check (seller_debit_paise >= 0),   -- taken back from the seller
  seller_account        text check (seller_account in ('pending', 'available')),
  reason                text not null check (length(reason) between 3 and 500),
  status                text not null default 'pending' check (status in ('pending', 'processed')),
  provider_refund_id    text,
  attempts              integer not null default 0,
  next_attempt_at       timestamptz not null default now(),                       -- retry back-off
  last_error            text check (length(last_error) <= 500),
  requested_by          uuid references users(id),
  created_at            timestamptz not null default now(),
  processed_at          timestamptz,
  updated_at            timestamptz not null default now(),
  check (amount_paise = items_paise + buyer_fee_paise + delivery_paise + return_shipping_paise + other_paise),
  check ((status = 'processed') = (processed_at is not null and provider_refund_id is not null)),
  check ((kind = 'unapplied_payment') = (seller_order_id is null)),
  check ((kind = 'return') = (return_id is not null)),
  check ((seller_debit_paise > 0) <= (seller_account is not null))
);
-- One cancellation refund per package, one refund per payment that could not be applied.
create unique index refunds_one_cancellation on refunds (seller_order_id) where kind = 'cancellation';
create unique index refunds_one_unapplied on refunds (payment_id) where kind = 'unapplied_payment';
create index refunds_pending_idx on refunds (next_attempt_at) where status = 'pending';
create index refunds_order_idx on refunds (order_id);
create trigger refunds_updated before update on refunds for each row execute function set_updated_at();
create or replace function guard_refund() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'refunds cannot be deleted' using errcode = 'insufficient_privilege'; end if;
  if (new.order_id, new.payment_id, new.seller_order_id, new.return_id, new.kind, new.items_paise, new.buyer_fee_paise, new.delivery_paise,
      new.return_shipping_paise, new.other_paise, new.amount_paise, new.seller_debit_paise, new.seller_account, new.reason, new.created_at)
     is distinct from (old.order_id, old.payment_id, old.seller_order_id, old.return_id, old.kind, old.items_paise, old.buyer_fee_paise, old.delivery_paise,
      old.return_shipping_paise, old.other_paise, old.amount_paise, old.seller_debit_paise, old.seller_account, old.reason, old.created_at) then
    raise exception 'refund amounts cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'processed' and (new.status <> 'processed' or new.provider_refund_id is distinct from old.provider_refund_id) then
    raise exception 'a processed refund is final' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger refunds_guard before update or delete on refunds for each row execute function guard_refund();

-- Each order line is refunded at most once, whatever the route (cancellation or return).
create table refund_items (
  refund_id        uuid not null references refunds(id),
  order_item_id    uuid not null unique references order_items(id),
  net_paise        bigint not null check (net_paise >= 0),
  discount_paise   bigint not null check (discount_paise >= 0),
  commission_paise bigint not null check (commission_paise >= 0),
  buyer_fee_paise  bigint not null check (buyer_fee_paise >= 0),
  primary key (refund_id, order_item_id)
);
create trigger refund_items_append_only before update or delete on refund_items for each row execute function reject_modification();

-- ---------------- payments and ledger ----------------

alter table payments drop constraint payments_status_check;
alter table payments add constraint payments_status_check check (status in ('created', 'captured', 'failed', 'needs_refund', 'refunded'));
alter table payments drop constraint payments_check;
alter table payments add constraint payments_check
  check ((status in ('captured', 'needs_refund', 'refunded')) = (provider_payment_id is not null and captured_at is not null and received_paise is not null));
create or replace function guard_payment() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payments cannot be deleted' using errcode = 'insufficient_privilege';
  end if;
  if (new.order_id, new.user_id, new.provider, new.provider_order_id, new.amount_paise, new.currency, new.created_at)
     is distinct from (old.order_id, old.user_id, old.provider, old.provider_order_id, old.amount_paise, old.currency, old.created_at)
     or (old.received_paise is not null and new.received_paise is distinct from old.received_paise) then
    raise exception 'payment identity and amount cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  if old.provider_payment_id is not null and new.provider_payment_id is distinct from old.provider_payment_id then
    raise exception 'the provider payment id cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  -- captured stays captured (partial refunds are tracked in refunds); needs_refund may only become refunded.
  if old.status in ('captured', 'refunded') and new.status <> old.status then
    raise exception 'a % payment cannot become %', old.status, new.status using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'needs_refund' and new.status not in ('needs_refund', 'refunded') then
    raise exception 'a needs_refund payment cannot become %', new.status using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'failed' and new.status = 'created' then
    raise exception 'a failed payment cannot be reopened' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

insert into ledger_accounts (code, kind, name) values
  ('platform:refund_commission_expense', 'expense', 'Commission kept from sellers on refunded items, borne by the platform');
alter table ledger_transactions drop constraint ledger_transactions_kind_check;
alter table ledger_transactions add constraint ledger_transactions_kind_check
  check (kind in ('order_payment', 'hold_release', 'unapplied_payment', 'refund_due', 'refund_paid'));

insert into permissions (key, description) values
  ('admin.returns.manage', 'View and decide return requests, cancel packages for customers or sellers'),
  ('admin.refunds.manage', 'View refunds, retry them, and refund payments that could not be applied');
insert into role_permissions (role_key, permission_key) values
  ('admin', 'admin.returns.manage'), ('admin', 'admin.refunds.manage');
