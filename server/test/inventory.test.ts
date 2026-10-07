import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";
import { withTx } from "../src/lib/db.js";
import * as inv from "../src/modules/inventory/service.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let admin: U, alice: U, bob: U, carl: U;
let aliceSeller: string, bobSeller: string, productId: string, v1: string, v2: string, bobVariant: string;
let ip = 0;
const nextIp = () => `10.70.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

const reg = async (email: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: "correct horse battery", fullName: email } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, remoteAddress: nextIp(), headers: u ? { authorization: `Bearer ${u.at}` } : {}, ...(payload !== undefined ? { payload: payload as any } : {}) });
const level = async (variantId: string) =>
  (await t.pool.query(`select coalesce(sum(on_hand),0)::int on_hand, coalesce(sum(reserved),0)::int reserved, coalesce(sum(sold),0)::int sold,
     coalesce(sum(returned),0)::int returned, coalesce(sum(damaged),0)::int damaged from inventory_levels where variant_id = $1`, [variantId])).rows[0];
const reserveOne = (variantId: string, quantity: number, ref: string, owner = carl.id) =>
  withTx(t.pool, (tx) => inv.reserve(tx, [{ variantId, quantity }], { ownerUserId: owner, referenceType: "checkout", referenceId: ref, ttlMinutes: 15 }));
const defaultWh = async (sellerId: string) => (await t.pool.query(`select id from warehouses where seller_id = $1 and is_default`, [sellerId])).rows[0]?.id as string;

beforeAll(async () => {
  t = await setup();
  admin = await reg("admin@example.com");
  alice = await reg("alice@example.com");
  bob = await reg("bob@example.com");
  carl = await reg("carl@example.com");
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
  const cat = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('shoes', 'Shoes', 'shoes', 0) returning id`)).rows[0].id;
  const mkProduct = async (seller: string, title: string) =>
    (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, 'active', $2, $3, 'new', 1800) returning id`, [seller, title, cat])).rows[0].id;
  const mkVariant = async (pid: string, seller: string, sku: string, size: string) =>
    (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, options, price_paise, mrp_paise) values ($1, $2, $3, $4, 250000, 300000) returning id`, [pid, seller, sku, JSON.stringify({ size })])).rows[0].id;
  productId = await mkProduct(aliceSeller, "Running shoes");
  v1 = await mkVariant(productId, aliceSeller, "RUN-8", "8");
  v2 = await mkVariant(productId, aliceSeller, "RUN-9", "9");
  bobVariant = await mkVariant(await mkProduct(bobSeller, "Bob boots"), bobSeller, "BOOT-1", "7");
});
afterAll(async () => { await t.close(); });

