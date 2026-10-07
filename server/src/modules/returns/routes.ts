import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, safeText, uuid } from "../../lib/validate.js";
import { AppError, Errors } from "../../lib/errors.js";
import { withTx } from "../../lib/db.js";
import { writeAudit } from "../../lib/audit.js";
import { CURRENCY } from "../../lib/money.js";
import { MAX_IMAGE_BYTES } from "../../lib/images.js";
import { cursorTime, decodeCursor, encodeCursor, page, pageQuery } from "../../lib/pagination.js";
import { authenticate, requirePermission } from "../auth/guard.js";
import { providerFor } from "../payments/provider.js";
import * as refunds from "../refunds/service.js";
import * as returns from "./service.js";

const idParam = z.object({ id: uuid() });
const photoParam = z.object({ id: uuid(), photoId: uuid() });
const ctxOf = (req: FastifyRequest) => ({ actorUserId: req.auth!.userId, ip: req.ip ?? null, requestId: String(req.id) });
const RETURN_STATUSES = ["requested", "approved", "rejected", "disputed", "shipped_back", "received", "refunded", "closed", "withdrawn"] as const;

const listOut = (x: any) => ({
  id: x.id, orderId: x.order_id, packageId: x.seller_order_id, status: x.status, reason: x.reason, createdAt: x.created_at,
  sellerDecideBy: x.seller_decide_by, escalateBy: x.escalate_by, shipBy: x.ship_by, receiveBy: x.receive_by,
});
async function listReturns(app: FastifyInstance, req: FastifyRequest, where: { userId?: string; sellerId?: string }) {
  const q = parse(pageQuery.extend({ status: z.enum(RETURN_STATUSES).optional() }), req.query);
  const c = decodeCursor(q.cursor);
  const r = await app.db.query(
    `select r.*, ${cursorTime("r.created_at")} from returns r
      where ($1::uuid is null or r.user_id = $1) and ($2::uuid is null or r.seller_id = $2) and ($3::text is null or r.status = $3)
        and ($4::timestamptz is null or (r.created_at, r.id) < ($4, $5::uuid))
      order by r.created_at desc, r.id desc limit $6`,
    [where.userId ?? null, where.sellerId ?? null, q.status ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
  const p = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
  return { items: p.items.map(listOut), nextCursor: p.nextCursor };
}

async function sendPhoto(reply: FastifyReply, body: Buffer) {
  return reply.header("content-type", "image/webp").header("cache-control", "private, no-store").header("x-content-type-options", "nosniff").send(body);
}

// Sends refunds created by a request right away; anything the provider does not confirm stays
// pending and is retried by the background sweep.
async function sendRefunds(app: FastifyInstance, ids: string[]) {
  const provider = providerFor(app.cfg);
  for (const id of ids) await refunds.processRefund(app.db, provider, id);
}

const shipping = { carrier: safeText(2, 60), trackingNumber: z.string().trim().regex(/^[A-Za-z0-9-]{4,60}$/, "Letters, digits and dashes") };

// ---------------- buyer ----------------

export async function buyerReturnRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const uid = (req: FastifyRequest) => req.auth!.userId;

  // Cancel one paid package that has not shipped yet. Refund: items, delivery fee, Buyer Protection share.
  app.post("/orders/:id/packages/:packageId/cancel", async (req) => {
    const p = parse(z.object({ id: uuid(), packageId: uuid() }), req.params);
    const b = parse(z.object({ reason: safeText(3, 300).optional() }).strict(), req.body ?? {});
    const refundId = await withTx(app.db, async (tx) => {
      const so = (await tx.query(`select 1 from seller_orders where id = $1 and order_id = $2`, [p.packageId, p.id])).rows[0];
      if (!so) throw Errors.notFound("Order");
      return refunds.cancelPaidPackage(tx, p.packageId, { userId: uid(req), role: "customer" }, b.reason ?? "Cancelled by the customer", { onlyUserId: uid(req) });
    });
    await sendRefunds(app, [refundId]);
    return { ok: true, refundId };
  });

  app.post("/me/return-photos", { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } }, async (req, reply) => {
    if (!req.isMultipart()) throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload the photo as multipart/form-data.");
    const tooLarge = () => new AppError(413, "FILE_TOO_LARGE", "Photos can be up to 8 MB.");
    let body: Buffer;
    try {
      const part = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 } });
      if (!part) throw Errors.validation([{ path: "file", message: "Attach a photo." }]);
      body = await part.toBuffer();
      if (part.file.truncated) throw tooLarge();
    } catch (e: any) {
      if (e instanceof AppError) throw e;
      if (e?.code === "FST_REQ_FILE_TOO_LARGE" || e?.statusCode === 413) throw tooLarge();
      throw new AppError(400, "BAD_REQUEST", "The upload could not be read. Try again.");
    }
    return reply.code(201).send(await returns.uploadPhoto(app.db, app.storage, uid(req), body));
  });

  app.post("/returns", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const b = parse(z.object({
      packageId: uuid(),
      orderItemIds: z.array(uuid()).min(1).max(50),
      reason: z.enum(["damaged", "fake"]),
      description: safeText(10, 1000),
      photoIds: z.array(uuid()).min(1, "Add at least one photo").max(5),
    }).strict(), req.body);
    const id = await returns.create(app.db, uid(req), { sellerOrderId: b.packageId, orderItemIds: b.orderItemIds, reason: b.reason, description: b.description, photoIds: b.photoIds });
    return reply.code(201).send(await returns.detail(app.db, id, { userId: uid(req) }));
  });
  app.get("/returns", async (req) => listReturns(app, req, { userId: uid(req) }));
  app.get("/returns/:id", async (req) => returns.detail(app.db, parse(idParam, req.params).id, { userId: uid(req) }));
  app.get("/returns/:id/photos/:photoId", async (req, reply) => {
    const p = parse(photoParam, req.params);
    await returns.detail(app.db, p.id, { userId: uid(req) });
    return sendPhoto(reply, await returns.readPhoto(app.db, app.storage, p.id, p.photoId));
  });
  app.post("/returns/:id/escalate", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ note: safeText(10, 1000) }).strict(), req.body);
    await returns.escalate(app.db, uid(req), id, b.note);
    return returns.detail(app.db, id, { userId: uid(req) });
  });
  app.post("/returns/:id/ship", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object(shipping).strict(), req.body);
    await returns.shipBack(app.db, uid(req), id, b.carrier, b.trackingNumber);
    return returns.detail(app.db, id, { userId: uid(req) });
  });
  app.post("/returns/:id/withdraw", async (req) => {
    const { id } = parse(idParam, req.params);
    await returns.withdraw(app.db, uid(req), id);
    return returns.detail(app.db, id, { userId: uid(req) });
  });
}

