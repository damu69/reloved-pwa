import { createHash, randomUUID } from "node:crypto";
import type { Db, Queryable, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { CURRENCY } from "../../lib/money.js";
import * as inv from "../inventory/service.js";
import * as cart from "../cart/service.js";

export type Actor = { userId: string | null; role: "customer" | "seller" | "admin" | "system" };
export type SellerOrderStatus = "pending_payment" | "confirmed" | "processing" | "shipped" | "out_for_delivery" | "delivered" | "cancelled";

// ---------- helpers ----------

async function event(tx: Tx, sellerOrderId: string, from: string | null, to: string, actor: Actor, reason?: string | null) {
  await tx.query(
    `insert into seller_order_events (seller_order_id, from_status, to_status, actor_id, actor_role, reason) values ($1, $2, $3, $4, $5, $6)`,
    [sellerOrderId, from, to, actor.userId, actor.role, reason ?? null],
  );
}

export async function outbox(tx: Tx, type: string, aggregate: string, aggregateId: string, payload: object = {}) {
  await tx.query(`insert into outbox_events (type, aggregate, aggregate_id, payload) values ($1, $2, $3, $4)`, [type, aggregate, aggregateId, JSON.stringify(payload)]);
}

// The customer-facing status follows from the seller packages; it is never set by hand.
export function deriveOrderStatus(statuses: SellerOrderStatus[]): string {
  const live = statuses.filter((s) => s !== "cancelled");
  if (!live.length) return "cancelled";
  if (live.every((s) => s === "pending_payment")) return "pending_payment";
  if (live.every((s) => s === "delivered")) return "delivered";
  if (live.some((s) => s === "delivered")) return "partially_delivered";
  const out = live.filter((s) => s === "shipped" || s === "out_for_delivery");
  if (out.length === live.length) return "shipped";
  if (out.length) return "partially_shipped";
  if (live.some((s) => s === "processing")) return "processing";
  return "confirmed";
}

async function syncOrderStatus(tx: Tx, orderId: string) {
  const r = await tx.query(`select status from seller_orders where order_id = $1`, [orderId]);
  const s = deriveOrderStatus(r.rows.map((x) => x.status));
  await tx.query(`update orders set status = $2 where id = $1 and status <> $2`, [orderId, s]);
  return s;
}

// ---------- checkout ----------

export interface CheckoutInput { addressId: string; expectedTotalPaise: number; idempotencyKey: string }

// Creates one order (with one package per seller) from the cart, holds the stock and reserves one
// use of the coupon, all in one transaction. Repeating the call with the same Idempotency-Key and
// body returns the same order; a different body with the same key is refused.
export async function checkout(db: Db, userId: string, input: CheckoutInput, paymentWindowMinutes: number): Promise<{ orderId: string; replayed: boolean }> {
  const requestHash = createHash("sha256").update(JSON.stringify({ a: input.addressId, t: input.expectedTotalPaise })).digest("hex");
  const replay = async (q: Queryable) => {
    const r = await q.query(`select id, request_hash from orders where user_id = $1 and idempotency_key = $2`, [userId, input.idempotencyKey]);
    if (!r.rows[0]) return null;
    if (r.rows[0].request_hash !== requestHash) {
      throw new AppError(422, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different checkout.");
    }
    return r.rows[0].id as string;
  };
  const earlier = await replay(db);
  if (earlier) return { orderId: earlier, replayed: true };

  return withTx(db, async (tx) => {
    // One checkout per customer at a time; the second waits, then sees the first one's result.
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('checkout:' || $1, 0))`, [userId]);
    const again = await replay(tx);
    if (again) return { orderId: again, replayed: true };

    const pending = (await tx.query(`select id, number from orders where user_id = $1 and status = 'pending_payment'`, [userId])).rows[0];
    if (pending) {
      throw new AppError(409, "PENDING_ORDER_EXISTS", "You have an unpaid order. Pay for it or cancel it first.", { orderId: pending.id, number: pending.number });
    }

    const addr = (await tx.query(`select * from addresses where id = $1 and user_id = $2 and deleted_at is null`, [input.addressId, userId])).rows[0];
    if (!addr) throw Errors.notFound("Address");

    await cart.lockCart(tx, userId);
    const { view, internal } = await cart.compute(tx, userId);
    if (!view.canCheckout) {
      throw new AppError(409, "CART_NOT_READY", "Some items in your cart need attention.",
        view.items.filter((i) => i.problems.some((p) => p.code !== "PRICE_CHANGED")).map((i) => ({ variantId: i.variantId, problems: i.problems })));
    }
    if (internal.couponId && view.coupon?.problem) {
      throw new AppError(409, "COUPON_PROBLEM", view.coupon.problem.message, { code: view.coupon.problem.code });
    }
    const q = internal.quote;
    if (q.totalPaise !== input.expectedTotalPaise) {
      throw new AppError(409, "TOTAL_CHANGED", "The total changed. Please review your cart.", { totalPaise: q.totalPaise });
    }

    const orderId = randomUUID();

    // Coupon: per-customer limit, first-order rule, and one use from the overall limit.
    if (internal.couponRule) {
      const c = (await tx.query(`select * from coupons where id = $1`, [internal.couponRule.id])).rows[0];
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('coupon_user:' || $1 || ':' || $2, 0))`, [c.id, userId]);
      const used = await tx.query(`select count(*)::int n from coupon_redemptions where coupon_id = $1 and user_id = $2 and status <> 'released'`, [c.id, userId]);
      if (used.rows[0].n >= c.per_user_limit) throw new AppError(409, "COUPON_LIMIT_REACHED", "You have already used this code the maximum number of times.");
      if (c.first_order_only) {
        const prior = await tx.query(`select 1 from orders where user_id = $1 and paid_at is not null limit 1`, [userId]);
        if (prior.rowCount) throw new AppError(409, "COUPON_FIRST_ORDER_ONLY", "This code is only for your first order.");
      }
      const take = await tx.query(
        `update coupons set used_count = used_count + 1
          where id = $1 and is_active and starts_at <= now() and (ends_at is null or ends_at > now())
            and (usage_limit is null or used_count < usage_limit)
          returning id`, [c.id]);
      if (!take.rowCount) throw new AppError(409, "COUPON_PROBLEM", "This code has just run out or expired.");
    }

    // Hold the stock (all-or-nothing; OUT_OF_STOCK rolls everything back).
    const lines = q.packages.flatMap((p) => p.lines);
    const holds = await inv.reserve(tx, lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      { ownerUserId: userId, referenceType: "order", referenceId: orderId, ttlMinutes: paymentWindowMinutes });
    const holdByVariant = new Map(holds.map((h) => [h.variantId, h]));

    const seq = (await tx.query(`select nextval('order_number_seq') as n`)).rows[0].n;
    const number = `RL${seq}`;
    const st = internal.settings;
    const address = {
      name: addr.name, phone: addr.phone, line1: addr.line1, line2: addr.line2, landmark: addr.landmark,
      city: addr.city, state: addr.state, pincode: addr.pincode,
    };
    await tx.query(
      `insert into orders (id, number, user_id, items_subtotal_paise, discount_paise, items_net_paise, delivery_paise, buyer_fee_paise, total_paise,
                           gst_included_paise, buyer_fee_fixed_paise, buyer_fee_bp, coupon_id, coupon_code, shipping_address,
                           idempotency_key, request_hash, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [orderId, number, userId, q.itemsSubtotalPaise, q.discountPaise, q.itemsNetPaise, q.deliveryPaise, q.buyerFeePaise, q.totalPaise,
       q.gstIncludedInItemsPaise, st.buyerFeeFixedPaise, st.buyerFeeBp, q.coupon ? internal.couponRule!.id : null, q.coupon?.code ?? null,
       JSON.stringify(address), input.idempotencyKey, requestHash, holds[0]!.expiresAt],
    );
    let n = 0;
    for (const p of q.packages) {
      const soId = randomUUID();
      const sub = p.lines.reduce((a, l) => a + l.subtotalPaise, 0);
      const disc = p.lines.reduce((a, l) => a + l.discountPaise, 0);
      await tx.query(
        `insert into seller_orders (id, order_id, seller_id, number, items_subtotal_paise, discount_paise, items_net_paise, delivery_code, delivery_label, delivery_paise)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [soId, orderId, p.sellerId, `${number}-${++n}`, sub, disc, p.itemsNetPaise, p.delivery.code, p.delivery.label, p.delivery.feePaise],
      );
      for (const l of p.lines) {
        const f = internal.facts.get(l.variantId);
        const h = holdByVariant.get(l.variantId)!;
        await tx.query(
          `insert into order_items (order_id, seller_order_id, variant_id, product_id, warehouse_id, reservation_id, title, sku, options,
                                    unit_price_paise, quantity, subtotal_paise, discount_paise, net_paise, gst_rate_bp, gst_included_paise)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [orderId, soId, l.variantId, f.product_id, h.warehouseId, h.id, f.title, f.sku, JSON.stringify(f.options),
           l.unitPricePaise, l.quantity, l.subtotalPaise, l.discountPaise, l.netPaise, l.gstRateBp, l.gstIncludedPaise],
        );
      }
      await event(tx, soId, null, "pending_payment", { userId, role: "customer" });
    }
    if (q.coupon) {
      await tx.query(`insert into coupon_redemptions (coupon_id, order_id, user_id, discount_paise) values ($1, $2, $3, $4)`,
        [internal.couponRule!.id, orderId, userId, q.coupon.discountPaise]);
    }
    await outbox(tx, "order.placed", "order", orderId, { number, totalPaise: q.totalPaise });
    return { orderId, replayed: false };
  });
}

// ---------- payment confirmation (the ONLY way an order becomes paid) ----------

// Called by the payment module after the payment is verified on the server (step 10). Safe to call
// twice: a paid order is left as it is. If the order was already cancelled (for example the payment
// window passed), nothing changes and ORDER_NOT_PAYABLE tells the caller to refund the payment.
export async function confirmPayment(tx: Tx, orderId: string): Promise<{ alreadyPaid: boolean }> {
  const o = (await tx.query(`select * from orders where id = $1 for update`, [orderId])).rows[0];
  if (!o) throw Errors.notFound("Order");
  if (o.payment_status === "paid") return { alreadyPaid: true };
  if (o.status !== "pending_payment") {
    throw new AppError(409, "ORDER_NOT_PAYABLE", "This order was cancelled before payment arrived. The payment must be refunded.");
  }
  const holds = (await tx.query(`select reservation_id from order_items where order_id = $1`, [orderId])).rows.map((r) => r.reservation_id);
  await inv.convert(tx, holds); // throws RESERVATION_NOT_ACTIVE if the stock was released
  await tx.query(`update orders set status = 'confirmed', payment_status = 'paid', paid_at = now() where id = $1`, [orderId]);
  const sos = (await tx.query(`update seller_orders set status = 'confirmed', confirmed_at = now() where order_id = $1 returning id, seller_id`, [orderId])).rows;
  for (const so of sos) {
    await event(tx, so.id, "pending_payment", "confirmed", { userId: null, role: "system" }, "Payment received");
    await outbox(tx, "seller_order.confirmed", "seller_order", so.id, { sellerId: so.seller_id, orderNumber: o.number });
  }
  await tx.query(`update coupon_redemptions set status = 'confirmed' where order_id = $1`, [orderId]);
  // The bought items leave the cart.
  await tx.query(
    `delete from cart_items ci using carts c where ci.cart_id = c.id and c.user_id = $1
        and ci.variant_id in (select variant_id from order_items where order_id = $2)`, [o.user_id, orderId]);
  await tx.query(`update carts set coupon_id = null where user_id = $1 and coupon_id = $2`, [o.user_id, o.coupon_id]);
  await outbox(tx, "order.confirmed", "order", orderId, { number: o.number, totalPaise: Number(o.total_paise) });
  return { alreadyPaid: false };
}

// ---------- cancelling unpaid orders ----------

// Lock order everywhere: order row, then the coupon row, then products (stock). Checkout takes the
// coupon row before the products too, so the two can never wait on each other in a cycle.
async function cancelUnpaidLocked(tx: Tx, o: any, actor: Actor, reason: string) {
  const red = await tx.query(`update coupon_redemptions set status = 'released' where order_id = $1 and status = 'reserved' returning coupon_id`, [o.id]);
  for (const r of red.rows) await tx.query(`update coupons set used_count = used_count - 1 where id = $1 and used_count > 0`, [r.coupon_id]);
  const holds = (await tx.query(`select reservation_id from order_items where order_id = $1`, [o.id])).rows.map((r) => r.reservation_id);
  await inv.release(tx, holds, "release", actor.userId);
  await tx.query(`update orders set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1`, [o.id, reason]);
  const sos = (await tx.query(
    `update seller_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where order_id = $1 and status = 'pending_payment' returning id`,
    [o.id, reason])).rows;
  for (const so of sos) await event(tx, so.id, "pending_payment", "cancelled", actor, reason);
  await outbox(tx, "order.cancelled", "order", o.id, { number: o.number, reason });
}

export async function cancelByCustomer(db: Db, userId: string, orderId: string): Promise<void> {
  await withTx(db, async (tx) => {
    const o = (await tx.query(`select * from orders where id = $1 and user_id = $2 for update`, [orderId, userId])).rows[0];
    if (!o) throw Errors.notFound("Order");
    if (o.status === "cancelled") return;
    if (o.status !== "pending_payment") {
      // MOCK / TEMPORARY limit: cancelling a PAID order needs a refund, which arrives in step 11.
      throw Errors.invalidTransition("This order is already paid. Cancelling paid orders is not available yet; please contact support.");
    }
    await cancelUnpaidLocked(tx, o, { userId, role: "customer" }, "Cancelled by the customer before payment");
  });
}

// Background sweep: unpaid orders past their payment window are cancelled and their stock and coupon
// use are given back. One order per transaction, so a conflict affects only that order (it is
// retried next run), and SKIP LOCKED lets several API instances run it at once.
export async function expireUnpaidOrders(db: Db, max = 500): Promise<number> {
  let total = 0;
  while (total < max) {
    const done = await withTx(db, async (tx) => {
      const o = (await tx.query(
        `select * from orders where status = 'pending_payment' and expires_at <= now() order by expires_at limit 1 for update skip locked`)).rows[0];
      if (!o) return false;
      await cancelUnpaidLocked(tx, o, { userId: null, role: "system" }, "Payment was not received in time");
      return true;
    });
    if (!done) break;
    total++;
  }
  return total;
}

// ---------- fulfilment (seller or admin) ----------

// Exactly the approved sequence (design pack, section 6). Only meet-and-collect may jump to delivered.
const NEXT: Record<string, SellerOrderStatus[]> = {
  confirmed: ["processing"],
  processing: ["shipped"],
  shipped: ["out_for_delivery"],
  out_for_delivery: ["delivered"],
};

export interface StatusInput { to: SellerOrderStatus; carrier?: string | undefined; trackingNumber?: string | undefined; reason?: string | undefined }

export async function moveSellerOrder(
  db: Db, sellerOrderId: string, input: StatusInput, actor: Actor, onlySellerId: string | null,
  audit?: (tx: Tx) => Promise<void>,
): Promise<string> {
  return withTx(db, async (tx) => {
    // Lock the customer order first (same order as payment confirmation), so two sellers moving
    // their packages at once are serialised and the derived order status is never computed from stale data.
    const parent = (await tx.query(`select order_id from seller_orders where id = $1 and ($2::uuid is null or seller_id = $2)`, [sellerOrderId, onlySellerId])).rows[0];
    if (!parent) throw Errors.notFound("Order");
    await tx.query(`select id from orders where id = $1 for update`, [parent.order_id]);
    const so = (await tx.query(
      `select * from seller_orders where id = $1 and ($2::uuid is null or seller_id = $2) for update`, [sellerOrderId, onlySellerId])).rows[0];
    if (!so) throw Errors.notFound("Order");
    if (input.to === "cancelled") {
      // MOCK / TEMPORARY limit: cancelling a paid package needs a refund (step 11).
      throw Errors.invalidTransition("Cancelling a paid package is not available yet; it arrives together with refunds.");
    }
    let allowed = NEXT[so.status] ?? [];
    // Meet-and-collect: handed over in person, so it can go straight to delivered.
    if (so.delivery_code === "meet" && (so.status === "confirmed" || so.status === "processing")) allowed = [...allowed, "delivered"];
    if (!allowed.includes(input.to)) {
      throw Errors.invalidTransition(`A package that is ${so.status.replace(/_/g, " ")} cannot become ${input.to.replace(/_/g, " ")}.`);
    }
    if (input.to === "shipped" && so.delivery_code !== "meet" && (!input.carrier || !input.trackingNumber)) {
      throw Errors.validation([{ path: "trackingNumber", message: "Give the carrier and tracking number when shipping." }]);
    }
    // Tracking is recorded once, when the package ships, and is not overwritten later.
    if (input.to !== "shipped" && (input.carrier || input.trackingNumber)) {
      throw Errors.validation([{ path: "trackingNumber", message: "Tracking details are given only when shipping." }]);
    }
    await tx.query(
      `update seller_orders set status = $2,
              carrier = coalesce($3, carrier), tracking_number = coalesce($4, tracking_number),
              shipped_at = case when $2 = 'shipped' then now() else shipped_at end,
              delivered_at = case when $2 = 'delivered' then now() else delivered_at end
        where id = $1`,
      [so.id, input.to, input.carrier ?? null, input.trackingNumber ?? null],
    );
    await event(tx, so.id, so.status, input.to, actor, input.reason ?? null);
    await outbox(tx, `seller_order.${input.to}`, "seller_order", so.id, { orderId: so.order_id, sellerId: so.seller_id });
    if (audit) await audit(tx);
    return syncOrderStatus(tx, so.order_id);
  });
}

// ---------- views ----------

export async function orderDetail(db: Queryable, orderId: string, scope: { userId?: string; sellerId?: string; admin?: boolean }) {
  const o = (await db.query(`select * from orders where id = $1 and ($2::uuid is null or user_id = $2)`, [orderId, scope.userId ?? null])).rows[0];
  if (!o) throw Errors.notFound("Order");
  const sos = (await db.query(
    `select so.*, s.display_name from seller_orders so join sellers s on s.id = so.seller_id
      where so.order_id = $1 and ($2::uuid is null or so.seller_id = $2) order by so.number`, [orderId, scope.sellerId ?? null])).rows;
  if (scope.sellerId && !sos.length) throw Errors.notFound("Order");
  const items = (await db.query(`select * from order_items where order_id = $1 order by created_at, id`, [orderId])).rows;
  const events = (await db.query(
    `select e.* from seller_order_events e join seller_orders so on so.id = e.seller_order_id where so.order_id = $1 order by e.id`, [orderId])).rows;
  const sellerView = !!scope.sellerId;
  return {
    // A seller sees their own package status only, not how other sellers' packages are progressing.
    id: o.id, number: o.number, status: sellerView ? undefined : o.status, paymentStatus: o.payment_status, currency: CURRENCY,
    // A seller sees only their own package, and the address only once the order is paid.
    totals: sellerView ? undefined : {
      itemsSubtotalPaise: Number(o.items_subtotal_paise), discountPaise: Number(o.discount_paise), itemsNetPaise: Number(o.items_net_paise),
      deliveryPaise: Number(o.delivery_paise), buyerProtectionPaise: Number(o.buyer_fee_paise), totalPaise: Number(o.total_paise),
      gstIncludedInItemsPaise: Number(o.gst_included_paise),
    },
    coupon: sellerView ? undefined : o.coupon_code,
    shippingAddress: sellerView && o.payment_status !== "paid" ? null : o.shipping_address,
    placedAt: o.placed_at, paidAt: o.paid_at, expiresAt: o.status === "pending_payment" ? o.expires_at : undefined,
    cancelledAt: o.cancelled_at, cancelReason: o.cancel_reason,
    packages: sos.map((so) => ({
      id: so.id, number: so.number, sellerId: so.seller_id, sellerName: so.display_name, status: so.status,
      delivery: { code: so.delivery_code, label: so.delivery_label, feePaise: Number(so.delivery_paise) },
      itemsSubtotalPaise: Number(so.items_subtotal_paise), discountPaise: Number(so.discount_paise), itemsNetPaise: Number(so.items_net_paise),
      carrier: so.carrier, trackingNumber: so.tracking_number, confirmedAt: so.confirmed_at, shippedAt: so.shipped_at, deliveredAt: so.delivered_at,
      cancelledAt: so.cancelled_at, cancelReason: so.cancel_reason,
      items: items.filter((i) => i.seller_order_id === so.id).map((i) => ({
        id: i.id, variantId: i.variant_id, productId: i.product_id, title: i.title, sku: i.sku, options: i.options,
        unitPricePaise: Number(i.unit_price_paise), quantity: i.quantity, subtotalPaise: Number(i.subtotal_paise),
        discountPaise: Number(i.discount_paise), netPaise: Number(i.net_paise), gstRateBp: i.gst_rate_bp, gstIncludedPaise: Number(i.gst_included_paise),
      })),
      history: events.filter((e) => e.seller_order_id === so.id).map((e) => ({
        from: e.from_status, to: e.to_status, by: e.actor_role, reason: e.reason, at: e.created_at,
        ...(scope.admin ? { actorId: e.actor_id } : {}),
      })),
    })),
  };
}