describe("seller stock management", () => {
  it("sets stock in a default warehouse created from the seller's address", async () => {
    const r = await call(alice, "PUT", `/seller/inventory/${v1}`, { onHand: 4, expectedOnHand: 0 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ onHand: 4, reserved: 0, available: 4, warehouseName: "Main warehouse" });
    const wh = (await call(alice, "GET", "/seller/inventory/warehouses")).json().items;
    expect(wh).toHaveLength(1);
    expect(wh[0]).toMatchObject({ isDefault: true, pincode: "431601" });
  });
  it("refuses an exact count based on an out-of-date view", async () => {
    const r = await call(alice, "PUT", `/seller/inventory/${v1}`, { onHand: 10, expectedOnHand: 0 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("STOCK_CHANGED");
    expect(r.json().error.details.currentOnHand).toBe(4);
  });
  it("adjusts by reason: restock adds, damage moves units to damaged, stock never goes below zero", async () => {
    expect((await call(alice, "POST", `/seller/inventory/${v1}/adjust`, { delta: -1, reason: "restock" })).statusCode).toBe(400);
    expect((await call(alice, "POST", `/seller/inventory/${v1}/adjust`, { delta: 2, reason: "restock" })).json().onHand).toBe(6);
    expect((await call(alice, "POST", `/seller/inventory/${v1}/adjust`, { delta: -1, reason: "damage", note: "Torn sole" })).json().onHand).toBe(5);
    expect((await level(v1)).damaged).toBe(1);
    const r = await call(alice, "POST", `/seller/inventory/${v1}/adjust`, { delta: -6, reason: "loss" });
    expect(r.json().error.code).toBe("STOCK_BELOW_RESERVED");
    expect((await level(v1)).on_hand).toBe(5);
  });
  it("records every change in an append-only history", async () => {
    const m = (await call(alice, "GET", `/seller/inventory/${v1}/movements`)).json().items;
    expect(m.map((x: any) => x.reason)).toEqual(["damage", "restock", "correction"]);
    expect(m[0]).toMatchObject({ change: { onHand: -1, damaged: 1 }, onHandAfter: 5, note: "Torn sole" });
    await expect(t.pool.query(`delete from stock_movements`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`update stock_movements set d_on_hand = 100`)).rejects.toThrow(/append-only/);
  });
  it("keeps sellers out of each other's stock and warehouses", async () => {
    expect((await call(bob, "PUT", `/seller/inventory/${v1}`, { onHand: 0, expectedOnHand: 5 })).statusCode).toBe(404);
    expect((await call(bob, "GET", `/seller/inventory/${v1}/movements`)).statusCode).toBe(404);
    const aliceWh = await defaultWh(aliceSeller);
    expect((await call(bob, "PUT", `/seller/inventory/${bobVariant}`, { warehouseId: aliceWh, onHand: 1, expectedOnHand: 0 })).statusCode).toBe(404);
    expect((await call(carl, "GET", "/seller/inventory")).json().error.code).toBe("NOT_A_SELLER");
    await expect(t.pool.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1, $2, 1)`, [bobVariant, aliceWh])).rejects.toThrow(/different sellers/);
  });
  it("the database refuses negative stock and over-reservation", async () => {
    const wh = await defaultWh(aliceSeller);
    await expect(t.pool.query(`update inventory_levels set reserved = on_hand + 1 where variant_id = $1 and warehouse_id = $2`, [v1, wh])).rejects.toThrow(/inventory_reserved_within_on_hand/);
    await expect(t.pool.query(`update inventory_levels set on_hand = -1 where variant_id = $1`, [v1])).rejects.toThrow(/inventory_/);
  });
  it("lists low stock", async () => {
    await call(alice, "PUT", `/seller/inventory/${v2}`, { onHand: 1, expectedOnHand: 0 });
    const low = (await call(alice, "GET", "/seller/inventory?lowStock=true")).json().items.map((x: any) => x.sku);
    expect(low).toEqual(["RUN-9"]);
  });
});

describe("reservations", () => {
  it("holds stock all-or-nothing and reports what is short", async () => {
    const res = await reserveOne(v1, 2, "chk-1");
    expect(res).toHaveLength(1);
    expect(await level(v1)).toMatchObject({ on_hand: 5, reserved: 2 });
    const err: any = await withTx(t.pool, (tx) => inv.reserve(tx, [{ variantId: v1, quantity: 1 }, { variantId: v2, quantity: 5 }],
      { ownerUserId: carl.id, referenceType: "checkout", referenceId: "chk-2", ttlMinutes: 15 })).catch((e) => e);
    expect(err.code).toBe("OUT_OF_STOCK");
    expect(err.details).toEqual([{ variantId: v2, requested: 5, available: 1 }]);
    expect(await level(v1)).toMatchObject({ reserved: 2 }); // v1's hold in the failed checkout was rolled back
    const dup: any = await reserveOne(v1, 1, "chk-1").catch((e) => e);
    expect(dup.code).toBe("ALREADY_RESERVED");
  });
  it("a seller cannot lower stock below what checkouts hold", async () => {
    const r = await call(alice, "PUT", `/seller/inventory/${v1}`, { onHand: 1, expectedOnHand: 5 });
    expect(r.json().error.code).toBe("STOCK_BELOW_RESERVED");
  });
  it("releasing twice gives the stock back once", async () => {
    const [r] = await reserveOne(v1, 1, "chk-3");
    expect(await withTx(t.pool, (tx) => inv.release(tx, [r!.id]))).toBe(1);
    expect(await withTx(t.pool, (tx) => inv.release(tx, [r!.id]))).toBe(0);
    expect((await level(v1)).reserved).toBe(2);
  });
  it("payment confirmation turns held units into sales", async () => {
    const [r] = await reserveOne(v1, 1, "chk-4");
    await withTx(t.pool, (tx) => inv.convert(tx, [r!.id]));
    expect(await level(v1)).toMatchObject({ on_hand: 4, reserved: 2, sold: 1 });
  });
  it("expired holds are released by the sweep, and a late payment cannot use them", async () => {
    const [r] = await reserveOne(v1, 1, "chk-5");
    await t.pool.query(`update stock_reservations set expires_at = now() - interval '1 second' where id = $1`, [r!.id]);
    expect(await inv.expireDue(t.pool)).toBeGreaterThanOrEqual(1);
    const late: any = await withTx(t.pool, (tx) => inv.convert(tx, [r!.id])).catch((e) => e);
    expect(late.code).toBe("RESERVATION_NOT_ACTIVE");
    expect((await level(v1)).sold).toBe(1);
  });
  it("two sweeps running at once release each hold exactly once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await reserveOne(v1, 1, `sweep-${i}`).catch(() => []))[0]?.id ?? "");
    await t.pool.query(`update stock_reservations set expires_at = now() - interval '1 second' where reference_id like 'sweep-%'`);
    const before = await level(v1);
    const [a, b] = await Promise.all([inv.expireDue(t.pool, 3), inv.expireDue(t.pool, 3)]);
    const made = ids.filter(Boolean).length;
    expect(a + b).toBe(made);
    expect((await level(v1)).reserved).toBe(before.reserved - made);
  });
});

describe("concurrent buyers", () => {
  it("50 buyers for the last unit: exactly one gets it", async () => {
    await call(alice, "PUT", `/seller/inventory/${v2}`, { onHand: 1, expectedOnHand: 1 });
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => reserveOne(v2, 1, `last-${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason.code);
    expect(new Set(errors)).toEqual(new Set(["OUT_OF_STOCK"]));
    expect(await level(v2)).toMatchObject({ on_hand: 1, reserved: 1 });
  });
  it("30 buyers for 10 units: exactly 10 succeed, then the product shows as sold out", async () => {
    const wh = await defaultWh(aliceSeller);
    await t.pool.query(`update stock_reservations set status = 'released' where variant_id = $1 and status = 'active'`, [v1]);
    await t.pool.query(`update inventory_levels set reserved = 0, on_hand = 10 where variant_id = $1 and warehouse_id = $2`, [v1, wh]);
    await t.pool.query(`update stock_reservations set status = 'released' where variant_id = $1 and status = 'active'`, [v2]);
    await t.pool.query(`update inventory_levels set reserved = 0, on_hand = 0 where variant_id = $1`, [v2]);
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => reserveOne(v1, 1, `many-${i}`)));
    const won = results.filter((r): r is PromiseFulfilledResult<inv.Reservation[]> => r.status === "fulfilled");
    expect(won).toHaveLength(10);
    await withTx(t.pool, (tx) => inv.convert(tx, won.map((r) => r.value[0]!.id)));
    expect(await level(v1)).toMatchObject({ on_hand: 0, reserved: 0 });
    expect((await call(null, "GET", "/catalogue/products?q=running")).json().items).toHaveLength(0);
    const sold = (await call(null, "GET", "/catalogue/products?q=running&includeOutOfStock=true")).json().items[0];
    expect(sold.inStock).toBe(false);
  });
  it("checkouts holding the same items in opposite order do not deadlock", async () => {
    await call(alice, "POST", `/seller/inventory/${v1}/adjust`, { delta: 200, reason: "restock" });
    await call(alice, "POST", `/seller/inventory/${v2}/adjust`, { delta: 200, reason: "restock" });
    const runs = Array.from({ length: 40 }, (_, i) => withTx(t.pool, (tx) => inv.reserve(tx,
      i % 2 ? [{ variantId: v1, quantity: 1 }, { variantId: v2, quantity: 1 }] : [{ variantId: v2, quantity: 1 }, { variantId: v1, quantity: 1 }],
      { ownerUserId: carl.id, referenceType: "checkout", referenceId: `pair-${i}`, ttlMinutes: 15 })));
    const out = await Promise.allSettled(runs);
    expect(out.filter((r) => r.status === "rejected")).toHaveLength(0);
  });
});

