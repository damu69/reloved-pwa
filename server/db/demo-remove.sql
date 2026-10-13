-- Removes everything installed by db/demo-seed.sql (and any chats about those items).
-- Run in Supabase -> SQL Editor. Safe to run when there is nothing to remove.
--
-- If someone already ordered a demo item, the order history must stay, so in that case the demo
-- listings are archived (hidden from the app) and the demo sellers suspended instead of deleted.

set search_path = reloved, extensions, public;

do $$
declare dusers uuid[]; dsellers uuid[]; dpids uuid[]; dvars uuid[];
begin
  select array_agg(id) into dusers from users where email like '%@demo.reloved.invalid';
  if dusers is null then raise notice 'No demo data found.'; return; end if;
  select array_agg(id) into dsellers from sellers where user_id = any(dusers);
  select array_agg(id) into dpids from products where seller_id = any(dsellers);
  select array_agg(id) into dvars from product_variants where product_id = any(dpids);

  begin
    delete from messages where conversation_id in (select id from conversations where product_id = any(dpids) or seller_id = any(dsellers));
    delete from conversations where product_id = any(dpids) or seller_id = any(dsellers);
    delete from cart_items where variant_id = any(dvars);
    delete from wishlists where product_id = any(dpids);
    delete from inventory_levels where variant_id = any(dvars);
    delete from product_images where product_id = any(dpids);
    delete from product_revisions where product_id = any(dpids);
    delete from product_variants where product_id = any(dpids);
    -- Deleting stock and variants re-queues search updates, so clear the search rows last.
    delete from search_refresh_queue where product_id = any(dpids);
    delete from product_search where product_id = any(dpids);
    delete from products where id = any(dpids);
    delete from warehouses where seller_id = any(dsellers);
    delete from sellers where id = any(dsellers);
    delete from user_roles where user_id = any(dusers);
    delete from users where id = any(dusers);
    raise notice 'Demo data deleted.';
  exception when others then
    raise notice 'Could not delete everything (%). Archiving the demo listings and suspending the demo sellers instead.', sqlerrm;
    update products set status = 'archived' where id = any(dpids);
    update sellers set status = 'suspended' where id = any(dsellers);
  end;
end $$;
