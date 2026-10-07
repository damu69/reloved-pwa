-- 0004 search: one row per product with everything search and listing pages need.
-- Kept current by triggers on the source tables, so search never reads stale prices or shows
-- hidden products. The same rows can later be shipped to a dedicated search engine.

create extension if not exists pg_trgm;

-- Seller approval and category status are NOT copied here: search joins sellers and categories
-- live, so suspending a seller or hiding a category takes effect at once, with no bulk update and
-- no chance of a concurrent edit writing an old value back.
create table product_search (
  product_id      uuid primary key references products(id),
  is_listed       boolean not null,  -- product-level: active, not deleted, has an active variant
  seller_id       uuid not null references sellers(id),
  seller_name     text not null,
  category_id     uuid not null references categories(id),
  category_path   text not null,
  brand_id        uuid,
  brand_slug      text,
  brand_name      text,
  title           text not null,
  title_lower     text not null,
  condition       text not null,
  min_price_paise bigint,          -- cheapest active variant; null when none
  cover_image_id  uuid,
  document        tsvector not null,
  created_at      timestamptz not null,
  refreshed_at    timestamptz not null default now()
);
create index product_search_document_idx on product_search using gin (document) where is_listed;
create index product_search_title_trgm_idx on product_search using gin (title_lower gin_trgm_ops) where is_listed;
create index product_search_newest_idx on product_search (created_at desc, product_id desc) where is_listed;
create index product_search_price_idx on product_search (min_price_paise, product_id) where is_listed;
create index product_search_category_idx on product_search (category_path text_pattern_ops) where is_listed;
create index product_search_brand_idx on product_search (brand_slug) where is_listed;
create index product_search_seller_idx on product_search (seller_id) where is_listed;
create index sellers_approved_idx on sellers (id) where status = 'approved';

-- Lowercase and turn ASCII punctuation into spaces, so "DJ-001" indexes as "dj 001" exactly as the
-- API splits a query. Letters and vowel signs of other scripts (e.g. Devanagari) are kept intact.
create or replace function search_norm(t text) returns text language sql immutable parallel safe as $$
  select regexp_replace(lower(coalesce(t, '')), '[[:punct:][:space:]]+', ' ', 'g')
$$;

-- Rebuilds the rows for many products in one set-based statement.
create or replace function refresh_product_search_many(pids uuid[]) returns void language sql as $$
  insert into product_search as ps (product_id, is_listed, seller_id, seller_name, category_id, category_path, brand_id, brand_slug,
                                    brand_name, title, title_lower, condition, min_price_paise, cover_image_id, document, created_at, refreshed_at)
  select pr.id,
         pr.status = 'active' and pr.deleted_at is null and v.minp is not null,
         pr.seller_id, s.display_name::text, pr.category_id, c.path, pr.brand_id, b.slug, b.name::text,
         pr.title, lower(pr.title), pr.condition, v.minp, img.id,
         setweight(to_tsvector('simple', search_norm(pr.title || ' ' || coalesce(v.skus, ''))), 'A') ||
         setweight(to_tsvector('simple', search_norm(coalesce(b.name::text, '') || ' ' || c.name)), 'B') ||
         setweight(to_tsvector('simple', search_norm(coalesce((select string_agg(value, ' ') from jsonb_each_text(pr.attributes)), '') || ' ' || s.display_name)), 'C') ||
         setweight(to_tsvector('simple', search_norm(pr.description)), 'D'),
         pr.created_at, now()
    from products pr
    join sellers s on s.id = pr.seller_id
    join categories c on c.id = pr.category_id
    left join brands b on b.id = pr.brand_id
    left join lateral (
      select string_agg(sku, ' ') as skus, min(price_paise) as minp
        from product_variants where product_id = pr.id and is_active and deleted_at is null
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
    refreshed_at = now()
$$;

-- One product. The transaction-scoped lock makes concurrent refreshes of the same product run one
-- after the other, and each statement after the lock sees what the other transaction committed,
-- so an older price or status can never overwrite a newer one.
create or replace function refresh_product_search(pid uuid) returns void language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('product_search:' || pid::text, 0));
  perform refresh_product_search_many(array[pid]);
end $$;

create or replace function trg_search_product() returns trigger language plpgsql as $$
begin
  perform refresh_product_search(new.id);
  return null;
end $$;
create trigger products_search after insert or update on products for each row execute function trg_search_product();

create or replace function trg_search_child() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform refresh_product_search(old.product_id);
  else
    perform refresh_product_search(new.product_id);
    if tg_op = 'UPDATE' and new.product_id <> old.product_id then perform refresh_product_search(old.product_id); end if;
  end if;
  return null;
end $$;
create trigger product_variants_search after insert or update or delete on product_variants for each row execute function trg_search_child();
create trigger product_images_search after insert or update or delete on product_images for each row execute function trg_search_child();

-- Renames change only searchable text, never visibility, so one set-based rebuild is enough.
create or replace function trg_search_seller() returns trigger language plpgsql as $$
begin
  perform refresh_product_search_many(array(select id from products where seller_id = new.id));
  return null;
end $$;
create trigger sellers_search after update of display_name on sellers
  for each row when (old.display_name is distinct from new.display_name) execute function trg_search_seller();

create or replace function trg_search_category() returns trigger language plpgsql as $$
begin
  perform refresh_product_search_many(array(select id from products where category_id = new.id));
  return null;
end $$;
create trigger categories_search after update of name on categories
  for each row when (old.name is distinct from new.name) execute function trg_search_category();

create or replace function trg_search_brand() returns trigger language plpgsql as $$
begin
  perform refresh_product_search_many(array(select id from products where brand_id = new.id));
  return null;
end $$;
create trigger brands_search after update of name, slug on brands
  for each row when (old.name is distinct from new.name or old.slug is distinct from new.slug)
  execute function trg_search_brand();

-- Build rows for products that already exist.
select refresh_product_search_many(array(select id from products));