describe("after the sale", () => {
  it("cancellation, returns and restocking move units between the right counters", async () => {
    const wh = await defaultWh(aliceSeller);
    const start = await level(v1);
    await withTx(t.pool, (tx) => inv.cancelSale(tx, v1, wh, 1, { referenceType: "order", referenceId: "o-1" }));
    await withTx(t.pool, (tx) => inv.receiveReturn(tx, v1, wh, 2, "good", { referenceType: "order", referenceId: "o-2" }));
    await withTx(t.pool, (tx) => inv.receiveReturn(tx, v1, wh, 1, "damaged", { referenceType: "order", referenceId: "o-3" }));
    expect(await level(v1)).toMatchObject({ on_hand: start.on_hand + 1, sold: start.sold - 4, returned: 2, damaged: start.damaged + 1 });
    expect((await call(alice, "POST", `/seller/inventory/${v1}/restock-returned`, { quantity: 3 })).json().error.code).toBe("INSUFFICIENT_STOCK");
    expect((await call(alice, "POST", `/seller/inventory/${v1}/restock-returned`, { quantity: 2 })).statusCode).toBe(200);
    expect(await level(v1)).toMatchObject({ on_hand: start.on_hand + 3, returned: 0 });
    const tooMany: any = await withTx(t.pool, (tx) => inv.receiveReturn(tx, v1, wh, 10_000, "good", {})).catch((e) => e);
    expect(tooMany.code).toBe("INSUFFICIENT_STOCK");
  });
});

