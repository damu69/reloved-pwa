import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, safeText, uuid } from "../../lib/validate.js";
import { Errors } from "../../lib/errors.js";
import { withTx } from "../../lib/db.js";
import { writeAudit } from "../../lib/audit.js";
import { CURRENCY } from "../../lib/money.js";
import { windowLimiter } from "../../lib/limiter.js";
import { authenticate, requirePermission } from "../auth/guard.js";
import * as cart from "./service.js";

const ctxOf = (req: FastifyRequest) => ({ actorUserId: req.auth!.userId, ip: req.ip ?? null, requestId: String(req.id) });

// ---------------- customer: cart ----------------

export async function cartRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const uid = (req: FastifyRequest) => req.auth!.userId;
  // Guessing coupon codes is slowed down per account AND per IP (separate counters), so neither
  // switching IPs nor switching accounts helps.
  const couponPerUser = windowLimiter("coupon-user", 10, 15 * 60_000, (req) => String(req.auth?.userId));
  const couponPerIp = windowLimiter("coupon-ip", 30, 15 * 60_000, (req) => req.ip);
  const couponLimit = async (req: FastifyRequest) => { await couponPerUser(req); await couponPerIp(req); };

  app.get("/", async (req) => cart.view(app.db, uid(req)));

  app.put("/items/:variantId", async (req) => {
    const { variantId } = parse(z.object({ variantId: uuid() }), req.params);
    const { quantity } = parse(z.object({ quantity: z.number().int().min(0).max(1000) }).strict(), req.body);
    await cart.setItem(app.db, uid(req), variantId, quantity);
    return cart.view(app.db, uid(req));
  });

  app.delete("/items/:variantId", async (req) => {
    const { variantId } = parse(z.object({ variantId: uuid() }), req.params);
    await cart.setItem(app.db, uid(req), variantId, 0);
    return cart.view(app.db, uid(req));
  });

  app.put("/delivery/:sellerId", async (req) => {
    const { sellerId } = parse(z.object({ sellerId: uuid() }), req.params);
    const { code } = parse(z.object({ code: z.string().regex(/^[a-z_]{2,20}$/) }).strict(), req.body);
    await cart.setDelivery(app.db, uid(req), sellerId, code);
    return cart.view(app.db, uid(req));
  });

  app.post("/coupon", { preHandler: couponLimit }, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().regex(/^[A-Za-z0-9]{4,20}$/, "Codes are 4 to 20 letters or digits") }).strict(), req.body);
    await cart.applyCoupon(app.db, uid(req), code);
    return cart.view(app.db, uid(req));
  });

  app.delete("/coupon", async (req) => {
    await cart.removeCoupon(app.db, uid(req));
    return cart.view(app.db, uid(req));
  });

  app.delete("/", async (req, reply) => {
    await cart.clear(app.db, uid(req));
    return reply.code(204).send();
  });
}

// ---------------- customer: wishlist ----------------

export async function wishlistRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.get("/", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    // Only products that are still live are shown; removed ones simply drop out.
    const r = await app.db.query(
      `select ps.product_id, ps.title, ps.min_price_paise, ps.cover_image_id, ps.in_stock, w.created_at
         from wishlists w
         join product_search ps on ps.product_id = w.product_id and ps.is_listed
         join sellers s on s.id = ps.seller_id and s.status = 'approved'
         join categories c on c.id = ps.category_id and c.is_active
        where w.user_id = $1 order by w.created_at desc limit $2`,
      [req.auth!.userId, q.limit],
    );
    return { items: r.rows.map((x) => ({ productId: x.product_id, title: x.title, minPricePaise: Number(x.min_price_paise), currency: CURRENCY, coverImageId: x.cover_image_id, inStock: x.in_stock, addedAt: x.created_at })) };
  });
  app.put("/:productId", async (req, reply) => {
    const { productId } = parse(z.object({ productId: uuid() }), req.params);
    const ok = await app.db.query(`select 1 from product_search where product_id = $1 and is_listed`, [productId]);
    if (!ok.rowCount) throw Errors.notFound("Product");
    const n = await app.db.query(`select count(*)::int n from wishlists where user_id = $1`, [req.auth!.userId]);
    if (n.rows[0].n >= 500) throw Errors.conflict("WISHLIST_FULL", "Your wishlist can hold up to 500 items.");
    await app.db.query(`insert into wishlists (user_id, product_id) values ($1, $2) on conflict do nothing`, [req.auth!.userId, productId]);
    return reply.code(204).send();
  });
  app.delete("/:productId", async (req, reply) => {
    const { productId } = parse(z.object({ productId: uuid() }), req.params);
    await app.db.query(`delete from wishlists where user_id = $1 and product_id = $2`, [req.auth!.userId, productId]);
    return reply.code(204).send();
  });
}

