import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";
import { withTx } from "../src/lib/db.js";
import * as orders from "../src/modules/orders/service.js";
import { expireDue } from "../src/modules/inventory/service.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let admin: U, alice: U, bob: U, carl: U, dave: U;
let aliceSeller: string, bobSeller: string, tops: string;
const V: Record<string, string> = {};
let ip = 0;
const nextIp = () => `10.90.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;
let keyN = 0;
const newKey = () => `key-${Date.now()}-${++keyN}`;

const reg = async (email: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: "correct horse battery", fullName: email } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, remoteAddress: nextIp(), headers: { ...(u ? { authorization: `Bearer ${u.at}` } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as any } : {}) });
const add = (u: U, key: string, quantity: number) => call(u, "PUT", `/cart/items/${V[key]}`, { quantity });
const total = async (u: U) => (await call(u, "GET", "/cart")).json().totals.totalPaise as number;
const checkout = async (u: U, addressId: string, key = newKey(), expected?: number) =>
  call(u, "POST", "/checkout", { addressId, expectedTotalPaise: expected ?? (await total(u)) }, { "idempotency-key": key });
const level = async (k: string) => (await t.pool.query(`select on_hand, reserved, sold from inventory_levels where variant_id = $1`, [V[k]])).rows[0];
const confirm = (orderId: string) => withTx(t.pool, (tx) => orders.confirmPayment(tx, orderId));
const mkAddress = async (u: U) => (await call(u, "POST", "/me/addresses", { name: "Carl K", phone: "9876543210", line1: "4 MG Road", city: "Pune", state: "MH", pincode: "411001" })).json().id as string;

beforeAll(async () => {
  t = await setup();
  admin = await reg("admin@example.com"); alice = await reg("alice@example.com"); bob = await reg("bob@example.com");
  carl = await reg("carl@example.com"); dave = await reg("dave@example.com");
  await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [admin.id]);
  const mkSeller = async (u: U, name: string) => {
    const id = (await t.pool.query(
      `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
       values ($1, 'approved', $2::text, $2::text, 'individual', 'v1:x', '1234', 'Street', 'Nanded', 'MH', '431601', '9876543210') returning id`, [u.id, name])).rows[0].id;
    await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'seller')`, [u.id]);
    return id as string;
  };
  aliceSeller = await mkSeller(alice, "Alice Attic");
  bobSeller = await mkSeller(bob, "Bob Boutique");
  const wh = new Map<string, string>();
  for (const s of [aliceSeller, bobSeller]) wh.set(s, (await t.pool.query(`insert into warehouses (seller_id, name, pincode, is_default) values ($1, 'Main', '431601', true) returning id`, [s])).rows[0].id);
  tops = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('tops','Tops','tops',0) returning id`)).rows[0].id;
  const mk = async (key: string, seller: string, price: number, stock: number) => {
    const p = (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, 'active', $2, $3, 'good', 500) returning id`, [seller, `Item ${key}`, tops])).rows[0].id;
    V[key] = (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) values ($1, $2, $3, $4, $4) returning id`, [p, seller, `SKU-${key}`, price * 100])).rows[0].id;
    await t.pool.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1, $2, $3)`, [V[key], wh.get(seller), stock]);
  };
  await mk("dress", aliceSeller, 1000, 10);
  await mk("scarf", aliceSeller, 300, 10);
  await mk("boots", bobSeller, 2000, 10);
  await mk("last", bobSeller, 500, 1);
});
afterAll(async () => { await t.close(); });

describe("addresses", () => {
  it("first address becomes the default; another customer cannot touch it; deleting keeps a default", async () => {
    const a1 = await mkAddress(carl);
    const a2 = (await call(carl, "POST", "/me/addresses", { name: "Carl Work", phone: "+919876543210", line1: "Office 9", city: "Pune", state: "MH", pincode: "411002", isDefault: true })).json();
    expect(a2.isDefault).toBe(true);
    expect((await call(dave, "PATCH", `/me/addresses/${a1}`, { city: "Mumbai" })).statusCode).toBe(404);
    expect((await call(carl, "POST", "/me/addresses", { name: "X", phone: "1", line1: "abc", city: "Pune", state: "MH", pincode: "011001" })).statusCode).toBe(400);
    expect((await call(carl, "DELETE", `/me/addresses/${a2.id}`)).statusCode).toBe(204);
    const list = (await call(carl, "GET", "/me/addresses")).json().items;
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
  });
});

