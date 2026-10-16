import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let ip = 0;
const nextIp = () => `10.97.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;
const reg = async (email: string, fullName: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: "correct horse battery", fullName } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, remoteAddress: nextIp(), headers: u ? { authorization: `Bearer ${u.at}` } : {}, ...(payload !== undefined ? { payload: payload as any } : {}) });

let seq = 0;
async function seller(owner: U, name: string, withItem = true): Promise<string> {
  const id = (await t.pool.query(
    `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
     values ($1, 'approved', $2, $3, 'individual', 'v1:x', '1234', 'Street', 'Nanded', 'MH', '431601', '9876543210') returning id`, [owner.id, name, name + ' Pvt'])).rows[0].id;
  if (withItem) {
    const cat = (await t.pool.query(`select id from categories limit 1`)).rows[0]?.id
      ?? (await t.pool.query(`insert into categories (slug, name, path, depth) values ('tops','Tops','tops',0) returning id`)).rows[0].id;
    const pid = (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, 'active', $2, $3, 'good', 500) returning id`, [id, `${name} dress`, cat])).rows[0].id;
    await t.pool.query(`insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) values ($1, $2, $3, 49900, 49900)`, [pid, id, `SKU-${pid.slice(0, 8)}`]);
  }
  return id;
}
// A package (seller_orders row) for this buyer and seller, in the given status.
async function pkg(buyer: U, sellerId: string, status: string): Promise<string> {
  const n = ++seq;
  const o = (await t.pool.query(
    `insert into orders (number, user_id, status, payment_status, items_subtotal_paise, discount_paise, items_net_paise, delivery_paise, buyer_fee_paise, total_paise, gst_included_paise,
                         buyer_fee_fixed_paise, buyer_fee_bp, shipping_address, idempotency_key, request_hash, expires_at)
     values ($1, $2, 'confirmed', 'paid', 1000, 0, 1000, 0, 0, 1000, 0, 0, 0, '{}', $3, 'h', now() + interval '1 day') returning id`, [`RL9${n}`, buyer.id, `idem-key-${n}-${buyer.id.slice(0, 8)}`])).rows[0].id;
  return (await t.pool.query(
    `insert into seller_orders (order_id, seller_id, number, status, items_subtotal_paise, discount_paise, items_net_paise, delivery_code, delivery_label, delivery_paise, commission_paise, seller_earning_paise, delivered_at)
     values ($1, $2, $3, $4, 1000, 0, 1000, 'home', 'Home delivery', 0, 50, 950, ${status === "delivered" ? "now()" : "null"}) returning id`, [o, sellerId, `RL9${n}-1`, status])).rows[0].id;
}

let amy: U, ben: U, cal: U, dee: U, eve: U, admin: U;
let aS: string, bS: string, noItemS: string;

beforeAll(async () => {
  t = await setup();
  [amy, ben, cal, dee, eve, admin] = await Promise.all([
    reg("amy@example.com", "Amy Shop"), reg("ben@example.com", "Ben Buyer"), reg("cal@example.com", "Cal Buyer"),
    reg("dee@example.com", "Dee Buyer"), reg("eve@example.com", "Eve Seller"), reg("admin@example.com", "Admin User")]);
  aS = await seller(amy, "Amy Attic");
  bS = await seller(eve, "Eve Emporium");
  noItemS = await seller(await reg("fay@example.com", "Fay Seller"), "Fay Empty", false);
  await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [admin.id]);
});
afterAll(async () => { await t.close(); });

