import type { Db, Queryable, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { CURRENCY } from "../../lib/money.js";
import { availability } from "../inventory/service.js";
import { priceOrder, type CouponRule, type DeliveryOption, type PriceLine, type PricingSettings } from "./pricing.js";

// The cart holds quantities only. Every view re-reads live prices, availability and the coupon,
// and prices with the same function checkout will use. Adding to the cart never holds stock.

export async function settings(db: Queryable): Promise<PricingSettings & { maxCartLines: number; maxLineQuantity: number }> {
  const r = (await db.query(`select * from pricing_settings`)).rows[0];
  return { buyerFeeFixedPaise: r.buyer_fee_fixed_paise, buyerFeeBp: r.buyer_fee_bp, maxCartLines: r.max_cart_lines, maxLineQuantity: r.max_line_quantity };
}

export async function deliveryOptions(db: Queryable): Promise<DeliveryOption[]> {
  const r = await db.query(`select code, label, fee_paise from delivery_options where is_active order by sort_order, code`);
  return r.rows.map((o) => ({ code: o.code, label: o.label, feePaise: o.fee_paise }));
}

async function cartId(db: Queryable, userId: string): Promise<string> {
  const r = await db.query(
    `insert into carts (user_id) values ($1) on conflict (user_id) do update set user_id = excluded.user_id returning id`, [userId]);
  return r.rows[0].id;
}

// Everything needed to judge whether a variant can be bought right now.
const VARIANT_FACTS = `
  select pv.id as variant_id, pv.sku, pv.options, pv.price_paise, pv.is_active as variant_active, pv.deleted_at as variant_deleted,
         p.id as product_id, p.title, p.status as product_status, p.deleted_at as product_deleted, p.gst_rate_bp,
         s.id as seller_id, s.user_id as seller_user_id, s.status as seller_status, s.display_name as seller_name,
         c.path as category_path, c.is_active as category_active,
         (select i.id from product_images i where i.product_id = p.id and i.status in ('active', 'pending_remove') order by i.sort_order, i.created_at limit 1) as cover_image_id
    from product_variants pv
    join products p on p.id = pv.product_id
    join sellers s on s.id = p.seller_id
    join categories c on c.id = p.category_id`;

const purchasable = (f: any) =>
  f.variant_active && !f.variant_deleted && f.product_status === "active" && !f.product_deleted && f.seller_status === "approved" && f.category_active;

// ---------- coupons ----------

export type CouponState = "OK" | "INACTIVE" | "NOT_STARTED" | "EXPIRED" | "USED_UP";

export function couponState(c: any, now = new Date()): CouponState {
  if (!c.is_active) return "INACTIVE";
  if (new Date(c.starts_at) > now) return "NOT_STARTED";
  if (c.ends_at && new Date(c.ends_at) <= now) return "EXPIRED";
  if (c.usage_limit !== null && c.used_count >= c.usage_limit) return "USED_UP";
  return "OK";
}

export async function loadCoupon(db: Queryable, where: { id?: string; code?: string }): Promise<{ row: any; rule: CouponRule } | null> {
  const r = await db.query(
    `select c.*,
            coalesce((select array_agg(cat.path) from coupon_categories cc join categories cat on cat.id = cc.category_id where cc.coupon_id = c.id), '{}') as category_paths,
            coalesce((select array_agg(cs.seller_id) from coupon_sellers cs where cs.coupon_id = c.id), '{}') as seller_ids
       from coupons c where ($1::uuid is not null and c.id = $1) or ($2::text is not null and c.code = $2::citext)`,
    [where.id ?? null, where.code ?? null],
  );
  const c = r.rows[0];
  if (!c) return null;
  return {
    row: c,
    rule: {
      id: c.id, code: String(c.code).toUpperCase(), discountType: c.discount_type, percentBp: c.percent_bp, amountPaise: c.amount_paise,
      maxDiscountPaise: c.max_discount_paise, minOrderPaise: c.min_order_paise, scopeAll: c.scope_all,
      categoryPaths: c.category_paths, sellerIds: c.seller_ids,
    },
  };
}

// A code that exists but has not started yet gets the same answer as an unknown code, so
// unreleased campaign codes cannot be discovered by guessing.
const COUPON_MESSAGES: Record<string, string> = {
  INACTIVE: "This code is not valid.", NOT_STARTED: "This code is not valid.", EXPIRED: "This code has expired.",
  USED_UP: "This code has been fully used.", NOT_ELIGIBLE: "This code does not apply to the items in your cart.",
  MIN_ORDER: "Add more eligible items to use this code.",
};

// ---------- the quote ----------

export async function view(db: Db, userId: string) {
  const id = await cartId(db, userId);
  const cart = (await db.query(`select * from carts where id = $1`, [id])).rows[0];
  // Quantities come from the same query as the item facts, so a concurrent removal cannot leave a gap.
  const items = (await db.query(
    `${VARIANT_FACTS.replace("select pv.id as variant_id,", "select ci.quantity as cart_quantity, ci.price_at_add_paise as cart_price_at_add, pv.id as variant_id,")}
       join cart_items ci on ci.variant_id = pv.id where ci.cart_id = $1 order by ci.added_at, pv.id`, [id],
  )).rows;
  const avail = await availability(db, items.map((i) => i.variant_id));
  const st = await settings(db);

  const lines = items.map((f, index) => {
    const q = { quantity: f.cart_quantity as number, priceAtAdd: Number(f.cart_price_at_add) };
    const available = avail.get(f.variant_id) ?? 0;
    const problems: { code: string; message: string; available?: number; previousPricePaise?: number }[] = [];
    if (!purchasable(f)) problems.push({ code: "NOT_AVAILABLE", message: "This item is no longer for sale." });
    else if (f.seller_user_id === userId) problems.push({ code: "OWN_PRODUCT", message: "You cannot buy your own item." });
    else if (available === 0) problems.push({ code: "OUT_OF_STOCK", message: "Sold out." });
    else if (q.quantity > available) problems.push({ code: "ONLY_N_LEFT", message: `Only ${available} left.`, available });
    // Limits are re-checked on every view, so lowering them also applies to carts filled earlier.
    if (q.quantity > st.maxLineQuantity) problems.push({ code: "QUANTITY_LIMIT", message: `At most ${st.maxLineQuantity} of one item.` });
    if (index >= st.maxCartLines) problems.push({ code: "CART_TOO_LARGE", message: `A cart can hold up to ${st.maxCartLines} different items. Remove some.` });
    const blocking = problems.length > 0;
    if (Number(f.price_paise) !== q.priceAtAdd) {
      problems.push({ code: "PRICE_CHANGED", message: "The price changed since you added this item.", previousPricePaise: q.priceAtAdd });
    }
    return { f, q, blocking, problems };
  });

  const ok = lines.filter((l) => !l.blocking);
  const priceLines: PriceLine[] = ok.map((l) => ({
    variantId: l.f.variant_id, sellerId: l.f.seller_id, categoryPath: l.f.category_path,
    unitPricePaise: Number(l.f.price_paise), quantity: l.q.quantity, gstRateBp: l.f.gst_rate_bp,
  }));

  // Coupon: re-checked on every view.
  let couponRule: CouponRule | null = null;
  let couponIssue: { code: string; message: string; shortfallPaise?: number } | null = null;
  if (cart.coupon_id) {
    const c = await loadCoupon(db, { id: cart.coupon_id });
    const st = c ? couponState(c.row) : "INACTIVE";
    if (st === "OK") couponRule = c!.rule;
    else couponIssue = { code: st, message: COUPON_MESSAGES[st]! };
  }

  const options = await deliveryOptions(db);
  const chosen = new Map((await db.query(`select seller_id, delivery_code from cart_delivery where cart_id = $1`, [id])).rows
    .map((r) => [r.seller_id, r.delivery_code]));
  const deliveryBySeller = new Map<string, DeliveryOption>();
  for (const l of ok) {
    const pick = options.find((o) => o.code === chosen.get(l.f.seller_id)) ?? options[0];
    if (!pick) throw new AppError(503, "NO_DELIVERY_OPTIONS", "Delivery is not available right now.");
    deliveryBySeller.set(l.f.seller_id, pick);
  }
  const q = priceOrder(priceLines, couponRule, deliveryBySeller, st);
  if (q.couponProblem) {
    couponIssue = { code: q.couponProblem.reason, message: COUPON_MESSAGES[q.couponProblem.reason]!, ...(q.couponProblem.shortfallPaise ? { shortfallPaise: q.couponProblem.shortfallPaise } : {}) };
  }

  const pricedByVariant = new Map(q.packages.flatMap((p) => p.lines).map((l) => [l.variantId, l]));
  const sellerName = new Map(lines.map((l) => [l.f.seller_id, l.f.seller_name]));
  return {
    currency: CURRENCY,
    items: lines.map(({ f, q: cq, problems }) => {
      const p = pricedByVariant.get(f.variant_id);
      return {
        variantId: f.variant_id, productId: f.product_id, title: f.title, sku: f.sku, options: f.options, coverImageId: f.cover_image_id,
        sellerId: f.seller_id, sellerName: f.seller_name, quantity: cq.quantity, unitPricePaise: Number(f.price_paise),
        subtotalPaise: p?.subtotalPaise ?? null, discountPaise: p?.discountPaise ?? null, netPaise: p?.netPaise ?? null,
        gstIncludedPaise: p?.gstIncludedPaise ?? null, problems,
      };
    }),
    packages: q.packages.map((p) => ({
      sellerId: p.sellerId, sellerName: sellerName.get(p.sellerId), itemsNetPaise: p.itemsNetPaise,
      delivery: { code: p.delivery.code, label: p.delivery.label, feePaise: p.delivery.feePaise },
      deliveryChoices: options.map((o) => ({ code: o.code, label: o.label, feePaise: o.feePaise })),
    })),
    coupon: cart.coupon_id ? { code: couponRule?.code ?? null, discountPaise: q.coupon?.discountPaise ?? 0, problem: couponIssue } : null,
    totals: {
      itemsSubtotalPaise: q.itemsSubtotalPaise, discountPaise: q.discountPaise, itemsNetPaise: q.itemsNetPaise,
      deliveryPaise: q.deliveryPaise, buyerProtectionPaise: q.buyerFeePaise, totalPaise: q.totalPaise,
      gstIncludedInItemsPaise: q.gstIncludedInItemsPaise,
    },
    canCheckout: lines.length > 0 && lines.every((l) => !l.blocking),
  };
}

// ---------- changes ----------

async function lockCart(tx: Tx, userId: string) {
  const id = await cartId(tx, userId);
  await tx.query(`select id from carts where id = $1 for update`, [id]);
  return id;
}

export async function setItem(db: Db, userId: string, variantId: string, quantity: number): Promise<void> {
  await withTx(db, async (tx) => {
    const id = await lockCart(tx, userId);
    if (quantity === 0) {
      await tx.query(`delete from cart_items where cart_id = $1 and variant_id = $2`, [id, variantId]);
      await tx.query(`delete from cart_delivery d where d.cart_id = $1 and not exists (
        select 1 from cart_items ci join product_variants pv on pv.id = ci.variant_id where ci.cart_id = $1 and pv.seller_id = d.seller_id)`, [id]);
      return;
    }
    const st = await settings(tx);
    if (quantity > st.maxLineQuantity) throw Errors.validation([{ path: "quantity", message: `At most ${st.maxLineQuantity} of one item.` }]);
    const f = (await tx.query(`${VARIANT_FACTS} where pv.id = $1`, [variantId])).rows[0];
    if (!f || !purchasable(f)) throw Errors.notFound("Item");
    if (f.seller_user_id === userId) throw new AppError(403, "OWN_PRODUCT", "You cannot buy your own item.");
    const available = (await availability(tx, [variantId])).get(variantId) ?? 0;
    if (available < quantity) {
      throw new AppError(409, available ? "ONLY_N_LEFT" : "OUT_OF_STOCK", available ? `Only ${available} left.` : "Sold out.", { available });
    }
    const exists = await tx.query(`select 1 from cart_items where cart_id = $1 and variant_id = $2`, [id, variantId]);
    if (!exists.rowCount) {
      const n = await tx.query(`select count(*)::int as n from cart_items where cart_id = $1`, [id]);
      if (n.rows[0].n >= st.maxCartLines) throw Errors.conflict("CART_FULL", `A cart can hold up to ${st.maxCartLines} different items.`);
    }
    // Changing the quantity counts as seeing the current price, so its "price changed" note resets.
    await tx.query(
      `insert into cart_items (cart_id, variant_id, quantity, price_at_add_paise) values ($1, $2, $3, $4)
       on conflict (cart_id, variant_id) do update set quantity = excluded.quantity, price_at_add_paise = excluded.price_at_add_paise`,
      [id, variantId, quantity, f.price_paise],
    );
    await tx.query(`update carts set updated_at = now() where id = $1`, [id]);
  });
}

export async function setDelivery(db: Db, userId: string, sellerId: string, code: string): Promise<void> {
  await withTx(db, async (tx) => {
    const id = await lockCart(tx, userId);
    const inCart = await tx.query(
      `select 1 from cart_items ci join product_variants pv on pv.id = ci.variant_id where ci.cart_id = $1 and pv.seller_id = $2 limit 1`, [id, sellerId]);
    if (!inCart.rowCount) throw Errors.notFound("Seller in your cart");
    const opt = await tx.query(`select 1 from delivery_options where code = $1 and is_active`, [code]);
    if (!opt.rowCount) throw Errors.validation([{ path: "code", message: "Choose an available delivery option." }]);
    await tx.query(
      `insert into cart_delivery (cart_id, seller_id, delivery_code) values ($1, $2, $3)
       on conflict (cart_id, seller_id) do update set delivery_code = excluded.delivery_code`,
      [id, sellerId, code],
    );
  });
}

export async function applyCoupon(db: Db, userId: string, code: string): Promise<void> {
  const c = await loadCoupon(db, { code });
  const state = c ? couponState(c.row) : "INACTIVE";
  if (state !== "OK") throw new AppError(422, "COUPON_INVALID", COUPON_MESSAGES[state]!);
  const previous = await withTx(db, async (tx) => {
    const id = await lockCart(tx, userId);
    const prev = (await tx.query(`select coupon_id from carts where id = $1`, [id])).rows[0].coupon_id as string | null;
    await tx.query(`update carts set coupon_id = $2 where id = $1`, [id, c!.row.id]);
    return prev;
  });
  // Refuse a code that does not fit this cart, and put back the code the buyer had before.
  const v = await view(db, userId);
  if (v.coupon?.problem) {
    await db.query(`update carts set coupon_id = $2 where user_id = $1 and coupon_id = $3`, [userId, previous, c!.row.id]);
    throw new AppError(422, "COUPON_NOT_APPLICABLE", v.coupon.problem.message,
      v.coupon.problem.shortfallPaise ? { shortfallPaise: v.coupon.problem.shortfallPaise } : undefined);
  }
}

export async function removeCoupon(db: Db, userId: string): Promise<void> {
  await db.query(`update carts set coupon_id = null where user_id = $1`, [userId]);
}

export async function clear(db: Db, userId: string): Promise<void> {
  await withTx(db, async (tx) => {
    const id = await lockCart(tx, userId);
    await tx.query(`delete from cart_items where cart_id = $1`, [id]);
    await tx.query(`delete from cart_delivery where cart_id = $1`, [id]);
    await tx.query(`update carts set coupon_id = null where id = $1`, [id]);
  });
}
