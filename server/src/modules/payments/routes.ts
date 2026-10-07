import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, uuid } from "../../lib/validate.js";
import { AppError, Errors } from "../../lib/errors.js";
import { CURRENCY } from "../../lib/money.js";
import { cursorTime, decodeCursor, encodeCursor, page, pageQuery } from "../../lib/pagination.js";
import { windowLimiter } from "../../lib/limiter.js";
import { authenticate, requirePermission } from "../auth/guard.js";
import * as orders from "../orders/service.js";
import { MockProvider, providerFor, type PaymentProvider } from "./provider.js";
import * as payments from "./service.js";

const idParam = z.object({ id: uuid() });
const providerId = z.string().regex(/^[A-Za-z0-9_-]{6,100}$/);

const notAvailable = () => new AppError(503, "PAYMENTS_NOT_AVAILABLE", "Online payment is not available yet.");

// ---------------- buyer ----------------

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  const provider = providerFor(app.cfg);
  app.addHook("preHandler", authenticate);
  const uid = (req: FastifyRequest) => req.auth!.userId;
  const need = (): PaymentProvider => { if (!provider) throw notAvailable(); return provider; };
  const payLimit = windowLimiter("pay", 30, 15 * 60_000, (req) => String(req.auth?.userId));

  // Start (or resume) paying for an unpaid order. The amount is always the order total from the database.
  app.post("/orders/:id/pay", { preHandler: payLimit }, async (req) => {
    const { id } = parse(idParam, req.params);
    return payments.start(app.db, need(), uid(req), id);
  });

  // The browser's confirmation after the provider's checkout. Checked with the server-side secret.
  app.post("/payments/verify", { preHandler: payLimit }, async (req) => {
    const b = parse(z.object({ providerOrderId: providerId, providerPaymentId: providerId, signature: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), req.body);
    const r = await payments.verifyFromClient(app.db, need(), uid(req), b);
    return { outcome: r.outcome, order: r.orderId ? await orders.orderDetail(app.db, r.orderId, { userId: uid(req) }) : null };
  });

  // MOCK / TEMPORARY: stands in for the provider's checkout page in development and tests. The
  // buyer "pays" (or fails); the mock gateway returns what a real one would give the browser, and
  // can also send its signed webhook. Exists only when PAYMENT_PROVIDER=mock (refused in production).
  if (provider instanceof MockProvider) {
    app.post("/payments/mock/simulate", async (req) => {
      const b = parse(z.object({
        paymentId: uuid(), outcome: z.enum(["success", "failure"]), sendWebhook: z.boolean().default(false),
        amountPaise: z.number().int().min(1).max(10_000_000_000).optional(),   // to test a wrong amount
      }).strict(), req.body);
      const p = (await app.db.query(`select * from payments where id = $1 and user_id = $2`, [b.paymentId, uid(req)])).rows[0];
      if (!p) throw Errors.notFound("Payment");
      const sim = provider.simulate(p.provider_order_id, b.outcome, b.amountPaise ?? Number(p.amount_paise));
      const webhook = b.sendWebhook ? await payments.handleWebhook(app.db, provider, sim.webhook.body, sim.webhook.headers) : null;
      return { providerOrderId: p.provider_order_id, providerPaymentId: sim.providerPaymentId, signature: sim.signature, webhook };
    });
  }
}

// ---------------- provider webhooks (no sign-in; signature required) ----------------

export async function paymentWebhookRoutes(app: FastifyInstance): Promise<void> {
  const provider = providerFor(app.cfg);
  // The signature covers the exact bytes sent, so keep them instead of re-serialising parsed JSON.
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));

  app.post("/:provider", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { provider: name } = parse(z.object({ provider: z.string().regex(/^[a-z]{2,20}$/) }), req.params);
    if (!provider || provider.name !== name) throw Errors.notFound("Route");
    if (!Buffer.isBuffer(req.body)) throw new AppError(400, "BAD_EVENT", "Send the event as JSON.");
    const r = await payments.handleWebhook(app.db, provider, req.body, req.headers);
    return reply.code(200).send({ ok: true, outcome: r.outcome });
  });
}

// ---------------- admin ----------------

const paymentOut = (p: any) => ({
  id: p.id, orderId: p.order_id, orderNumber: p.number, userId: p.user_id, provider: p.provider, providerOrderId: p.provider_order_id,
  providerPaymentId: p.provider_payment_id, status: p.status, amountPaise: Number(p.amount_paise),
  receivedPaise: p.received_paise === null ? null : Number(p.received_paise), currency: CURRENCY,
  failureReason: p.failure_reason, refundReason: p.refund_reason, capturedAt: p.captured_at, createdAt: p.created_at,
});

export async function adminPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requirePermission("admin.payments.read"));

  app.get("/", async (req) => {
    const q = parse(pageQuery.extend({ status: z.enum(["created", "captured", "failed", "needs_refund"]).optional(), orderId: uuid().optional() }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select p.*, o.number, ${cursorTime("p.created_at")} from payments p join orders o on o.id = p.order_id
        where ($1::text is null or p.status = $1) and ($2::uuid is null or p.order_id = $2)
          and ($3::timestamptz is null or (p.created_at, p.id) < ($3, $4::uuid))
        order by p.created_at desc, p.id desc limit $5`,
      [q.status ?? null, q.orderId ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
    const p = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return { items: p.items.map(paymentOut), nextCursor: p.nextCursor };
  });

  app.get("/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const p = (await app.db.query(`select p.*, o.number from payments p join orders o on o.id = p.order_id where p.id = $1`, [id])).rows[0];
    if (!p) throw Errors.notFound("Payment");
    const ev = await app.db.query(`select event_id, type, outcome, received_at from payment_events where payment_id = $1 order by id`, [id]);
    return { ...paymentOut(p), events: ev.rows.map((e) => ({ eventId: e.event_id, type: e.type, outcome: e.outcome, receivedAt: e.received_at })) };
  });
}

