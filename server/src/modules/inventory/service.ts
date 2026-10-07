import type { Db, Queryable, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";

// All stock changes go through this module. Functions that take `tx` run inside the caller's
// transaction, so checkout can reserve stock and create an order atomically.

export interface Deltas { onHand?: number; reserved?: number; sold?: number; returned?: number; damaged?: number }
export interface MoveMeta { referenceType?: string | null; referenceId?: string | null; actorId?: string | null; note?: string | null }
export type MoveReason =
  | "restock" | "correction" | "damage" | "loss" | "reserve" | "release" | "expire" | "sale"
  | "cancel_sale" | "return_received" | "return_damaged" | "return_restocked" | "admin_adjustment";

const CHECK_VIOLATION = "23514";
const STOCK_CONSTRAINTS = new Set(["inventory_non_negative", "inventory_reserved_within_on_hand"]);

// Lock the products behind these variants, always in product-id order, before touching stock.
// The search refresh triggered by a stock change takes the same per-product lock, so taking all of
// them up front in one global order means two checkouts can never wait on each other in a cycle.
export async function lockProducts(tx: Tx, variantIds: string[]): Promise<void> {
  if (!variantIds.length) return;
  await tx.query(
    `select pg_advisory_xact_lock(hashtextextended('product_search:' || product_id::text, 0))
       from (select distinct product_id from product_variants where id = any($1) order by product_id) p`,
    [variantIds],
  );
}

export const insufficient = (details?: unknown) =>
  new AppError(409, "INSUFFICIENT_STOCK", "There is not enough stock for this change.", details);

// Applies counter changes to one stock row and records the movement, in the same statement order
// every time. The CHECK constraints on inventory_levels are the final guard against negative stock.
export async function move(tx: Tx, variantId: string, warehouseId: string, d: Deltas, reason: MoveReason, meta: MoveMeta = {}) {
  const v = [d.onHand ?? 0, d.reserved ?? 0, d.sold ?? 0, d.returned ?? 0, d.damaged ?? 0];
  await lockProducts(tx, [variantId]);
  let row;
  try {
    const r = await tx.query(
      `update inventory_levels
          set on_hand = on_hand + $3, reserved = reserved + $4, sold = sold + $5, returned = returned + $6, damaged = damaged + $7
        where variant_id = $1 and warehouse_id = $2
        returning on_hand, reserved`,
      [variantId, warehouseId, ...v],
    );
    row = r.rows[0];
    if (!row) {
      if (v.some((x) => x < 0)) throw insufficient();
      const ins = await tx.query(
        `insert into inventory_levels (variant_id, warehouse_id, on_hand, reserved, sold, returned, damaged)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (variant_id, warehouse_id) do update set
           on_hand = inventory_levels.on_hand + excluded.on_hand, reserved = inventory_levels.reserved + excluded.reserved,
           sold = inventory_levels.sold + excluded.sold, returned = inventory_levels.returned + excluded.returned,
           damaged = inventory_levels.damaged + excluded.damaged
         returning on_hand, reserved`,
        [variantId, warehouseId, ...v],
      );
      row = ins.rows[0];
    }
  } catch (e: any) {
    if (e?.code === CHECK_VIOLATION && STOCK_CONSTRAINTS.has(e.constraint)) throw insufficient();
    if (e?.code === CHECK_VIOLATION && e.constraint === "inventory_sane_size") {
      throw new AppError(422, "STOCK_LIMIT", "A stock count cannot exceed 1,000,000 units.");
    }
    throw e;
  }
  await tx.query(
    `insert into stock_movements (variant_id, warehouse_id, reason, d_on_hand, d_reserved, d_sold, d_returned, d_damaged,
                                  on_hand_after, reserved_after, reference_type, reference_id, actor_id, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [variantId, warehouseId, reason, ...v, row.on_hand, row.reserved, meta.referenceType ?? null, meta.referenceId ?? null, meta.actorId ?? null, meta.note ?? null],
  );
  return { onHand: row.on_hand as number, reserved: row.reserved as number };
}

// ---------- reservations (used by checkout) ----------

export interface ReserveLine { variantId: string; quantity: number }
export interface Reservation { id: string; variantId: string; warehouseId: string; quantity: number; expiresAt: Date }

// All-or-nothing: either every line gets stock held, or the caller's transaction is rolled back
// with OUT_OF_STOCK listing what is short. Two buyers can never both reserve the last unit:
// the UPDATE re-checks availability on the latest row version after waiting for the other.
export async function reserve(
  tx: Tx, lines: ReserveLine[],
  opts: { ownerUserId: string; referenceType: string; referenceId: string; ttlMinutes: number },
): Promise<Reservation[]> {
  const merged = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 1000) throw Errors.validation([{ path: "quantity", message: "Quantity must be 1 to 1000." }]);
    merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity);
  }
  for (const q of merged.values()) {
    if (q > 1000) throw Errors.validation([{ path: "quantity", message: "At most 1000 units of one item per order." }]);
  }
  await lockProducts(tx, [...merged.keys()]);
  // A fixed order (by variant id) means two checkouts with the same items cannot deadlock.
  const ordered = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Reservation[] = [];
  const short: { variantId: string; requested: number; available: number }[] = [];
  for (const [variantId, quantity] of ordered) {
    const ok = await tx.query(`select 1 from product_variants where id = $1 and is_active and deleted_at is null`, [variantId]);
    if (!ok.rowCount) { short.push({ variantId, requested: quantity, available: 0 }); continue; }
    let warehouseId: string | null = null;
    for (let attempt = 0; attempt < 3 && !warehouseId; attempt++) {
      const r = await tx.query(
        `with pick as (
           select il.warehouse_id
             from inventory_levels il join warehouses w on w.id = il.warehouse_id
            where il.variant_id = $1 and w.is_active and il.on_hand - il.reserved >= $2
            order by w.is_default desc, il.on_hand - il.reserved desc, il.warehouse_id
            limit 1
         )
         update inventory_levels il set reserved = il.reserved + $2
           from pick
          where il.variant_id = $1 and il.warehouse_id = pick.warehouse_id and il.on_hand - il.reserved >= $2
         returning il.warehouse_id`,
        [variantId, quantity],
      );
      warehouseId = r.rows[0]?.warehouse_id ?? null;
    }
    if (!warehouseId) {
      const a = await tx.query(
        `select coalesce(max(il.on_hand - il.reserved), 0)::int as available
           from inventory_levels il join warehouses w on w.id = il.warehouse_id where il.variant_id = $1 and w.is_active`,
        [variantId],
      );
      short.push({ variantId, requested: quantity, available: a.rows[0].available });
      continue;
    }
    let res;
    try {
      res = await tx.query(
        `insert into stock_reservations (variant_id, warehouse_id, quantity, owner_user_id, reference_type, reference_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7)) returning id, expires_at`,
        [variantId, warehouseId, quantity, opts.ownerUserId, opts.referenceType, opts.referenceId, opts.ttlMinutes],
      );
    } catch (e: any) {
      if (e?.code === "23505") throw Errors.conflict("ALREADY_RESERVED", "Stock is already held for this checkout.");
      throw e;
    }
    const row = await tx.query(`select on_hand, reserved from inventory_levels where variant_id = $1 and warehouse_id = $2`, [variantId, warehouseId]);
    await tx.query(
      `insert into stock_movements (variant_id, warehouse_id, reason, d_reserved, on_hand_after, reserved_after, reference_type, reference_id, actor_id)
       values ($1, $2, 'reserve', $3, $4, $5, $6, $7, $8)`,
      [variantId, warehouseId, quantity, row.rows[0].on_hand, row.rows[0].reserved, opts.referenceType, opts.referenceId, opts.ownerUserId],
    );
    out.push({ id: res.rows[0].id, variantId, warehouseId, quantity, expiresAt: res.rows[0].expires_at });
  }
  if (short.length) {
    throw new AppError(409, "OUT_OF_STOCK", "Some items are no longer available in the quantity you asked for.", short);
  }
  return out;
}

async function closeReservations(tx: Tx, ids: string[], to: "released" | "expired" | "converted") {
  const vs = await tx.query(`select distinct variant_id from stock_reservations where id = any($1)`, [ids]);
  await lockProducts(tx, vs.rows.map((x) => x.variant_id));
  const r = await tx.query(
    `update stock_reservations set status = $2, closed_at = now()
      where id = any($1) and status = 'active'
      returning id, variant_id, warehouse_id, quantity, reference_type, reference_id`,
    [ids, to],
  );
  return r.rows.sort((a, b) => (a.variant_id + a.warehouse_id < b.variant_id + b.warehouse_id ? -1 : 1));
}

// Gives held stock back. Safe to call twice: only reservations still active are released.
export async function release(tx: Tx, ids: string[], reason: "release" | "expire" = "release", actorId: string | null = null): Promise<number> {
  const rows = await closeReservations(tx, ids, reason === "expire" ? "expired" : "released");
  for (const r of rows) {
    await move(tx, r.variant_id, r.warehouse_id, { reserved: -r.quantity }, reason, { referenceType: r.reference_type, referenceId: r.reference_id, actorId });
  }
  return rows.length;
}

// Payment confirmed: held units become sold. Every reservation must still be active (not yet
// released or expired by the sweeper); otherwise nothing changes and the payment flow must refund.
export async function convert(tx: Tx, ids: string[], actorId: string | null = null): Promise<void> {
  const rows = await closeReservations(tx, ids, "converted");
  if (rows.length !== new Set(ids).size) {
    throw new AppError(409, "RESERVATION_NOT_ACTIVE", "The stock hold for this order has ended. The payment must be refunded.");
  }
  for (const r of rows) {
    await move(tx, r.variant_id, r.warehouse_id, { reserved: -r.quantity, onHand: -r.quantity, sold: r.quantity }, "sale",
      { referenceType: r.reference_type, referenceId: r.reference_id, actorId });
  }
}

// Background sweep: releases holds whose time is up. Several API instances can run it at once:
// SKIP LOCKED means each reservation is processed by exactly one of them.
export async function expireDue(db: Db, batch = 100): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await withTx(db, async (tx) => {
      const r = await tx.query(
        // Holds that belong to an order are released by the order sweep, which also cancels the order.
        `select id from stock_reservations where status = 'active' and expires_at <= now() and reference_type <> 'order'
          order by expires_at limit $1 for update skip locked`,
        [batch],
      );
      if (!r.rowCount) return 0;
      return release(tx, r.rows.map((x) => x.id), "expire");
    });
    total += n;
    if (n < batch) return total;
  }
}

// ---------- order follow-ups (used by the order module) ----------

export const cancelSale = (tx: Tx, variantId: string, warehouseId: string, qty: number, meta: MoveMeta) =>
  move(tx, variantId, warehouseId, { sold: -qty, onHand: qty }, "cancel_sale", meta);

export const receiveReturn = (tx: Tx, variantId: string, warehouseId: string, qty: number, condition: "good" | "damaged", meta: MoveMeta) =>
  condition === "good"
    ? move(tx, variantId, warehouseId, { sold: -qty, returned: qty }, "return_received", meta)
    : move(tx, variantId, warehouseId, { sold: -qty, damaged: qty }, "return_damaged", meta);

export const restockReturned = (tx: Tx, variantId: string, warehouseId: string, qty: number, meta: MoveMeta) =>
  move(tx, variantId, warehouseId, { returned: -qty, onHand: qty }, "return_restocked", meta);

// ---------- manual stock changes ----------

export type AdjustReason = "restock" | "correction" | "damage" | "loss";

export async function adjust(tx: Tx, variantId: string, warehouseId: string, delta: number, reason: AdjustReason, meta: MoveMeta, asAdmin = false) {
  if (!Number.isInteger(delta) || delta === 0) throw Errors.validation([{ path: "delta", message: "Give a whole number other than 0." }]);
  if (reason === "restock" && delta < 0) throw Errors.validation([{ path: "delta", message: "A restock adds stock." }]);
  if ((reason === "damage" || reason === "loss") && delta > 0) throw Errors.validation([{ path: "delta", message: "Damage and loss remove stock." }]);
  const d: Deltas = reason === "damage" ? { onHand: delta, damaged: -delta } : { onHand: delta };
  try {
    return await move(tx, variantId, warehouseId, d, asAdmin ? "admin_adjustment" : reason, meta);
  } catch (e) {
    if (e instanceof AppError && e.code === "INSUFFICIENT_STOCK") {
      throw new AppError(409, "STOCK_BELOW_RESERVED", "Stock cannot go below the units already held for checkouts or below zero.");
    }
    throw e;
  }
}

// Sets the count to an exact number, but only if it is still what the seller last saw. A sale that
// happened in between makes this fail with STOCK_CHANGED instead of silently undoing the sale.
export async function setOnHand(tx: Tx, variantId: string, warehouseId: string, onHand: number, expectedOnHand: number, meta: MoveMeta) {
  await lockProducts(tx, [variantId]);
  // Make sure the row exists before locking it, so two first-time counts cannot both pass the check.
  await tx.query(`insert into inventory_levels (variant_id, warehouse_id) values ($1, $2) on conflict do nothing`, [variantId, warehouseId]);
  const cur = await tx.query(`select on_hand from inventory_levels where variant_id = $1 and warehouse_id = $2 for update`, [variantId, warehouseId]);
  const now = cur.rows[0]?.on_hand ?? 0;
  if (now !== expectedOnHand) {
    throw new AppError(409, "STOCK_CHANGED", "Stock changed since you loaded it (for example, a sale). Reload and try again.", { currentOnHand: now });
  }
  if (onHand === now) return { onHand: now };
  return adjust(tx, variantId, warehouseId, onHand - now, "correction", meta);
}

// ---------- reads ----------

// What one order can actually get: a reservation comes from a single warehouse, so this is the
// largest amount in any one active warehouse (not the sum across warehouses).
export async function availability(db: Queryable, variantIds: string[]): Promise<Map<string, number>> {
  const r = await db.query(
    `select il.variant_id, max(il.on_hand - il.reserved)::int as available
       from inventory_levels il join warehouses w on w.id = il.warehouse_id
      where il.variant_id = any($1) and w.is_active group by il.variant_id`,
    [variantIds],
  );
  return new Map(r.rows.map((x) => [x.variant_id, x.available]));
}

// ---------- search refresh queue ----------

// Refreshes queued products in batches. Each batch first takes the per-product locks in
// product-id order (the same locks stock changes take), then rebuilds the batch in one statement,
// whose snapshot therefore already includes every stock change that committed before it.
// Called right after a bulk change commits (up to `maxTotal` products, so a request never waits
// long) and by the background sweep for anything left over.
export async function processSearchQueue(db: Db, batch = 200, maxTotal = Infinity): Promise<number> {
  let total = 0;
  while (total < maxTotal) {
    const n = await withTx(db, async (tx) => {
      const r = await tx.query(
        `select product_id from search_refresh_queue order by product_id limit $1 for update skip locked`, [batch]);
      const ids: string[] = r.rows.map((x) => x.product_id);
      if (!ids.length) return 0;
      await tx.query(
        `select pg_advisory_xact_lock(hashtextextended('product_search:' || id::text, 0)) from unnest($1::uuid[]) as id order by id`, [ids]);
      await tx.query(`select refresh_product_search_many($1)`, [ids]);
      await tx.query(`delete from search_refresh_queue where product_id = any($1)`, [ids]);
      return ids.length;
    });
    total += n;
    if (n < batch) break;
  }
  return total;
}
