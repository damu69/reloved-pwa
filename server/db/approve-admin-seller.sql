-- Reloved: approve the admin's OWN seller application (the app blocks self-approval by design).
-- Accepts the pending documents, verifies the pending bank account, approves, adds the seller role,
-- and records it in the status history and audit log. Stops without changes if anything looks off.
do $$
declare uid uuid; s record; n int;
begin
  set local search_path = reloved, extensions, public;
  select count(*) into n from user_roles where role_key = 'admin';
  if n <> 1 then raise exception 'Expected exactly one admin account, found %. Nothing was changed.', n; end if;
  select user_id into uid from user_roles where role_key = 'admin';
  select * into s from sellers where user_id = uid;
  if s.id is null then raise exception 'The admin has no seller application. Nothing was changed.'; end if;
  if s.status <> 'submitted' then raise exception 'Application status is %, expected submitted. Nothing was changed.', s.status; end if;

  update seller_documents set status = 'accepted', reviewed_by = uid, reviewed_at = now()
   where seller_id = s.id and removed_at is null and status = 'pending';
  update seller_bank_accounts set status = 'verified', verified_by = uid, verified_at = now()
   where seller_id = s.id and status = 'pending';
  update sellers set status = 'approved', approved_at = now(), approved_by = uid where id = s.id;
  insert into user_roles (user_id, role_key, granted_by) values (uid, 'seller', uid) on conflict do nothing;
  insert into seller_status_history (seller_id, from_status, to_status, actor_id, reason)
    values (s.id, 'submitted', 'approved', uid, 'Admin self-approval by SQL');
  insert into audit_logs (actor_user_id, action, entity, entity_id, old_value, new_value)
    values (uid, 'seller.approve', 'seller', s.id::text, '{"status":"submitted"}', '{"status":"approved","reason":"admin self-approval by SQL"}');
end $$;

select s.display_name, s.status,
       (select count(*) from reloved.seller_documents d where d.seller_id = s.id and d.status = 'accepted' and d.removed_at is null) as docs_accepted,
       (select count(*) from reloved.seller_bank_accounts b where b.seller_id = s.id and b.status = 'verified') as bank_verified,
       exists (select 1 from reloved.user_roles r where r.user_id = s.user_id and r.role_key = 'seller') as has_seller_role
  from reloved.sellers s join reloved.user_roles a on a.user_id = s.user_id and a.role_key = 'admin';
