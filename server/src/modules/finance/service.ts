import type { Db, Queryable, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { PLATFORM, post, sellerAccount } from "./ledger.js";

export async function settings(db: Queryable): Promise<{ payoutHoldDays: number }> {
  const r = (await db.query(`select payout_hold_days from finance_settings where id = 1`)).rows[0];
  return { payoutHoldDays: r.payout_hold_days };
}

// Called by payment confirmation, inside its transaction, with the order row already locked.
// Books what the buyer paid: sellers are owed their earnings (on hold), the platform earns the
// commission and the Buyer Protection fee, and pays for the coupon.
//
//   debit  payments receivable   order total
//   debit  coupon expense        coupon discount
//   credit seller (on hold)      items price − commission + delivery fee, per seller
//   credit commission revenue    commission
//   credit buyer fee revenue     Buyer Protection fee
export async function postOrderPayment(tx: Tx, order: any): Promise<void> {
  const sos = (await tx.query(
    `select id, seller_id, number, commission_paise, seller_earning_paise from seller_orders where order_id = $1 order by number`, [order.id])).rows;
  const missing = sos.some((s) => s.commission_paise === null || s.seller_earning_paise === null);
  if (missing) throw new Error(`Order ${order.number} has no frozen commission; it cannot be booked`);
  const { payoutHoldDays } = await settings(tx);
  const commission = sos.reduce((a, s) => a + Number(s.commission_paise), 0);
  await post(tx, {
    kind: "order_payment", referenceType: "order", referenceId: order.id, memo: `Payment for order ${order.number}`,
    lines: [
      { account: PLATFORM.receivable, direction: "debit", amountPaise: Number(order.total_paise) },
      { account: PLATFORM.coupons, direction: "debit", amountPaise: Number(order.discount_paise) },
      ...sos.map((s) => ({ account: sellerAccount(s.seller_id, "pending"), direction: "credit" as const, amountPaise: Number(s.seller_earning_paise) })),
      { account: PLATFORM.commission, direction: "credit", amountPaise: commission },
      { account: PLATFORM.buyerFee, direction: "credit", amountPaise: Number(order.buyer_fee_paise) },
    ],
  });
  // The hold is counted from payment (owner's decision) and fixed now; changing the setting later
  // does not move existing payout dates.
  await tx.query(
    `update seller_orders set funds_available_at = now() + make_interval(days => $2) where order_id = $1 and funds_available_at is null`,
    [order.id, payoutHoldDays]);
}

// Background sweep: earnings whose hold has ended move from "on hold" to "available". One package
// per transaction; SKIP LOCKED lets several instances run it; the ledger's unique key makes a
// repeat harmless.
//
// TODO step 11: packages with an open return or dispute, or cancelled after payment, must not be released.
export async function releaseHeldFunds(db: Db, max = 500): Promise<number> {
  let n = 0;
  while (n < max) {
    const done = await withTx(db, async (tx) => {
      const so = (await tx.query(
        `select id, seller_id, number, seller_earning_paise from seller_orders
          where funds_available_at <= now() and funds_released_at is null and status <> 'cancelled'
          order by funds_available_at limit 1 for update skip locked`)).rows[0];
      if (!so) return false;
      const amount = Number(so.seller_earning_paise);
      if (amount > 0) {
        await post(tx, {
          kind: "hold_release", referenceType: "seller_order", referenceId: so.id, memo: `Hold ended for package ${so.number}`,
          lines: [
            { account: sellerAccount(so.seller_id, "pending"), direction: "debit", amountPaise: amount },
            { account: sellerAccount(so.seller_id, "available"), direction: "credit", amountPaise: amount },
          ],
        });
      }
      await tx.query(`update seller_orders set funds_released_at = now() where id = $1`, [so.id]);
      return true;
    });
    if (!done) break;
    n++;
  }
  return n;
}