describe("giving a rating", () => {
  it("needs sign-in", async () => {
    const p = await pkg(ben, aS, "delivered");
    expect((await call(null, "PUT", `/ratings/packages/${p}`, { stars: 5 })).statusCode).toBe(401);
    expect((await call(null, "GET", "/ratings/mine")).statusCode).toBe(401);
  });

  it("lets the buyer rate a delivered package, with an optional trimmed comment", async () => {
    const p = await pkg(ben, aS, "delivered");
    const r = await call(ben, "PUT", `/ratings/packages/${p}`, { stars: 5, comment: "  Lovely, as described  " });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ packageId: p, sellerId: aS, stars: 5, comment: "Lovely, as described", canEdit: true });
    const mine = (await call(ben, "GET", "/ratings/mine")).json().items;
    expect(mine.find((x: any) => x.packageId === p)).toMatchObject({ stars: 5 });
    const blank = await pkg(ben, bS, "delivered");
    expect((await call(ben, "PUT", `/ratings/packages/${blank}`, { stars: 4, comment: "   " })).json().comment).toBeNull();
  });

  it("refuses packages that are not delivered, someone else's packages, and your own shop", async () => {
    const shipped = await pkg(ben, aS, "shipped");
    const r1 = await call(ben, "PUT", `/ratings/packages/${shipped}`, { stars: 5 });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe("NOT_DELIVERED");
    const bens = await pkg(ben, aS, "delivered");
    expect((await call(cal, "PUT", `/ratings/packages/${bens}`, { stars: 1 })).statusCode).toBe(404);
    expect((await call(ben, "PUT", `/ratings/packages/00000000-0000-4000-8000-000000000000`, { stars: 1 })).statusCode).toBe(404);
    const own = await pkg(amy, aS, "delivered");
    const r2 = await call(amy, "PUT", `/ratings/packages/${own}`, { stars: 5 });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("OWN_SELLER");
  });

  it("validates stars and comment", async () => {
    const p = await pkg(cal, aS, "delivered");
    for (const bad of [{ stars: 0 }, { stars: 6 }, { stars: 4.5 }, { stars: "5" }, {}, { stars: 5, comment: "x".repeat(301) }, { stars: 5, extra: 1 }]) {
      expect((await call(cal, "PUT", `/ratings/packages/${p}`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("allows changing a rating within 7 days and locks it after", async () => {
    const p = await pkg(dee, aS, "delivered");
    expect((await call(dee, "PUT", `/ratings/packages/${p}`, { stars: 2, comment: "Slow" })).statusCode).toBe(201);
    const changed = await call(dee, "PUT", `/ratings/packages/${p}`, { stars: 4, comment: "Arrived in the end" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ stars: 4, comment: "Arrived in the end" });
    expect((await t.pool.query(`select count(*)::int n from seller_ratings where seller_order_id = $1`, [p])).rows[0].n).toBe(1);
    await t.pool.query(`update seller_ratings set created_at = now() - interval '8 days' where seller_order_id = $1`, [p]);
    const late = await call(dee, "PUT", `/ratings/packages/${p}`, { stars: 1 });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("RATING_LOCKED");
    expect((await call(dee, "GET", "/ratings/mine")).json().items.find((x: any) => x.packageId === p).canEdit).toBe(false);
  });
});

describe("top rated sellers", () => {
  it("shows nobody until a seller has 3 ratings, then ranks by average, then count", async () => {
    // Amy Attic has ratings from the tests above (5, 4 after edit... plus more below); start from a clean slate.
    await t.pool.query(`delete from seller_ratings`);
    expect((await call(null, "GET", "/catalogue/sellers/top")).json().items).toEqual([]);
    const rate = async (u: U, s: string, stars: number) => (await call(u, "PUT", `/ratings/packages/${await pkg(u, s, "delivered")}`, { stars })).statusCode;
    await rate(ben, aS, 5); await rate(cal, aS, 5);
    expect((await call(null, "GET", "/catalogue/sellers/top")).json().items).toEqual([]); // only 2
    await rate(dee, aS, 4);
    let top = (await call(null, "GET", "/catalogue/sellers/top")).json();
    expect(top.minRatings).toBe(3);
    expect(top.items).toEqual([{ id: aS, displayName: "Amy Attic", ratingAvg: 4.7, ratingCount: 3, itemCount: 1 }]);
    // Eve: 5, 5, 5, 5 => higher average
    for (const u of [ben, cal, dee, amy]) expect(await rate(u, bS, 5)).toBe(201);
    top = (await call(null, "GET", "/catalogue/sellers/top")).json();
    expect(top.items.map((x: any) => [x.displayName, x.ratingAvg, x.ratingCount])).toEqual([["Eve Emporium", 5, 4], ["Amy Attic", 4.7, 3]]);
  });

  it("leaves out sellers with no live items and sellers that are not approved", async () => {
    for (const u of [ben, cal, dee]) await call(u, "PUT", `/ratings/packages/${await pkg(u, noItemS, "delivered")}`, { stars: 5 });
    expect((await call(null, "GET", "/catalogue/sellers/top")).json().items.map((x: any) => x.displayName)).not.toContain("Fay Empty");
    await t.pool.query(`update sellers set status = 'suspended' where id = $1`, [bS]);
    expect((await call(null, "GET", "/catalogue/sellers/top")).json().items.map((x: any) => x.displayName)).not.toContain("Eve Emporium");
    await t.pool.query(`update sellers set status = 'approved' where id = $1`, [bS]);
  });

  it("shows a seller's summary and recent comments publicly, with first names only", async () => {
    await call(ben, "PUT", `/ratings/packages/${await pkg(ben, aS, "delivered")}`, { stars: 3, comment: "Fine" });
    const r = await call(null, "GET", `/catalogue/sellers/${aS}/ratings`);
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.seller).toEqual({ id: aS, displayName: "Amy Attic" });
    expect(j.ratingCount).toBe(4);
    expect(j.distribution.find((d: any) => d.stars === 5).count).toBe(2);
    expect(j.recent[0]).toMatchObject({ stars: 3, comment: "Fine", buyerName: "Ben" });
    expect(JSON.stringify(j)).not.toContain("Buyer");
    expect((await call(null, "GET", "/catalogue/sellers/00000000-0000-4000-8000-000000000000/ratings")).statusCode).toBe(404);
  });

  it("shows the rating on the item page seller", async () => {
    const pid = (await t.pool.query(`select id from products where seller_id = $1 limit 1`, [aS])).rows[0].id;
    const r = await call(null, "GET", `/catalogue/products/${pid}`);
    expect(r.json().seller).toMatchObject({ id: aS, displayName: "Amy Attic", ratingAvg: 4.3, ratingCount: 4 });
  });
});

describe("removing abusive ratings", () => {
  it("is admin-only, drops the rating from the average, keeps the row, and cannot be re-rated", async () => {
    const row = (await t.pool.query(`select id, seller_order_id, buyer_id from seller_ratings where seller_id = $1 and stars = 3`, [aS])).rows[0];
    expect((await call(ben, "POST", `/admin/ratings/${row.id}/remove`, { reason: "Abusive" })).statusCode).toBe(403);
    expect((await call(admin, "POST", `/admin/ratings/${row.id}/remove`, { reason: "x" })).statusCode).toBe(400);
    expect((await call(admin, "POST", `/admin/ratings/${row.id}/remove`, { reason: "Abusive language" })).statusCode).toBe(200);
    expect((await call(admin, "POST", `/admin/ratings/${row.id}/remove`, { reason: "Abusive language" })).statusCode).toBe(200); // repeat is harmless
    const j = (await call(null, "GET", `/catalogue/sellers/${aS}/ratings`)).json();
    expect(j.ratingCount).toBe(3);
    expect(j.ratingAvg).toBe(4.7);
    expect((await t.pool.query(`select count(*)::int n from seller_ratings where id = $1`, [row.id])).rows[0].n).toBe(1);
    expect((await t.pool.query(`select count(*)::int n from audit_logs where action = 'rating.remove' and entity_id = $1`, [row.id])).rows[0].n).toBe(1);
    const again = await call(ben, "PUT", `/ratings/packages/${row.seller_order_id}`, { stars: 5 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("RATING_REMOVED");
    expect((await call(ben, "GET", "/ratings/mine")).json().items.some((x: any) => x.id === row.id)).toBe(false);
  });
});
