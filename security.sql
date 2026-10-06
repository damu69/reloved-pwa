-- Reloved Marketplace: ownership rules. Run this whole file once in Supabase > SQL Editor
-- (after schema.sql). Safe to run again.

-- ---------- rule book: who may read/write which document ----------
create or replace function public.rl_check(op text, col text, rid text, d jsonb)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  u text := auth.uid()::text;
  cid text;
begin
  if u is null then return false; end if;

  -- private per-user data
  if col like 'data~users~%' then
    return col like 'data~users~' || u || '%';
  end if;

  if col = 'sellers' then
    if op = 's' then return true; end if;
    if rid <> u then return false; end if;
    if op = 'i' then return coalesce((d->>'balance')::numeric, 0) = 0; end if;
    return true;
  end if;

  if col = 'items' then
    if op = 's' then return true; end if;
    return d->>'sellerId' = u;
  end if;

  if col = 'orders' then
    if op = 'i' then
      return d->>'buyerId' = u and d->>'status' = 'paid' and d->>'sellerId' <> u
        and exists (select 1 from docs i where i.collection = 'items' and i.id = d->>'itemId'
                    and i.data->>'sellerId' = d->>'sellerId' and i.data->>'status' = 'active');
    end if;
    return d->>'buyerId' = u or d->>'sellerId' = u;
  end if;

  if col = 'reviews' then
    if op = 's' then return true; end if;
    if op = 'i' then
      return d->>'fromId' = u and rid = (d->>'orderId') || '_' || u
        and exists (select 1 from docs o where o.collection = 'orders' and o.id = d->>'orderId'
                    and o.data->>'status' = 'completed'
                    and ((o.data->>'buyerId' = u and o.data->>'sellerId' = d->>'toId')
                      or (o.data->>'sellerId' = u and o.data->>'buyerId' = d->>'toId')));
    end if;
    return d->>'fromId' = u;
  end if;

  if col = 'notifs' then
    if op = 'i' then return coalesce(d->>'toId', '') <> ''; end if;
    return d->>'toId' = u;
  end if;

  if col = 'reports' then
    return op in ('s', 'i') and d->>'by' = u;
  end if;

  if col = 'convs' then
    if op = 'i' then
      return d->>'buyerId' = u and d->>'sellerId' <> u
        and exists (select 1 from docs i where i.collection = 'items' and i.id = d->>'itemId'
                    and i.data->>'sellerId' = d->>'sellerId');
    end if;
    return d->>'buyerId' = u or d->>'sellerId' = u;
  end if;

  if col like 'convs~%~msgs' then
    cid := split_part(col, '~', 2);
    if not exists (select 1 from docs c where c.collection = 'convs' and c.id = cid
                   and (c.data->>'buyerId' = u or c.data->>'sellerId' = u)) then
      return false;
    end if;
    if op = 'i' then return d->>'from' = u; end if;
    if op = 'd' then return d->>'from' = u; end if;
    return true;
  end if;

  return false;  -- any other collection: closed
end $$;

-- ---------- policies ----------
alter table public.docs enable row level security;
drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
create policy docs_select on public.docs for select to authenticated
  using (public.rl_check('s', collection, id, data));
create policy docs_insert on public.docs for insert to authenticated
  with check (public.rl_check('i', collection, id, data));
create policy docs_update on public.docs for update to authenticated
  using (public.rl_check('u', collection, id, data))
  with check (public.rl_check('u', collection, id, data));
create policy docs_delete on public.docs for delete to authenticated
  using (public.rl_check('d', collection, id, data));

-- ---------- guard: balances and order status can't be faked ----------
create or replace function public.rl_guard() returns trigger language plpgsql as $$
declare
  flag boolean := coalesce(current_setting('rl.credit', true), '') = 'on';
  os text; ns text;
begin
  if auth.uid() is null then return new; end if;  -- dashboard / service role

  if new.collection = 'sellers' and not flag
     and coalesce((new.data->>'balance')::numeric, 0) > coalesce((old.data->>'balance')::numeric, 0) then
    raise exception 'balance cannot be increased directly';
  end if;

  if new.collection = 'orders' then
    if new.data->>'buyerId' is distinct from old.data->>'buyerId'
       or new.data->>'sellerId' is distinct from old.data->>'sellerId'
       or new.data->>'itemId' is distinct from old.data->>'itemId'
       or new.data->>'price' is distinct from old.data->>'price'
       or new.data->>'total' is distinct from old.data->>'total' then
      raise exception 'order details cannot be changed';
    end if;
    os := old.data->>'status'; ns := new.data->>'status';
    if ns is distinct from os then
      if not ( (os = 'paid' and ns = 'cancelled')
            or (os = 'paid' and ns = 'shipped' and new.data->>'sellerId' = auth.uid()::text)
            or (os = 'shipped' and ns = 'completed' and flag) ) then
        raise exception 'invalid order status change';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rl_guard_trg on public.docs;
create trigger rl_guard_trg before update on public.docs for each row execute function public.rl_guard();

-- ---------- safe server actions used by the app ----------
create or replace function public.rl_complete_order(p_order text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.docs;
begin
  select * into o from docs where collection = 'orders' and id = p_order for update;
  if not found or o.data->>'buyerId' <> auth.uid()::text or o.data->>'status' <> 'shipped' then
    raise exception 'not allowed';
  end if;
  perform set_config('rl.credit', 'on', true);
  update docs set data = jsonb_set(data, '{status}', '"completed"'), updated_at = now()
    where collection = 'orders' and id = p_order;
  update docs set data = jsonb_set(data, '{balance}',
      to_jsonb(round(coalesce((data->>'balance')::numeric, 0) + (o.data->>'price')::numeric, 2))), updated_at = now()
    where collection = 'sellers' and id = o.data->>'sellerId';
end $$;

create or replace function public.rl_item_status(p_item text, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := auth.uid()::text;
begin
  if p_status = 'sold' then
    if not exists (select 1 from docs o where o.collection = 'orders' and o.data->>'itemId' = p_item
                   and o.data->>'buyerId' = u and o.data->>'status' = 'paid')
       or not exists (select 1 from docs i where i.collection = 'items' and i.id = p_item and i.data->>'status' = 'active') then
      raise exception 'not allowed';
    end if;
  elsif p_status = 'active' then
    if not exists (select 1 from docs o where o.collection = 'orders' and o.data->>'itemId' = p_item
                   and (o.data->>'buyerId' = u or o.data->>'sellerId' = u) and o.data->>'status' = 'cancelled') then
      raise exception 'not allowed';
    end if;
  else
    raise exception 'bad status';
  end if;
  update docs set data = jsonb_set(data, '{status}', to_jsonb(p_status)), updated_at = now()
    where collection = 'items' and id = p_item;
end $$;

revoke all on function public.rl_complete_order(text) from public, anon;
revoke all on function public.rl_item_status(text, text) from public, anon;
grant execute on function public.rl_complete_order(text) to authenticated;
grant execute on function public.rl_item_status(text, text) to authenticated;
