import type { Db, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { CURRENCY } from "../../lib/money.js";
import * as orders from "../orders/service.js";
import { PLATFORM, post } from "../finance/ledger.js";
import type { PaymentProvider, ProviderEvent } from "./provider.js";

const attemptOut = (p: any, clientData?: Record<string, unknown>) => ({
  paymentId: p.id, orderId: p.order_id, provider: p.provider, providerOrderId: p.provider_order_id, status: p.status,
  amountPaise: Number(p.amount_paise), currency: CURRENCY, createdAt: p.created_at, ...(clientData ? { clientData } : {}),
});

// ---------- starting a payment ----------

// Returns the order's open attempt, or creates one for exactly the order total. The provider is
// called outside the database transaction (a slow network must not hold the order lock); if two
// requests race, the second's provider order is simply never used.
export async function start(db: Db, provider: PaymentProvider, userId: string, orderId: string) {
  const check = async (tx: Tx) => {
    const o = (await tx.query(`select * from orders where id = $1 and user_id = $2 for update`, [orderId, userId])).rows[0];
    if (!o) throw Errors.notFound("Order");
    if (o.payment_status !== "unpaid") throw Errors.conflict("ALREADY_PAID", "This order is already paid.");
    if (o.status !== "pending_payment") throw Errors.conflict("ORDER_NOT_PAYABLE", "This order was cancelled and cannot be paid.");
    const ended = (await tx.query(`select $1::timestamptz <= now() as ended`, [o.expires_at])).rows[0].ended;
    if (ended) throw Errors.conflict("PAYMENT_WINDOW_ENDED", "The time to pay for this order has ended. Please place the order again.");
    const open = (await tx.query(`select * from payments where order_id = $1 and status = 'created'`, [orderId])).rows[0];
    return { o, open };
  };
  const first = await withTx(db, check);
  if (first.open) return { ...attemptOut(first.open), expiresAt: first.o.expires_at, reused: true };

  const created = await provider.createOrder({ amountPaise: Number(first.o.total_paise), currency: "INR", receipt: first.o.number });
  return withTx(db, async (tx) => {
    const { o, open } = await check(tx);
    if (open) return { ...attemptOut(open), expiresAt: o.expires_at, reused: true };
    const p = (await tx.query(
      `insert into payments (order_id, user_id, provider, provider_order_id, amount_paise) values ($1, $2, $3, $4, $5) returning *`,
      [o.id, userId, provider.name, created.providerOrderId, o.total_paise])).rows[0];
    return { ...attemptOut(p, created.clientData), expiresAt: o.expires_at, reused: false };
  });
}

// ---------- applying money received ----------

export type CaptureOutcome = "captured" | "already_captured" | "needs_refund" | "already_recorded" | "unknown_payment" | "discrepancy";

async function bookUnapplied(tx: Tx, paymentId: string, amountPaise: number, orderNumber: string, reason: string) {
  await post(tx, {
    kind: "unapplied_payment", referenceType: "payment", referenceId: paymentId, memo: `Payment for ${orderNumber} to refund: ${reason}`,
    lines: [
      { account: PLATFORM.receivable, direction: "debit", amountPaise },
      { account: PLATFORM.refundsPayable, direction: "credit", amountPaise },
    ],
  });
  await orders.outbox(tx, "payment.needs_refund", "payment", paymentId, { orderNumber, amountPaise, reason });
}

// The provider says money arrived for providerOrderId. Applies it to the order if the order can
// still take it; otherwise records it as money to refund. Safe to call any number of times, from
// the browser's confirmation and from the webhook, in any order.
//
// Locks: the order row first, then the payment row (the same order as everywhere else).
export async function applyCapture(
  tx: Tx, provider: string,
  input: { providerOrderId: string; providerPaymentId: string; amountPaise: number; refundReason?: string },
): Promise<{ outcome: CaptureOutcome; paymentId: string | null; orderId: string | null }> {
  const attempt = (await tx.query(
    `select id, order_id from payments where provider = $1 and provider_order_id = $2 order by created_at limit 1`,
    [provider, input.providerOrderId])).rows[0];
  if (!attempt) return { outcome: "unknown_payment", paymentId: null, orderId: null };
  const o = (await tx.query(`select * from orders where id = $1 for update`, [attempt.order_id])).rows[0];
  const p = (await tx.query(`select * from payments where id = $1 for update`, [attempt.id])).rows[0];

  // Seen this exact payment before (on this attempt or as an extra row)?
  const seen = (await tx.query(`select id, status, received_paise from payments where provider = $1 and provider_payment_id = $2`, [provider, input.providerPaymentId])).rows[0];
  if (seen) {
    // Two reports about the same payment disagree on the amount: never ignore that silently.
    if (Number(seen.received_paise) !== input.amountPaise) {
      await orders.outbox(tx, "payment.discrepancy", "payment", seen.id, { recordedPaise: Number(seen.received_paise), reportedPaise: input.amountPaise });
      return { outcome: "discrepancy", paymentId: seen.id, orderId: o.id };
    }
    return { outcome: seen.status === "captured" ? "already_captured" : "already_recorded", paymentId: seen.id, orderId: o.id };
  }

  const received = input.amountPaise;

  // A second payment on a provider order that already has one: keep it as its own row, to refund.
  if (p.status === "captured" || p.status === "needs_refund") {
    const extra = (await tx.query(
      `insert into payments (order_id, user_id, provider, provider_order_id, provider_payment_id, amount_paise, received_paise, status, refund_reason, captured_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'needs_refund', $8, now()) returning id`,
      [o.id, p.user_id, provider, input.providerOrderId, input.providerPaymentId, p.amount_paise, received, "Second payment for the same attempt"])).rows[0];
    await bookUnapplied(tx, extra.id, received, o.number, "second payment for the same attempt");
    return { outcome: "needs_refund", paymentId: extra.id, orderId: o.id };
  }

  const reason = input.refundReason ? input.refundReason
    : received !== Number(p.amount_paise) ? `Amount received (${received}) differs from the amount due (${p.amount_paise})`
    : o.payment_status !== "unpaid" ? "The order was already paid by another payment"
    : o.status !== "pending_payment" ? "The order was cancelled before the payment arrived"
    : null;
  if (reason) {
    await tx.query(
      `update payments set status = 'needs_refund', provider_payment_id = $2, received_paise = $3, captured_at = now(), refund_reason = $4 where id = $1`,
      [p.id, input.providerPaymentId, received, reason]);
    await bookUnapplied(tx, p.id, received, o.number, reason);
    return { outcome: "needs_refund", paymentId: p.id, orderId: o.id };
  }

  // If the order cannot take the money after all (for example its stock hold is gone), undo just
  // this part and keep the money as a refund instead of losing track of it.
  await tx.query("savepoint apply_payment");
  try {
    await tx.query(
      `update payments set status = 'captured', provider_payment_id = $2, received_paise = $3, captured_at = now(), failure_reason = null where id = $1`,
      [p.id, input.providerPaymentId, received]);
    await orders.confirmPayment(tx, o.id); // the only way an order becomes paid; books the ledger
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    await tx.query("rollback to savepoint apply_payment");
    const why = `The order could not take the payment: ${err.message}`.slice(0, 300);
    await tx.query(
      `update payments set status = 'needs_refund', provider_payment_id = $2, received_paise = $3, captured_at = now(), refund_reason = $4 where id = $1`,
      [p.id, input.providerPaymentId, received, why]);
    await bookUnapplied(tx, p.id, received, o.number, why);
    return { outcome: "needs_refund", paymentId: p.id, orderId: o.id };
  }
  await tx.query("release savepoint apply_payment");
  await orders.outbox(tx, "payment.captured", "payment", p.id, { orderId: o.id, orderNumber: o.number, amountPaise: received });
  return { outcome: "captured", paymentId: p.id, orderId: o.id };
}

async function applyFailure(tx: Tx, provider: string, providerOrderId: string, reason: string | null) {
  const attempt = (await tx.query(
    `select id, order_id from payments where provider = $1 and provider_order_id = $2 order by created_at limit 1`, [provider, providerOrderId])).rows[0];
  if (!attempt) return { outcome: "unknown_payment", paymentId: null };
  await tx.query(`select id from orders where id = $1 for update`, [attempt.order_id]);
  const r = await tx.query(
    `update payments set status = 'failed', failure_reason = $2 where id = $1 and status = 'created' returning id`, [attempt.id, reason ?? "Payment failed"]);
  return { outcome: r.rowCount ? "failed" : "ignored", paymentId: attempt.id as string };
}

// ---------- entry points ----------

// The browser's confirmation after paying. Trusted only because the signature is checked here.
export async function verifyFromClient(
  db: Db, provider: PaymentProvider, userId: string, input: { providerOrderId: string; providerPaymentId: string; signature: string },
) {
  if (!provider.verifyClientSignature(input)) throw new AppError(400, "INVALID_SIGNATURE", "The payment could not be verified.");
  const owner = (await db.query(`select user_id from payments where provider = $1 and provider_order_id = $2 order by created_at limit 1`, [provider.name, input.providerOrderId])).rows[0];
  if (!owner || owner.user_id !== userId) throw Errors.notFound("Payment");
  // The signature proves checkout happened; the provider itself tells us whether, and how much, was captured.
  const f = await provider.fetchPayment(input.providerPaymentId);
  if (!f || f.providerOrderId !== input.providerOrderId) throw new AppError(400, "INVALID_SIGNATURE", "The payment could not be verified.");
  if (f.status !== "captured") {
    throw new AppError(409, "PAYMENT_NOT_CAPTURED", "We are waiting for the bank to confirm this payment. Your order updates automatically once it does.");
  }
  return withTx(db, (tx) => applyCapture(tx, provider.name, {
    providerOrderId: input.providerOrderId, providerPaymentId: input.providerPaymentId, amountPaise: f.amountPaise,
    ...(f.currency !== "INR" ? { refundReason: `Paid in ${f.currency.slice(0, 10)} instead of INR` } : {}),
  }));
}

// A webhook from the provider. Each event is processed once; a repeat returns "duplicate".
export async function handleWebhook(db: Db, provider: PaymentProvider, rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
  if (!provider.verifyWebhook(rawBody, headers)) throw new AppError(400, "INVALID_SIGNATURE", "Invalid signature.");
  let e: ProviderEvent;
  try { e = provider.parseWebhook(rawBody, headers); } catch { throw new AppError(400, "BAD_EVENT", "The event could not be read."); }
  // A capture we cannot attribute or measure is refused (not stored), so the provider retries it and
  // it shows up in alerts, instead of being recorded as handled while the money goes unbooked.
  if (e.type === "payment.captured" && (!e.providerOrderId || !e.providerPaymentId || e.amountPaise === null)) {
    throw new AppError(400, "BAD_EVENT", "The payment event is missing its ids or amount.");
  }
  return withTx(db, async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('payment_event:' || $1 || ':' || $2, 0))`, [provider.name, e.eventId]);
    const dup = await tx.query(`select outcome from payment_events where provider = $1 and event_id = $2`, [provider.name, e.eventId]);
    if (dup.rowCount) return { outcome: "duplicate" };
    let outcome = "ignored";
    let paymentId: string | null = null;
    if (e.type === "payment.captured") {
      ({ outcome, paymentId } = await applyCapture(tx, provider.name, {
        providerOrderId: e.providerOrderId!, providerPaymentId: e.providerPaymentId!, amountPaise: e.amountPaise!,
        ...(e.currency !== "INR" ? { refundReason: `Paid in ${String(e.currency).slice(0, 10)} instead of INR` } : {}),
      }));
    } else if (e.type === "payment.failed" && e.providerOrderId) {
      ({ outcome, paymentId } = await applyFailure(tx, provider.name, e.providerOrderId, e.failureReason));
    }
    await tx.query(
      `insert into payment_events (provider, event_id, type, payment_id, payload, outcome) values ($1, $2, $3, $4, $5, $6)`,
      [provider.name, e.eventId, e.rawType.slice(0, 60) || "unknown", paymentId, rawBody.toString("utf8"), outcome]);
    return { outcome };
  });
}
