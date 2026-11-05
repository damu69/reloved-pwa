-- Reloved: flatten categories to one level of item types. Gender moves to products.attributes.gender.
-- Run ONCE in the Supabase SQL Editor (paste the whole file, press Run).
--
-- What it does
--   1. Sets Gender on products from their old parent: Men -> men, Women -> women. Kids is left blank.
--      Pending edits waiting for review get the same Gender.
--   2. Merges Men > Jeans into Jeans (products and pending edits move across).
--   3. Makes every item type a top-level category: Dresses, Jeans, Kurtas, Sarees, Tops, Shirts, T-shirts,
--      Jackets, Kids clothing, Flats, Heels, Sneakers, Handbags, Backpacks, Jewellery, Sunglasses, Watches, Decor.
--      Category ids stay the same, so coupons and commission rules on these keep working.
--   4. Hides the old groups (Accessories, Bags, Footwear, Home, Kids, Men, Women) and Men > Jeans.
--   5. Rebuilds the search table and lists the result.
--
-- Everything runs in one transaction: if any step fails, nothing changes. A second run stops at step 0.
-- Old links such as /women/dresses stop working; the new link is /dresses.

begin;
set local search_path = reloved, extensions, public;

-- 0. Stop if the tree is not the one this script was written for (for example, it already ran).
do $$ begin
  if (select count(*) from categories where is_active and path in ('men/jeans', 'women/jeans', 'kids/clothing', 'men/tshirts', 'women/dresses')) <> 5 then
    raise exception 'Categories are not in the expected shape (already flattened?). Nothing was changed.';
  end if;
end $$;

-- 1. Gender from the old parent (only where none is set yet).
update products p
   set attributes = p.attributes || jsonb_build_object('gender', split_part(c.path, '/', 1))
  from categories c
 where c.id = p.category_id and split_part(c.path, '/', 1) in ('men', 'women') and not (p.attributes ? 'gender');

update product_revisions r
   set data = jsonb_set(r.data, '{attributes}', coalesce(r.data -> 'attributes', '{}'::jsonb) || jsonb_build_object('gender', split_part(c.path, '/', 1)))
  from categories c
 where r.status = 'pending' and c.id::text = r.data ->> 'categoryId'
   and split_part(c.path, '/', 1) in ('men', 'women') and not coalesce(r.data -> 'attributes', '{}'::jsonb) ? 'gender';

-- 2. Merge Men > Jeans into Women > Jeans (which becomes plain "Jeans").
update products set category_id = (select id from categories where path = 'women/jeans')
 where category_id = (select id from categories where path = 'men/jeans');
update product_revisions
   set data = jsonb_set(data, '{categoryId}', to_jsonb((select id from categories where path = 'women/jeans')::text))
 where status = 'pending' and data ->> 'categoryId' = (select id from categories where path = 'men/jeans')::text;

-- 3. Item types become top-level.
update categories
   set parent_id = null, depth = 0,
       slug = case when path = 'kids/clothing' then 'kids-clothing' else slug end,
       name = case path when 'kids/clothing' then 'Kids clothing' when 'men/tshirts' then 'T-shirts' else name end,
       path = case when path = 'kids/clothing' then 'kids-clothing' else slug end
 where depth = 1 and is_active and path <> 'men/jeans';

-- 4. Hide the old groups and the merged Men > Jeans.
update categories set is_active = false
 where path in ('accessories', 'bags', 'footwear', 'home', 'kids', 'men', 'women', 'men/jeans');

-- Alphabetical order for the new list.
update categories c set sort_order = x.n
  from (select id, row_number() over (order by name) as n from categories where parent_id is null and is_active) x
 where c.id = x.id;

-- 5. Search rows carry the category path, so rebuild them.
select refresh_product_search_many(array(select id from products));

commit;

-- Check: coupons or commission rules still pointing at a hidden category (fix these in admin if any show).
select 'coupon' as kind, cc.coupon_id::text as id, c.path from reloved.coupon_categories cc join reloved.categories c on c.id = cc.category_id where not c.is_active
union all
select 'commission rule', r.id::text, c.path from reloved.commission_rules r join reloved.categories c on c.id = r.category_id where not c.is_active and r.ends_at is null;

-- Result: the new list with product counts.
select c.name, c.path, count(p.id) as products
  from reloved.categories c left join reloved.products p on p.category_id = c.id
 where c.is_active group by c.id order by c.sort_order;
