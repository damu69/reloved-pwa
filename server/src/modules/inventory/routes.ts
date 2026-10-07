import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, safeText, uuid } from "../../lib/validate.js";
import { Errors } from "../../lib/errors.js";
import { withTx, type Tx } from "../../lib/db.js";
import { writeAudit } from "../../lib/audit.js";
import { authenticate, requirePermission } from "../auth/guard.js";
import { requireApprovedSeller } from "../sellers/guard.js";
import * as inv from "./service.js";

// After a change that queued many products for a search refresh. Failures are logged and left to
// the background sweep; they never fail the request that already committed.
// Up to 1,000 products are refreshed before the response; a larger backlog continues in the
// background right away (and the sweep picks up anything left after a crash).
export async function refreshSearchSoon(app: FastifyInstance): Promise<void> {
  const log = (err: unknown) => app.log.error({ err }, "search refresh queue failed");
  const done = await inv.processSearchQueue(app.db, 200, 1000).catch((err) => { log(err); return 0; });
  if (done >= 1000) void inv.processSearchQueue(app.db).catch(log);
}

const ctxOf = (req: FastifyRequest) => ({ actorUserId: req.auth!.userId, ip: req.ip ?? null, requestId: String(req.id) });
const variantParam = z.object({ variantId: uuid() });
const qty = z.number().int().min(1).max(100_000);

async function ownVariant(tx: Tx, sellerId: string, variantId: string) {
  const r = await tx.query(`select id from product_variants where id = $1 and seller_id = $2 and deleted_at is null`, [variantId, sellerId]);
  if (!r.rowCount) throw Errors.notFound("Variant");
}

// The seller's default warehouse, created from their business address the first time it is needed.
async function defaultWarehouse(tx: Tx, sellerId: string): Promise<string> {
  const find = () => tx.query(`select id from warehouses where seller_id = $1 and is_default`, [sellerId]);
  const r = await find();
  if (r.rows[0]) return r.rows[0].id;
  await tx.query(
    `insert into warehouses (seller_id, name, pincode, city, is_default)
     select id, 'Main warehouse', pincode, city, true from sellers where id = $1
     on conflict do nothing`,
    [sellerId],
  );
  return (await find()).rows[0].id;
}

async function resolveWarehouse(tx: Tx, sellerId: string, warehouseId: string | undefined): Promise<string> {
  if (!warehouseId) return defaultWarehouse(tx, sellerId);
  const r = await tx.query(`select id from warehouses where id = $1 and seller_id = $2`, [warehouseId, sellerId]);
  if (!r.rowCount) throw Errors.notFound("Warehouse");
  return warehouseId;
}

const levelSelect = `
  select il.variant_id, il.warehouse_id, il.on_hand, il.reserved, il.sold, il.returned, il.damaged, il.low_stock_threshold,
         il.on_hand - il.reserved as available, pv.sku, pv.options, pv.product_id, p.title, w.name as warehouse_name, w.is_active as warehouse_active
    from inventory_levels il
    join product_variants pv on pv.id = il.variant_id
    join products p on p.id = pv.product_id
    join warehouses w on w.id = il.warehouse_id`;
const levelOut = (x: any) => ({
  variantId: x.variant_id, warehouseId: x.warehouse_id, warehouseName: x.warehouse_name, warehouseActive: x.warehouse_active,
  productId: x.product_id, productTitle: x.title, sku: x.sku, options: x.options,
  onHand: x.on_hand, reserved: x.reserved, available: x.available, sold: x.sold, returned: x.returned, damaged: x.damaged,
  lowStockThreshold: x.low_stock_threshold, isLow: x.available <= x.low_stock_threshold,
});