describe("checkout", () => {
  let addr: string, orderId: string, couponId: string;
  beforeAll(async () => {
    addr = (await call(carl, "GET", "/me/addresses")).json().items[0].id;
    couponId = (await call(admin, "POST", "/admin/coupons", { code: "WELCOME", discountType: "fixed", amountPaise: 10000, perUserLimit: 1 })).json().id;
  });
  it("needs an Idempotency-Key, a ready cart and the total the buyer saw", async () => {
    expect((await call(carl, "POST", "/checkout", { addressId: addr, expectedTotalPaise: 1 })).json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await checkout(carl, addr, newKey(), 0)).json().error.code).toBe("CART_NOT_READY");
    await add(carl, "dress", 2);
    await add(carl, "boots", 1);
    await call(carl, "POST", "/cart/coupon", { code: "WELCOME" });
    const r = await checkout(carl, addr, newKey(), 1);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: "TOTAL_CHANGED", details: { totalPaise: await total(carl) } });
    expect((await checkout(dave, addr)).json().error.code).toBe("NOT_FOUND"); // someone else's address
  });
  it("creates one order with a package per seller, frozen amounts, held stock and a reserved coupon use", async () => {
    const quote = (await call(carl, "GET", "/cart")).json();
    const key = newKey();
    const r = await checkout(carl, addr, key);
    expect(r.statusCode).toBe(201);
    const o = r.json();
    orderId = o.id;
    expect(o.number).toMatch(/^RL\d{7}$/);
    expect(o.status).toBe("pending_payment");
    expect(o.totals).toEqual(quote.totals.buyerProtectionPaise === undefined ? undefined : {
      itemsSubtotalPaise: quote.totals.itemsSubtotalPaise, discountPaise: quote.totals.discountPaise, itemsNetPaise: quote.totals.itemsNetPaise,
      deliveryPaise: quote.totals.deliveryPaise, buyerProtectionPaise: quote.totals.buyerProtectionPaise, totalPaise: quote.totals.totalPaise,
      gstIncludedInItemsPaise: quote.totals.gstIncludedInItemsPaise,
    });
    expect(o.packages.map((p: any) => p.number)).toEqual([`${o.number}-1`, `${o.number}-2`]);
    expect(o.packages.map((p: any) => p.sellerId).sort()).toEqual([aliceSeller, bobSeller].sort());
    expect(await level("dress")).toMatchObject({ on_hand: 10, reserved: 2, sold: 0 });
    expect((await t.pool.query(`select used_count from coupons where id = $1`, [couponId])).rows[0].used_count).toBe(1);
    expect((await t.pool.query(`select status from coupon_redemptions where order_id = $1`, [orderId])).rows[0].status).toBe("reserved");
    expect((await t.pool.query(`select type from outbox_events where aggregate_id = $1`, [orderId])).rows.map((x) => x.type)).toEqual(["order.placed"]);
    // The cart is kept until payment succeeds.
    expect((await call(carl, "GET", "/cart")).json().items).toHaveLength(2);
    // Same key and body: same order. Same key, different body: refused. New key while unpaid: refused.
    const again = await checkout(carl, addr, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(orderId);
    expect((await checkout(carl, addr, key, 5)).json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const second = await checkout(carl, addr);
    expect(second.json().error).toMatchObject({ code: "PENDING_ORDER_EXISTS", details: { orderId } });
  });
  it("an order's amounts and lines can never be edited", async () => {
    await expect(t.pool.query(`update orders set total_paise = 1 where id = $1`, [orderId])).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`update order_items set unit_price_paise = 1 where order_id = $1`, [orderId])).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`delete from order_items where order_id = $1`, [orderId])).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`delete from seller_order_events`)).rejects.toThrow(/append-only/);
    // Later price changes do not touch the order.
    await t.pool.query(`update product_variants set price_paise = 500, mrp_paise = 500 where id = $1`, [V.dress]);
    expect((await call(carl, "GET", `/orders/${orderId}`)).json().packages.flatMap((p: any) => p.items).find((i: any) => i.sku === "SKU-dress").unitPricePaise).toBe(100000);
    await t.pool.query(`update product_variants set price_paise = 100000, mrp_paise = 100000 where id = $1`, [V.dress]);
  });
  it("other people cannot see the order; a seller sees only their package and no address before payment", async () => {
    expect((await call(dave, "GET", `/orders/${orderId}`)).statusCode).toBe(404);
    const boPkg = (await call(bob, "GET", "/seller/orders")).json().items[0];
    const view = (await call(bob, "GET", `/seller/orders/${boPkg.id}`)).json();
    expect(view.packages).toHaveLength(1);
    expect(view.packages[0].sellerId).toBe(bobSeller);
    expect(view.totals).toBeUndefined();
    expect(view.shippingAddress).toBeNull();
    expect((await call(alice, "GET", `/seller/orders/${boPkg.id}`)).statusCode).toBe(404);
  });
  it("payment confirmation turns holds into sales, confirms every package, clears the cart; a repeat is harmless", async () => {
    expect(await confirm(orderId)).toEqual({ alreadyPaid: false });
    expect(await confirm(orderId)).toEqual({ alreadyPaid: true });
    const o = (await call(carl, "GET", `/orders/${orderId}`)).json();
    expect(o).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(o.packages.every((p: any) => p.status === "confirmed")).toBe(true);
    expect(await level("dress")).toMatchObject({ on_hand: 8, reserved: 0, sold: 2 });
    expect((await t.pool.query(`select status from coupon_redemptions where order_id = $1`, [orderId])).rows[0].status).toBe("confirmed");
    expect((await call(carl, "GET", "/cart")).json().items).toHaveLength(0);
    const boPkg = (await call(bob, "GET", "/seller/orders")).json().items[0];
    expect((await call(bob, "GET", `/seller/orders/${boPkg.id}`)).json().shippingAddress.city).toBe("Pune");
  });
  it("the same coupon cannot be used twice by one customer", async () => {
    await add(carl, "scarf", 1);
    const r = await call(carl, "POST", "/cart/coupon", { code: "WELCOME" });
    expect(r.statusCode).toBe(200);
    const c = await checkout(carl, addr);
    expect(c.json().error.code).toBe("COUPON_LIMIT_REACHED");
    await call(carl, "DELETE", "/cart/coupon");
    await call(carl, "DELETE", "/cart");
  });
});

