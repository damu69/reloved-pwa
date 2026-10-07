import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let admin: U, alice: U, bob: U, carl: U;
let aliceSeller: string, bobSeller: string, tops: string, shoes: string;
const V: Record<string, string> = {};
const P: Record<string, string> = {};
let ip = 0;
const nextIp = () => `10.80.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

const reg = async (email: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: "correct horse battery", fullName: email } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown, remoteAddress = nextIp()) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, remoteAddress, headers: u ? { authorization: `Bearer ${u.at}` } : {}, ...(payload !== undefined ? { payload: payload as any } : {}) });
const add = (u: U, key: string, quantity: number) => call(u, "PUT", `/cart/items/${V[key]}`, { quantity });

beforeAll(async () => {
  t = await setup();
  admin = await reg("admin@example.com"); alice = await reg("alice@example.com"); bob = await reg("bob@example.com"); carl = await reg("carl@example.com");
  await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [admin.id]);
  const mkSeller = async (u: U, name: string) => (await t.pool.query(
    `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
     values ($1, 'approved', $2::text, $2::text, 'individual', 'v1:x', '1234', 'Street', 'Nanded', 'MH', '431601', '9876543210') returning id`, [u.id, name])).rows[0].id;
  aliceSeller = await mkSeller(alice, "Alice Attic");
  bobSeller = await mkSeller(bob, "Bob Boutique");
  const wh = new Map<string, string>();
  for (const s of [aliceSeller, bobSeller]) wh.set(s, (await t.pool.query(`insert into warehouses (seller_id, name, pincode, is_default) values ($1, 'Main', '431601', true) returning id`, [s])).rows[0].id);
  const women = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('women','Women','women',0) returning id`)).rows[0].id;
  tops = (await t.pool.query(`insert into categories (parent_id, slug, name, path, depth) values ($1,'tops','Tops','women/tops',1) returning id`, [women])).rows[0].id;
  shoes = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('shoes','Shoes','shoes',0) returning id`)).rows[0].id;
  const mk = async (key: string, seller: string, cat: string, price: number, stock: number, gst = 500) => {
    P[key] = (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, 'active', $2, $3, 'good', $4) returning id`, [seller, `Item ${key}`, cat, gst])).rows[0].id;
    V[key] = (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) values ($1, $2, $3, $4, $4) returning id`, [P[key], seller, `SKU-${key}`, price * 100])).rows[0].id;
    await t.pool.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1, $2, $3)`, [V[key], wh.get(seller), stock]);
  };
  await mk("top", aliceSeller, tops, 1000, 5);
  await mk("top2", aliceSeller, tops, 500, 5);
  await mk("shoe", bobSeller, shoes, 2000, 2, 1800);
  await mk("bag", bobSeller, shoes, 300, 1);
});
afterAll(async () => { await t.close(); });

describe("cart basics", () => {
  it("needs sign-in", async () => {
    expect((await call(null, "GET", "/cart")).statusCode).toBe(401);
  });
  it("prices ₹1,000 + ₹99 home delivery + ₹65 Buyer Protection = ₹1,164", async () => {
    const r = await add(carl, "top", 1);
    expect(r.statusCode).toBe(200);
    expect(r.json().totals).toMatchObject({ itemsNetPaise: 100000, deliveryPaise: 9900, buyerProtectionPaise: 6500, totalPaise: 116400, gstIncludedInItemsPaise: 4762 });
    expect(r.json().currency).toBe("INR");
    expect(r.json().canCheckout).toBe(true);
  });
  it("charges delivery per seller package and Buyer Protection once", async () => {
    const r = await add(carl, "shoe", 1);
    const b = r.json();
    expect(b.packages.map((p: any) => p.delivery.feePaise)).toEqual([9900, 9900]);
    expect(b.totals).toMatchObject({ itemsNetPaise: 300000, deliveryPaise: 19800, buyerProtectionPaise: 1500 + 15000, totalPaise: 300000 + 19800 + 16500 });
  });
  it("adding to the cart never holds stock", async () => {
    const r = await t.pool.query(`select coalesce(sum(reserved),0)::int as reserved, (select count(*)::int from stock_reservations) as holds from inventory_levels`);
    expect(r.rows[0]).toEqual({ reserved: 0, holds: 0 });
  });
  it("lets the buyer pick delivery per seller", async () => {
    const r = await call(carl, "PUT", `/cart/delivery/${bobSeller}`, { code: "pickup" });
    expect(r.json().packages.find((p: any) => p.sellerId === bobSeller).delivery.feePaise).toBe(5900);
    expect((await call(carl, "PUT", `/cart/delivery/${bobSeller}`, { code: "drone" })).statusCode).toBe(400);
    expect((await call(carl, "PUT", `/cart/delivery/00000000-0000-4000-8000-000000000000`, { code: "home" })).statusCode).toBe(404);
  });
  it("refuses more than is in stock, too many of one item, unknown items, and your own items", async () => {
    const r = await add(carl, "shoe", 3);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: "ONLY_N_LEFT", details: { available: 2 } });
    expect((await add(carl, "top", 11)).statusCode).toBe(400);
    expect((await call(carl, "PUT", `/cart/items/00000000-0000-4000-8000-000000000000`, { quantity: 1 })).statusCode).toBe(404);
    const own = await add(alice, "top", 1);
    expect(own.statusCode).toBe(403);
    expect(own.json().error.code).toBe("OWN_PRODUCT");
  });
});