export async function sellerInventoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireApprovedSeller);
  const sid = (req: FastifyRequest) => req.seller!.id;

  app.get("/warehouses", async (req) => {
    const r = await app.db.query(`select id, name, pincode, city, is_default, is_active from warehouses where seller_id = $1 order by is_default desc, name`, [sid(req)]);
    return { items: r.rows.map((w) => ({ id: w.id, name: w.name, pincode: w.pincode, city: w.city, isDefault: w.is_default, isActive: w.is_active })) };
  });

  app.post("/warehouses", async (req, reply) => {
    const b = parse(z.object({ name: safeText(2, 80), pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/), city: safeText(2, 80).optional(), isDefault: z.boolean().optional() }).strict(), req.body);
    const id = await withTx(app.db, async (tx) => {
      await tx.query(`select id from sellers where id = $1 for update`, [sid(req)]); // serialise default changes per seller
      const any = await tx.query(`select 1 from warehouses where seller_id = $1 and is_default`, [sid(req)]);
      const makeDefault = b.isDefault === true || !any.rowCount;
      if (makeDefault) await tx.query(`update warehouses set is_default = false where seller_id = $1 and is_default`, [sid(req)]);
      try {
        const r = await tx.query(
          `insert into warehouses (seller_id, name, pincode, city, is_default) values ($1, $2, $3, $4, $5) returning id`,
          [sid(req), b.name, b.pincode, b.city ?? null, makeDefault],
        );
        return r.rows[0].id;
      } catch (e: any) {
        if (e?.code === "23505") throw Errors.conflict("WAREHOUSE_EXISTS", "You already have a warehouse with this name.");
        throw e;
      }
    });
    return reply.code(201).send({ id });
  });

  app.patch("/warehouses/:id", async (req) => {
    const { id } = parse(z.object({ id: uuid() }), req.params);
    const b = parse(z.object({ name: safeText(2, 80), isDefault: z.literal(true), isActive: z.boolean() }).partial().strict(), req.body);
    await withTx(app.db, async (tx) => {
      await tx.query(`select id from sellers where id = $1 for update`, [sid(req)]);
      const w = (await tx.query(`select * from warehouses where id = $1 and seller_id = $2`, [id, sid(req)])).rows[0];
      if (!w) throw Errors.notFound("Warehouse");
      const willBeActive = b.isActive ?? w.is_active;
      const willBeDefault = b.isDefault ?? w.is_default;
      if (willBeDefault && !willBeActive) {
        throw Errors.invalidTransition("The default warehouse must stay active. Make another warehouse the default first.");
      }
      if (b.isDefault) {
        await tx.query(`update warehouses set is_default = false where seller_id = $1 and is_default and id <> $2`, [sid(req), id]);
      }
      try {
        await tx.query(
          `update warehouses set name = coalesce($2, name), is_default = coalesce($3, is_default), is_active = coalesce($4, is_active) where id = $1`,
          [id, b.name ?? null, b.isDefault ?? null, b.isActive ?? null],
        );
      } catch (e: any) {
        if (e?.code === "23505") throw Errors.conflict("WAREHOUSE_EXISTS", "You already have a warehouse with this name.");
        throw e;
      }
    });
    await refreshSearchSoon(app);
    return { ok: true };
  });

  app.get("/", async (req) => {
    const q = parse(z.object({
      productId: uuid().optional(),
      lowStock: z.enum(["true", "false"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().regex(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/).optional(),
    }), req.query);
    const [cv, cw] = q.cursor ? q.cursor.split(":") : [null, null];
    const r = await app.db.query(
      `${levelSelect}
        where pv.seller_id = $1 and pv.deleted_at is null
          and ($2::uuid is null or pv.product_id = $2)
          and ($3::boolean is not true or il.on_hand - il.reserved <= il.low_stock_threshold)
          and ($4::uuid is null or (il.variant_id, il.warehouse_id) > ($4::uuid, $5::uuid))
        order by il.variant_id, il.warehouse_id limit $6`,
      [sid(req), q.productId ?? null, q.lowStock === "true", cv, cw, q.limit + 1],
    );
    const more = r.rows.length > q.limit;
    const items = (more ? r.rows.slice(0, q.limit) : r.rows).map(levelOut);
    const last = items.at(-1);
    return { items, nextCursor: more && last ? `${last.variantId}:${last.warehouseId}` : null };
  });

  app.post("/:variantId/adjust", async (req) => {
    const { variantId } = parse(variantParam, req.params);
    const b = parse(z.object({
      warehouseId: uuid().optional(),
      delta: z.number().int().min(-100_000).max(100_000).refine((x) => x !== 0, "Cannot be 0"),
      reason: z.enum(["restock", "correction", "damage", "loss"]),
      note: safeText(1, 300).optional(),
    }).strict(), req.body);
    return withTx(app.db, async (tx) => {
      await ownVariant(tx, sid(req), variantId);
      const wh = await resolveWarehouse(tx, sid(req), b.warehouseId);
      const res = await inv.adjust(tx, variantId, wh, b.delta, b.reason, { actorId: req.auth!.userId, note: b.note ?? null });
      return { variantId, warehouseId: wh, ...res, available: res.onHand - res.reserved };
    });
  });

  app.put("/:variantId", async (req) => {
    const { variantId } = parse(variantParam, req.params);
    const b = parse(z.object({
      warehouseId: uuid().optional(),
      onHand: z.number().int().min(0).max(1_000_000),
      expectedOnHand: z.number().int().min(0).max(1_000_000),
      lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
      note: safeText(1, 300).optional(),
    }).strict(), req.body);
    return withTx(app.db, async (tx) => {
      await ownVariant(tx, sid(req), variantId);
      const wh = await resolveWarehouse(tx, sid(req), b.warehouseId);
      const res = await inv.setOnHand(tx, variantId, wh, b.onHand, b.expectedOnHand, { actorId: req.auth!.userId, note: b.note ?? null });
      if (b.lowStockThreshold !== undefined) {
        await tx.query(
          `insert into inventory_levels (variant_id, warehouse_id, low_stock_threshold) values ($1, $2, $3)
           on conflict (variant_id, warehouse_id) do update set low_stock_threshold = excluded.low_stock_threshold`,
          [variantId, wh, b.lowStockThreshold],
        );
      }
      const lvl = (await tx.query(`${levelSelect} where il.variant_id = $1 and il.warehouse_id = $2`, [variantId, wh])).rows[0];
      return lvl ? levelOut(lvl) : { variantId, warehouseId: wh, ...res };
    });
  });

  app.post("/:variantId/restock-returned", async (req) => {
    const { variantId } = parse(variantParam, req.params);
    const b = parse(z.object({ warehouseId: uuid().optional(), quantity: qty }).strict(), req.body);
    return withTx(app.db, async (tx) => {
      await ownVariant(tx, sid(req), variantId);
      const wh = await resolveWarehouse(tx, sid(req), b.warehouseId);
      return inv.restockReturned(tx, variantId, wh, b.quantity, { actorId: req.auth!.userId });
    });
  });

  app.get("/:variantId/movements", async (req) => {
    const { variantId } = parse(variantParam, req.params);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.coerce.number().int().positive().optional() }), req.query);
    await withTx(app.db, (tx) => ownVariant(tx, sid(req), variantId));
    const r = await app.db.query(
      `select m.id, m.warehouse_id, m.reason, m.d_on_hand, m.d_reserved, m.d_sold, m.d_returned, m.d_damaged, m.on_hand_after, m.reserved_after, m.note, m.created_at
         from stock_movements m where m.variant_id = $1 and ($2::bigint is null or m.id < $2) order by m.id desc limit $3`,
      [variantId, q.before ?? null, q.limit],
    );
    return {
      items: r.rows.map((m) => ({
        id: String(m.id), warehouseId: m.warehouse_id, reason: m.reason,
        change: { onHand: m.d_on_hand, reserved: m.d_reserved, sold: m.d_sold, returned: m.d_returned, damaged: m.d_damaged },
        onHandAfter: m.on_hand_after, reservedAfter: m.reserved_after, note: m.note, at: m.created_at,
      })),
      nextBefore: r.rows.length === q.limit ? String(r.rows.at(-1).id) : null,
    };
  });
}