describe("fulfilment", () => {
  let orderId: string, alicePkg: string, bobPkg: string;
  beforeAll(async () => {
    const addr = await mkAddress(dave);
    await add(dave, "scarf", 1);
    await add(dave, "boots", 1);
    await call(dave, "PUT", `/cart/delivery/${aliceSeller}`, { code: "meet" });
    orderId = (await checkout(dave, addr)).json().id;
    await confirm(orderId);
    const o = (await call(dave, "GET", `/orders/${orderId}`)).json();
    alicePkg = o.packages.find((p: any) => p.sellerId === aliceSeller).id;
    bobPkg = o.packages.find((p: any) => p.sellerId === bobSeller).id;
  });
  it("only allows the next valid step, needs tracking to ship, and keeps the order status in step", async () => {
    const orderStatus = async () => (await call(dave, "GET", `/orders/${orderId}`)).json().status;
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "delivered" })).statusCode).toBe(422);
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "shipped", carrier: "Delhivery", trackingNumber: "DL123456" })).statusCode).toBe(422); // must be processing first
    expect((await call(alice, "POST", `/seller/orders/${bobPkg}/status`, { to: "processing" })).statusCode).toBe(404);
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "processing", trackingNumber: "EARLY123" })).statusCode).toBe(400);
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "processing" })).json().status).toBe("processing");
    expect(await orderStatus()).toBe("processing");
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "shipped" })).statusCode).toBe(400);
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "shipped", carrier: "Delhivery", trackingNumber: "DL123456" })).statusCode).toBe(200);
    expect(await orderStatus()).toBe("partially_shipped");
    // Meet-and-collect goes straight to delivered on handover.
    expect((await call(alice, "POST", `/seller/orders/${alicePkg}/status`, { to: "delivered" })).statusCode).toBe(200);
    expect(await orderStatus()).toBe("partially_delivered");
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "delivered" })).statusCode).toBe(422); // must be out for delivery first
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "out_for_delivery", trackingNumber: "NEW99999", carrier: "Other" })).statusCode).toBe(400);
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "out_for_delivery" })).statusCode).toBe(200);
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "delivered" })).statusCode).toBe(200);
    expect(await orderStatus()).toBe("delivered");
    expect((await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "shipped", carrier: "XPost", trackingNumber: "ABCD1" })).statusCode).toBe(422);
    const o = (await call(dave, "GET", `/orders/${orderId}`)).json();
    expect(o.packages.find((p: any) => p.id === bobPkg).history.map((h: any) => h.to)).toEqual(["pending_payment", "confirmed", "processing", "shipped", "out_for_delivery", "delivered"]);
    expect(o.packages.find((p: any) => p.id === bobPkg).trackingNumber).toBe("DL123456");
  });
  it("paid packages cannot be cancelled until refunds exist", async () => {
    const r = await call(bob, "POST", `/seller/orders/${bobPkg}/status`, { to: "cancelled", reason: "No stock" });
    expect(r.statusCode).toBe(422);
    expect((await call(dave, "POST", `/orders/${orderId}/cancel`)).statusCode).toBe(422);
  });
  it("admins can act with a reason, audited, but not on orders they are part of", async () => {
    const addr = await mkAddress(carl);
    await add(carl, "boots", 1);
    const id = (await checkout(carl, addr)).json().id;
    await confirm(id);
    const pkg = (await call(carl, "GET", `/orders/${id}`)).json().packages[0].id;
    expect((await call(carl, "POST", `/admin/seller-orders/${pkg}/status`, { to: "processing", reason: "x" })).statusCode).toBe(403);
    expect((await call(admin, "POST", `/admin/seller-orders/${pkg}/status`, { to: "processing" })).statusCode).toBe(400);
    expect((await call(admin, "POST", `/admin/seller-orders/${pkg}/status`, { to: "processing", reason: "Seller asked by phone" })).json().orderStatus).toBe("processing");
    expect((await t.pool.query(`select 1 from audit_logs where action = 'seller_order.admin_status' and entity_id = $1`, [pkg])).rowCount).toBe(1);
    const num = (await call(carl, "GET", `/orders/${id}`)).json().number;
    expect((await call(admin, "GET", `/admin/orders?number=${num}`)).json().items.map((x: any) => x.id)).toEqual([id]);
    await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [bob.id]);
    expect((await call(bob, "POST", `/admin/seller-orders/${pkg}/status`, { to: "shipped", carrier: "XPost", trackingNumber: "ABCD1", reason: "Own order" })).statusCode).toBe(403);
    await t.pool.query(`delete from user_roles where user_id = $1 and role_key = 'admin'`, [bob.id]);
  });
});

