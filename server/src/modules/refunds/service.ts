// Refunds: money going back to buyers, for cancelled packages, approved returns, and payments that
// could not be applied to an order.
//
// A refund is created inside the transaction that decides it (the package is cancelled, the return
// is received), together with its ledger booking ("refund due"). The provider is called afterwards,
// outside any transaction, with the refund id as idempotency key; a failure leaves the refund
// pending and the sweep retries it. When the provider confirms, the refund is marked processed and
// the money leaving is booked ("refund paid").
//
// Rules (owner, 2026-10-07): delivery is refunded only when a package is cancelled before shipping;
// on returns the buyer gets the return shipping (₹99) instead, charged to the seller; Buyer
// Protection is refunded in proportion to the value refunded; commission is never given back to the
// seller (the platform bears it); a coupon's discount is not refunded (the buyer gets what they paid).
import type { Db, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { allocate } from "../cart/pricing.js";
import { PLATFORM, post, sellerAccount } from "../finance/ledger.js";
import { deriveOrderStatus, outbox } from "../orders/service.js";
import * as inv from "../inventory/service.js";
import type { PaymentProvider } from "../payments/provider.js";

// Each order line's share of the Buyer Protection fee, in proportion to what was paid for it. The
// shares add up exactly to the fee, so refunding every line returns the whole fee.
export async function feeShares(tx: Tx, order: any): Promise<Map<string, number>> {
  const lines = (await tx.query(
    `select i.id, i.net_paise from order_items i join seller_orders so on so.id = i.seller_order_id
      where i.order_id = $1 order by so.number, i.created_at, i.id`, [order.id])).rows;
  const shares = allocate(Number(order.buyer_fee_paise), lines.map((l) => Number(l.net_paise)));
  return new Map(lines.map((l, i) => [l.id as string, shares[i]!]));
}

async function capturedPayment(tx: Tx, orderId: string) {
  const p = (await tx.query(`select * from payments where order_id = $1 and status = 'captured'`, [orderId])).rows[0];
  if (!p) throw new Error(`Order ${orderId} has no captured payment to refund`);
  return p;
}

export interface PackageRefundInput {
  order: any;             // locked order row
  so: any;                // locked seller order row
  itemIds: string[];      // order lines being refunded
  kind: "cancellation" | "return";
  returnRow?: any;
  reason: string;
  actorId: string | null;
}

// Creates the refund and books it. Must run in the transaction that locked the order and package.
export async function createPackageRefund(tx: Tx, i: PackageRefundInput): Promise<string> {
  const items = (await tx.query(
    `select i.* from order_items i where i.seller_order_id = $1 and i.id = any($2::uuid[]) order by i.created_at, i.id`, [i.so.id, i.itemIds])).rows;
  if (items.length !== new Set(i.itemIds).size || !items.length) throw new Error("Refund lines do not belong to this package");
  const shares = await feeShares(tx, i.order);
  const payment = await capturedPayment(tx, i.order.id);

  const net = items.reduce((a, x) => a + Number(x.net_paise), 0);
  const subtotal = items.reduce((a, x) => a + Number(x.subtotal_paise), 0);
  const discount = items.reduce((a, x) => a + Number(x.discount_paise), 0);
  const commission = items.reduce((a, x) => a + Number(x.commission_paise), 0);
  const fee = items.reduce((a, x) => a + shares.get(x.id)!, 0);
  const delivery = i.kind === "cancellation" ? Number(i.so.delivery_paise) : 0;
  // Never give back more for a package than the buyer paid for it (items, its delivery fee and its
  // Buyer Protection share), so the other packages of the order always stay fully refundable. The
  // return shipping is capped by what is left: for a ₹59 pickup it is ₹59, for meet-and-collect ₹0.
  let returnShipping = 0;
  if (i.kind === "return") {
    const pkgLines = (await tx.query(`select id from order_items where seller_order_id = $1`, [i.so.id])).rows;
    const paidForPackage = Number(i.so.items_net_paise) + Number(i.so.delivery_paise) + pkgLines.reduce((a, l) => a + shares.get(l.id)!, 0);
    const refundedForPackage = Number((await tx.query(
      `select coalesce(sum(amount_paise), 0)::bigint s from refunds where seller_order_id = $1`, [i.so.id])).rows[0].s);
    returnShipping = Math.max(0, Math.min(Number(i.returnRow.return_shipping_paise), paidForPackage - refundedForPackage - net - fee));
  }
  const amount = net + fee + delivery + returnShipping;
  // The seller gives back what they earned on these lines (price − commission), the delivery fee
  // when nothing was shipped, and pays for the return shipping.
  const sellerDebit = subtotal - commission + delivery + returnShipping;
  const account = i.so.funds_released_at ? "available" : "pending";

  // Never refund more than was received for the order.
  const before = (await tx.query(
    `select coalesce(sum(amount_paise), 0)::bigint s from refunds where payment_id = $1`, [payment.id])).rows[0].s;
  if (Number(before) + amount > Number(payment.received_paise)) throw new Error(`Refunds for order ${i.order.number} would exceed the payment`);

  const r = (await tx.query(
    `insert into refunds (order_id, payment_id, seller_order_id, return_id, kind, items_paise, buyer_fee_paise, delivery_paise, return_shipping_paise,
                          amount_paise, seller_debit_paise, seller_account, reason, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    [i.order.id, payment.id, i.so.id, i.returnRow?.id ?? null, i.kind, net, fee, delivery, returnShipping, amount, sellerDebit,
     sellerDebit > 0 ? account : null, i.reason.slice(0, 500), i.actorId])).rows[0];
  for (const x of items) {
    await tx.query(
      `insert into refund_items (refund_id, order_item_id, net_paise, discount_paise, commission_paise, buyer_fee_paise) values ($1, $2, $3, $4, $5, $6)`,
      [r.id, x.id, x.net_paise, x.discount_paise, x.commission_paise, shares.get(x.id)]);
  }
  //   debit  seller (on hold or available)   price − commission (+ delivery on cancel, + return shipping)
  //   debit  refund commission expense        commission (kept from the seller, borne by the platform)
  //   debit  Buyer Protection revenue         the fee share given back
  //   credit coupon expense                   the coupon discount on these lines (the buyer is refunded what they paid)
  //   credit refunds payable                  the refund
  await post(tx, {
    kind: "refund_due", referenceType: "refund", referenceId: r.id, memo: `${i.kind === "return" ? "Return" : "Cancellation"} refund, package ${i.so.number}`,
    lines: [
      { account: sellerAccount(i.so.seller_id, account), direction: "debit", amountPaise: sellerDebit },
      { account: PLATFORM.refundCommission, direction: "debit", amountPaise: commission },
      { account: PLATFORM.buyerFee, direction: "debit", amountPaise: fee },
      { account: PLATFORM.coupons, direction: "credit", amountPaise: discount },
      { account: PLATFORM.refundsPayable, direction: "credit", amountPaise: amount },
    ],
  });
  await outbox(tx, "refund.created", "refund", r.id, { orderId: i.order.id, sellerOrderId: i.so.id, amountPaise: amount, kind: i.kind });
  return r.id;
}

// A payment that could not be applied to its order (already in refunds payable) is given back in full.
export async function createUnappliedRefund(db: Db, paymentId: string, actorId: string, reason: string, audit?: (tx: Tx, refundId: string) => Promise<void>): Promise<string> {
  return withTx(db, async (tx) => {
    const p0 = (await tx.query(`select order_id from payments where id = $1`, [paymentId])).rows[0];
    if (!p0) throw Errors.notFound("Payment");
    await tx.query(`select id from orders where id = $1 for update`, [p0.order_id]);
    const p = (await tx.query(`select * from payments where id = $1 for update`, [paymentId])).rows[0];
    const existing = (await tx.query(`select id from refunds where payment_id = $1 and kind = 'unapplied_payment'`, [paymentId])).rows[0];
    if (existing) return existing.id as string;
    if (p.status !== "needs_refund") throw Errors.invalidTransition("Only payments marked as needing a refund can be refunded here.");
    const r = (await tx.query(
      `insert into refunds (order_id, payment_id, kind, other_paise, amount_paise, reason, requested_by)
       values ($1, $2, 'unapplied_payment', $3, $3, $4, $5) returning id`,
      [p.order_id, p.id, p.received_paise, reason, actorId])).rows[0];
    await outbox(tx, "refund.created", "refund", r.id, { orderId: p.order_id, paymentId: p.id, amountPaise: Number(p.received_paise), kind: "unapplied_payment" });
    if (audit) await audit(tx, r.id);
    return r.id as string;
  });
}

async function syncPaymentStatus(tx: Tx, orderId: string) {
  const r = (await tx.query(
    `select p.id, p.received_paise,
            (select coalesce(sum(amount_paise), 0) from refunds f where f.payment_id = p.id and f.status = 'processed' and f.kind <> 'unapplied_payment') as refunded
       from payments p where p.order_id = $1 and p.status = 'captured'`, [orderId])).rows[0];
  if (!r || Number(r.refunded) === 0) return;
  const s = Number(r.refunded) >= Number(r.received_paise) ? "refunded" : "partially_refunded";
  await tx.query(`update orders set payment_status = $2 where id = $1 and payment_status <> $2`, [orderId, s]);
}

// Sends one pending refund to the provider and records the result. Safe to call repeatedly and
// from several places at once: the provider deduplicates by refund id, and the database update
// happens once.
export async function processRefund(db: Db, provider: PaymentProvider | null, refundId: string): Promise<"processed" | "pending"> {
  const r = (await db.query(
    `select f.*, p.provider, p.provider_payment_id from refunds f join payments p on p.id = f.payment_id where f.id = $1`, [refundId])).rows[0];
  if (!r) throw Errors.notFound("Refund");
  if (r.status === "processed") return "processed";
  let providerRefundId: string;
  try {
    if (!provider || provider.name !== r.provider) throw new Error(`Payment provider ${r.provider} is not available`);
    ({ providerRefundId } = await provider.refund({ providerPaymentId: r.provider_payment_id, amountPaise: Number(r.amount_paise), idempotencyKey: r.id }));
  } catch (err: any) {
    // Back off: 30 s, 1 min, 2 min … up to an hour between attempts.
    await db.query(
      `update refunds set attempts = attempts + 1, last_error = $2,
              next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, least(attempts, 7)))) where id = $1 and status = 'pending'`,
      [refundId, String(err?.message ?? err).slice(0, 500)]);
    return "pending";
  }
  await withTx(db, async (tx) => {
    await tx.query(`select id from orders where id = $1 for update`, [r.order_id]);
    const cur = (await tx.query(`select status from refunds where id = $1 for update`, [refundId])).rows[0];
    if (cur.status === "processed") return;
    await tx.query(
      `update refunds set status = 'processed', processed_at = now(), provider_refund_id = $2, attempts = attempts + 1, last_error = null where id = $1`,
      [refundId, providerRefundId]);
    await post(tx, {
      kind: "refund_paid", referenceType: "refund", referenceId: refundId, memo: `Refund sent to the buyer (${providerRefundId})`,
      lines: [
        { account: PLATFORM.refundsPayable, direction: "debit", amountPaise: Number(r.amount_paise) },
        { account: PLATFORM.receivable, direction: "credit", amountPaise: Number(r.amount_paise) },
      ],
    });
    if (r.kind === "unapplied_payment") await tx.query(`update payments set status = 'refunded' where id = $1 and status = 'needs_refund'`, [r.payment_id]);
    else await syncPaymentStatus(tx, r.order_id);
    if (r.return_id) {
      const ret = (await tx.query(`update returns set status = 'refunded' where id = $1 and status = 'received' returning id`, [r.return_id])).rows[0];
      if (ret) await tx.query(`insert into return_events (return_id, from_status, to_status, actor_role, note) values ($1, 'received', 'refunded', 'system', 'Refund sent')`, [r.return_id]);
    }
    await outbox(tx, "refund.processed", "refund", refundId, { orderId: r.order_id, amountPaise: Number(r.amount_paise) });
  });
  return "processed";
}

// Background retry of refunds the provider has not confirmed yet (oldest first, a few per run).
export async function processPendingRefunds(db: Db, provider: PaymentProvider | null, max = 50): Promise<number> {
  const ids = (await db.query(
    `select id from refunds where status = 'pending' and next_attempt_at <= now() order by next_attempt_at limit $1`, [max])).rows.map((x) => x.id as string);
  let done = 0;
  for (const id of ids) if ((await processRefund(db, provider, id)) === "processed") done++;
  return done;
}

// ---------- cancelling a paid package before it ships ----------

export type CancelActor = { userId: string | null; role: "customer" | "seller" | "admin" };
const PRE_SHIP = ["confirmed", "processing"];

// Cancels one paid package that has not shipped: stock goes back on sale, the buyer is refunded the
// items, the delivery fee and the Buyer Protection share, and the seller's earning is reversed.
// Returns the refund id. `onlyUserId` / `onlySellerId` restrict who may do it.
export async function cancelPaidPackage(
  tx: Tx, sellerOrderId: string, actor: CancelActor, reason: string, scope: { onlyUserId?: string; onlySellerId?: string } = {},
  restock = true,
): Promise<string> {
  const ref = (await tx.query(
    `select so.order_id from seller_orders so join orders o on o.id = so.order_id
      where so.id = $1 and ($2::uuid is null or o.user_id = $2) and ($3::uuid is null or so.seller_id = $3)`,
    [sellerOrderId, scope.onlyUserId ?? null, scope.onlySellerId ?? null])).rows[0];
  if (!ref) throw Errors.notFound("Order");
  const order = (await tx.query(`select * from orders where id = $1 for update`, [ref.order_id])).rows[0];
  const so = (await tx.query(`select * from seller_orders where id = $1 for update`, [sellerOrderId])).rows[0];
  if (order.payment_status === "unpaid") throw Errors.invalidTransition("This order is not paid; cancel the whole order instead.");
  if (!PRE_SHIP.includes(so.status)) {
    throw new AppError(422, "ALREADY_SHIPPED", so.status === "cancelled" ? "This package is already cancelled." : "This package has already shipped. You can request a return after delivery if the item is damaged or fake.");
  }
  const items = (await tx.query(`select id, variant_id, warehouse_id, quantity from order_items where seller_order_id = $1 order by variant_id, warehouse_id`, [so.id])).rows;
  const refundId = await createPackageRefund(tx, { order, so, itemIds: items.map((x) => x.id), kind: "cancellation", reason, actorId: actor.userId });
  await inv.lockProducts(tx, items.map((x) => x.variant_id));
  // Back on sale, unless the item no longer exists (a seller or admin cancelling because it was lost
  // or sold elsewhere): then the sale is undone without putting stock back.
  const meta = { referenceType: "seller_order", referenceId: so.id, actorId: actor.userId, note: reason.slice(0, 200) };
  for (const x of items) {
    if (restock) await inv.cancelSale(tx, x.variant_id, x.warehouse_id, x.quantity, meta);
    else await inv.move(tx, x.variant_id, x.warehouse_id, { sold: -x.quantity }, "loss", meta);
  }
  await tx.query(`update seller_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1`, [so.id, reason.slice(0, 300)]);
  await tx.query(
    `insert into seller_order_events (seller_order_id, from_status, to_status, actor_id, actor_role, reason) values ($1, $2, 'cancelled', $3, $4, $5)`,
    [so.id, so.status, actor.userId, actor.role, reason.slice(0, 300)]);
  await outbox(tx, "seller_order.cancelled", "seller_order", so.id, { orderId: order.id, sellerId: so.seller_id, by: actor.role });
  // The customer-facing status follows the packages; a fully cancelled order records when.
  const left = (await tx.query(`select count(*)::int n from seller_orders where order_id = $1 and status <> 'cancelled'`, [order.id])).rows[0].n;
  const st = deriveOrderStatus((await tx.query(`select status from seller_orders where order_id = $1`, [order.id])).rows.map((x) => x.status));
  await tx.query(
    `update orders set status = $2, cancelled_at = case when $3 then now() else cancelled_at end, cancel_reason = case when $3 then $4 else cancel_reason end where id = $1`,
    [order.id, st, left === 0, reason.slice(0, 300)]);
  return refundId;
}

// The buyer cancels a whole paid order: possible only while none of its packages has shipped.
export async function cancelPaidOrder(tx: Tx, userId: string, orderId: string, reason: string): Promise<string[]> {
  const o = (await tx.query(`select * from orders where id = $1 and user_id = $2 for update`, [orderId, userId])).rows[0];
  if (!o) throw Errors.notFound("Order");
  const sos = (await tx.query(`select id, status from seller_orders where order_id = $1 and status <> 'cancelled' order by number`, [orderId])).rows;
  if (!sos.length) return [];
  if (sos.some((s) => !PRE_SHIP.includes(s.status))) {
    throw new AppError(422, "PARTLY_SHIPPED", "Some packages have already shipped. Cancel the packages that have not shipped one by one.",
      sos.filter((s) => PRE_SHIP.includes(s.status)).map((s) => s.id));
  }
  const ids: string[] = [];
  for (const s of sos) ids.push(await cancelPaidPackage(tx, s.id, { userId, role: "customer" }, reason, { onlyUserId: userId }));
  return ids;
}
