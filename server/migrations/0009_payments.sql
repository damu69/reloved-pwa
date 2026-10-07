-- 0009 payments: payment attempts for orders, verified provider events (webhooks), and the
-- ledger booking for money received that cannot be applied to an order (it must be refunded).
--
-- Payment providers sit behind one interface. Only a MOCK provider exists for now; Razorpay plugs
-- in later without changing this schema. An order becomes paid ONLY through orders.confirmPayment,
-- called after the server has verified the provider's signature and the amount.

create table payments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id),
  user_id             uuid not null references users(id),
  provider            text not null check (provider in ('mock', 'razorpay')),
  provider_order_id   text not null,
  provider_payment_id text,
  amount_paise        bigint not null check (amount_paise > 0),        -- what the buyer was asked to pay
  received_paise      bigint check (received_paise > 0),               -- what the provider says was paid
  currency            text not null default 'INR' check (currency = 'INR'),
  -- created: waiting for the buyer; captured: money received and applied to the order;
  -- failed: the buyer's attempt failed (they may try again);
  -- needs_refund: money received but it cannot be applied (order cancelled first, already paid by
  -- another attempt, or the amount differs). Refunds are handled in step 11.
  status              text not null default 'created' check (status in ('created', 'captured', 'failed', 'needs_refund')),
  failure_reason      text check (length(failure_reason) <= 300),
  refund_reason       text check (length(refund_reason) <= 300),
  captured_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((status in ('captured', 'needs_refund')) = (provider_payment_id is not null and captured_at is not null and received_paise is not null)),
  check (status <> 'captured' or received_paise = amount_paise)
);
-- One provider order is one attempt; a second payment the provider accepts on the same provider
-- order (it happens) is stored as its own row, marked needs_refund.
create index payments_provider_order_idx on payments (provider, provider_order_id, created_at);
create unique index payments_provider_payment_uidx on payments (provider, provider_payment_id) where provider_payment_id is not null;
-- At most one open attempt and at most one successful payment per order.
create unique index payments_one_open_per_order on payments (order_id) where status = 'created';
create unique index payments_one_captured_per_order on payments (order_id) where status = 'captured';
create index payments_order_idx on payments (order_id, created_at);
create index payments_needs_refund_idx on payments (created_at) where status = 'needs_refund';
create trigger payments_updated before update on payments for each row execute function set_updated_at();

-- Identity and amount never change; captured and needs_refund are final here (refunds: step 11).
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
  if old.status in ('captured', 'needs_refund') and new.status <> old.status then
    raise exception 'a % payment cannot become %', old.status, new.status using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'failed' and new.status = 'created' then
    raise exception 'a failed payment cannot be reopened' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger payments_guard before update or delete on payments for each row execute function guard_payment();

-- Every verified event from a provider, stored once (the provider's event id is the key), with what
-- we did about it. Events with a bad signature are never stored.
create table payment_events (
  id           bigint generated always as identity primary key,
  provider     text not null check (provider in ('mock', 'razorpay')),
  event_id     text not null check (length(event_id) between 1 and 100),
  type         text not null check (length(type) <= 60),
  payment_id   uuid references payments(id),
  payload      jsonb not null,
  outcome      text not null check (length(outcome) <= 60),
  received_at  timestamptz not null default now(),
  unique (provider, event_id)
);
create index payment_events_payment_idx on payment_events (payment_id);
create trigger payment_events_append_only before update or delete on payment_events
  for each row execute function reject_modification();
create trigger payment_events_no_truncate before truncate on payment_events
  for each statement execute function reject_modification();

-- Money received that must go back to the buyer.
insert into ledger_accounts (code, kind, name) values
  ('platform:refunds_payable', 'liability', 'Payments received that must be refunded to buyers');
alter table ledger_transactions drop constraint ledger_transactions_kind_check;
alter table ledger_transactions add constraint ledger_transactions_kind_check
  check (kind in ('order_payment', 'hold_release', 'unapplied_payment'));

insert into permissions (key, description) values
  ('admin.payments.read', 'View payment attempts, provider events and payments that need a refund');
insert into role_permissions (role_key, permission_key) values ('admin', 'admin.payments.read');
