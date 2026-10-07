-- 0005 inventory: warehouses, stock levels, reservations, append-only stock movements.
--
-- Counters per variant and warehouse:
--   on_hand   units physically in the warehouse and sellable (includes reserved units)
--   reserved  units held for checkouts that are not paid yet
--   sold      units sold (net of cancellations and returns), cumulative
--   returned  units returned in good condition, waiting to be put back into stock
--   damaged   units returned or found damaged; not sellable
-- Available to buy = on_hand - reserved. It is computed, never stored, so it cannot drift.

create table warehouses (
  id          uuid primary key default gen_random_uuid(),
  seller_id   uuid not null references sellers(id),
  name        text not null check (length(name) between 2 and 80),
  pincode     text not null check (pincode ~ '^[1-9][0-9]{5}$'),
  city        text check (length(city) <= 80),
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (seller_id, name)
);
create unique index warehouses_one_default on warehouses (seller_id) where is_default;
create trigger warehouses_updated before update on warehouses for each row execute function set_updated_at();

create table inventory_levels (
  variant_id          uuid not null references product_variants(id),
  warehouse_id        uuid not null references warehouses(id),
  on_hand             integer not null default 0,
  reserved            integer not null default 0,
  sold                integer not null default 0,
  returned            integer not null default 0,
  damaged             integer not null default 0,
  low_stock_threshold integer not null default 2 check (low_stock_threshold between 0 and 100000),
  updated_at          timestamptz not null default now(),
  primary key (variant_id, warehouse_id),
  -- The database itself refuses negative stock and over-reservation, whatever the code does.
  constraint inventory_non_negative check (on_hand >= 0 and reserved >= 0 and sold >= 0 and returned >= 0 and damaged >= 0),
  constraint inventory_reserved_within_on_hand check (reserved <= on_hand),
  constraint inventory_sane_size check (on_hand <= 1000000)
);
create index inventory_levels_warehouse_idx on inventory_levels (warehouse_id);

-- A seller's stock can only sit in that seller's own warehouse.
create or replace function check_inventory_owner() returns trigger language plpgsql as $$
begin
  if (select seller_id from warehouses where id = new.warehouse_id) is distinct from
     (select seller_id from product_variants where id = new.variant_id) then
    raise exception 'warehouse and variant belong to different sellers';
  end if;
  return new;
end $$;
create trigger inventory_levels_owner before insert or update of variant_id, warehouse_id on inventory_levels
  for each row execute function check_inventory_owner();
create trigger inventory_levels_updated before update on inventory_levels for each row execute function set_updated_at();

create table stock_reservations (
  id             uuid primary key default gen_random_uuid(),
  variant_id     uuid not null references product_variants(id),
  warehouse_id   uuid not null references warehouses(id),
  quantity       integer not null check (quantity between 1 and 1000),
  status         text not null default 'active' check (status in ('active', 'converted', 'released', 'expired')),
  owner_user_id  uuid not null references users(id),
  reference_type text not null check (reference_type ~ '^[a-z_]{2,30}$'),  -- e.g. checkout, order
  reference_id   text not null check (length(reference_id) between 1 and 100),
  expires_at     timestamptz not null,
  closed_at      timestamptz,
  created_at     timestamptz not null default now()
);
-- One live reservation per variant per checkout: retrying a checkout cannot hold stock twice.
create unique index stock_reservations_one_per_reference on stock_reservations (reference_type, reference_id, variant_id)
  where status in ('active', 'converted');
create index stock_reservations_expiry_idx on stock_reservations (expires_at) where status = 'active';
create index stock_reservations_variant_idx on stock_reservations (variant_id, created_at desc);

create table stock_movements (
  id              bigint generated always as identity primary key,
  variant_id      uuid not null references product_variants(id),
  warehouse_id    uuid not null references warehouses(id),
  reason          text not null check (reason in (
                    'restock', 'correction', 'damage', 'loss', 'reserve', 'release', 'expire', 'sale',
                    'cancel_sale', 'return_received', 'return_damaged', 'return_restocked', 'admin_adjustment')),
  d_on_hand       integer not null default 0,
  d_reserved      integer not null default 0,
  d_sold          integer not null default 0,
  d_returned      integer not null default 0,
  d_damaged       integer not null default 0,
  on_hand_after   integer not null,
  reserved_after  integer not null,
  reference_type  text,
  reference_id    text,
  actor_id        uuid references users(id),
  note            text check (length(note) <= 300),
  created_at      timestamptz not null default now()
);
create index stock_movements_variant_idx on stock_movements (variant_id, created_at desc, id desc);
create trigger stock_movements_append_only before update or delete on stock_movements
  for each row execute function reject_modification();
create trigger stock_movements_no_truncate before truncate on stock_movements
  for each statement execute function reject_modification();

insert into permissions (key, description) values
  ('admin.inventory.manage', 'View stock movements and adjust any seller''s stock (audited)');
insert into role_permissions (role_key, permission_key) values ('admin', 'admin.inventory.manage');

-- ---------- search: availability ----------
alter table product_search add column in_stock boolean not null default false;
create index product_search_in_stock_newest_idx on product_search (created_at desc, product_id desc) where is_listed and in_stock;