describe("warehouses", () => {
  let second: string;
  it("adds warehouses, keeps exactly one default, and refuses to switch off the default", async () => {
    second = (await call(alice, "POST", "/seller/inventory/warehouses", { name: "Pune store", pincode: "411001" })).json().id;
    expect((await call(alice, "POST", "/seller/inventory/warehouses", { name: "Pune store", pincode: "411001" })).statusCode).toBe(409);
    const first = await defaultWh(aliceSeller);
    expect((await call(alice, "PATCH", `/seller/inventory/warehouses/${first}`, { isActive: false })).statusCode).toBe(422);
    expect((await call(alice, "PATCH", `/seller/inventory/warehouses/${second}`, { isDefault: true })).statusCode).toBe(200);
    expect(await defaultWh(aliceSeller)).toBe(second);
    expect((await call(bob, "PATCH", `/seller/inventory/warehouses/${second}`, { name: "Mine now" })).statusCode).toBe(404);
  });
  it("stock in an inactive warehouse cannot be bought", async () => {
    const old = (await t.pool.query(`select id from warehouses where seller_id = $1 and not is_default`, [aliceSeller])).rows[0].id;
    // Everything of v2 sits in the old warehouse; the new default has none.
    await call(alice, "PATCH", `/seller/inventory/warehouses/${old}`, { isActive: false });
    const r: any = await reserveOne(v2, 1, "inactive-1").catch((e) => e);
    expect(r.code).toBe("OUT_OF_STOCK");
    await call(alice, "PATCH", `/seller/inventory/warehouses/${old}`, { isActive: true });
    expect((await reserveOne(v2, 1, "inactive-2"))[0]!.warehouseId).toBe(old);
  });
});