describe("unpaid orders", () => {
  let erin: U, addr: string, coupon: string;
  beforeAll(async () => {
    erin = await reg("erin@example.com");
    addr = await mkAddress(erin);
    coupon = (await call(admin, "POST", "/admin/coupons", { code: "ONCEONLY", discountType: "fixed", amountPaise: 5000, usageLimit: 1 })).json().id;
  });
  it("cancelling before payment gives back the stock and the coupon use", async () => {
    await add(erin, "scarf", 3);
    await call(erin, "POST", "/cart/coupon", { code: "ONCEONLY" });
    const before = await level("scarf");
    const id = (await checkout(erin, addr)).json().id;
    expect((await level("scarf")).reserved).toBe(before.reserved + 3);
    expect((await t.pool.query(`select used_count from coupons where id = $1`, [coupon])).rows[0].used_count).toBe(1);
    const r = await call(erin, "POST", `/orders/${id}/cancel`);
    expect(r.json().status).toBe("cancelled");
    expect((await level("scarf")).reserved).toBe(before.reserved);
    expect((await t.pool.query(`select used_count from coupons where id = $1`, [coupon])).rows[0].used_count).toBe(0);
    expect((await t.pool.query(`select status from coupon_redemptions where order_id = $1`, [id])).rows[0].status).toBe("released");
  });
  it("an order past its payment window is cancelled by the sweep, and a late payment is refused", async () => {
    const id = (await checkout(erin, addr)).json().id;
    // The general stock sweep leaves order holds alone; only the order sweep releases them.
    await t.pool.query(`update stock_reservations set expires_at = now() - interval '1 second' where reference_id = $1`, [id]);
    await expireDue(t.pool);
    expect((await t.pool.query(`select count(*)::int n from stock_reservations where reference_id = $1 and status = 'active'`, [id])).rows[0].n).toBeGreaterThan(0);
    await t.pool.query(`update orders set expires_at = now() - interval '1 second' where id = $1`, [id]);
    expect(await orders.expireUnpaidOrders(t.pool)).toBe(1);
    const o = (await call(erin, "GET", `/orders/${id}`)).json();
    expect(o).toMatchObject({ status: "cancelled", cancelReason: "Payment was not received in time" });
    const late: any = await confirm(id).catch((e) => e);
    expect(late.code).toBe("ORDER_NOT_PAYABLE");
    expect((await t.pool.query(`select count(*)::int n from stock_reservations where reference_id = $1 and status = 'active'`, [id])).rows[0].n).toBe(0);
  });
});

