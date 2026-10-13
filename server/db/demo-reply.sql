-- Makes the demo sellers answer chats, so you can try the Inbox as a buyer.
-- Run in Supabase -> SQL Editor after you have swiped right on a few items. Every conversation with a
-- demo seller where the buyer wrote last gets one friendly reply. Run it again after more messages.

set search_path = reloved, extensions, public;

do $$
declare cv record; mid bigint; n int := 0;
  replies text[] := array[
    'Hi! Yes, it is still available. Happy to answer any questions.',
    'Hello, thanks for your interest! It is in the condition described. I can send more photos if you like.',
    'Hi there! Yes, available. I can ship within 2 days of your order.',
    'Thanks for messaging! The price is fairly firm, but I can add a small thank-you gift with the order.'];
begin
  for cv in
    select c.id, c.seller_user_id from conversations c
      join users u on u.id = c.seller_user_id and u.email like '%@demo.reloved.invalid'
     where (select m.sender_id from messages m where m.conversation_id = c.id order by m.id desc limit 1) is distinct from c.seller_user_id
       and exists (select 1 from messages m where m.conversation_id = c.id)
  loop
    insert into messages (conversation_id, sender_id, body)
      values (cv.id, cv.seller_user_id, replies[1 + floor(random() * array_length(replies, 1))::int]) returning id into mid;
    update conversations set last_message_at = now(), seller_last_read_id = mid,
           last_message_preview = (select left(body, 140) from messages where id = mid)
     where id = cv.id;
    n := n + 1;
  end loop;
  raise notice 'Sent % reply message(s).', n;
end $$;
