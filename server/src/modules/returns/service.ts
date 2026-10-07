// Returns of delivered items that arrived damaged or fake (owner's rules, 2026-10-07).
//
//   requested ──seller accepts / no answer in 3 days──▶ approved ──buyer ships──▶ shipped_back
//       │                                                  ▲  │                       │
//       └─seller rejects─▶ rejected ──buyer asks admin─▶ disputed                      ▼
//                             │                     admin approves / admin rejects ─▶ closed
//                             └── no request in 3 days ─▶ closed            received ─▶ refunded
//
// The buyer can withdraw until the item is shipped back. An approved return not shipped in time is
// closed; a shipped return the seller does not confirm in time is treated as received (not resellable).
import { randomUUID } from "node:crypto";
import type { Db, Queryable, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import type { Storage } from "../../lib/storage.js";
import { ImageError, processProductImage } from "../../lib/images.js";
import { CURRENCY } from "../../lib/money.js";
import * as inv from "../inventory/service.js";
import { outbox } from "../orders/service.js";
import { settings as financeSettings } from "../finance/service.js";
import { createPackageRefund } from "../refunds/service.js";

export type Actor = { userId: string | null; role: "customer" | "seller" | "admin" | "system" };
const MAX_PHOTOS = 5;

// ---------- photos ----------

export async function uploadPhoto(db: Db, storage: Storage, userId: string, input: Buffer): Promise<{ id: string }> {
  const recent = (await db.query(`select count(*)::int n from return_photos where user_id = $1 and created_at > now() - interval '1 day'`, [userId])).rows[0].n;
  if (recent >= 30) throw new AppError(429, "RATE_LIMITED", "Too many photos today. Try again tomorrow.");
  let out;
  try { out = await processProductImage(input); } catch (e) {
    if (e instanceof ImageError) throw new AppError(422, "INVALID_IMAGE", e.message);
    throw e;
  }
  const big = out.outputs.find((o) => o.size === 1200)!;
  const id = randomUUID();
  const key = `returns/${userId}/${id}.webp`;
  await storage.put(key, big.body, "image/webp");
  await db.query(`insert into return_photos (id, user_id, key, bytes) values ($1, $2, $3, $4)`, [id, userId, key, big.body.length]);
  return { id };
}

export async function readPhoto(db: Queryable, storage: Storage, returnId: string, photoId: string): Promise<Buffer> {
  const p = (await db.query(`select key from return_photos where id = $1 and return_id = $2`, [photoId, returnId])).rows[0];
  if (!p) throw Errors.notFound("Photo");
  return storage.get(p.key);
}

// ---------- helpers ----------

async function event(tx: Tx, returnId: string, from: string | null, to: string, actor: Actor, note?: string | null) {
  await tx.query(`insert into return_events (return_id, from_status, to_status, actor_id, actor_role, note) values ($1, $2, $3, $4, $5, $6)`,
    [returnId, from, to, actor.userId, actor.role, note ?? null]);
  await outbox(tx, `return.${to}`, "return", returnId, { from, by: actor.role });
}

// Lock order: the order row, the package, then the return (the same order as every other money path).
async function lockReturn(tx: Tx, returnId: string, scope: { userId?: string; sellerId?: string }) {
  const ref = (await tx.query(
    `select order_id, seller_order_id from returns where id = $1 and ($2::uuid is null or user_id = $2) and ($3::uuid is null or seller_id = $3)`,
    [returnId, scope.userId ?? null, scope.sellerId ?? null])).rows[0];
  if (!ref) throw Errors.notFound("Return");
  const order = (await tx.query(`select * from orders where id = $1 for update`, [ref.order_id])).rows[0];
  const so = (await tx.query(`select * from seller_orders where id = $1 for update`, [ref.seller_order_id])).rows[0];
  const r = (await tx.query(`select *, now() as now from returns where id = $1 for update`, [returnId])).rows[0];
  return { order, so, r };
}

const must = (r: any, allowed: string[], what: string) => {
  if (!allowed.includes(r.status)) throw Errors.invalidTransition(`This return is ${r.status.replace(/_/g, " ")}; you cannot ${what} now.`);
};
const before = (r: any, deadline: Date | null, what: string) => {
  if (deadline && new Date(r.now) > new Date(deadline)) throw new AppError(422, "DEADLINE_PASSED", `The time to ${what} has passed.`);
};

// ---------- buyer ----------

export interface CreateInput { sellerOrderId: string; orderItemIds: string[]; reason: "damaged" | "fake"; description: string; photoIds: string[] }

export async function create(db: Db, userId: string, i: CreateInput): Promise<string> {
  return withTx(db, async (tx) => {
    const ref = (await tx.query(
      `select so.order_id from seller_orders so join orders o on o.id = so.order_id where so.id = $1 and o.user_id = $2`, [i.sellerOrderId, userId])).rows[0];
    if (!ref) throw Errors.notFound("Order");
    await tx.query(`select id from orders where id = $1 for update`, [ref.order_id]);
    const so = (await tx.query(`select *, now() as now from seller_orders where id = $1 for update`, [i.sellerOrderId])).rows[0];
    if (so.status !== "delivered") throw Errors.invalidTransition("A return can be requested only after the package is delivered.");
    const st = await financeSettings(tx);
    const deadline = new Date(new Date(so.delivered_at).getTime() + st.returnWindowDays * 86_400_000);
    if (new Date(so.now) > deadline) throw new AppError(422, "RETURN_WINDOW_ENDED", `Returns are accepted within ${st.returnWindowDays} days of delivery.`);

    const ids = [...new Set(i.orderItemIds)];
    const lines = await tx.query(`select id from order_items where seller_order_id = $1 and id = any($2::uuid[])`, [so.id, ids]);
    if (lines.rowCount !== ids.length) throw Errors.validation([{ path: "orderItemIds", message: "Choose items from this package." }]);
    // One return per item. A decided return (accepted, rejected, closed by an admin) can never be
    // filed again; only one withdrawn before anyone decided anything frees the item.
    const taken = await tx.query(
      `select ri.order_item_id from return_items ri join returns r on r.id = ri.return_id
        where ri.order_item_id = any($1::uuid[])
          and (r.status <> 'withdrawn'
               or exists (select 1 from return_events e where e.return_id = r.id and e.to_status in ('approved', 'rejected', 'disputed')))
       union select order_item_id from refund_items where order_item_id = any($1::uuid[])`, [ids]);
    if (taken.rowCount) throw Errors.conflict("RETURN_EXISTS", "A return or refund already exists for some of these items.");

    const photos = [...new Set(i.photoIds)];
    const ph = await tx.query(`select id from return_photos where id = any($1::uuid[]) and user_id = $2 and return_id is null for update`, [photos, userId]);
    if (ph.rowCount !== photos.length) throw Errors.validation([{ path: "photoIds", message: "Upload the photos first; each can be used once." }]);

    const r = (await tx.query(
      `insert into returns (order_id, seller_order_id, user_id, seller_id, reason, description, seller_decide_by, return_shipping_paise)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7), $8) returning id`,
      [so.order_id, so.id, userId, so.seller_id, i.reason, i.description, st.sellerDecisionDays, so.delivery_code === "meet" ? 0 : st.returnShippingPaise])).rows[0];
    await tx.query(`insert into return_items (return_id, order_item_id) select $1, unnest($2::uuid[])`, [r.id, ids]);
    await tx.query(`update return_photos set return_id = $1 where id = any($2::uuid[])`, [r.id, photos]);
    await event(tx, r.id, null, "requested", { userId, role: "customer" });
    return r.id as string;
  });
}

export async function escalate(db: Db, userId: string, id: string, note: string) {
  await withTx(db, async (tx) => {
    const { r } = await lockReturn(tx, id, { userId });
    must(r, ["rejected"], "ask an admin");
    before(r, r.escalate_by, "ask an admin");
    await tx.query(`update returns set status = 'disputed', escalation_note = $2 where id = $1`, [id, note]);
    await event(tx, id, "rejected", "disputed", { userId, role: "customer" }, note);
  });
}

export async function shipBack(db: Db, userId: string, id: string, carrier: string, trackingNumber: string) {
  await withTx(db, async (tx) => {
    const { r } = await lockReturn(tx, id, { userId });
    must(r, ["approved"], "add shipping details");
    before(r, r.ship_by, "ship the item back");
    const st = await financeSettings(tx);
    await tx.query(
      `update returns set status = 'shipped_back', carrier = $2, tracking_number = $3, shipped_back_at = now(),
              receive_by = now() + make_interval(days => $4) where id = $1`, [id, carrier, trackingNumber, st.returnReceiptDays]);
    await event(tx, id, "approved", "shipped_back", { userId, role: "customer" }, `${carrier} ${trackingNumber}`);
  });
}

export async function withdraw(db: Db, userId: string, id: string) {
  await withTx(db, async (tx) => {
    const { r } = await lockReturn(tx, id, { userId });
    must(r, ["requested", "approved", "rejected", "disputed"], "withdraw it");
    await tx.query(`update returns set status = 'withdrawn' where id = $1`, [id]);
    await event(tx, id, r.status, "withdrawn", { userId, role: "customer" });
  });
}

// ---------- seller and admin decisions ----------

async function approveLocked(tx: Tx, r: any, actor: Actor, note?: string | null) {
  const st = await financeSettings(tx);
  await tx.query(`update returns set status = 'approved', ship_by = now() + make_interval(days => $2), admin_note = coalesce($3, admin_note) where id = $1`,
    [r.id, st.returnShipDays, actor.role === "admin" ? note ?? null : null]);
  await event(tx, r.id, r.status, "approved", actor, note);
}

export async function sellerAccept(db: Db, sellerId: string, userId: string, id: string) {
  await withTx(db, async (tx) => {
    const { r } = await lockReturn(tx, id, { sellerId });
    must(r, ["requested"], "accept it");
    before(r, r.seller_decide_by, "decide");
    await approveLocked(tx, r, { userId, role: "seller" });
  });
}

export async function sellerReject(db: Db, sellerId: string, userId: string, id: string, reason: string) {
  await withTx(db, async (tx) => {
    const { r } = await lockReturn(tx, id, { sellerId });
    must(r, ["requested"], "reject it");
    before(r, r.seller_decide_by, "decide");
    const st = await financeSettings(tx);
    await tx.query(`update returns set status = 'rejected', rejection_reason = $2, escalate_by = now() + make_interval(days => $3) where id = $1`,
      [id, reason, st.escalationDays]);
    await event(tx, id, "requested", "rejected", { userId, role: "seller" }, reason);
  });
}

// The admin's decision is final. Admins may decide any return that is not yet shipped back.
export async function adminDecide(db: Db, adminId: string, id: string, approve: boolean, note: string, audit: (tx: Tx) => Promise<void>) {
  await withTx(db, async (tx) => {
    const { r } = await lockReturn(tx, id, {});
    must(r, ["requested", "rejected", "disputed"], "decide it");
    if (approve) await approveLocked(tx, r, { userId: adminId, role: "admin" }, note);
    else {
      await tx.query(`update returns set status = 'closed', admin_note = $2 where id = $1`, [id, note]);
      await event(tx, id, r.status, "closed", { userId: adminId, role: "admin" }, note);
    }
    await audit(tx);
  });
}

// The item is back with the seller: stock is recorded as returned, and the refund is created and booked.
async function receiveLocked(tx: Tx, order: any, so: any, r: any, condition: "good" | "damaged", actor: Actor, note?: string | null): Promise<string> {
  await tx.query(`update returns set status = 'received', received_at = now(), received_condition = $2 where id = $1`, [r.id, condition]);
  await event(tx, r.id, r.status, "received", actor, note ?? (condition === "good" ? "Received in resellable condition" : "Received, not resellable"));
  const items = (await tx.query(
    `select i.id, i.variant_id, i.warehouse_id, i.quantity from return_items ri join order_items i on i.id = ri.order_item_id
      where ri.return_id = $1 order by i.variant_id, i.warehouse_id`, [r.id])).rows;
  const refundId = await createPackageRefund(tx, {
    order, so, itemIds: items.map((x) => x.id), kind: "return", returnRow: r, actorId: actor.userId,
    reason: `Return (${r.reason}) for package ${so.number}`,
  });
  await inv.lockProducts(tx, items.map((x) => x.variant_id));
  for (const x of items) await inv.receiveReturn(tx, x.variant_id, x.warehouse_id, x.quantity, condition, { referenceType: "return", referenceId: r.id, actorId: actor.userId });
  return refundId;
}

export async function markReceived(db: Db, actor: Actor, id: string, condition: "good" | "damaged", scope: { sellerId?: string }, note?: string, audit?: (tx: Tx) => Promise<void>): Promise<string> {
  return withTx(db, async (tx) => {
    const { order, so, r } = await lockReturn(tx, id, scope);
    must(r, ["shipped_back"], "confirm receipt");
    const refundId = await receiveLocked(tx, order, so, r, condition, actor, note);
    if (audit) await audit(tx);
    return refundId;
  });
}

// ---------- deadlines (background) ----------

// One return per transaction; returns the ids of refunds created so the caller can send them.
// One return per transaction; returns the ids of refunds created so the caller can send them. A
// return that fails is skipped for the rest of this run (and reported), so one bad record never
// stops the others.
export async function processDeadlines(db: Db, max = 200): Promise<{ changed: number; refunds: string[]; failed: { id: string; error: string }[] }> {
  const refunds: string[] = [];
  const failed: { id: string; error: string }[] = [];
  let changed = 0;
  const system: Actor = { userId: null, role: "system" };
  while (changed + failed.length < max) {
    const id = (await db.query(
      `select id from returns where ((status = 'requested' and seller_decide_by <= now())
          or (status = 'rejected' and escalate_by <= now())
          or (status = 'approved' and ship_by <= now())
          or (status = 'shipped_back' and receive_by <= now()))
          and not (id = any($1::uuid[]))
        order by updated_at limit 1`, [failed.map((f) => f.id)])).rows[0]?.id;
    if (!id) break;
    try {
      await withTx(db, async (tx) => {
        const { order, so, r } = await lockReturn(tx, id, {});
        const due = (d: any) => d && new Date(r.now) >= new Date(d);
        if (r.status === "requested" && due(r.seller_decide_by)) await approveLocked(tx, r, system, "The seller did not answer in time, so the return is accepted.");
        else if (r.status === "rejected" && due(r.escalate_by)) {
          await tx.query(`update returns set status = 'closed' where id = $1`, [id]);
          await event(tx, id, "rejected", "closed", system, "Not taken to an admin in time.");
        } else if (r.status === "approved" && due(r.ship_by)) {
          await tx.query(`update returns set status = 'closed' where id = $1`, [id]);
          await event(tx, id, "approved", "closed", system, "The item was not shipped back in time.");
        } else if (r.status === "shipped_back" && due(r.receive_by)) {
          refunds.push(await receiveLocked(tx, order, so, r, "damaged", system, "The seller did not confirm receipt in time; treated as received."));
        }
      });
      changed++;
    } catch (err: any) {
      failed.push({ id, error: String(err?.message ?? err).slice(0, 300) });
    }
  }
  return { changed, refunds, failed };
}

// ---------- views ----------

export async function detail(db: Queryable, id: string, scope: { userId?: string; sellerId?: string; admin?: boolean }) {
  const r = (await db.query(
    `select r.*, so.number as package_number, o.number as order_number from returns r
       join seller_orders so on so.id = r.seller_order_id join orders o on o.id = r.order_id
      where r.id = $1 and ($2::uuid is null or r.user_id = $2) and ($3::uuid is null or r.seller_id = $3)`,
    [id, scope.userId ?? null, scope.sellerId ?? null])).rows[0];
  if (!r) throw Errors.notFound("Return");
  const items = (await db.query(
    `select i.id, i.title, i.sku, i.quantity, i.net_paise from return_items ri join order_items i on i.id = ri.order_item_id where ri.return_id = $1 order by i.created_at, i.id`, [id])).rows;
  const photos = (await db.query(`select id from return_photos where return_id = $1 order by created_at, id`, [id])).rows;
  const events = (await db.query(`select * from return_events where return_id = $1 order by id`, [id])).rows;
  const refund = (await db.query(`select id, amount_paise, items_paise, buyer_fee_paise, return_shipping_paise, status, processed_at from refunds where return_id = $1`, [id])).rows[0];
  return {
    id: r.id, orderId: r.order_id, orderNumber: r.order_number, packageId: r.seller_order_id, packageNumber: r.package_number,
    status: r.status, reason: r.reason, description: r.description,
    items: items.map((x) => ({ id: x.id, title: x.title, sku: x.sku, quantity: x.quantity, netPaise: Number(x.net_paise) })),
    photoIds: photos.map((p) => p.id),
    sellerDecideBy: r.seller_decide_by, rejectionReason: r.rejection_reason, escalateBy: r.escalate_by, escalationNote: r.escalation_note,
    adminNote: r.admin_note, shipBy: r.ship_by, carrier: r.carrier, trackingNumber: r.tracking_number, shippedBackAt: r.shipped_back_at,
    receiveBy: r.receive_by, receivedAt: r.received_at, receivedCondition: r.received_condition,
    returnShippingPaise: Number(r.return_shipping_paise), currency: CURRENCY,
    refund: refund ? {
      id: refund.id, amountPaise: Number(refund.amount_paise), itemsPaise: Number(refund.items_paise), buyerProtectionPaise: Number(refund.buyer_fee_paise),
      returnShippingPaise: Number(refund.return_shipping_paise), status: refund.status, processedAt: refund.processed_at,
    } : null,
    history: events.map((e) => ({ from: e.from_status, to: e.to_status, by: e.actor_role, note: e.note, at: e.created_at, ...(scope.admin ? { actorId: e.actor_id } : {}) })),
    createdAt: r.created_at,
  };
}
