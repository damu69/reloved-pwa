-- 0013 ratings: a buyer rates the seller of a delivered package, once per package.
-- 1 to 5 stars and an optional comment. The buyer may edit within 7 days of first rating (enforced in the API);
-- an admin can remove an abusive rating, which keeps the row but takes it out of every average.

create table seller_ratings (
  id               uuid primary key default gen_random_uuid(),
  seller_order_id  uuid not null unique references seller_orders(id),
  seller_id        uuid not null references sellers(id),
  buyer_id         uuid not null references users(id),
  stars            smallint not null check (stars between 1 and 5),
  comment          text check (length(comment) <= 300),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  removed_at       timestamptz,
  removed_by       uuid references users(id),
  removal_reason   text check (length(removal_reason) <= 300),
  check ((removed_at is null) = (removed_by is null))
);
create index seller_ratings_seller_idx on seller_ratings (seller_id, created_at desc) where removed_at is null;
create index seller_ratings_buyer_idx on seller_ratings (buyer_id, created_at desc);
create trigger seller_ratings_updated before update on seller_ratings for each row execute function set_updated_at();
