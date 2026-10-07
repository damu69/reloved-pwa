-- 0003 catalogue: categories, brands, GST rates, products, pending revisions, variants, images.
-- Money is stored as integer paise. Prices INCLUDE GST (decided 2026-10-06); gst_rate_bp lets
-- invoices and the ledger derive the tax part later.

create table categories (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references categories(id),
  slug       text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  name       text not null check (length(name) between 1 and 80),
  path       text not null unique,  -- slugs from the root, joined by "/", e.g. women/tops
  depth      smallint not null check (depth between 0 and 4),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (parent_id, slug)
);
create unique index categories_root_slug on categories (slug) where parent_id is null;
create index categories_parent_idx on categories (parent_id, sort_order);
create index categories_path_prefix_idx on categories (path text_pattern_ops);
create trigger categories_updated before update on categories for each row execute function set_updated_at();

create table brands (
  id         uuid primary key default gen_random_uuid(),
  name       citext not null unique check (length(name) between 1 and 80),
  slug       text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger brands_updated before update on brands for each row execute function set_updated_at();

-- Allowed GST rates in basis points (1800 = 18%). Admin-maintained; confirm the list with the accountant.
create table gst_rates (
  rate_bp    integer primary key check (rate_bp between 0 and 10000),
  label      text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
insert into gst_rates (rate_bp, label) values (0, 'Nil'), (300, '3%'), (500, '5%'), (1800, '18%'), (4000, '40%');

create table products (
  id              uuid primary key default gen_random_uuid(),
  seller_id       uuid not null references sellers(id),
  status          text not null default 'draft'
                  check (status in ('draft', 'pending', 'active', 'rejected', 'archived', 'blocked')),
  title           text not null check (length(title) between 3 and 150),
  description     text not null default '' check (length(description) <= 5000),
  category_id     uuid not null references categories(id),
  brand_id        uuid references brands(id),
  condition       text not null check (condition in ('new_with_tags', 'new', 'very_good', 'good', 'satisfactory')),
  attributes      jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  gst_rate_bp     integer not null references gst_rates(rate_bp),
  hsn_code        text check (hsn_code ~ '^[0-9]{4,8}$'),
  review_note     text check (length(review_note) <= 500),
  -- Increases on every submit. The admin approves a specific submission, so content swapped in
  -- by withdraw-edit-resubmit after the admin opened it cannot be approved by accident.
  submission      integer not null default 0,
  submitted_at    timestamptz,
  approved_at     timestamptz,  -- first approval; set once, never cleared
  approved_by     uuid references users(id),
  deleted_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index products_seller_idx on products (seller_id, created_at desc, id desc) where deleted_at is null;
create index products_status_idx on products (status, submitted_at, id) where deleted_at is null;
create index products_public_idx on products (created_at desc, id desc) where status = 'active' and deleted_at is null;
create index products_category_idx on products (category_id) where status = 'active' and deleted_at is null;
create index products_brand_idx on products (brand_id) where status = 'active' and deleted_at is null;
create trigger products_updated before update on products for each row execute function set_updated_at();

-- A proposed content change to a product that is already live. The live version keeps selling
-- until an admin approves the revision. `version` increases on every edit and never repeats for a
-- product (a new revision continues from the highest earlier one), and the admin approves a specific
-- version, so a seller cannot slip in a change after the admin looked.
create table product_revisions (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id),
  data         jsonb not null check (jsonb_typeof(data) = 'object'),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'discarded')),
  version      integer not null default 1,
  review_note  text check (length(review_note) <= 500),
  created_by   uuid not null references users(id),
  reviewed_by  uuid references users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index product_revisions_one_pending on product_revisions (product_id) where status = 'pending';
create unique index product_revisions_version_unique on product_revisions (product_id, version);
create index product_revisions_queue_idx on product_revisions (created_at, id) where status = 'pending';
create trigger product_revisions_updated before update on product_revisions for each row execute function set_updated_at();

create table product_variants (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id),
  seller_id   uuid not null references sellers(id),  -- copied from the product so SKUs are unique per seller
  sku         text not null check (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  options     jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  price_paise bigint not null check (price_paise between 100 and 100000000),
  mrp_paise   bigint not null check (mrp_paise >= price_paise and mrp_paise <= 100000000),
  is_active   boolean not null default true,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index product_variants_sku_unique on product_variants (seller_id, lower(sku)) where deleted_at is null;
create unique index product_variants_options_unique on product_variants (product_id, options) where deleted_at is null;
create index product_variants_product_idx on product_variants (product_id) where deleted_at is null;
create trigger product_variants_updated before update on product_variants for each row execute function set_updated_at();

-- Image status: active (shown), pending_add (waits for revision approval), pending_remove
-- (still shown until the revision is approved), removed.
create table product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id),
  key_prefix  text not null unique,  -- files are <key_prefix>-<size>.webp
  width       integer not null check (width > 0),
  height      integer not null check (height > 0),
  bytes       integer not null check (bytes > 0),
  sort_order  integer not null default 0,
  status      text not null default 'active' check (status in ('active', 'pending_add', 'pending_remove', 'removed')),
  created_at  timestamptz not null default now()
);
create index product_images_product_idx on product_images (product_id, sort_order, created_at) where status <> 'removed';

insert into permissions (key, description) values
  ('admin.catalogue.manage', 'Manage categories, brands and GST rates'),
  ('admin.products.review',  'Approve, reject, block and unblock products and product changes');
insert into role_permissions (role_key, permission_key) values
  ('admin', 'admin.catalogue.manage'),
  ('admin', 'admin.products.review');