// ---------------- seller ----------------

// Sellers can answer returns and cancel unshipped packages even while suspended.
async function anySeller(req: FastifyRequest): Promise<void> {
  const s = (await req.server.db.query(`select id from sellers where user_id = $1`, [req.auth!.userId])).rows[0];
  if (!s) throw new AppError(403, "NOT_A_SELLER", "Apply to become a seller first.");
  req.seller = { id: s.id };
}

export async function sellerReturnRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", anySeller);
  const sid = (req: FastifyRequest) => req.seller!.id;
  const uid = (req: FastifyRequest) => req.auth!.userId;

  // For example the item was sold elsewhere or is lost. The buyer gets a full refund for the package.
  app.post("/orders/:id/cancel", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: safeText(5, 300), restock: z.boolean() }).strict(), req.body);
    const refundId = await withTx(app.db, (tx) => refunds.cancelPaidPackage(tx, id, { userId: uid(req), role: "seller" }, b.reason, { onlySellerId: sid(req) }, b.restock));
    await sendRefunds(app, [refundId]);
    return { ok: true, refundId };
  });

  app.get("/returns", async (req) => listReturns(app, req, { sellerId: sid(req) }));
  app.get("/returns/:id", async (req) => returns.detail(app.db, parse(idParam, req.params).id, { sellerId: sid(req) }));
  app.get("/returns/:id/photos/:photoId", async (req, reply) => {
    const p = parse(photoParam, req.params);
    await returns.detail(app.db, p.id, { sellerId: sid(req) });
    return sendPhoto(reply, await returns.readPhoto(app.db, app.storage, p.id, p.photoId));
  });
  app.post("/returns/:id/accept", async (req) => {
    const { id } = parse(idParam, req.params);
    await returns.sellerAccept(app.db, sid(req), uid(req), id);
    return returns.detail(app.db, id, { sellerId: sid(req) });
  });
  app.post("/returns/:id/reject", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: safeText(10, 500) }).strict(), req.body);
    await returns.sellerReject(app.db, sid(req), uid(req), id, b.reason);
    return returns.detail(app.db, id, { sellerId: sid(req) });
  });
  app.post("/returns/:id/received", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ condition: z.enum(["good", "damaged"]) }).strict(), req.body);
    const refundId = await returns.markReceived(app.db, { userId: uid(req), role: "seller" }, id, b.condition, { sellerId: sid(req) });
    await sendRefunds(app, [refundId]);
    return returns.detail(app.db, id, { sellerId: sid(req) });
  });
}

// ---------------- admin ----------------

const refundOut = (r: any) => ({
  id: r.id, orderId: r.order_id, paymentId: r.payment_id, packageId: r.seller_order_id, returnId: r.return_id, kind: r.kind,
  itemsPaise: Number(r.items_paise), buyerProtectionPaise: Number(r.buyer_fee_paise), deliveryPaise: Number(r.delivery_paise),
  returnShippingPaise: Number(r.return_shipping_paise), otherPaise: Number(r.other_paise), amountPaise: Number(r.amount_paise),
  sellerDebitPaise: Number(r.seller_debit_paise), sellerAccount: r.seller_account, reason: r.reason, status: r.status,
  providerRefundId: r.provider_refund_id, attempts: r.attempts, lastError: r.last_error, createdAt: r.created_at, processedAt: r.processed_at, currency: CURRENCY,
});