describe("public product page and admin", () => {
  it("shows whether each size can be bought and 'only N left', never exact stock", async () => {
    const wh = await defaultWh(aliceSeller);
    await t.pool.query(`update stock_reservations set status = 'released' where variant_id = $1 and status = 'active'`, [v2]);
    await t.pool.query(`update inventory_levels set reserved = 0, on_hand = 2 where variant_id = $1`, [v2]);
    expect(wh).toBeTruthy();
    const p = (await call(null, "GET", `/catalogue/products/${productId}`)).json();
    const bySku = Object.fromEntries(p.variants.map((v: any) => [v.sku, v]));
    expect(bySku["RUN-9"]).toMatchObject({ inStock: true, onlyLeft: 2 });
    expect(bySku["RUN-8"].onlyLeft).toBeNull();
    expect(JSON.stringify(p)).not.toMatch(/onHand|reserved/);
  });
  it("admins adjust any stock with a note, audited; never their own; customers cannot", async () => {
    const wh = await defaultWh(bobSeller) ?? (await t.pool.query(`insert into warehouses (seller_id, name, pincode, is_default) values ($1, 'Main', '431601', true) returning id`, [bobSeller])).rows[0].id;
    expect((await call(admin, "POST", `/admin/inventory/${bobVariant}/adjust`, { warehouseId: wh, delta: 3, reason: "correction" })).statusCode).toBe(400);
    const r = await call(admin, "POST", `/admin/inventory/${bobVariant}/adjust`, { warehouseId: wh, delta: 3, reason: "correction", note: "Stock count audit" });
    expect(r.json().onHand).toBe(3);
    const a = await t.pool.query(`select 1 from audit_logs where action = 'inventory.admin_adjust' and entity_id = $1`, [bobVariant]);
    expect(a.rowCount).toBe(1);
    const m = (await call(admin, "GET", `/admin/inventory/movements?variantId=${bobVariant}`)).json().items[0];
    expect(m).toMatchObject({ reason: "admin_adjustment", actorId: admin.id });
    expect((await call(carl, "GET", "/admin/inventory/movements")).statusCode).toBe(403);
    // An admin who is also a seller cannot adjust their own stock through the admin route.
    await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [bob.id]);
    expect((await call(bob, "POST", `/admin/inventory/${bobVariant}/adjust`, { warehouseId: wh, delta: 1, reason: "correction", note: "Self service" })).statusCode).toBe(403);
  });
});

