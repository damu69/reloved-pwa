import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, safeText, uuid } from "../../lib/validate.js";
import { AppError, Errors } from "../../lib/errors.js";
import { withTx } from "../../lib/db.js";
import { writeAudit } from "../../lib/audit.js";
import { CURRENCY } from "../../lib/money.js";
import { cursorTime, decodeCursor, encodeCursor, page, pageQuery } from "../../lib/pagination.js";
import { windowLimiter } from "../../lib/limiter.js";
import { authenticate, requirePermission } from "../auth/guard.js";
import { requireApprovedSeller } from "../sellers/guard.js";
import * as orders from "./service.js";
import * as refunds from "../refunds/service.js";
import { providerFor } from "../payments/provider.js";

const idParam = z.object({ id: uuid() });

// ---------------- addresses ----------------

const addressFields = {
  name: safeText(2, 80),
  phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, "Use 10 to 15 digits, optionally starting with +"),
  line1: safeText(3, 200),
  line2: safeText(1, 200).nullable().optional(),
  landmark: safeText(1, 100).nullable().optional(),
  city: safeText(2, 80),
  state: safeText(2, 80),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, "Enter a 6-digit PIN code"),
  isDefault: z.boolean().optional(),
};
const addrOut = (a: any) => ({ id: a.id, name: a.name, phone: a.phone, line1: a.line1, line2: a.line2, landmark: a.landmark, city: a.city, state: a.state, pincode: a.pincode, isDefault: a.is_default });

export async function addressRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const uid = (req: FastifyRequest) => req.auth!.userId;

  app.get("/", async (req) => {
    const r = await app.db.query(`select * from addresses where user_id = $1 and deleted_at is null order by is_default desc, created_at`, [uid(req)]);
    return { items: r.rows.map(addrOut) };
  });

  app.post("/", async (req, reply) => {
    const b = parse(z.object(addressFields).strict(), req.body);
    const a = await withTx(app.db, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('addresses:' || $1, 0))`, [uid(req)]);
      const n = (await tx.query(`select count(*)::int n, bool_or(is_default) d from addresses where user_id = $1 and deleted_at is null`, [uid(req)])).rows[0];
      if (n.n >= 20) throw Errors.conflict("ADDRESS_LIMIT", "You can save up to 20 addresses.");
      const makeDefault = b.isDefault === true || !n.d;
      if (makeDefault) await tx.query(`update addresses set is_default = false where user_id = $1 and is_default`, [uid(req)]);
      return (await tx.query(
        `insert into addresses (user_id, name, phone, line1, line2, landmark, city, state, pincode, is_default)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [uid(req), b.name, b.phone, b.line1, b.line2 ?? null, b.landmark ?? null, b.city, b.state, b.pincode, makeDefault])).rows[0];
    });
    return reply.code(201).send(addrOut(a));
  });

  // Editing creates no history problem: orders keep their own copy of the address.
  app.patch("/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object(addressFields).partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to update"), req.body);
    const a = await withTx(app.db, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('addresses:' || $1, 0))`, [uid(req)]);
      const cur = (await tx.query(`select * from addresses where id = $1 and user_id = $2 and deleted_at is null`, [id, uid(req)])).rows[0];
      if (!cur) throw Errors.notFound("Address");
      if (b.isDefault === false && cur.is_default) throw Errors.invalidTransition("Choose another default address instead.");
      if (b.isDefault) await tx.query(`update addresses set is_default = false where user_id = $1 and is_default and id <> $2`, [uid(req), id]);
      return (await tx.query(
        `update addresses set name = coalesce($3, name), phone = coalesce($4, phone), line1 = coalesce($5, line1),
                line2 = case when $6::boolean then $7 else line2 end, landmark = case when $8::boolean then $9 else landmark end,
                city = coalesce($10, city), state = coalesce($11, state), pincode = coalesce($12, pincode), is_default = coalesce($13, is_default)
          where id = $1 and user_id = $2 returning *`,
        [id, uid(req), b.name ?? null, b.phone ?? null, b.line1 ?? null, b.line2 !== undefined, b.line2 ?? null, b.landmark !== undefined, b.landmark ?? null,
         b.city ?? null, b.state ?? null, b.pincode ?? null, b.isDefault ?? null])).rows[0];
    });
    return addrOut(a);
  });

  app.delete("/:id", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await withTx(app.db, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('addresses:' || $1, 0))`, [uid(req)]);
      const r = await tx.query(`update addresses set deleted_at = now(), is_default = false where id = $1 and user_id = $2 and deleted_at is null returning is_default`, [id, uid(req)]);
      if (!r.rowCount) throw Errors.notFound("Address");
      // Keep a default if any address remains.
      await tx.query(
        `update addresses set is_default = true where id = (
           select id from addresses where user_id = $1 and deleted_at is null order by created_at limit 1)
         and not exists (select 1 from addresses where user_id = $1 and deleted_at is null and is_default)`, [uid(req)]);
    });
    return reply.code(204).send();
  });
}

