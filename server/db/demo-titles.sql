-- One-off fix for demo data installed before 15 Oct 2026: sizes now live only in the size option, not in titles,
-- so the size filter and the title agree. Run once in Supabase -> SQL Editor. Safe to run again (it matches old titles only).

set search_path = reloved, extensions, public;

do $$
declare dsellers uuid[]; kolha uuid;
begin
  select array_agg(s.id) into dsellers from sellers s join users u on u.id = s.user_id where u.email like '%@demo.reloved.invalid';
  if dsellers is null then raise notice 'No demo data found.'; return; end if;

  update products set title = v.new_title
    from (values ('Nude block heels, size 38', 'Nude block heels'),
                 ('Adidas Grand Court sneakers, UK 7', 'Adidas Grand Court sneakers'),
                 ('Puma RS-X sneakers, white and grey, UK 9', 'Puma RS-X sneakers, white and grey'),
                 ('Hand-stitched Kolhapuri sandals, size 7', 'Hand-stitched Kolhapuri sandals'),
                 ('Nike Air Max 90, UK 8', 'Nike Air Max 90')) as v(old_title, new_title)
   where products.title = v.old_title and products.seller_id = any(dsellers);

  -- The Kolhapuris said "size 7" in the title but had no size option.
  select id into kolha from products where title = 'Hand-stitched Kolhapuri sandals' and seller_id = any(dsellers) limit 1;
  if kolha is not null then
    update product_variants set options = '{"size": "UK 7"}'::jsonb where product_id = kolha and options = '{}'::jsonb;
  end if;
  raise notice 'Demo titles updated.';
end $$;