export async function adminReturnRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const returnsPerm = requirePermission("admin.returns.manage");
  const refundsPerm = requirePermission("admin.refunds.manage");

  const notOwn = async (req: FastifyRequest, sellerOrderId: string) => {
    const own = await app.db.query(`select 1 from seller_orders so join sellers s on s.id = so.seller_id join orders o on o.id = so.order_id
       where so.id = $1 and (s.user_id = $2 or o.user_id = $2)`, [sellerOrderId, req.auth!.userId]);
    if (own.rowCount) throw Errors.forbidden("You cannot act as admin on an order you are part of.");
  };

  app.post("/seller-orders/:id/cancel", { preHandler: returnsPerm }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: safeText(5, 300), restock: z.boolean() }).strict(), req.body);
    await notOwn(req, id);
    const refundId = await withTx(app.db, async (tx) => {
      const rid = await refunds.cancelPaidPackage(tx, id, { userId: req.auth!.userId, role: "admin" }, b.reason, {}, b.restock);
      await writeAudit(tx, { ...ctxOf(req), action: "seller_order.admin_cancel", entity: "seller_order", entityId: id, newValue: b });
      return rid;
    });
    await sendRefunds(app, [refundId]);
    return { ok: true, refundId };
  });

  app.get("/returns", { preHandler: returnsPerm }, async (req) => listReturns(app, req, {}));
  app.get("/returns/:id", { preHandler: returnsPerm }, async (req) => returns.detail(app.db, parse(idParam, req.params).id, { admin: true }));
  app.get("/returns/:id/photos/:photoId", { preHandler: returnsPerm }, async (req, reply) => {
    const p = parse(photoParam, req.params);
    return sendPhoto(reply, await returns.readPhoto(app.db, app.storage, p.id, p.photoId));
  });
  app.post("/returns/:id/decide", { preHandler: returnsPerm }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: safeText(5, 500) }).strict(), req.body);
    const r = (await app.db.query(`select seller_order_id from returns where id = $1`, [id])).rows[0];
    if (!r) throw Errors.notFound("Return");
    await notOwn(req, r.seller_order_id);
    await returns.adminDecide(app.db, req.auth!.userId, id, b.approve, b.note,
      (tx) => writeAudit(tx, { ...ctxOf(req), action: "return.admin_decide", entity: "return", entityId: id, newValue: b }));
    return returns.detail(app.db, id, { admin: true });
  });
  app.post("/returns/:id/received", { preHandler: returnsPerm }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ condition: z.enum(["good", "damaged"]), note: safeText(5, 500) }).strict(), req.body);
    const r = (await app.db.query(`select seller_order_id from returns where id = $1`, [id])).rows[0];
    if (!r) throw Errors.notFound("Return");
    await notOwn(req, r.seller_order_id);
    const refundId = await returns.markReceived(app.db, { userId: req.auth!.userId, role: "admin" }, id, b.condition, {}, b.note,
      (tx) => writeAudit(tx, { ...ctxOf(req), action: "return.admin_received", entity: "return", entityId: id, newValue: b }));
    await sendRefunds(app, [refundId]);
    return returns.detail(app.db, id, { admin: true });
  });

  app.get("/refunds", { preHandler: refundsPerm }, async (req) => {
    const q = parse(pageQuery.extend({ status: z.enum(["pending", "processed"]).optional(), orderId: uuid().optional() }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select f.*, ${cursorTime("f.created_at")} from refunds f
        where ($1::text is null or f.status = $1) and ($2::uuid is null or f.order_id = $2)
          and ($3::timestamptz is null or (f.created_at, f.id) < ($3, $4::uuid))
        order by f.created_at desc, f.id desc limit $5`,
      [q.status ?? null, q.orderId ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
    const p = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return { items: p.items.map(refundOut), nextCursor: p.nextCursor };
  });
  app.post("/refunds/:id/retry", { preHandler: refundsPerm }, async (req) => {
    const { id } = parse(idParam, req.params);
    await refunds.processRefund(app.db, providerFor(app.cfg), id);
    return refundOut((await app.db.query(`select * from refunds where id = $1`, [id])).rows[0]);
  });
  // Gives back a payment that could not be applied to its order (status needs_refund).
  app.post("/payments/:id/refund", { preHandler: refundsPerm }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: safeText(5, 300) }).strict(), req.body);
    const refundId = await refunds.createUnappliedRefund(app.db, id, req.auth!.userId, b.reason,
      (tx, rid) => writeAudit(tx, { ...ctxOf(req), action: "payment.refund", entity: "payment", entityId: id, newValue: { ...b, refundId: rid } }));
    await sendRefunds(app, [refundId]);
    return refundOut((await app.db.query(`select * from refunds where id = $1`, [refundId])).rows[0]);
  });
}
