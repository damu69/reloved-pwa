-- Reloved: give the admin account an approved seller profile with TEST details (agreed 2026-11-05).
-- Change the four values in the "Your shop" block if you like, then run the whole file in the Supabase SQL Editor.
--
-- Why SQL: the app blocks an admin from approving their own seller account, and real PAN/bank details
-- should not go in until DATA_ENCRYPTION_KEY is rotated. So this uses obvious test values:
--   PAN is a placeholder (shows as ****0000, cannot be revealed), no bank account, no KYC documents.
-- Before real selling with payouts: rotate the key, then replace these with real details (see note at the end).

do $$
declare
  -- ---- Your shop (edit these) ----
  shop_name  text := 'Reloved Store';   -- shown to buyers; must be unique
  shop_city  text := 'Nanded';
  shop_state text := 'Maharashtra';
  shop_pin   text := '431601';
  -- --------------------------------
  uid uuid; sid uuid; n int;
begin
  set local search_path = reloved, extensions, public;

  select count(*) into n from user_roles where role_key = 'admin';
  if n <> 1 then raise exception 'Expected exactly one admin account, found %. Nothing was changed.', n; end if;
  select user_id into uid from user_roles where role_key = 'admin';
  if exists (select 1 from sellers where user_id = uid) then
    raise exception 'This admin already has a seller profile. Nothing was changed.';
  end if;

  insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4,
                       address_line1, city, state, pincode, contact_phone, submitted_at, approved_at, approved_by)
  values (uid, 'approved', shop_name, shop_name, 'individual', 'v1:test-placeholder', '0000',
          'Test address', shop_city, shop_state, shop_pin, '9999999999', now(), now(), uid)
  returning id into sid;

  insert into user_roles (user_id, role_key, granted_by) values (uid, 'seller', uid) on conflict do nothing;
  insert into warehouses (seller_id, name, pincode, city, is_default) values (sid, 'Home', shop_pin, shop_city, true);
  insert into seller_status_history (seller_id, from_status, to_status, actor_id, reason)
    values (sid, null, 'approved', uid, 'Admin set up as test seller by SQL (test details, no KYC)');
  insert into audit_logs (actor_user_id, action, entity, entity_id, new_value)
    values (uid, 'seller.approve', 'seller', sid::text, jsonb_build_object('status', 'approved', 'reason', 'admin test seller via SQL, no KYC'));
end $$;

-- Result
select u.email, s.display_name, s.status, s.city, s.pan_last4,
       exists (select 1 from reloved.user_roles r where r.user_id = u.id and r.role_key = 'seller') as has_seller_role
  from reloved.sellers s join reloved.users u on u.id = s.user_id
  join reloved.user_roles a on a.user_id = u.id and a.role_key = 'admin';

-- Later, to switch to real details: suspend this seller from another admin account, or delete the test
-- profile while it has no products/orders, then apply normally in the app with your real PAN and bank.