describe("races", () => {
  it("five checkouts from one customer at once create exactly one order", async () => {
    const f = await reg("fay@example.com");
    const addr = await mkAddress(f);
    await add(f, "scarf", 1);
    const tot = await total(f);
    const res = await Promise.all(Array.from({ length: 5 }, () => checkout(f, addr, newKey(), tot)));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(res.filter((r) => r.json().error?.code === "PENDING_ORDER_EXISTS")).toHaveLength(4);
    const sameKey = newKey();
    await call(f, "POST", `/orders/${res.find((r) => r.statusCode === 201)!.json().id}/cancel`);
    const twins = await Promise.all(Array.from({ length: 4 }, () => checkout(f, addr, sameKey, tot)));
    expect(new Set(twins.map((r) => r.json().id)).size).toBe(1);
    expect((await t.pool.query(`select count(*)::int n from orders where user_id = $1`, [f.id])).rows[0].n).toBe(2);
  });
  it("two customers for the last unit: one order, one clear refusal, nothing half-created", async () => {
    const g = await reg("gina@example.com"), h = await reg("hari@example.com");
    const [ag, ah] = [await mkAddress(g), await mkAddress(h)];
    await add(g, "last", 1); await add(h, "last", 1);
    const [tg, th] = [await total(g), await total(h)];
    const [rg, rh] = await Promise.all([checkout(g, ag, newKey(), tg), checkout(h, ah, newKey(), th)]);
    expect([rg.statusCode, rh.statusCode].sort()).toEqual([201, 409]);
    expect([rg, rh].find((r) => r.statusCode === 409)!.json().error.code).toBe("OUT_OF_STOCK");
    expect((await t.pool.query(`select count(*)::int n from orders where user_id = any($1)`, [[g.id, h.id]])).rows[0].n).toBe(1);
  });
  it("two customers racing for a single-use coupon: only one gets it", async () => {
    const [i1, i2] = [await reg("isha@example.com"), await reg("ivan@example.com")];
    await call(admin, "POST", "/admin/coupons", { code: "ONLYONE", discountType: "fixed", amountPaise: 1000, usageLimit: 1 });
    const addrs = [await mkAddress(i1), await mkAddress(i2)];
    for (const u of [i1, i2]) { await add(u, "scarf", 1); await call(u, "POST", "/cart/coupon", { code: "ONLYONE" }); }
    const tots = [await total(i1), await total(i2)];
    const res = await Promise.all([checkout(i1, addrs[0]!, newKey(), tots[0]), checkout(i2, addrs[1]!, newKey(), tots[1])]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.statusCode === 409)!.json().error.code).toBe("COUPON_PROBLEM");
  });
});

describe("order status", () => {
  it("follows from the packages", () => {
    const d = orders.deriveOrderStatus;
    expect(d(["pending_payment", "pending_payment"])).toBe("pending_payment");
    expect(d(["confirmed", "processing"])).toBe("processing");
    expect(d(["shipped", "confirmed"])).toBe("partially_shipped");
    expect(d(["shipped", "out_for_delivery"])).toBe("shipped");
    expect(d(["delivered", "shipped"])).toBe("partially_delivered");
    expect(d(["delivered", "cancelled"])).toBe("delivered");
    expect(d(["cancelled", "cancelled"])).toBe("cancelled");
  });
});

