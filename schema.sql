-- Reloved Marketplace: run this whole file once in Supabase > SQL Editor.
create table if not exists public.docs (
  collection text not null,           -- path with "/" written as "~", e.g. items, convs~abc~msgs, data~users~<uid>
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists docs_data_idx on public.docs using gin (data jsonb_path_ops);

alter table public.docs enable row level security;

-- Shared collections: any signed-in member can read and write (prototype trust model).
-- Private collections (data~users~<uid>...): only that user.
drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
create policy docs_select on public.docs for select to authenticated
  using (collection not like 'data~users~%' or collection like 'data~users~' || auth.uid()::text || '%');
create policy docs_insert on public.docs for insert to authenticated
  with check (collection not like 'data~users~%' or collection like 'data~users~' || auth.uid()::text || '%');
create policy docs_update on public.docs for update to authenticated
  using (collection not like 'data~users~%' or collection like 'data~users~' || auth.uid()::text || '%')
  with check (collection not like 'data~users~%' or collection like 'data~users~' || auth.uid()::text || '%');
create policy docs_delete on public.docs for delete to authenticated
  using (collection not like 'data~users~%' or collection like 'data~users~' || auth.uid()::text || '%');

-- Live updates
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Sample marketplace data
insert into public.docs(collection,id,data) values ('sellers','seed_nad2297','{"handle": "nad2297", "balance": 0, "holiday": false, "bundle": true, "bundlePct": 10, "joined": 1759000000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('sellers','seed_mimmo','{"handle": "mimmo1494", "balance": 0, "holiday": false, "bundle": false, "bundlePct": 10, "joined": 1759000000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('sellers','seed_shopio','{"handle": "shopio0", "balance": 0, "holiday": false, "bundle": true, "bundlePct": 15, "joined": 1759000000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('sellers','seed_emma','{"handle": "emma_allm", "balance": 0, "holiday": false, "bundle": false, "bundlePct": 10, "joined": 1759000000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed01','{"title": "Dark blue sleeping mat, 180 cm", "desc": "Self-inflating camping mat. Used on three trips, no leaks.", "brand": "Decathlon", "cat": "Sports", "cond": "Good", "size": "180 cm", "price": 5, "sellerId": "seed_nad2297", "status": "active", "photos": [], "hue": 215, "at": 1759600000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed02','{"title": "Climbing harness", "desc": "Black Diamond harness, adjustable leg loops. Inspected and in good order.", "brand": "Black Diamond", "cat": "Sports", "cond": "Very good", "size": "M", "price": 34, "sellerId": "seed_nad2297", "status": "active", "photos": [], "hue": 20, "at": 1759500000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed03','{"title": "Via ferrata kit", "desc": "Complete set with energy-absorbing lanyard and two carabiners.", "brand": "Climbing Technology", "cat": "Sports", "cond": "Good", "size": "One size", "price": 42, "sellerId": "seed_emma", "status": "active", "photos": [], "hue": 170, "at": 1759400000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed04','{"title": "The North Face shell jacket", "desc": "Waterproof, taped seams, hood packs away.", "brand": "The North Face", "cat": "Men", "cond": "Very good", "size": "M", "price": 55, "sellerId": "seed_mimmo", "status": "active", "photos": [], "hue": 200, "at": 1759300000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed05','{"title": "3-in-1 winter jacket", "desc": "Fleece liner zips out. Warm and barely worn.", "brand": "Columbia", "cat": "Women", "cond": "Good", "size": "S", "price": 38, "sellerId": "seed_shopio", "status": "active", "photos": [], "hue": 330, "at": 1759200000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed06','{"title": "Ultralight sleeping bag", "desc": "Three-season bag, compresses small. Comes with stuff sack.", "brand": "Jack Wolfskin", "cat": "Sports", "cond": "Satisfactory", "size": "Regular", "price": 20.24, "sellerId": "seed_emma", "status": "active", "photos": [], "hue": 150, "at": 1759100000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed07','{"title": "Leather ankle boots", "desc": "Resoled last year. Classic eight-eye style.", "brand": "Dr. Martens", "cat": "Designer", "cond": "Very good", "size": "EU 40", "price": 48, "sellerId": "seed_shopio", "status": "active", "photos": [], "hue": 270, "at": 1759000000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed08','{"title": "Kids rain set, size 104", "desc": "Jacket and trousers, never worn. Tags attached.", "brand": "Reima", "cat": "Kids", "cond": "New with tags", "size": "104", "price": 18, "sellerId": "seed_mimmo", "status": "active", "photos": [], "hue": 40, "at": 1758900000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed09','{"title": "Ceramic table lamp", "desc": "White glaze with linen shade. Bulb not included.", "brand": "IKEA", "cat": "Home", "cond": "Good", "size": "", "price": 12, "sellerId": "seed_nad2297", "status": "active", "photos": [], "hue": 55, "at": 1758800000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed10','{"title": "Wireless earbuds", "desc": "Charging case included. Battery still lasts about 6 hours.", "brand": "Anker", "cat": "Electronics", "cond": "Good", "size": "", "price": 25, "sellerId": "seed_emma", "status": "active", "photos": [], "hue": 195, "at": 1758700000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed11','{"title": "Vintage paperback set", "desc": "Twelve classic novels, spines creased but pages clean.", "brand": "Penguin", "cat": "Books & Media", "cond": "Satisfactory", "size": "", "price": 9, "sellerId": "seed_shopio", "status": "active", "photos": [], "hue": 20, "at": 1758600000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('items','seed12','{"title": "Trading card binder", "desc": "Around 200 cards in sleeves, mostly commons and uncommons.", "brand": "", "cat": "Hobbies & Collectables", "cond": "Good", "size": "", "price": 30, "sellerId": "seed_mimmo", "status": "active", "photos": [], "hue": 300, "at": 1758500000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('reviews','seedrv1','{"orderId": "seedo1", "fromId": "seed_emma", "toId": "seed_nad2297", "rating": 5, "text": "Quick reply and exactly as described.", "at": 1758000000000}'::jsonb) on conflict do nothing;
insert into public.docs(collection,id,data) values ('reviews','seedrv2','{"orderId": "seedo2", "fromId": "seed_mimmo", "toId": "seed_shopio", "rating": 4, "text": "Good jacket, shipped fast.", "at": 1758100000000}'::jsonb) on conflict do nothing;
