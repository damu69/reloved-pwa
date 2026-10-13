-- Demo data for the Reloved trial: 8 sample sellers and 46 live listings (no photos; the app draws
-- a tile for items without one). Run in Supabase -> SQL Editor as the default "postgres" user.
--
--   * Every demo seller's login email ends in @demo.reloved.invalid and has no usable password,
--     so nobody can sign in as them. That ending is also how demo-remove.sql finds everything.
--   * Safe to run once. Running it again stops with a message instead of creating duplicates.
--   * Missing categories and brands are created; existing ones are reused.
--   * To remove it all later: run db/demo-remove.sql.
--   * To make a demo seller answer your chat messages: run db/demo-reply.sql.

set search_path = reloved, extensions, public;

create or replace function pg_temp.demo_cat(p text) returns uuid language plpgsql as $$
declare parts text[] := string_to_array(p, '/'); i int; cur text; pid uuid := null; cid uuid;
begin
  for i in 1..array_length(parts, 1) loop
    cur := array_to_string(parts[1:i], '/');
    select id into cid from categories where path = cur;
    if cid is null then
      insert into categories (parent_id, slug, name, path, depth)
        values (pid, parts[i], initcap(replace(parts[i], '-', ' ')), cur, i - 1) returning id into cid;
    end if;
    pid := cid;
  end loop;
  return cid;
end $$;

create or replace function pg_temp.demo_brand(b text) returns uuid language plpgsql as $$
declare bid uuid;
begin
  if b is null then return null; end if;
  select id into bid from brands where lower(name::text) = lower(b);
  if bid is null then
    insert into brands (name, slug) values (b, regexp_replace(lower(b), '[^a-z0-9]+', '-', 'g')) returning id into bid;
  end if;
  return bid;
end $$;

do $$
declare
  s record; l record; uid uuid; sid uuid; wid uuid; pid uuid; vid uuid; sz text;
  seller_ids jsonb := '{}'::jsonb; wh_ids jsonb := '{}'::jsonb;
  n int := 0; nv int := 0;