// ---------------- admin: coupons and fees ----------------

const money = z.number().int().min(100).max(10_000_000);
const couponFields = {
  description: safeText(1, 200),
  discountType: z.enum(["percent", "fixed"]),
  percentBp: z.number().int().min(1).max(9000),
  amountPaise: money,
  maxDiscountPaise: money.nullable(),
  minOrderPaise: z.number().int().min(0).max(100_000_000),
  categoryIds: z.array(uuid()).max(50),
  sellerIds: z.array(uuid()).max(50),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
  usageLimit: z.number().int().min(1).max(10_000_000).nullable(),
  perUserLimit: z.number().int().min(1).max(1000),
  firstOrderOnly: z.boolean(),
};

export async function adminCouponRoutes(app: FastifyInstance): Promise<void> {
  const perm = requirePermission("admin.coupons.manage");
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", perm);

  const out = (c: any) => ({
    id: c.id, code: String(c.code).toUpperCase(), description: c.description, discountType: c.discount_type, percentBp: c.percent_bp,
    amountPaise: c.amount_paise, maxDiscountPaise: c.max_discount_paise, minOrderPaise: c.min_order_paise, scopeAll: c.scope_all,
    startsAt: c.starts_at, endsAt: c.ends_at, usageLimit: c.usage_limit, perUserLimit: c.per_user_limit, firstOrderOnly: c.first_order_only,
    usedCount: c.used_count, isActive: c.is_active, state: cart.couponState(c), currency: CURRENCY,
  });

  async function setScope(tx: any, id: string, categoryIds: string[] | undefined, sellerIds: string[] | undefined) {
    if (categoryIds) {
      await tx.query(`delete from coupon_categories where coupon_id = $1`, [id]);
      if (categoryIds.length) {
        const ok = await tx.query(`select count(*)::int n from categories where id = any($1)`, [categoryIds]);
        if (ok.rows[0].n !== new Set(categoryIds).size) throw Errors.validation([{ path: "categoryIds", message: "Unknown category." }]);
        await tx.query(`insert into coupon_categories (coupon_id, category_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [id, categoryIds]);
      }
    }
    if (sellerIds) {
      await tx.query(`delete from coupon_sellers where coupon_id = $1`, [id]);
      if (sellerIds.length) {
        const ok = await tx.query(`select count(*)::int n from sellers where id = any($1)`, [sellerIds]);
        if (ok.rows[0].n !== new Set(sellerIds).size) throw Errors.validation([{ path: "sellerIds", message: "Unknown seller." }]);
        await tx.query(`insert into coupon_sellers (coupon_id, seller_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [id, sellerIds]);
      }
    }
    const scoped = await tx.query(
      `select exists (select 1 from coupon_categories where coupon_id = $1) or exists (select 1 from coupon_sellers where coupon_id = $1) as s`, [id]);
    await tx.query(`update coupons set scope_all = not $2 where id = $1`, [id, scoped.rows[0].s]);
  }

  const shape = (b: any) => {
    if (b.discountType === "percent" && b.percentBp === undefined) throw Errors.validation([{ path: "percentBp", message: "Give the percentage." }]);
    if (b.discountType === "fixed" && b.amountPaise === undefined) throw Errors.validation([{ path: "amountPaise", message: "Give the amount." }]);
    if (b.discountType === "fixed" && b.maxDiscountPaise != null) throw Errors.validation([{ path: "maxDiscountPaise", message: "Only for percentage coupons." }]);
  };

  app.post("/", async (req, reply) => {
    const b = parse(z.object({
      code: z.string().trim().regex(/^[A-Za-z0-9]{4,20}$/),
      ...couponFields,
      description: couponFields.description.optional(),
      percentBp: couponFields.percentBp.optional(), amountPaise: couponFields.amountPaise.optional(),
      maxDiscountPaise: couponFields.maxDiscountPaise.optional(), minOrderPaise: couponFields.minOrderPaise.default(0),
      categoryIds: couponFields.categoryIds.default([]), sellerIds: couponFields.sellerIds.default([]),
      startsAt: couponFields.startsAt.optional(), endsAt: couponFields.endsAt.optional(), usageLimit: couponFields.usageLimit.optional(),
      perUserLimit: couponFields.perUserLimit.default(1), firstOrderOnly: couponFields.firstOrderOnly.default(false),
    }).strict(), req.body);
    shape(b);
    const id = await withTx(app.db, async (tx) => {
      let r;
      try {
        r = await tx.query(
          `insert into coupons (code, description, discount_type, percent_bp, amount_paise, max_discount_paise, min_order_paise, starts_at, ends_at,
                                usage_limit, per_user_limit, first_order_only, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()), $9, $10, $11, $12, $13) returning id`,
          [b.code.toUpperCase(), b.description ?? "", b.discountType, b.percentBp ?? null, b.amountPaise ?? null, b.maxDiscountPaise ?? null,
           b.minOrderPaise, b.startsAt ?? null, b.endsAt ?? null, b.usageLimit ?? null, b.perUserLimit, b.firstOrderOnly, req.auth!.userId],
        );
      } catch (e: any) {
        if (e?.code === "23505") throw Errors.conflict("COUPON_EXISTS", "A coupon with this code already exists.");
        if (e?.code === "23514") throw Errors.validation([{ path: "endsAt", message: "Check the dates and limits." }]);
        throw e;
      }
      const cid = r.rows[0].id;
      await setScope(tx, cid, b.categoryIds, b.sellerIds);
      await writeAudit(tx, { ...ctxOf(req), action: "coupon.create", entity: "coupon", entityId: cid, newValue: { ...b, code: b.code.toUpperCase() } });
      return cid;
    });
    return reply.code(201).send(out((await cart.loadCoupon(app.db, { id }))!.row));
  });

  app.get("/", async (req) => {
    const q = parse(z.object({ active: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const r = await app.db.query(
      `select * from coupons where ($1::boolean is null or is_active = $1) order by created_at desc limit $2`,
      [q.active === undefined ? null : q.active === "true", q.limit],
    );
    return { items: r.rows.map(out) };
  });

  app.get("/:id", async (req) => {
    const { id } = parse(z.object({ id: uuid() }), req.params);
    const c = await cart.loadCoupon(app.db, { id });
    if (!c) throw Errors.notFound("Coupon");
    return { ...out(c.row), categoryPaths: c.rule.categoryPaths, sellerIds: c.rule.sellerIds };
  });

  // The code and discount type never change; make a new coupon for that.
  app.patch("/:id", async (req) => {
    const { id } = parse(z.object({ id: uuid() }), req.params);
    const b = parse(z.object({ ...couponFields, isActive: z.boolean() }).omit({ discountType: true }).partial().strict()
      .refine((v) => Object.keys(v).length > 0, "Nothing to update"), req.body);
    await withTx(app.db, async (tx) => {
      const cur = (await tx.query(`select * from coupons where id = $1 for update`, [id])).rows[0];
      if (!cur) throw Errors.notFound("Coupon");
      if (cur.discount_type === "fixed" && b.maxDiscountPaise != null) throw Errors.validation([{ path: "maxDiscountPaise", message: "Only for percentage coupons." }]);
      if (cur.discount_type === "fixed" && b.percentBp !== undefined) throw Errors.validation([{ path: "percentBp", message: "This is a fixed-amount coupon." }]);
      if (cur.discount_type === "percent" && b.amountPaise !== undefined) throw Errors.validation([{ path: "amountPaise", message: "This is a percentage coupon." }]);
      const map: Record<string, string> = {
        description: "description", percentBp: "percent_bp", amountPaise: "amount_paise", maxDiscountPaise: "max_discount_paise",
        minOrderPaise: "min_order_paise", startsAt: "starts_at", endsAt: "ends_at", usageLimit: "usage_limit",
        perUserLimit: "per_user_limit", firstOrderOnly: "first_order_only", isActive: "is_active",
      };
      const cols = Object.entries(b).filter(([k, v]) => map[k] && v !== undefined);
      if (cols.length) {
        try {
          await tx.query(`update coupons set ${cols.map(([k], i) => `${map[k]} = $${i + 2}`).join(", ")} where id = $1`, [id, ...cols.map(([, v]) => v)]);
        } catch (e: any) {
          if (e?.code === "23514") throw Errors.validation([{ path: "usageLimit", message: "Check the dates and limits (the limit cannot be below uses so far)." }]);
          throw e;
        }
      }
      const oldScope = {
        categoryIds: (await tx.query(`select category_id from coupon_categories where coupon_id = $1 order by 1`, [id])).rows.map((x) => x.category_id),
        sellerIds: (await tx.query(`select seller_id from coupon_sellers where coupon_id = $1 order by 1`, [id])).rows.map((x) => x.seller_id),
      };
      await setScope(tx, id, b.categoryIds, b.sellerIds);
      const oldValue: Record<string, unknown> = Object.fromEntries(cols.map(([k]) => [k, cur[map[k]!]]));
      if (b.categoryIds) oldValue.categoryIds = oldScope.categoryIds;
      if (b.sellerIds) oldValue.sellerIds = oldScope.sellerIds;
      await writeAudit(tx, { ...ctxOf(req), action: "coupon.update", entity: "coupon", entityId: id, oldValue, newValue: b });
    });
    return out((await cart.loadCoupon(app.db, { id }))!.row);
  });
}

export async function adminPricingRoutes(app: FastifyInstance): Promise<void> {
  const perm = requirePermission("admin.pricing.manage");
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", perm);

  app.get("/", async () => ({ settings: await cart.settings(app.db), deliveryOptions: (await app.db.query(`select code, label, fee_paise, is_active, sort_order from delivery_options order by sort_order`)).rows, currency: CURRENCY }));

  app.patch("/settings", async (req) => {
    const b = parse(z.object({
      buyerFeeFixedPaise: z.number().int().min(0).max(100_000), buyerFeeBp: z.number().int().min(0).max(2000),
      maxCartLines: z.number().int().min(1).max(200), maxLineQuantity: z.number().int().min(1).max(1000),
    }).partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to update"), req.body);
    await withTx(app.db, async (tx) => {
      const old = await cart.settings(tx);
      await tx.query(
        `update pricing_settings set buyer_fee_fixed_paise = coalesce($1, buyer_fee_fixed_paise), buyer_fee_bp = coalesce($2, buyer_fee_bp),
                max_cart_lines = coalesce($3, max_cart_lines), max_line_quantity = coalesce($4, max_line_quantity), updated_by = $5, updated_at = now()`,
        [b.buyerFeeFixedPaise ?? null, b.buyerFeeBp ?? null, b.maxCartLines ?? null, b.maxLineQuantity ?? null, req.auth!.userId],
      );
      await writeAudit(tx, { ...ctxOf(req), action: "pricing.settings_update", entity: "pricing_settings", entityId: "1", oldValue: old, newValue: b });
    });
    return { settings: await cart.settings(app.db) };
  });

  app.put("/delivery-options/:code", async (req) => {
    const { code } = parse(z.object({ code: z.string().regex(/^[a-z_]{2,20}$/) }), req.params);
    const b = parse(z.object({ label: safeText(2, 60), feePaise: z.number().int().min(0).max(1_000_000), isActive: z.boolean(), sortOrder: z.number().int().min(0).max(100) }).strict(), req.body);
    await withTx(app.db, async (tx) => {
      // Lock every option, so two admins cannot each switch off "the other" last one at the same time.
      await tx.query(`select code from delivery_options order by code for update`);
      const old = (await tx.query(`select * from delivery_options where code = $1`, [code])).rows[0] ?? null;
      if (!b.isActive) {
        const others = await tx.query(`select 1 from delivery_options where is_active and code <> $1`, [code]);
        if (!others.rowCount) throw Errors.invalidTransition("At least one delivery option must stay active.");
      }
      await tx.query(
        `insert into delivery_options (code, label, fee_paise, is_active, sort_order) values ($1, $2, $3, $4, $5)
         on conflict (code) do update set label = excluded.label, fee_paise = excluded.fee_paise, is_active = excluded.is_active, sort_order = excluded.sort_order`,
        [code, b.label, b.feePaise, b.isActive, b.sortOrder],
      );
      await writeAudit(tx, { ...ctxOf(req), action: "pricing.delivery_option_set", entity: "delivery_option", entityId: code, oldValue: old, newValue: b });
    });
    return { ok: true };
  });
}