// ---------------- checkout and customer orders ----------------

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const uid = (req: FastifyRequest) => req.auth!.userId;
  const checkoutLimit = windowLimiter("checkout", 20, 15 * 60_000, (req) => String(req.auth?.userId));

  app.post("/checkout", { preHandler: checkoutLimit }, async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
      throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Send a unique Idempotency-Key header (8 to 100 letters, digits, - or _) with each checkout.");
    }
    const b = parse(z.object({ addressId: uuid(), expectedTotalPaise: z.number().int().min(0).max(10_000_000_000) }).strict(), req.body);
    const res = await orders.checkout(app.db, uid(req), { ...b, idempotencyKey: key }, app.cfg.PAYMENT_WINDOW_MINUTES);
    return reply.code(res.replayed ? 200 : 201).send({
      ...(await orders.orderDetail(app.db, res.orderId, { userId: uid(req) })),
      // Next step for the buyer: POST /orders/:id/pay. With no provider configured the order waits
      // for the payment window and is then cancelled automatically.
      payment: app.cfg.PAYMENT_PROVIDER === "none" ? { provider: "none", available: false } : { provider: app.cfg.PAYMENT_PROVIDER, available: true },
    });
  });

  app.get("/orders", async (req) => {
    const q = parse(pageQuery.extend({ status: z.string().regex(/^[a-z_]{3,30}$/).optional() }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select o.id, o.number, o.status, o.payment_status, o.total_paise, o.placed_at, ${cursorTime("o.placed_at")},
              (select count(*)::int from order_items i where i.order_id = o.id) as item_count
         from orders o
        where o.user_id = $1 and ($2::text is null or o.status = $2)
          and ($3::timestamptz is null or (o.placed_at, o.id) < ($3, $4::uuid))
        order by o.placed_at desc, o.id desc limit $5`,
      [uid(req), q.status ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1],
    );
    const p = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return { items: p.items.map((x: any) => ({ id: x.id, number: x.number, status: x.status, paymentStatus: x.payment_status, totalPaise: Number(x.total_paise), currency: CURRENCY, itemCount: x.item_count, placedAt: x.placed_at })), nextCursor: p.nextCursor };
  });

  app.get("/orders/:id", async (req) => orders.orderDetail(app.db, parse(idParam, req.params).id, { userId: uid(req) }));

  // Before payment: the order is simply cancelled. After payment: every package is cancelled and
  // refunded, as long as none has shipped.
  app.post("/orders/:id/cancel", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: safeText(3, 300).optional() }).strict(), req.body ?? {});
    const o = (await app.db.query(`select payment_status from orders where id = $1 and user_id = $2`, [id, uid(req)])).rows[0];
    if (!o) throw Errors.notFound("Order");
    if (o.payment_status === "unpaid") await orders.cancelByCustomer(app.db, uid(req), id);
    else {
      const ids = await withTx(app.db, (tx) => refunds.cancelPaidOrder(tx, uid(req), id, b.reason ?? "Cancelled by the customer"));
      const provider = providerFor(app.cfg);
      for (const rid of ids) await refunds.processRefund(app.db, provider, rid);
    }
    return orders.orderDetail(app.db, id, { userId: uid(req) });
  });
}

// ---------------- seller orders ----------------

const statusBody = z.object({
  to: z.enum(["processing", "shipped", "out_for_delivery", "delivered", "cancelled"]),
  carrier: safeText(2, 60).optional(),
  trackingNumber: z.string().trim().regex(/^[A-Za-z0-9-]{4,60}$/, "Letters, digits and dashes").optional(),
  reason: safeText(3, 300).optional(),
}).strict();

export async function sellerOrderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireApprovedSeller);
  const sid = (req: FastifyRequest) => req.seller!.id;

  app.get("/", async (req) => {
    const q = parse(pageQuery.extend({ status: z.enum(["pending_payment", "confirmed", "processing", "shipped", "out_for_delivery", "delivered", "cancelled"]).optional() }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select so.id, so.order_id, so.number, so.status, so.items_net_paise, so.delivery_code, so.created_at, ${cursorTime("so.created_at")},
              (select count(*)::int from order_items i where i.seller_order_id = so.id) as item_count
         from seller_orders so
        where so.seller_id = $1 and ($2::text is null or so.status = $2)
          and ($3::timestamptz is null or (so.created_at, so.id) < ($3, $4::uuid))
        order by so.created_at desc, so.id desc limit $5`,
      [sid(req), q.status ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1],
    );
    const p = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return { items: p.items.map((x: any) => ({ id: x.id, orderId: x.order_id, number: x.number, status: x.status, itemsNetPaise: Number(x.items_net_paise), currency: CURRENCY, deliveryCode: x.delivery_code, itemCount: x.item_count, createdAt: x.created_at })), nextCursor: p.nextCursor };
  });

  app.get("/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const so = (await app.db.query(`select order_id from seller_orders where id = $1 and seller_id = $2`, [id, sid(req)])).rows[0];
    if (!so) throw Errors.notFound("Order");
    return orders.orderDetail(app.db, so.order_id, { sellerId: sid(req) });
  });

  app.post("/:id/status", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(statusBody, req.body);
    await orders.moveSellerOrder(app.db, id, b, { userId: req.auth!.userId, role: "seller" }, sid(req));
    const so = (await app.db.query(`select status from seller_orders where id = $1`, [id])).rows[0];
    return { ok: true, status: so.status };
  });
}