describe("review findings (regressions)", () => {
  beforeAll(async () => {
    await t.pool.query(`update inventory_levels set on_hand = on_hand + 1000 where variant_id = any($1)`, [[V.scarf, V.boots]]);
  });
  const confirmedTwoSeller = async (u: U) => {
    const addr = await mkAddress(u);
    await add(u, "scarf", 1); await add(u, "boots", 1);
    const id = (await checkout(u, addr)).json().id;
    await confirm(id);
    const o = (await call(u, "GET", `/orders/${id}`)).json();
    return { id, a: o.packages.find((p: any) => p.sellerId === aliceSeller).id, b: o.packages.find((p: any) => p.sellerId === bobSeller).id };
  };
  it("two sellers shipping at the same moment leave the order status correct", async () => {
    for (let round = 0; round < 6; round++) {
      const u = await reg(`race${round}@example.com`);
      const { id, a, b } = await confirmedTwoSeller(u);
      await call(alice, "POST", `/seller/orders/${a}/status`, { to: "processing" });
      await call(bob, "POST", `/seller/orders/${b}/status`, { to: "processing" });
      await Promise.all([
        call(alice, "POST", `/seller/orders/${a}/status`, { to: "shipped", carrier: "Delhivery", trackingNumber: `A${round}0000` }),
        call(bob, "POST", `/seller/orders/${b}/status`, { to: "shipped", carrier: "Delhivery", trackingNumber: `B${round}0000` }),
      ]);
      expect((await call(u, "GET", `/orders/${id}`)).json().status).toBe("shipped");
    }
  });
  it("cancelling and checking out with the same coupon and item at once never deadlocks", async () => {
    await call(admin, "POST", "/admin/coupons", { code: "SHARED10", discountType: "fixed", amountPaise: 1000, perUserLimit: 1000 });
    for (let round = 0; round < 8; round++) {
      const [x, y] = [await reg(`cx${round}@example.com`), await reg(`cy${round}@example.com`)];
      const [ax, ay] = [await mkAddress(x), await mkAddress(y)];
      for (const u of [x, y]) { await add(u, "scarf", 1); await call(u, "POST", "/cart/coupon", { code: "SHARED10" }); }
      const xid = (await checkout(x, ax)).json().id;
      const ty = await total(y);
      const [c, k] = await Promise.all([call(x, "POST", `/orders/${xid}/cancel`), checkout(y, ay, newKey(), ty)]);
      expect(c.statusCode).toBe(200);
      expect(k.statusCode).toBe(201);
    }
  });
  it("frozen order fields, payment state and redemption amounts are guarded by the database", async () => {
    const u = await reg("guard@example.com");
    const { id, a } = await confirmedTwoSeller(u);
    await expect(t.pool.query(`update orders set payment_status = 'unpaid', paid_at = null where id = $1`, [id])).rejects.toThrow(/cannot become unpaid|payment time/);
    await expect(t.pool.query(`update orders set coupon_code = 'X', buyer_fee_bp = 0 where id = $1`, [id])).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`update orders set status = 'pending_payment' where id = $1`, [id])).rejects.toThrow(/waiting for payment/);
    await expect(t.pool.query(`update seller_orders set delivery_code = 'meet' where id = $1`, [a])).rejects.toThrow(/cannot be changed/);
    const r = await t.pool.query(`select id from coupon_redemptions limit 1`);
    if (r.rows[0]) await expect(t.pool.query(`update coupon_redemptions set discount_paise = 0 where id = $1`, [r.rows[0].id])).rejects.toThrow(/cannot be changed/);
  });
  it("a seller's view does not reveal the overall order status", async () => {
    const u = await reg("peek@example.com");
    const { b } = await confirmedTwoSeller(u);
    const v = (await call(bob, "GET", `/seller/orders/${b}`)).json();
    expect(v.status).toBeUndefined();
    expect(v.packages).toHaveLength(1);
  });
});