-- Rebuilt with stock: `in_stock` when any active variant has available units, and the "from" price
-- is the cheapest variant that can actually be bought (falling back to the cheapest overall).
create or replace function refresh_product_search_many(pids uuid[]) returns void language sql as $$
  insert into product_search as ps (product_id, is_listed, seller_id, seller_name, category_id, category_path, brand_id, brand_slug,
                                    brand_name, title, title_lower, condition, min_price_paise, cover_image_id, document, created_at,
                                    in_stock, refreshed_at)
  select pr.id,
         pr.status = 'active' and pr.deleted_at is null and v.minp is not null,
         pr.seller_id, s.display_name::text, pr.category_id, c.path, pr.brand_id, b.slug, b.name::text,
         pr.title, lower(pr.title), pr.condition, coalesce(v.minp_in_stock, v.minp), img.id,
         setweight(to_tsvector('simple', search_norm(pr.title || ' ' || coalesce(v.skus, ''))), 'A') ||
         setweight(to_tsvector('simple', search_norm(coalesce(b.name::text, '') || ' ' || c.name)), 'B') ||
         setweight(to_tsvector('simple', search_norm(coalesce((select string_agg(value, ' ') from jsonb_each_text(pr.attributes)), '') || ' ' || s.display_name)), 'C') ||
         setweight(to_tsvector('simple', search_norm(pr.description)), 'D'),
         pr.created_at, v.minp_in_stock is not null, now()
    from products pr
    join sellers s on s.id = pr.seller_id
    join categories c on c.id = pr.category_id
    left join brands b on b.id = pr.brand_id
    left join lateral (
      select string_agg(pv.sku, ' ') as skus, min(pv.price_paise) as minp,
             min(pv.price_paise) filter (where exists (
               select 1 from inventory_levels il join warehouses w on w.id = il.warehouse_id
                where il.variant_id = pv.id and w.is_active and il.on_hand - il.reserved > 0)) as minp_in_stock
        from product_variants pv where pv.product_id = pr.id and pv.is_active and pv.deleted_at is null
    ) v on true
    left join lateral (
      select id from product_images where product_id = pr.id and status in ('active', 'pending_remove')
       order by sort_order, created_at limit 1
    ) img on true
   where pr.id = any(pids)
  on conflict (product_id) do update set
    is_listed = excluded.is_listed, seller_id = excluded.seller_id, seller_name = excluded.seller_name,
    category_id = excluded.category_id, category_path = excluded.category_path, brand_id = excluded.brand_id,
    brand_slug = excluded.brand_slug, brand_name = excluded.brand_name, title = excluded.title,
    title_lower = excluded.title_lower, condition = excluded.condition, min_price_paise = excluded.min_price_paise,
    cover_image_id = excluded.cover_image_id, document = excluded.document, created_at = excluded.created_at,
    in_stock = excluded.in_stock, refreshed_at = now()
$$;

-- Refresh search when a variant's available quantity changes (inside the stock transaction,
-- under the per-product lock, so search always matches real stock).
create or replace function trg_search_inventory() returns trigger language plpgsql as $$
declare pid uuid;
begin
  select product_id into pid from product_variants where id = coalesce(new.variant_id, old.variant_id);
  if pid is not null then perform refresh_product_search(pid); end if;
  return null;
end $$;
create trigger inventory_levels_search after insert or delete on inventory_levels for each row execute function trg_search_inventory();
create trigger inventory_levels_search_update after update on inventory_levels
  for each row when ((old.on_hand - old.reserved) is distinct from (new.on_hand - new.reserved))
  execute function trg_search_inventory();

-- Changes that touch many products at once (a warehouse switched off or on, a seller, category or
-- brand renamed) are queued and refreshed one product at a time under the same per-product lock,
-- right after the change commits and by the background sweep. A set-based rebuild from one
-- snapshot could write back stale stock or prices, and locking thousands of products in one
-- transaction would exhaust the database's lock table.
create table search_refresh_queue (
  product_id uuid primary key references products(id),
  queued_at  timestamptz not null default now()
);

create or replace function trg_search_warehouse() returns trigger language plpgsql as $$
begin
  insert into search_refresh_queue (product_id)
    select distinct pv.product_id from inventory_levels il join product_variants pv on pv.id = il.variant_id where il.warehouse_id = new.id
  on conflict do nothing;
  return null;
end $$;
create trigger warehouses_search after update of is_active on warehouses
  for each row when (old.is_active is distinct from new.is_active) execute function trg_search_warehouse();

create or replace function trg_search_seller() returns trigger language plpgsql as $$
begin
  insert into search_refresh_queue (product_id) select id from products where seller_id = new.id on conflict do nothing;
  return null;
end $$;
create or replace function trg_search_category() returns trigger language plpgsql as $$
begin
  insert into search_refresh_queue (product_id) select id from products where category_id = new.id on conflict do nothing;
  return null;
end $$;
create or replace function trg_search_brand() returns trigger language plpgsql as $$
begin
  insert into search_refresh_queue (product_id) select id from products where brand_id = new.id on conflict do nothing;
  return null;
end $$;

select refresh_product_search_many(array(select id from products order by id));
