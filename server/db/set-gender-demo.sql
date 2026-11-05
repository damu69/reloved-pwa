-- Reloved: set Gender on the demo listings that have none (agreed 2026-11-05).
-- Unisex items (kids dungarees, sneakers, backpacks, sunglasses, Kolhapuri sandals, decor) stay blank on purpose.
-- Only touches products with no Gender yet. Safe to run again.
begin;
set local search_path = reloved, extensions, public;

update products p
   set attributes = p.attributes || jsonb_build_object('gender', m.gender)
  from (values
    ('Titan ladies watch, rose gold dial', 'women'),
    ('Tan faux-leather tote bag',          'women'),
    ('Nude block heels',                   'women'),
    ('Jute and leather sling bag',         'women'),
    ('Oxidised silver jhumka earrings',    'women'),
    ('Girls cotton frock, 6 to 7 years',   'girls'),
    ('Fossil chronograph, brown leather strap', 'men')
  ) as m(title, gender)
 where p.title = m.title and not (p.attributes ? 'gender');

commit;

-- Result: every listed product and its Gender (blank = unisex / not set).
select coalesce(p.attributes ->> 'gender', '') as gender, c.name as category, p.title
  from reloved.products p join reloved.categories c on c.id = p.category_id
 order by 1 desc, 2, 3;
