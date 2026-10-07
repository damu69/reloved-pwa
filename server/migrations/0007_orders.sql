-- 0007 orders: addresses, customer orders, one seller order per seller, frozen order items,
-- append-only status history, coupon redemptions, and an outbox for notifications.
--
-- Everything the buyer pays is copied onto the order at checkout (prices, discounts, GST,
-- delivery, fees, address), so later product, price or fee changes never alter an order.

create table addresses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  name        text not null check (length(name) between 2 and 80),
  phone       text not null check (phone ~ '^\+?[0-9]{10,15}$'),
  line1       text not null check (length(line1) between 3 and 200),
  line2       text check (length(line2) <= 200),
  landmark    text check (length(landmark) <= 100),
  city        text not null check (length(city) between 2 and 80),
  state       text not null check (length(state) between 2 and 80),
  pincode     text not null check (pincode ~ '^[1-9][0-9]{5}$'),
  is_default  boolean not null default false,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index addresses_user_idx on addresses (user_id) where deleted_at is null;
create unique index addresses_one_default on addresses (user_id) where is_default and deleted_at is null;
create trigger addresses_updated before update on addresses for each row execute function set_updated_at();

create sequence order_number_seq start 1000001;

create table orders (
  id                   uuid primary key default gen_random_uuid(),
  number               text not null unique,                     -- e.g. RL1000001, shown to customers
  user_id              uuid not null references users(id),
  status               text not null default 'pending_payment' check (status in (
                         'pending_payment', 'confirmed', 'processing', 'partially_shipped', 'shipped',
                         'partially_delivered', 'delivered', 'cancelled')),
  payment_status       text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'refunded', 'partially_refunded')),
  currency             text not null default 'INR' check (currency = 'INR'),
  items_subtotal_paise bigint not null check (items_subtotal_paise >= 0),
  discount_paise       bigint not null check (discount_paise >= 0),
  items_net_paise      bigint not null check (items_net_paise >= 0),
  delivery_paise       bigint not null check (delivery_paise >= 0),
  buyer_fee_paise      bigint not null check (buyer_fee_paise >= 0),
  total_paise          bigint not null check (total_paise >= 0),
  gst_included_paise   bigint not null check (gst_included_paise >= 0),
  buyer_fee_fixed_paise integer not null,                         -- the fee rule in force at checkout
  buyer_fee_bp         integer not null,
  coupon_id            uuid references coupons(id),
  coupon_code          text,
  shipping_address     jsonb not null,                           -- copy, not a reference
  idempotency_key      text not null check (length(idempotency_key) between 8 and 100),
  request_hash         text not null,
  expires_at           timestamptz not null,                     -- unpaid orders are cancelled after this
  placed_at            timestamptz not null default now(),
  paid_at              timestamptz,
  cancelled_at         timestamptz,
  cancel_reason        text check (length(cancel_reason) <= 300),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (user_id, idempotency_key),
  check (items_subtotal_paise - discount_paise = items_net_paise),
  check (items_net_paise + delivery_paise + buyer_fee_paise = total_paise)
);
-- At most one unpaid order per customer at a time.
create unique index orders_one_pending_per_user on orders (user_id) where status = 'pending_payment';
create index orders_user_idx on orders (user_id, placed_at desc, id desc);
create index orders_status_idx on orders (status, placed_at desc, id desc);
create index orders_pending_expiry_idx on orders (expires_at) where status = 'pending_payment';
create trigger orders_updated before update on orders for each row execute function set_updated_at();