export async function adminInventoryRoutes(app: FastifyInstance): Promise<void> {
  const perm = requirePermission("admin.inventory.manage");
  app.addHook("preHandler", authenticate);

  app.get("/movements", { preHandler: perm }, async (req) => {
    const q = parse(z.object({ variantId: uuid().optional(), sellerId: uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), before: z.coerce.number().int().positive().optional() }), req.query);
    const r = await app.db.query(
      `select m.*, pv.sku, pv.seller_id from stock_movements m join product_variants pv on pv.id = m.variant_id
        where ($1::uuid is null or m.variant_id = $1) and ($2::uuid is null or pv.seller_id = $2) and ($3::bigint is null or m.id < $3)
        order by m.id desc limit $4`,
      [q.variantId ?? null, q.sellerId ?? null, q.before ?? null, q.limit],
    );
    return {
      items: r.rows.map((m) => ({ id: String(m.id), variantId: m.variant_id, sku: m.sku, sellerId: m.seller_id, warehouseId: m.warehouse_id, reason: m.reason,
        change: { onHand: m.d_on_hand, reserved: m.d_reserved, sold: m.d_sold, returned: m.d_returned, damaged: m.d_damaged },
        onHandAfter: m.on_hand_after, reservedAfter: m.reserved_after, actorId: m.actor_id, referenceType: m.reference_type, referenceId: m.reference_id, note: m.note, at: m.created_at })),
      nextBefore: r.rows.length === q.limit ? String(r.rows.at(-1).id) : null,
    };
  });

  app.post("/:variantId/adjust", { preHandler: perm }, async (req) => {
    const { variantId } = parse(variantParam, req.params);
    const b = parse(z.object({
      warehouseId: uuid(),
      delta: z.number().int().min(-100_000).max(100_000).refine((x) => x !== 0, "Cannot be 0"),
      reason: z.enum(["restock", "correction", "damage", "loss"]),
      note: safeText(3, 300),
    }).strict(), req.body);
    return withTx(app.db, async (tx) => {
      const v = (await tx.query(
        `select pv.id, s.user_id from product_variants pv join sellers s on s.id = pv.seller_id
          join warehouses w on w.id = $2 and w.seller_id = pv.seller_id where pv.id = $1`,
        [variantId, b.warehouseId],
      )).rows[0];
      if (!v) throw Errors.notFound("Variant or warehouse");
      if (v.user_id === req.auth!.userId) throw Errors.forbidden("You cannot adjust stock of your own seller account here.");
      const res = await inv.adjust(tx, variantId, b.warehouseId, b.delta, b.reason, { actorId: req.auth!.userId, note: b.note }, true);
      await writeAudit(tx, { ...ctxOf(req), action: "inventory.admin_adjust", entity: "variant", entityId: variantId, newValue: { warehouseId: b.warehouseId, delta: b.delta, reason: b.reason, note: b.note, ...res } });
      return { variantId, warehouseId: b.warehouseId, ...res, available: res.onHand - res.reserved };
    });
  });
}
