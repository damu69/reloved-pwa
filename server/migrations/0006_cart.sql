-- 0006 cart: pricing settings, delivery options, coupons, carts, wishlists.
-- Carts store quantities only; prices are always read live and computed on the server.

-- One row of marketplace pricing settings, edited by admins (audited).
create table pricing_settings (
  id                    boolean primary key default true check (id),
  buyer_fee_fixed_paise integer not null check (buyer_fee_fixed_paise between 0 and 100000),
  buyer_fee_bp          integer not null check (buyer_fee_bp between 0 and 2000),
  max_cart_lines        integer not null default 50 check (max_cart_lines between 1 and 200),
  max_line_quantity     integer not null default 10 check (max_line_quantity between 1 and 1000),
  updated_by            uuid references users(id),
  updated_at            timestamptz not null default now()
);
-- Decided 2026-10-07: Buyer Protection ₹15 + 5% of the item total after discount, once per order.
insert into pricing_settings (buyer_fee_fixed_paise, buyer_fee_bp) values (1500, 500);

-- Delivery is charged per seller package (decided 2026-10-07).
create table delivery_options (
  code       text primary key check (code ~ '^[a-z_]{2,20}$'),
  label      text not null check (length(label) between 2 and 60),
  fee_paise  integer not null check (fee_paise between 0 and 1000000),
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);
insert into delivery_options (code, label, fee_paise, sort_order) values
  ('home', 'Home delivery', 9900, 1), ('pickup', 'Pickup point', 5900, 2), ('meet', 'Meet and collect', 0, 3);
create trigger delivery_options_updated before update on delivery_options for each row execute function set_updated_at();

-- Coupons are created by admins and paid for by the platform (decided 2026-10-07). One per order.
create table coupons (
  id                 uuid primary key default gen_random_uuid(),
  code               citext not null unique check (code ~ '^[A-Za-z0-9]{4,20}$'),
  description        text not null default '' check (length(description) <= 200),
  discount_type      text not null check (discount_type in ('percent', 'fixed')),
  percent_bp         integer check (percent_bp between 1 and 9000),
  amount_paise       integer check (amount_paise between 100 and 10000000),
  max_discount_paise integer check (max_discount_paise between 100 and 10000000),
  min_order_paise    integer not null default 0 check (min_order_paise between 0 and 100000000),
  scope_all          boolean not null default true,
  starts_at          timestamptz not null default now(),
  ends_at            timestamptz,
  usage_limit        integer check (usage_limit between 1 and 10000000),  -- null = unlimited
  per_user_limit     integer not null default 1 check (per_user_limit between 1 and 1000),
  first_order_only   boolean not null default false,
  used_count         integer not null default 0 check (used_count >= 0),
  is_active          boolean not null default true,
  created_by         uuid not null references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((discount_type = 'percent' and percent_bp is not null and amount_paise is null)
      or (discount_type = 'fixed' and amount_paise is not null and percent_bp is null and max_discount_paise is null)),
  check (ends_at is null or ends_at > starts_at),
  check (usage_limit is null or used_count <= usage_limit)
);
create trigger coupons_updated before update on coupons for each row execute function set_updated_at();

create table coupon_categories (
  coupon_id   uuid not null references coupons(id) on delete cascade,
  category_id uuid not null references categories(id),
  primary key (coupon_id, category_id)
);
create table coupon_sellers (
  coupon_id uuid not null references coupons(id) on delete cascade,
  seller_id uuid not null references sellers(id),
  primary key (coupon_id, seller_id)
);

create table carts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references users(id),
  coupon_id  uuid references coupons(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger carts_updated before update on carts for each row execute function set_updated_at();

create table cart_items (
  cart_id            uuid not null references carts(id) on delete cascade,
  variant_id         uuid not null references product_variants(id),
  quantity           integer not null check (quantity between 1 and 1000),
  price_at_add_paise bigint not null,  -- only to tell the buyer a price changed; never used to charge
  added_at           timestamptz not null default now(),
  primary key (cart_id, variant_id)
);

-- The buyer's delivery choice for each seller package in the cart.
create table cart_delivery (
  cart_id       uuid not null references carts(id) on delete cascade,
  seller_id     uuid not null references sellers(id),
  delivery_code text not null references delivery_options(code),
  primary key (cart_id, seller_id)
);

create table wishlists (
  user_id    uuid not null references users(id),
  product_id uuid not null references products(id),
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);
create index wishlists_user_idx on wishlists (user_id, created_at desc);

insert into permissions (key, description) values
  ('admin.coupons.manage', 'Create, change and switch off coupons'),
  ('admin.pricing.manage', 'Change Buyer Protection and delivery fees');
insert into role_permissions (role_key, permission_key) values
  ('admin', 'admin.coupons.manage'), ('admin', 'admin.pricing.manage');