create table seller_orders (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references orders(id),
  seller_id          uuid not null references sellers(id),
  number             text not null unique,                       -- e.g. RL1000001-1
  status             text not null default 'pending_payment' check (status in (
                       'pending_payment', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled')),
  items_subtotal_paise bigint not null check (items_subtotal_paise >= 0),
  discount_paise     bigint not null check (discount_paise >= 0),
  items_net_paise    bigint not null check (items_net_paise >= 0),
  delivery_code      text not null,
  delivery_label     text not null,
  delivery_paise     bigint not null check (delivery_paise >= 0),
  carrier            text check (length(carrier) <= 60),
  tracking_number    text check (length(tracking_number) <= 60),
  confirmed_at       timestamptz,
  shipped_at         timestamptz,
  delivered_at       timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text check (length(cancel_reason) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (order_id, seller_id),
  check (items_subtotal_paise - discount_paise = items_net_paise)
);
create index seller_orders_seller_idx on seller_orders (seller_id, created_at desc, id desc);
create index seller_orders_seller_status_idx on seller_orders (seller_id, status, created_at desc);
create trigger seller_orders_updated before update on seller_orders for each row execute function set_updated_at();

create table order_items (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references orders(id),
  seller_order_id    uuid not null references seller_orders(id),
  variant_id         uuid not null references product_variants(id),
  product_id         uuid not null references products(id),
  warehouse_id       uuid not null references warehouses(id),
  reservation_id     uuid not null unique references stock_reservations(id),
  title              text not null,
  sku                text not null,
  options            jsonb not null,
  unit_price_paise   bigint not null check (unit_price_paise > 0),
  quantity           integer not null check (quantity between 1 and 1000),
  subtotal_paise     bigint not null,
  discount_paise     bigint not null check (discount_paise >= 0),
  net_paise          bigint not null check (net_paise >= 0),
  gst_rate_bp        integer not null,
  gst_included_paise bigint not null check (gst_included_paise >= 0),
  created_at         timestamptz not null default now(),
  check (unit_price_paise * quantity = subtotal_paise),
  check (subtotal_paise - discount_paise = net_paise)
);
create index order_items_order_idx on order_items (order_id);
create index order_items_seller_order_idx on order_items (seller_order_id);

-- Order lines and money never change after checkout.
create or replace function reject_money_change() returns trigger language plpgsql as $$
begin
  raise exception 'order items cannot be changed or deleted' using errcode = 'insufficient_privilege';
end $$;
create trigger order_items_immutable before update or delete on order_items for each row execute function reject_money_change();
create or replace function guard_order_money() returns trigger language plpgsql as $$
begin
  if (new.items_subtotal_paise, new.discount_paise, new.items_net_paise, new.delivery_paise, new.buyer_fee_paise, new.total_paise,
      new.gst_included_paise, new.coupon_id, new.coupon_code, new.buyer_fee_fixed_paise, new.buyer_fee_bp, new.user_id, new.number,
      new.shipping_address, new.idempotency_key, new.request_hash, new.placed_at, new.currency)
     is distinct from
     (old.items_subtotal_paise, old.discount_paise, old.items_net_paise, old.delivery_paise, old.buyer_fee_paise, old.total_paise,
      old.gst_included_paise, old.coupon_id, old.coupon_code, old.buyer_fee_fixed_paise, old.buyer_fee_bp, old.user_id, old.number,
      old.shipping_address, old.idempotency_key, old.request_hash, old.placed_at, old.currency) then
    raise exception 'order amounts and identity cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  -- A paid order never becomes unpaid again (refunds set refunded / partially_refunded), the payment
  -- time is set once, and no order goes back to waiting for payment.
  if old.payment_status <> 'unpaid' and new.payment_status = 'unpaid' then
    raise exception 'a paid order cannot become unpaid' using errcode = 'insufficient_privilege';
  end if;
  if old.paid_at is not null and new.paid_at is distinct from old.paid_at then
    raise exception 'the payment time cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  if old.status <> 'pending_payment' and new.status = 'pending_payment' then
    raise exception 'an order cannot go back to waiting for payment' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger orders_money_guard before update on orders for each row execute function guard_order_money();
create or replace function guard_seller_order_money() returns trigger language plpgsql as $$
begin
  if (new.items_subtotal_paise, new.discount_paise, new.items_net_paise, new.delivery_paise, new.order_id, new.seller_id,
      new.delivery_code, new.delivery_label, new.number)
     is distinct from (old.items_subtotal_paise, old.discount_paise, old.items_net_paise, old.delivery_paise, old.order_id, old.seller_id,
      old.delivery_code, old.delivery_label, old.number) then
    raise exception 'seller order amounts cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger seller_orders_money_guard before update on seller_orders for each row execute function guard_seller_order_money();

-- Every status change of a seller order, with who did it and why. Append-only.
create table seller_order_events (
  id              bigint generated always as identity primary key,
  seller_order_id uuid not null references seller_orders(id),
  from_status     text,
  to_status       text not null,
  actor_id        uuid references users(id),        -- null = the system (expiry, payment)
  actor_role      text not null check (actor_role in ('customer', 'seller', 'admin', 'system')),
  reason          text check (length(reason) <= 300),
  created_at      timestamptz not null default now()
);
create index seller_order_events_idx on seller_order_events (seller_order_id, id);
create trigger seller_order_events_append_only before update or delete on seller_order_events
  for each row execute function reject_modification();

create table coupon_redemptions (
  id             uuid primary key default gen_random_uuid(),
  coupon_id      uuid not null references coupons(id),
  order_id       uuid not null unique references orders(id),
  user_id        uuid not null references users(id),
  discount_paise bigint not null check (discount_paise >= 0),
  status         text not null default 'reserved' check (status in ('reserved', 'confirmed', 'released')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index coupon_redemptions_user_idx on coupon_redemptions (coupon_id, user_id) where status <> 'released';
create or replace function guard_redemption() returns trigger language plpgsql as $$
begin
  if (new.coupon_id, new.order_id, new.user_id, new.discount_paise) is distinct from (old.coupon_id, old.order_id, old.user_id, old.discount_paise) then
    raise exception 'coupon redemption amounts cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger coupon_redemptions_guard before update on coupon_redemptions for each row execute function guard_redemption();
create trigger coupon_redemptions_updated before update on coupon_redemptions for each row execute function set_updated_at();

-- Events written in the same transaction as the change that caused them. The notification module
-- (step 12) reads and delivers them; a slow or failing provider can never affect an order.
create table outbox_events (
  id            bigint generated always as identity primary key,
  type          text not null check (type ~ '^[a-z_]+\.[a-z_]+$'),
  aggregate     text not null,
  aggregate_id  text not null,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz,
  attempts      integer not null default 0
);
create index outbox_unprocessed_idx on outbox_events (id) where processed_at is null;

insert into permissions (key, description) values
  ('admin.orders.read', 'View all orders'),
  ('admin.orders.manage', 'Change order and package status on behalf of sellers or customers');
insert into role_permissions (role_key, permission_key) values
  ('admin', 'admin.orders.read'), ('admin', 'admin.orders.manage');
