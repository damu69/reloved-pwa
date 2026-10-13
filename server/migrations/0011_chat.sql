-- 0011 chat: buyer-to-seller conversations about a product, with plain text messages.
-- One conversation per (buyer, product). The seller side is the seller's user account, copied onto the
-- conversation so reads never need to join through sellers to check who may see it.

create table conversations (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references products(id),
  buyer_id            uuid not null references users(id),
  seller_id           uuid not null references sellers(id),
  seller_user_id      uuid not null references users(id),
  last_message_at     timestamptz not null default now(),
  last_message_preview text not null default '' check (length(last_message_preview) <= 140),
  buyer_last_read_id  bigint not null default 0,
  seller_last_read_id bigint not null default 0,
  created_at          timestamptz not null default now(),
  constraint conversations_not_self check (buyer_id <> seller_user_id),
  unique (buyer_id, product_id)
);
create index conversations_buyer_idx on conversations (buyer_id, last_message_at desc);
create index conversations_seller_idx on conversations (seller_user_id, last_message_at desc);

create table messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid not null references users(id),
  body            text not null check (length(body) between 1 and 1000),
  created_at      timestamptz not null default now()
);
create index messages_conversation_idx on messages (conversation_id, id);