describe("live re-checks", () => {
  it("shows a price change and charges the current price", async () => {
    await t.pool.query(`update product_variants set price_paise = 90000, mrp_paise = 90000 where id = $1`, [V.top]);
    const b = (await call(carl, "GET", "/cart")).json();
    const top = b.items.find((i: any) => i.variantId === V.top);
    expect(top.problems).toEqual([{ code: "PRICE_CHANGED", message: expect.any(String), previousPricePaise: 100000 }]);
    expect(top.netPaise).toBe(90000);
    expect(b.canCheckout).toBe(true);
    await t.pool.query(`update product_variants set price_paise = 100000, mrp_paise = 100000 where id = $1`, [V.top]);
  });
  it("blocks checkout when an item stops being for sale or runs low, and leaves it out of the total", async () => {
    await t.pool.query(`update sellers set status = 'suspended' where id = $1`, [bobSeller]);
    let b = (await call(carl, "GET", "/cart")).json();
    expect(b.items.find((i: any) => i.variantId === V.shoe).problems[0].code).toBe("NOT_AVAILABLE");
    expect(b.canCheckout).toBe(false);
    expect(b.totals.itemsNetPaise).toBe(100000);
    await t.pool.query(`update sellers set status = 'approved' where id = $1`, [bobSeller]);
    await add(carl, "shoe", 2);
    await t.pool.query(`update inventory_levels set on_hand = 1 where variant_id = $1`, [V.shoe]);
    b = (await call(carl, "GET", "/cart")).json();
    expect(b.items.find((i: any) => i.variantId === V.shoe).problems[0]).toMatchObject({ code: "ONLY_N_LEFT", available: 1 });
    expect(b.canCheckout).toBe(false);
    await t.pool.query(`update inventory_levels set on_hand = 2 where variant_id = $1`, [V.shoe]);
    await add(carl, "shoe", 1);
  });
});