begin
  if exists (select 1 from users where email like '%@demo.reloved.invalid') then
    raise exception 'Demo data is already installed. Run db/demo-remove.sql first if you want to reinstall it.';
  end if;

  -- ---------- sellers ----------
  for s in select * from (values
    ('ganga-vintage',    'Ganga Vintage',      'Nanded',    'Maharashtra', '431601', '9876500001'),
    ('bombay-closet',    'Bombay Closet',      'Mumbai',    'Maharashtra', '400050', '9876500002'),
    ('kochi-thrift',     'Kochi Thrift House', 'Kochi',     'Kerala',      '682016', '9876500003'),
    ('hyderabad-hanger', 'Hyderabad Hanger',   'Hyderabad', 'Telangana',   '500034', '9876500004'),
    ('pune-preloved',    'Pune Preloved',      'Pune',      'Maharashtra', '411004', '9876500005'),
    ('calicut-closet',   'Calicut Closet',     'Kozhikode', 'Kerala',      '673001', '9876500006'),
    ('delhi-drops',      'Delhi Drops',        'New Delhi', 'Delhi',       '110017', '9876500007'),
    ('jaipur-jhola',     'Jaipur Jhola',       'Jaipur',    'Rajasthan',   '302001', '9876500008')
  ) as t(slug, display_name, city, state, pincode, phone) loop
    insert into users (email, password_hash, full_name, status, email_verified_at)
      values ('demo.' || s.slug || '@demo.reloved.invalid', '!demo-account-no-login', s.display_name, 'active', now())
      returning id into uid;
    insert into user_roles (user_id, role_key) values (uid, 'seller');
    insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4,
                         address_line1, city, state, pincode, contact_phone, submitted_at, approved_at)
      values (uid, 'approved', s.display_name, s.display_name, 'individual', 'v1:demo', '0000',
              'Demo address', s.city, s.state, s.pincode, s.phone, now(), now())
      returning id into sid;
    insert into warehouses (seller_id, name, pincode, city, is_default) values (sid, 'Home', s.pincode, s.city, true) returning id into wid;
    seller_ids := seller_ids || jsonb_build_object(s.slug, sid);
    wh_ids := wh_ids || jsonb_build_object(s.slug, wid);
  end loop;

  -- ---------- listings ----------
  -- (seller, category, brand, title, description, condition, price Rs, original price Rs, GST bp, colour, sizes, stock per size)
  for l in select row_number() over () as rn, * from (values
    ('ganga-vintage','women/kurtas','FabIndia','Indigo block-print cotton kurta','Hand block printed pure cotton, straight fit, three-quarter sleeves. Worn a handful of times, no marks or fading.','very_good',650,1899,500,'Indigo','{S,M,L}'::text[],1),
    ('ganga-vintage','women/sarees',null,'Maroon silk saree with gold zari border','Soft silk blend with a woven zari border and pallu. Blouse piece included, uncut. Dry cleaned and stored folded in muslin.','good',2200,6500,500,'Maroon',null,1),
    ('ganga-vintage','women/tops','Zara','Ribbed white crop top','Stretchy ribbed cotton, square neck. Bought the wrong size, never worn. Tags still on.','new_with_tags',450,1290,500,'White','{S,M}'::text[],1),
    ('ganga-vintage','men/shirts','Allen Solly','Light blue slim-fit formal shirt','Wrinkle-resistant cotton blend. Perfect for office. A small ink dot on the inside of the cuff, not visible when worn.','good',520,1499,500,'Light blue','{M,L}'::text[],1),
    ('ganga-vintage','accessories/watches','Titan','Titan ladies watch, rose gold dial','Analog watch with a metal strap. Runs on time, battery changed last month. Comes with the original box.','very_good',2400,5995,1800,'Rose gold',null,1),

    ('bombay-closet','women/dresses','Mango','Floral wrap midi dress','Lightweight viscose, adjustable wrap waist, flutter sleeves. Worn once to a wedding lunch.','very_good',1100,3590,500,'Blue floral','{XS,S,M}'::text[],1),
    ('bombay-closet','women/dresses','H&M','Black bodycon party dress','Stretch jersey, knee length, hidden zip at the back. Washed gently, still very black.','good',600,1799,500,'Black','{S,M}'::text[],1),
    ('bombay-closet','women/tops','Forever 21','Champagne satin cami top','Silky satin with thin straps and a lace trim. Looks good under a blazer or on its own.','new',380,1299,500,'Champagne','{S,M,L}'::text[],2),
    ('bombay-closet','bags/handbags','Lavie','Tan faux-leather tote bag','Roomy tote with an inside zip pocket and magnetic closure. Fits a 13 inch laptop. Light wear on the corners.','good',750,2499,1800,'Tan',null,1),
    ('bombay-closet','footwear/heels','Aldo','Nude block heels, size 38','Comfortable 7 cm block heel with an ankle strap. Worn three times indoors, soles are clean.','very_good',900,3999,500,'Nude','{EU 38}'::text[],1),
    ('bombay-closet','men/jackets','Levis','Denim trucker jacket','Classic mid-wash denim, button front, two chest pockets. The one jacket that goes with everything.','very_good',1800,5999,500,'Mid blue','{M,L}'::text[],1),
    ('bombay-closet','accessories/sunglasses',null,'Gold-frame aviator sunglasses','Polarised lenses with UV protection. Light scratches on the case only, lenses are clean.','good',650,1499,1800,'Gold',null,1),

    ('kochi-thrift','women/kurtas','Biba','Mustard anarkali kurta set','Anarkali kurta with matching palazzo and dupatta. Gotta patti work on the neckline. Worn once for Onam.','very_good',1250,3299,500,'Mustard','{S,M}'::text[],1),
    ('kochi-thrift','women/sarees',null,'Kerala kasavu cotton saree','Off-white handloom cotton with the traditional gold kasavu border. Never worn, just ironed and folded.','new',1400,2200,500,'Off-white',null,2),
    ('kochi-thrift','women/tops','W','Printed peplum top','Soft crepe with a floral print and a flattering peplum hem. Machine washable.','good',420,1599,500,'Pink floral','{M,L}'::text[],1),
    ('kochi-thrift','kids/clothing','H&M','Kids denim dungarees, 4 to 5 years','Soft stretch denim with adjustable straps. Outgrown after two months, hardly any wear.','very_good',450,1499,500,'Denim',null,1),
    ('kochi-thrift','home/decor',null,'Brass diya set of 4, hand polished','Traditional brass diyas, polished and ready to light. A lovely Diwali gift.','new',550,1200,1800,'Brass',null,3),
    ('kochi-thrift','footwear/sneakers','Adidas','Adidas Grand Court sneakers, UK 7','White leather-look sneakers with the three stripes. Cleaned and deodorised. Minor creasing.','good',1300,4999,500,'White','{UK 7}'::text[],1),

    ('hyderabad-hanger','men/tshirts','Nike','Nike Dri-FIT running tee','Moisture-wicking black tee with a small swoosh. Used for a few gym sessions only.','very_good',600,2495,500,'Black','{M,L,XL}'::text[],1),
    ('hyderabad-hanger','men/jeans','Levis','Levis 511 slim jeans, dark wash','Slim fit through the thigh, stretch denim. Hemmed for a 30 inch length. No rips or stains.','good',1400,4499,500,'Dark blue','{30,32,34}'::text[],1),
    ('hyderabad-hanger','men/shirts','Van Heusen','White cotton formal shirt','Crisp white cotton with a spread collar. Bought two of the same, this one is unworn.','new',700,1799,500,'White','{40,42}'::text[],2),
    ('hyderabad-hanger','footwear/sneakers','Puma','Puma RS-X sneakers, white and grey, UK 9','Chunky retro runners with a cushioned sole. Wear on the heel tabs, otherwise clean.','good',2200,8999,500,'White and grey','{UK 9}'::text[],1),
    ('hyderabad-hanger','bags/backpacks','Wildcraft','Wildcraft 35L trekking backpack','Rain cover included, padded straps and a hip belt. Used on two treks. Zips all work smoothly.','good',1100,3200,1800,'Navy',null,1),
    ('hyderabad-hanger','accessories/watches','Fossil','Fossil chronograph, brown leather strap','Quartz chronograph with a tan dial. New battery fitted. Strap shows light creasing.','very_good',3200,9995,1800,'Brown',null,1),

    ('pune-preloved','women/dresses','Zara','Sage green linen midi dress','Breathable linen with a tie waist and side pockets. Wrinkles are part of the charm.','very_good',1400,3990,500,'Sage green','{S,M}'::text[],1),
    ('pune-preloved','women/jeans','Mango','High-rise mom jeans, light wash','Relaxed leg, high waist and a button fly. Comfortable all-day wear.','good',800,2999,500,'Light blue','{26,28,30}'::text[],1),
    ('pune-preloved','women/tops','H&M','Oversized striped shirt','Roomy cotton shirt in blue and white stripes. Great with jeans or over a swimsuit.','good',500,1499,500,'Blue stripe','{S,M}'::text[],1),
    ('pune-preloved','men/jackets','Zara','Olive bomber jacket','Lightweight bomber with ribbed cuffs and zip pockets. Warm enough for a Pune winter evening.','very_good',1600,4990,500,'Olive','{M,L}'::text[],1),
    ('pune-preloved','kids/clothing',null,'Girls cotton frock, 6 to 7 years','Bright yellow frock with a ruffled hem, soft lining. Washed many times, still looks fresh.','good',300,899,500,'Yellow',null,1),
    ('pune-preloved','footwear/flats',null,'Hand-stitched Kolhapuri sandals, size 7','Genuine leather Kolhapuris from Kolhapur. Softened already so no blisters.','new',650,1200,500,'Tan',null,2),

    ('calicut-closet','women/kurtas','W','White chikankari kurta','Delicate hand embroidery on soft cotton. Straight cut with side slits. Dry cleaned.','very_good',900,2599,500,'White','{S,M,L}'::text[],1),
    ('calicut-closet','women/sarees',null,'Mustard linen saree with ikat border','Handloom linen with a contrast ikat pallu. Light and perfect for hot days.','very_good',1700,3800,500,'Mustard',null,1),
    ('calicut-closet','men/shirts','FabIndia','Handloom linen shirt, grey','Relaxed fit with a mandarin collar. Breathable and softer with every wash.','good',850,2299,500,'Grey','{M,L}'::text[],1),
    ('calicut-closet','bags/handbags',null,'Jute and leather sling bag','Handmade jute body with leather straps and brass fittings. Spacious, lightweight.','new',480,999,1800,'Natural',null,2),
    ('calicut-closet','accessories/sunglasses',null,'Round tortoiseshell sunglasses','Classic round frames with UV400 lenses. Very light wear.','very_good',350,999,1800,'Tortoiseshell',null,1),
    ('calicut-closet','home/decor',null,'Handwoven cane baskets, set of 3','Nesting baskets for storage or plants. Never used, still has the shop tag.','new',900,1800,1800,'Natural',null,2),

    ('delhi-drops','women/dresses','Mango','Black satin slip dress','Bias-cut satin with a cowl neck and adjustable straps. New with tags, wrong size for me.','new_with_tags',1500,3999,500,'Black','{S,M}'::text[],1),
    ('delhi-drops','men/jackets','Raymond','Raymond navy wool blazer','Single-breasted, two button, notch lapel. Professionally pressed. Fits like a 40.','good',2600,9999,500,'Navy','{38,40}'::text[],1),
    ('delhi-drops','men/tshirts','H&M','Vintage wash graphic tee','Faded black cotton with a retro print. Soft from washing, small bobbling under the arms.','satisfactory',250,799,500,'Washed black','{M,L}'::text[],1),
    ('delhi-drops','footwear/sneakers','Nike','Nike Air Max 90, UK 8','Iconic Air Max with visible air unit. Midsole shows some yellowing, uppers are clean.','good',3600,11995,500,'White and red','{UK 8}'::text[],1),
    ('delhi-drops','bags/backpacks',null,'Canvas laptop backpack, 15 inch','Padded laptop sleeve, two side pockets and a hidden back pocket. Sturdy zips.','very_good',600,1699,1800,'Olive',null,1),

    ('jaipur-jhola','women/kurtas',null,'Jaipuri hand-block printed cotton kurta','Pure cotton in a floral block print, straight fit. Straight from a Jaipur workshop, never worn.','new',520,999,500,'Red and white','{S,M,L}'::text[],2),
    ('jaipur-jhola','women/tops',null,'Tie-dye cotton top','Hand tie-dyed in blue and white, loose fit with short sleeves.','good',280,799,500,'Blue','{M,L}'::text[],1),
    ('jaipur-jhola','accessories/jewellery',null,'Oxidised silver jhumka earrings','Lightweight jhumkas with small bell drops. Nickel free. Comes in a little cloth pouch.','new',300,699,300,'Oxidised silver',null,3),
    ('jaipur-jhola','home/decor',null,'Blue pottery decor vase','Hand-painted Jaipur blue pottery, about 20 cm tall. Perfect for dried flowers.','new',650,1500,1800,'Blue and white',null,1),
    ('jaipur-jhola','women/sarees',null,'Red bandhani georgette saree','Traditional bandhani tie-dye on flowing georgette with a gota border. Worn once.','very_good',1300,3200,500,'Red',null,1)
  ) as t(seller, cat, brand, title, descr, cond, price, mrp, gst, colour, sizes, stock) loop
    insert into products (seller_id, status, title, description, category_id, brand_id, condition, attributes, gst_rate_bp,
                          submission, submitted_at, approved_at, created_at)
      values ((seller_ids ->> l.seller)::uuid, 'active', l.title, l.descr, pg_temp.demo_cat(l.cat), pg_temp.demo_brand(l.brand),
              l.cond, jsonb_build_object('colour', l.colour), l.gst, 1, now(), now(),
              now() - (l.rn * interval '95 minutes'))
      returning id into pid;
    n := n + 1;
    foreach sz in array coalesce(l.sizes, array[null]::text[]) loop
      insert into product_variants (product_id, seller_id, sku, options, price_paise, mrp_paise)
        values (pid, (seller_ids ->> l.seller)::uuid, 'DEMO-' || l.rn || coalesce('-' || regexp_replace(sz, '[^A-Za-z0-9]+', '', 'g'), ''),
                case when sz is null then '{}'::jsonb else jsonb_build_object('size', sz) end,
                l.price * 100, l.mrp * 100)
        returning id into vid;
      insert into inventory_levels (variant_id, warehouse_id, on_hand) values (vid, (wh_ids ->> l.seller)::uuid, l.stock);
      nv := nv + 1;
    end loop;
  end loop;

  raise notice 'Demo data installed: % sellers, % listings, % sizes/variants.', (select count(*) from jsonb_object_keys(seller_ids)), n, nv;
end $$;