describe("review findings (regressions)", () => {
  let x1: string, x2: string, y1: string, y2: string, wh: string;
  beforeAll(async () => {
    wh = await defaultWh(aliceSeller);
    const cat = (await t.pool.query(`select id from categories limit 1`)).rows[0].id;
    const mk = async (title: string) => (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, 'active', $2, $3, 'new', 1800) returning id`, [aliceSeller, title, cat])).rows[0].id;
    const px = await mk("Product X"), py = await mk("Product Y");
    const mv = async (pid: string, sku: string, size: string) => {
      const id = (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, options, price_paise, mrp_paise) values ($1, $2, $3, $4, 1000, 1000) returning id`, [pid, aliceSeller, sku, JSON.stringify({ size })])).rows[0].id;
      await t.pool.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1, $2, 500)`, [id, wh]);
      return id as string;
    };
    x1 = await mv(px, "X-1", "1"); x2 = await mv(px, "X-2", "2"); y1 = await mv(py, "Y-1", "1"); y2 = await mv(py, "Y-2", "2");
  });
  it("buyers taking different sizes of the same two products in crossed order never deadlock", async () => {
    for (let round = 0; round < 5; round++) {
      const runs = Array.from({ length: 30 }, (_, i) => withTx(t.pool, (tx) => inv.reserve(tx,
        i % 2 ? [{ variantId: x1, quantity: 1 }, { variantId: y2, quantity: 1 }] : [{ variantId: y1, quantity: 1 }, { variantId: x2, quantity: 1 }],
        { ownerUserId: carl.id, referenceType: "checkout", referenceId: `cross-${round}-${i}`, ttlMinutes: 15 })));
      const out = await Promise.allSettled(runs);
      expect(out.filter((r) => r.status === "rejected").map((r: any) => r.reason?.code)).toEqual([]);
    }
    // The sweeper releasing them in big batches alongside new checkouts does not deadlock either.
    await t.pool.query(`update stock_reservations set expires_at = now() - interval '1 second' where reference_id like 'cross-%'`);
    const [swept, more] = await Promise.allSettled([
      inv.expireDue(t.pool, 100),
      Promise.all(Array.from({ length: 20 }, (_, i) => withTx(t.pool, (tx) => inv.reserve(tx, [{ variantId: y2, quantity: 1 }, { variantId: x1, quantity: 1 }],
        { ownerUserId: carl.id, referenceType: "checkout", referenceId: `late-${i}`, ttlMinutes: 15 })))),
    ]);
    expect(swept.status).toBe("fulfilled");
    expect(more.status).toBe("fulfilled");
  });
  it("switching a warehouse off or on updates search at once", async () => {
    const second = (await call(alice, "POST", "/seller/inventory/warehouses", { name: "Overflow", pincode: "411002" })).json().id;
    const only = (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) select $1, 'active', 'Overflow scarf', id, 'new', 500 from categories limit 1 returning id`, [aliceSeller])).rows[0].id;
    const v = (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) values ($1, $2, 'OV-1', 5000, 5000) returning id`, [only, aliceSeller])).rows[0].id;
    await t.pool.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1, $2, 3)`, [v, second]);
    expect((await call(null, "GET", "/catalogue/products?q=overflow")).json().items).toHaveLength(1);
    await call(alice, "PATCH", `/seller/inventory/warehouses/${second}`, { isActive: false });
    expect((await call(null, "GET", "/catalogue/products?q=overflow")).json().items).toHaveLength(0);
    await call(alice, "PATCH", `/seller/inventory/warehouses/${second}`, { isActive: true });
    expect((await call(null, "GET", "/catalogue/products?q=overflow")).json().items).toHaveLength(1);
    expect((await t.pool.query(`select count(*)::int n from search_refresh_queue`)).rows[0].n).toBe(0);
  });
  it("two first-time exact counts at once cannot double the stock", async () => {
    const pid = (await t.pool.query(`select product_id from product_variants where id = $1`, [x1])).rows[0].product_id;
    const fresh = (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, options, price_paise, mrp_paise) values ($1, $2, 'X-NEW', '{"size":"9"}', 1000, 1000) returning id`, [pid, aliceSeller])).rows[0].id;
    const [a, b] = await Promise.all([
      call(alice, "PUT", `/seller/inventory/${fresh}`, { onHand: 5, expectedOnHand: 0 }),
      call(alice, "PUT", `/seller/inventory/${fresh}`, { onHand: 5, expectedOnHand: 0 }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await level(fresh)).on_hand).toBe(5);
  });
  it("the same item twice in one checkout is limited to 1000 in total, with a clear error", async () => {
    const e: any = await withTx(t.pool, (tx) => inv.reserve(tx, [{ variantId: x1, quantity: 600 }, { variantId: x1, quantity: 600 }],
      { ownerUserId: carl.id, referenceType: "checkout", referenceId: "merge-1", ttlMinutes: 15 })).catch((x) => x);
    expect(e.code).toBe("VALIDATION_FAILED");
  });
  it("stock above the cap is reported as a limit, not as 'below reserved'", async () => {
    const r = await call(alice, "POST", `/seller/inventory/${x1}/adjust`, { delta: 100_000, reason: "restock" });
    expect(r.statusCode).toBe(200);
    await t.pool.query(`update inventory_levels set on_hand = 999990 where variant_id = $1`, [x1]);
    const over = await call(alice, "POST", `/seller/inventory/${x1}/adjust`, { delta: 100, reason: "restock" });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe("STOCK_LIMIT");
  });
  it("'only N left' matches what one order can actually get", async () => {
    const pid = (await t.pool.query(`select product_id from product_variants where id = $1`, [y1])).rows[0].product_id;
    const split = (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, options, price_paise, mrp_paise) values ($1, $2, 'Y-SPLIT', '{"size":"7"}', 1000, 1000) returning id`, [pid, aliceSeller])).rows[0].id;
    const other = (await t.pool.query(`select id from warehouses where seller_id = $1 and id <> $2 and is_active limit 1`, [aliceSeller, wh])).rows[0].id;
    await t.pool.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1, $2, 2), ($1, $3, 2)`, [split, wh, other]);
    const page = (await call(null, "GET", `/catalogue/products/${pid}`)).json();
    expect(page.variants.find((v: any) => v.sku === "Y-SPLIT").onlyLeft).toBe(2);
    expect((await reserveOne(split, 2, "split-ok"))).toHaveLength(1);
  });
});
