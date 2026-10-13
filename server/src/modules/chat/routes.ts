import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, uuid } from "../../lib/validate.js";
import { Errors } from "../../lib/errors.js";
import { withTx, type Queryable } from "../../lib/db.js";
import { windowLimiter } from "../../lib/limiter.js";
import { authenticate } from "../auth/guard.js";

// Plain text only. Line breaks are kept; other control characters (null bytes and so on) are refused.
const messageText = z.string().trim().min(1, "Write a message first").max(1000, "Messages can be up to 1000 characters")
  .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), "Contains invalid characters")
  .transform((s) => s.replace(/\r\n?/g, "\n"));

const idParam = z.object({ id: uuid() });
const preview = (s: string) => s.replace(/\s+/g, " ").slice(0, 140);

// One conversation as the signed-in user sees it: the other side's name, the item, and what is unread.
const SUMMARY = `
  select c.id, c.product_id, c.last_message_at, c.last_message_preview,
         (c.buyer_id = $1) as is_buyer,
         p.title as product_title,
         case when c.buyer_id = $1 then s.display_name::text else split_part(u.full_name, ' ', 1) end as other_name,
         (select pi.id from product_images pi where pi.product_id = p.id and pi.status in ('active', 'pending_remove')
           order by pi.sort_order, pi.created_at limit 1) as cover_image_id,
         (select count(*)::int from messages m
           where m.conversation_id = c.id and m.sender_id <> $1
             and m.id > case when c.buyer_id = $1 then c.buyer_last_read_id else c.seller_last_read_id end) as unread
    from conversations c
    join products p on p.id = c.product_id
    join sellers s on s.id = c.seller_id
    join users u on u.id = c.buyer_id`;

const summaryOut = (r: any) => ({
  id: r.id, productId: r.product_id, productTitle: r.product_title, coverImageId: r.cover_image_id,
  role: r.is_buyer ? "buyer" : "seller", otherName: r.other_name,
  lastMessageAt: r.last_message_at, lastMessagePreview: r.last_message_preview, unread: r.unread,
});