describe("coupons", () => {
  let couponId: string;
  it("only admins create coupons", async () => {
    expect((await call(carl, "POST", "/admin/coupons", { code: "FREE100", discountType: "fixed", amountPaise: 10000 })).statusCode).toBe(403);
    const r = await call(admin, "POST", "/admin/coupons", { code: "Tops10", discountType: "percent", percentBp: 1000, maxDiscountPaise: 5000, categoryIds: [tops], usageLimit: 100 });
    expect(r.statusCode).toBe(201);
    couponId = r.json().id;
    expect(r.json()).toMatchObject({ code: "TOPS10", scopeAll: false, state: "OK" });
    expect((await call(admin, "POST", "/admin/coupons", { code: "tops10", discountType: "fixed", amountPaise: 100 })).statusCode).toBe(409);
    expect((await call(admin, "POST", "/admin/coupons", { code: "BADFIX", discountType: "fixed", amountPaise: 1000, maxDiscountPaise: 500 })).statusCode).toBe(400);
  });
  it("applies case-insensitively, to eligible items only, capped", async () => {
    const r = await call(carl, "POST", "/cart/coupon", { code: "tops10" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.coupon).toEqual({ code: "TOPS10", discountPaise: 5000, problem: null });
    expect(b.items.find((i: any) => i.variantId === V.top).discountPaise).toBe(5000);
    expect(b.items.find((i: any) => i.variantId === V.shoe).discountPaise).toBe(0);
    expect(b.totals.totalPaise).toBe(300000 - 5000 + 19800 - 4000 + 1500 + Math.round((300000 - 5000) * 0.05) - 0);
  });
  it("refuses unknown, expired, used-up and not-applicable codes without storing them", async () => {
    expect((await call(carl, "POST", "/cart/coupon", { code: "NOPE1234" })).json().error.code).toBe("COUPON_INVALID");
    await call(admin, "POST", "/admin/coupons", { code: "OLDCODE", discountType: "fixed", amountPaise: 1000, startsAt: "2025-01-01T00:00:00Z", endsAt: "2025-02-01T00:00:00Z" });
    expect((await call(carl, "POST", "/cart/coupon", { code: "OLDCODE" })).json().error.message).toMatch(/expired/);
    const big = await call(admin, "POST", "/admin/coupons", { code: "BIGSPEND", discountType: "fixed", amountPaise: 20000, minOrderPaise: 1000000 });
    const r = await call(carl, "POST", "/cart/coupon", { code: "BIGSPEND" });
    expect(r.json().error).toMatchObject({ code: "COUPON_NOT_APPLICABLE", details: { shortfallPaise: 700000 } });
    // The code that was already applied (TOPS10) stays.
    expect((await call(carl, "GET", "/cart")).json().coupon.code).toBe("TOPS10");
    await t.pool.query(`update coupons set usage_limit = 1, used_count = 1 where id = $1`, [big.json().id]);
    expect((await call(carl, "POST", "/cart/coupon", { code: "BIGSPEND" })).json().error.message).toMatch(/fully used/);
  });
  it("one coupon per order: a new code replaces the old one", async () => {
    await call(admin, "POST", "/admin/coupons", { code: "FLAT50", discountType: "fixed", amountPaise: 5000 });
    expect((await call(carl, "POST", "/cart/coupon", { code: "TOPS10" })).statusCode).toBe(200);
    const b = (await call(carl, "POST", "/cart/coupon", { code: "FLAT50" })).json();
    expect(b.coupon.code).toBe("FLAT50");
    expect(b.totals.discountPaise).toBe(5000);
  });
  it("a coupon switched off after it was applied stops discounting, and says why", async () => {
    await call(carl, "POST", "/cart/coupon", { code: "TOPS10" });
    const p = await call(admin, "PATCH", `/admin/coupons/${couponId}`, { isActive: false });
    expect(p.json().state).toBe("INACTIVE");
    const b = (await call(carl, "GET", "/cart")).json();
    expect(b.coupon).toMatchObject({ discountPaise: 0, problem: { code: "INACTIVE" } });
    expect(b.totals.discountPaise).toBe(0);
    const a = await t.pool.query(`select old_value, new_value from audit_logs where action = 'coupon.update' and entity_id = $1`, [couponId]);
    expect(a.rows[0]).toMatchObject({ old_value: { isActive: true }, new_value: { isActive: false } });
  });
  it("cannot lower a usage limit below uses so far", async () => {
    await t.pool.query(`update coupons set used_count = 5 where id = $1`, [couponId]);
    expect((await call(admin, "PATCH", `/admin/coupons/${couponId}`, { usageLimit: 3 })).statusCode).toBe(400);
  });
  it("slows down code guessing", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await call(bob, "POST", "/cart/coupon", { code: `GUESS${i}X` }, "10.99.0.1")).statusCode);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("admin pricing settings", () => {
  it("changes Buyer Protection and delivery fees, audited, admins only", async () => {
    expect((await call(carl, "PATCH", "/admin/pricing/settings", { buyerFeeBp: 0 })).statusCode).toBe(403);
    expect((await call(admin, "PATCH", "/admin/pricing/settings", { buyerFeeFixedPaise: 2000, buyerFeeBp: 400 })).statusCode).toBe(200);
    expect((await call(admin, "PUT", "/admin/pricing/delivery-options/home", { label: "Home delivery", feePaise: 7900, isActive: true, sortOrder: 1 })).statusCode).toBe(200);
    await call(carl, "DELETE", "/cart/coupon");
    const b = (await call(carl, "GET", "/cart")).json();
    expect(b.totals.buyerProtectionPaise).toBe(2000 + 12000);
    expect(b.packages.find((p: any) => p.sellerId === aliceSeller).delivery.feePaise).toBe(7900);
    const a = await t.pool.query(`select old_value->>'buyerFeeFixedPaise' as old from audit_logs where action = 'pricing.settings_update'`);
    expect(a.rows[0].old).toBe("1500");
  });
  it("keeps at least one delivery option active", async () => {
    await call(admin, "PUT", "/admin/pricing/delivery-options/pickup", { label: "Pickup point", feePaise: 5900, isActive: false, sortOrder: 2 });
    await call(admin, "PUT", "/admin/pricing/delivery-options/meet", { label: "Meet and collect", feePaise: 0, isActive: false, sortOrder: 3 });
    expect((await call(admin, "PUT", "/admin/pricing/delivery-options/home", { label: "Home delivery", feePaise: 7900, isActive: false, sortOrder: 1 })).statusCode).toBe(422);
  });
  it("an inactive delivery choice falls back to an available one", async () => {
    await call(carl, "PUT", `/cart/delivery/${aliceSeller}`, { code: "home" });
    const b = (await call(carl, "GET", "/cart")).json();
    expect(b.packages.find((p: any) => p.sellerId === bobSeller).delivery.code).toBe("home");
  });
});

describe("limits, wishlist and clearing", () => {
  it("parallel adds cannot exceed the cart size limit", async () => {
    await call(admin, "PATCH", "/admin/pricing/settings", { maxCartLines: 2 });
    await call(carl, "DELETE", "/cart");
    const res = await Promise.all(["top", "top2", "shoe", "bag"].map((k) => add(carl, k, 1)));
    expect((await call(carl, "GET", "/cart")).json().items).toHaveLength(2);
    expect(res.filter((r) => r.statusCode === 409 && r.json().error.code === "CART_FULL")).toHaveLength(2);
    await call(admin, "PATCH", "/admin/pricing/settings", { maxCartLines: 50 });
  });
  it("lowering the limits also blocks carts filled earlier", async () => {
    await add(carl, "top", 3);
    await call(admin, "PATCH", "/admin/pricing/settings", { maxLineQuantity: 2, maxCartLines: 1 });
    const b = (await call(carl, "GET", "/cart")).json();
    const codes = b.items.flatMap((i: any) => i.problems.map((p: any) => p.code));
    expect(codes).toContain("QUANTITY_LIMIT");
    expect(codes).toContain("CART_TOO_LARGE");
    expect(b.canCheckout).toBe(false);
    await call(admin, "PATCH", "/admin/pricing/settings", { maxLineQuantity: 10, maxCartLines: 50 });
  });
  it("keeps a wishlist of live products only", async () => {
    expect((await call(carl, "PUT", `/me/wishlist/${P.top}`)).statusCode).toBe(204);
    expect((await call(carl, "PUT", `/me/wishlist/${P.top}`)).statusCode).toBe(204);
    expect((await call(carl, "PUT", `/me/wishlist/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
    expect((await call(carl, "GET", "/me/wishlist")).json().items.map((x: any) => x.productId)).toEqual([P.top]);
    await t.pool.query(`update products set status = 'archived' where id = $1`, [P.top]);
    expect((await call(carl, "GET", "/me/wishlist")).json().items).toEqual([]);
    await t.pool.query(`update products set status = 'active' where id = $1`, [P.top]);
    expect((await call(carl, "DELETE", `/me/wishlist/${P.top}`)).statusCode).toBe(204);
  });
  it("clears the cart", async () => {
    expect((await call(carl, "DELETE", "/cart")).statusCode).toBe(204);
    const b = (await call(carl, "GET", "/cart")).json();
    expect(b.items).toEqual([]);
    expect(b.totals.totalPaise).toBe(0);
    expect(b.canCheckout).toBe(false);
  });
});

describe("review findings (regressions)", () => {
  it("two admins switching off different delivery options at once still leave one active", async () => {
    for (const [code, label, fee, sort] of [["home", "Home delivery", 9900, 1], ["pickup", "Pickup point", 5900, 2], ["meet", "Meet and collect", 0, 3]] as const) {
      await call(admin, "PUT", `/admin/pricing/delivery-options/${code}`, { label, feePaise: fee, isActive: true, sortOrder: sort });
    }
    const res = await Promise.all([["home", 1], ["pickup", 2], ["meet", 3]].map(([code, sort]) =>
      call(admin, "PUT", `/admin/pricing/delivery-options/${code}`, { label: String(code), feePaise: 100, isActive: false, sortOrder: sort })));
    expect(res.filter((r) => r.statusCode === 422)).toHaveLength(1);
    const active = await t.pool.query(`select count(*)::int n from delivery_options where is_active`);
    expect(active.rows[0].n).toBe(1);
    for (const [code, label, fee, sort] of [["home", "Home delivery", 9900, 1], ["pickup", "Pickup point", 5900, 2], ["meet", "Meet and collect", 0, 3]] as const) {
      await call(admin, "PUT", `/admin/pricing/delivery-options/${code}`, { label, feePaise: fee, isActive: true, sortOrder: sort });
    }
  });
  it("viewing the cart while an item is removed never fails", async () => {
    for (let i = 0; i < 25; i++) {
      await add(carl, "top2", 1);
      const [v] = await Promise.all([call(carl, "GET", "/cart"), call(carl, "DELETE", `/cart/items/${V.top2}`)]);
      expect(v.statusCode).toBe(200);
    }
  });
  it("coupon guessing is limited per account across IPs, and unreleased codes look unknown", async () => {
    const dan = await reg("dan@example.com");
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await call(dan, "POST", "/cart/coupon", { code: `TRY${i}XYZ` })).statusCode);
    expect(codes.at(-1)).toBe(429);
    await call(admin, "POST", "/admin/coupons", { code: "DIWALI26", discountType: "fixed", amountPaise: 1000, startsAt: "2030-10-01T00:00:00Z" });
    const r = await call(carl, "POST", "/cart/coupon", { code: "DIWALI26" });
    expect(r.json().error.message).toBe("This code is not valid.");
  });
  it("a failed code keeps the coupon already applied", async () => {
    const fay = await reg("fay@example.com");
    await add(fay, "top", 1);
    expect((await call(fay, "POST", "/cart/coupon", { code: "FLAT50" })).statusCode).toBe(200);
    await call(admin, "PATCH", `/admin/coupons/${(await t.pool.query(`select id from coupons where code = 'BIGSPEND'`)).rows[0].id}`, { usageLimit: 100 });
    expect((await call(fay, "POST", "/cart/coupon", { code: "BIGSPEND" })).statusCode).toBe(422);
    expect((await call(fay, "GET", "/cart")).json().coupon.code).toBe("FLAT50");
  });
  it("records the previous scope when a coupon's scope changes, and allows removing a cap", async () => {
    const c = (await call(admin, "POST", "/admin/coupons", { code: "SCOPED1", discountType: "percent", percentBp: 500, maxDiscountPaise: 1000, categoryIds: [tops] })).json();
    expect((await call(admin, "PATCH", `/admin/coupons/${c.id}`, { categoryIds: [shoes], maxDiscountPaise: null })).statusCode).toBe(200);
    const a = await t.pool.query(`select old_value from audit_logs where action = 'coupon.update' and entity_id = $1`, [c.id]);
    expect(a.rows[0].old_value).toMatchObject({ categoryIds: [tops], maxDiscountPaise: 1000 });
  });
  it("a coupon scoped to a category and a seller applies only to that seller's items in that category", async () => {
    const erin = await reg("erin@example.com");
    await add(erin, "top", 1); // alice, tops
    await add(erin, "shoe", 1); // bob, shoes
    await call(admin, "POST", "/admin/coupons", { code: "BOBTOPS", discountType: "fixed", amountPaise: 5000, categoryIds: [tops], sellerIds: [bobSeller] });
    const r = await call(erin, "POST", "/cart/coupon", { code: "BOBTOPS" });
    expect(r.json().error.code).toBe("COUPON_NOT_APPLICABLE");
  });
});