// ---------------- admin ----------------

export async function adminOrderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const read = requirePermission("admin.orders.read");
  const manage = requirePermission("admin.orders.manage");

  app.get("/orders", { preHandler: read }, async (req) => {
    const q = parse(pageQuery.extend({ status: z.string().regex(/^[a-z_]{3,30}$/).optional(), userId: uuid().optional(), sellerId: uuid().optional(), number: z.string().regex(/^RL[0-9]{4,12}$/).optional() }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select o.id, o.number, o.status, o.payment_status, o.total_paise, o.user_id, o.placed_at, ${cursorTime("o.placed_at")}
         from orders o
        where ($1::text is null or o.status = $1) and ($2::uuid is null or o.user_id = $2)
          and ($3::uuid is null or exists (select 1 from seller_orders so where so.order_id = o.id and so.seller_id = $3))
          and ($4::text is null or o.number = $4)
          and ($5::timestamptz is null or (o.placed_at, o.id) < ($5, $6::uuid))
        order by o.placed_at desc, o.id desc limit $7`,
      [q.status ?? null, q.userId ?? null, q.sellerId ?? null, q.number ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1],
    );
    const p = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return { items: p.items.map((x: any) => ({ id: x.id, number: x.number, status: x.status, paymentStatus: x.payment_status, totalPaise: Number(x.total_paise), currency: CURRENCY, userId: x.user_id, placedAt: x.placed_at })), nextCursor: p.nextCursor };
  });

  app.get("/orders/:id", { preHandler: read }, async (req) => orders.orderDetail(app.db, parse(idParam, req.params).id, { admin: true }));

  // Acting for a seller (for example a courier update by phone). A reason is required and audited.
  app.post("/seller-orders/:id/status", { preHandler: manage }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(statusBody.extend({ reason: safeText(3, 300) }), req.body);
    const own = await app.db.query(`select 1 from seller_orders so join sellers s on s.id = so.seller_id join orders o on o.id = so.order_id
       where so.id = $1 and (s.user_id = $2 or o.user_id = $2)`, [id, req.auth!.userId]);
    if (own.rowCount) throw Errors.forbidden("You cannot act as admin on an order you are part of.");
    // The audit row is written in the same transaction as the change: both happen or neither.
    const orderStatus = await orders.moveSellerOrder(app.db, id, b, { userId: req.auth!.userId, role: "admin" }, null,
      (tx) => writeAudit(tx, { actorUserId: req.auth!.userId, ip: req.ip ?? null, requestId: String(req.id), action: "seller_order.admin_status", entity: "seller_order", entityId: id, newValue: b }));
    return { ok: true, orderStatus };
  });
}