async function summaryFor(db: Queryable, convoId: string, userId: string) {
  const r = await db.query(`${SUMMARY} where c.id = $2 and (c.buyer_id = $1 or c.seller_user_id = $1)`, [userId, convoId]);
  if (!r.rowCount) throw Errors.notFound("Conversation");
  return summaryOut(r.rows[0]);
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const uid = (req: FastifyRequest) => req.auth!.userId;
  const sendLimit = windowLimiter("chat-send", 40, 60_000, uid);
  const startLimit = windowLimiter("chat-start", 40, 60 * 60_000, uid);

  // Conversations the user is part of, newest activity first.
  app.get("/conversations", async (req) => {
    const r = await app.db.query(`${SUMMARY} where c.buyer_id = $1 or c.seller_user_id = $1 order by c.last_message_at desc, c.id desc limit 100`, [uid(req)]);
    return { items: r.rows.map(summaryOut) };
  });

  // Cheap check used for the badge on the Inbox tab.
  app.get("/unread", async (req) => {
    const r = await app.db.query(
      `select coalesce(sum(n), 0)::int as messages, count(*) filter (where n > 0)::int as conversations from (
         select (select count(*) from messages m
                  where m.conversation_id = c.id and m.sender_id <> $1
                    and m.id > case when c.buyer_id = $1 then c.buyer_last_read_id else c.seller_last_read_id end) as n
           from conversations c where c.buyer_id = $1 or c.seller_user_id = $1) t`,
      [uid(req)],
    );
    return { messages: r.rows[0].messages, conversations: r.rows[0].conversations };
  });

  // Start (or reopen) the conversation about a product, optionally with a first message.
  app.post("/conversations", { preHandler: [startLimit] }, async (req, reply) => {
    const b = parse(z.object({ productId: uuid(), message: messageText.optional() }).strict(), req.body);
    const out = await withTx(app.db, async (tx) => {
      const p = await tx.query(
        `select p.id, s.id as seller_id, s.user_id as seller_user_id
           from products p join sellers s on s.id = p.seller_id
          where p.id = $1 and p.status = 'active' and p.deleted_at is null and s.status = 'approved'`,
        [b.productId],
      );
      if (!p.rowCount) throw Errors.notFound("Item");
      const prod = p.rows[0];
      if (prod.seller_user_id === uid(req)) throw Errors.conflict("OWN_PRODUCT", "This is your own listing.");
      const ins = await tx.query(
        `insert into conversations (product_id, buyer_id, seller_id, seller_user_id) values ($1, $2, $3, $4)
         on conflict (buyer_id, product_id) do nothing returning id`,
        [prod.id, uid(req), prod.seller_id, prod.seller_user_id],
      );
      const created = ins.rowCount === 1;
      const id: string = created ? ins.rows[0].id : (await tx.query(`select id from conversations where buyer_id = $1 and product_id = $2`, [uid(req), prod.id])).rows[0].id;
      if (b.message) {
        const m = await tx.query(`insert into messages (conversation_id, sender_id, body) values ($1, $2, $3) returning id`, [id, uid(req), b.message]);
        await tx.query(`update conversations set last_message_at = now(), last_message_preview = $2, buyer_last_read_id = $3 where id = $1`, [id, preview(b.message), m.rows[0].id]);
      }
      return { id, created };
    });
    return reply.code(out.created ? 201 : 200).send({ ...(await summaryFor(app.db, out.id, uid(req))), created: out.created });
  });

  // Messages in a conversation. `after` returns only newer ones (used for polling); without it, the latest 60.
  // Opening a conversation marks everything in it as read for this user.
  app.get("/conversations/:id/messages", async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ after: z.coerce.number().int().min(0).optional() }), req.query);
    const convo = await summaryFor(app.db, id, uid(req));
    const r = q.after === undefined
      ? await app.db.query(`select * from (select id, sender_id, body, created_at from messages where conversation_id = $1 order by id desc limit 60) t order by id`, [id])
      : await app.db.query(`select id, sender_id, body, created_at from messages where conversation_id = $1 and id > $2 order by id limit 100`, [id, q.after]);
    await app.db.query(
      `update conversations set
         buyer_last_read_id  = case when buyer_id = $2 then greatest(buyer_last_read_id, m.mx) else buyer_last_read_id end,
         seller_last_read_id = case when seller_user_id = $2 then greatest(seller_last_read_id, m.mx) else seller_last_read_id end
        from (select coalesce(max(id), 0) as mx from messages where conversation_id = $1) m
       where conversations.id = $1`,
      [id, uid(req)],
    );
    return {
      conversation: { ...convo, unread: 0 },
      items: r.rows.map((m: any) => ({ id: Number(m.id), mine: m.sender_id === uid(req), body: m.body, createdAt: m.created_at })),
    };
  });

  app.post("/conversations/:id/messages", { preHandler: [sendLimit] }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ body: messageText }).strict(), req.body);
    const m = await withTx(app.db, async (tx) => {
      const c = await tx.query(`select buyer_id, seller_user_id from conversations where id = $1 for update`, [id]);
      const row = c.rows[0];
      if (!row || (row.buyer_id !== uid(req) && row.seller_user_id !== uid(req))) throw Errors.notFound("Conversation");
      const ins = await tx.query(`insert into messages (conversation_id, sender_id, body) values ($1, $2, $3) returning id, created_at`, [id, uid(req), b.body]);
      const col = row.buyer_id === uid(req) ? "buyer_last_read_id" : "seller_last_read_id";
      await tx.query(`update conversations set last_message_at = $2, last_message_preview = $3, ${col} = $4 where id = $1`, [id, ins.rows[0].created_at, preview(b.body), ins.rows[0].id]);
      return ins.rows[0];
    });
    return reply.code(201).send({ id: Number(m.id), mine: true, body: b.body, createdAt: m.created_at });
  });
}
