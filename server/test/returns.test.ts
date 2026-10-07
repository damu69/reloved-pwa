import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { setup, multipartFile } from "./helpers.js";
import { MockProvider } from "../src/modules/payments/provider.js";
import { processDeadlines } from "../src/modules/returns/service.js";
import { processPendingRefunds } from "../src/modules/refunds/service.js";
import { releaseHeldFunds } from "../src/modules/finance/service.js";
import { allocate } from "../src/modules/cart/pricing.js";
import { sellerBalances } from "../src/modules/finance/ledger.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let admin: U, alice: U, bob: U, carl: U, dave: U;
let aliceSeller: string, bobSeller: string;
let PHOTO: Buffer;
const V: Record<string, string> = {};
let ip = 0;
const nextIp = () => `10.93.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;
let keyN = 0;
const newKey = () => `ret-${Date.now()}-${++keyN}`;

const reg = async (email: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: "correct horse battery", fullName: email } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, remoteAddress: nextIp(), headers: { ...(u ? { authorization: `Bearer ${u.at}` } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as any } : {}) });
const total = async (u: U) => (await call(u, "GET", "/cart")).json().totals.totalPaise as number;

// Places and pays an order through the mock provider; returns the order detail.
const paidOrder = async (u: U, items: Record<string, number>, coupon?: string) => {
  for (const [k, q] of Object.entries(items)) expect((await call(u, "PUT", `/cart/items/${V[k]}`, { quantity: q })).statusCode).toBeLessThan(300);
  if (coupon) expect((await call(u, "POST", "/cart/coupon", { code: coupon })).statusCode).toBe(200);
  let addr = (await call(u, "GET", "/me/addresses")).json().items[0]?.id;
  if (!addr) addr = (await call(u, "POST", "/me/addresses", { name: "Buyer B", phone: "9876543210", line1: "4 MG Road", city: "Pune", state: "MH", pincode: "411001" })).json().id;
  const o = await call(u, "POST", "/checkout", { addressId: addr, expectedTotalPaise: await total(u) }, { "idempotency-key": newKey() });
  expect(o.statusCode).toBe(201);
  const a = (await call(u, "POST", `/orders/${o.json().id}/pay`)).json();
  const s = (await call(u, "POST", "/payments/mock/simulate", { paymentId: a.paymentId, outcome: "success" })).json();
  const v = await call(u, "POST", "/payments/verify", { providerOrderId: s.providerOrderId, providerPaymentId: s.providerPaymentId, signature: s.signature });
  expect(v.json().outcome).toBe("captured");
  return v.json().order;
};
const pkgOf = (o: any, sellerId: string) => o.packages.find((p: any) => p.sellerId === sellerId);
const sellerUser = (sellerId: string) => (sellerId === aliceSeller ? alice : bob);
const deliver = async (sellerId: string, packageId: string) => {
  const u = sellerUser(sellerId);
  for (const b of [{ to: "processing" }, { to: "shipped", carrier: "Delhivery", trackingNumber: "DL12345" }, { to: "out_for_delivery" }, { to: "delivered" }]) {
    expect((await call(u, "POST", `/seller/orders/${packageId}/status`, b)).statusCode).toBe(200);
  }
};
const photo = async (u: U) => {
  const m = multipartFile("p.png", PHOTO, "image/png");
  const r = await t.app.inject({ method: "POST", url: "/api/v1/me/return-photos", remoteAddress: nextIp(), headers: { authorization: `Bearer ${u.at}`, ...m.headers }, payload: m.payload });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};
const requestReturn = async (u: U, pkg: any, extra: Record<string, unknown> = {}) =>
  call(u, "POST", "/returns", { packageId: pkg.id, orderItemIds: pkg.items.map((i: any) => i.id), reason: "damaged", description: "The zip is broken and the seam is torn.", photoIds: [await photo(u)], ...extra });
const refundRow = async (id: string) => (await t.pool.query(`select * from refunds where id = $1`, [id])).rows[0];
const ledgerKinds = async (ref: string) => (await t.pool.query(`select kind from ledger_transactions where reference_id = $1 order by created_at`, [ref])).rows.map((x) => x.kind);
const balanced = async () => (await call(admin, "GET", "/admin/finance/trial-balance")).json().totals.balanced;
const level = async (k: string) => (await t.pool.query(`select on_hand, reserved, sold, returned, damaged from inventory_levels where variant_id = $1`, [V[k]])).rows[0];
const paymentOf = async (orderId: string) => (await t.pool.query(`select provider_payment_id, received_paise::int r from payments where order_id = $1 and status = 'captured'`, [orderId])).rows[0];

beforeAll(async () => {
  t = await setup();
  PHOTO = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer();
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
  const cat = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('tops','Tops','tops',0) returning id`)).rows[0].id;
  for (const s of [aliceSeller, bobSeller]) {
    const wh = (await t.pool.query(`insert into warehouses (seller_id, name, pincode, is_default) values ($1, 'Main', '431601', true) returning id`, [s])).rows[0].id;
    for (const [k, price] of (s === aliceSeller ? [["dress", 100000], ["scarf", 30000]] : [["boots", 200000], ["belt", 50000]]) as [string, number][]) {
      const p = (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, 'active', $2, $3, 'good', 500) returning id`, [s, k, cat])).rows[0].id;
      V[k] = (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) values ($1, $2, $3, $4, $4) returning id`, [p, s, `SKU-${k}`, price])).rows[0].id;
      await t.pool.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1, $2, 100)`, [V[k], wh]);
    }
  }
});
afterAll(async () => { await t.close(); });

describe("cancelling paid packages before they ship", () => {
  it("the buyer cancels one package: items, its delivery fee and its Buyer Protection share come back; stock returns", async () => {
    const o = await paidOrder(carl, { dress: 1, boots: 1 });
    const a = pkgOf(o, aliceSeller);
    const before = await level("dress");
    const r = await call(carl, "POST", `/orders/${o.id}/packages/${a.id}/cancel`, { reason: "Changed my mind" });
    expect(r.statusCode).toBe(200);
    const f = await refundRow(r.json().refundId);
    // Fee shares follow item value: dress ₹1000 of ₹3000 → a third of the fee (largest-remainder rounding).
    const fee = o.totals.buyerProtectionPaise;
    const ordered = [...o.packages].sort((x: any, y: any) => (x.number < y.number ? -1 : 1));
    const shares = allocate(fee, ordered.map((p: any) => p.itemsNetPaise));
    expect(Number(f.buyer_fee_paise)).toBe(shares[ordered.findIndex((p: any) => p.id === a.id)]);
    expect(Number(f.items_paise)).toBe(100000);
    expect(Number(f.delivery_paise)).toBe(a.delivery.feePaise);
    expect(Number(f.amount_paise)).toBe(100000 + a.delivery.feePaise + Number(f.buyer_fee_paise));
    expect(f.status).toBe("processed");
    expect(await ledgerKinds(f.id)).toEqual(["refund_due", "refund_paid"]);
    expect(await level("dress")).toMatchObject({ on_hand: before.on_hand + 1, sold: before.sold - 1 });
    const pay = await paymentOf(o.id);
    expect(MockProvider.refundedFor(pay.provider_payment_id)).toBe(Number(f.amount_paise));
    const view = (await call(carl, "GET", `/orders/${o.id}`)).json();
    expect(view.paymentStatus).toBe("partially_refunded");
    expect(view.status).toBe("confirmed");
    expect(pkgOf(view, aliceSeller).status).toBe("cancelled");
    // Alice's earning for that package is fully reversed; nothing on hold for it.
    expect((await sellerBalances(t.pool, aliceSeller)).pendingPaise).toBe(0);
    expect(await balanced()).toBe(true);
    // Twice is refused, and the other package goes on as normal.
    expect((await call(carl, "POST", `/orders/${o.id}/packages/${a.id}/cancel`, {})).json().error.code).toBe("ALREADY_SHIPPED");
    // Cancelling the rest gives back exactly what was paid.
    const b = pkgOf(o, bobSeller);
    await call(carl, "POST", `/orders/${o.id}/packages/${b.id}/cancel`, {});
    const refunded = (await t.pool.query(`select sum(amount_paise)::int s from refunds where order_id = $1`, [o.id])).rows[0].s;
    expect(refunded).toBe(o.totals.totalPaise);
    const after = (await call(carl, "GET", `/orders/${o.id}`)).json();
    expect(after).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
  });
  it("cancelling a whole paid order works only while nothing has shipped", async () => {
    const o = await paidOrder(dave, { scarf: 1, belt: 1 });
    const b = pkgOf(o, bobSeller);
    await call(bob, "POST", `/seller/orders/${b.id}/status`, { to: "processing" });
    await call(bob, "POST", `/seller/orders/${b.id}/status`, { to: "shipped", carrier: "Delhivery", trackingNumber: "DL99999" });
    const r = await call(dave, "POST", `/orders/${o.id}/cancel`, {});
    expect(r.json().error.code).toBe("PARTLY_SHIPPED");
    expect(r.json().error.details).toEqual([pkgOf(o, aliceSeller).id]);
    expect((await call(dave, "POST", `/orders/${o.id}/packages/${b.id}/cancel`, {})).json().error.code).toBe("ALREADY_SHIPPED");
    const o2 = await paidOrder(dave, { scarf: 1 });
    const all = await call(dave, "POST", `/orders/${o2.id}/cancel`, { reason: "Ordered by mistake" });
    expect(all.json()).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
  });
  it("a seller can cancel their own unshipped package with a reason; others cannot", async () => {
    const o = await paidOrder(carl, { belt: 1 });
    const b = pkgOf(o, bobSeller);
    expect((await call(alice, "POST", `/seller/orders/${b.id}/cancel`, { reason: "Not mine", restock: true })).statusCode).toBe(404);
    expect((await call(bob, "POST", `/seller/orders/${b.id}/cancel`, {})).statusCode).toBe(400);
    const before = await level("belt");
    const r = await call(bob, "POST", `/seller/orders/${b.id}/cancel`, { reason: "Item was damaged in storage", restock: false });
    expect(r.statusCode).toBe(200);
    expect((await refundRow(r.json().refundId)).amount_paise).toBe(String(o.totals.totalPaise));
    // The item no longer exists, so nothing goes back on sale.
    expect(await level("belt")).toMatchObject({ on_hand: before.on_hand, sold: before.sold - 1 });
    // The generic status endpoint never cancels (it would skip the refund).
    const o2 = await paidOrder(carl, { belt: 1 });
    expect((await call(bob, "POST", `/seller/orders/${pkgOf(o2, bobSeller).id}/status`, { to: "cancelled" })).statusCode).toBe(422);
  });
  it("with a coupon the buyer gets back what they paid; the platform recovers its discount; books balance", async () => {
    await call(admin, "POST", "/admin/coupons", { code: "SAVE200", discountType: "fixed", amountPaise: 20000, perUserLimit: 5 });
    const o = await paidOrder(dave, { boots: 1 }, "SAVE200");
    expect(o.totals.discountPaise).toBe(20000);
    const r = await call(dave, "POST", `/orders/${o.id}/cancel`, {});
    expect(r.json().paymentStatus).toBe("refunded");
    const f = (await t.pool.query(`select * from refunds where order_id = $1`, [o.id])).rows[0];
    expect(Number(f.items_paise)).toBe(180000);
    expect(Number(f.amount_paise)).toBe(o.totals.totalPaise);
    const tx = (await call(admin, "GET", `/admin/finance/transactions?referenceId=${f.id}&kind=refund_due`)).json().items[0];
    expect(tx.lines.find((l: any) => l.account === "platform:coupon_expense")).toMatchObject({ direction: "credit", amountPaise: 20000 });
    expect(tx.lines.find((l: any) => l.account === "platform:refund_commission_expense")).toMatchObject({ direction: "debit", amountPaise: 10000 });
    expect(await balanced()).toBe(true);
  });
  it("an admin can cancel with a reason (audited), but not on their own orders", async () => {
    const o = await paidOrder(carl, { scarf: 1 });
    const a = pkgOf(o, aliceSeller);
    expect((await call(admin, "POST", `/admin/seller-orders/${a.id}/cancel`, {})).statusCode).toBe(400);
    expect((await call(admin, "POST", `/admin/seller-orders/${a.id}/cancel`, { reason: "Fraud check failed", restock: true })).statusCode).toBe(200);
    expect((await t.pool.query(`select count(*)::int n from audit_logs where action = 'seller_order.admin_cancel' and entity_id = $1`, [a.id])).rows[0].n).toBe(1);
    const mine = await paidOrder(admin, { scarf: 1 });
    expect((await call(admin, "POST", `/admin/seller-orders/${pkgOf(mine, aliceSeller).id}/cancel`, { reason: "Testing myself", restock: true })).statusCode).toBe(403);
  });
});

describe("returns", () => {
  let o: any, pkg: any, retId: string;
  beforeAll(async () => {
    o = await paidOrder(carl, { dress: 1, scarf: 1 });
    pkg = pkgOf(o, aliceSeller);
  });
  it("only after delivery, only for damaged or fake items, with photos", async () => {
    expect((await requestReturn(carl, pkg)).json().error.code).toBe("INVALID_TRANSITION");
    await deliver(aliceSeller, pkg.id);
    expect((await requestReturn(carl, pkg, { reason: "wrong_size" })).statusCode).toBe(400);
    expect((await requestReturn(carl, pkg, { photoIds: [] })).statusCode).toBe(400);
    expect((await requestReturn(carl, pkg, { photoIds: [await photo(dave)] })).statusCode).toBe(400); // someone else's photo
    expect((await requestReturn(dave, pkg)).statusCode).toBe(404);
  });
  it("seller accepts, buyer ships back, seller confirms: refund = items + fee share + return shipping, not delivery", async () => {
    const dressLine = pkg.items.find((i: any) => i.sku === "SKU-dress");
    const r = await requestReturn(carl, pkg, { orderItemIds: [dressLine.id] });
    expect(r.statusCode).toBe(201);
    retId = r.json().id;
    expect(r.json()).toMatchObject({ status: "requested", reason: "damaged", returnShippingPaise: 9900 });
    expect((await requestReturn(carl, pkg, { orderItemIds: [dressLine.id] })).json().error.code).toBe("RETURN_EXISTS");
    // Photos: buyer and seller can see them; another seller cannot see the return at all.
    const ph = r.json().photoIds[0];
    expect((await call(carl, "GET", `/returns/${retId}/photos/${ph}`)).headers["content-type"]).toBe("image/webp");
    expect((await call(alice, "GET", `/seller/returns/${retId}/photos/${ph}`)).statusCode).toBe(200);
    expect((await call(bob, "GET", `/seller/returns/${retId}`)).statusCode).toBe(404);
    // Wrong order of steps is refused.
    expect((await call(carl, "POST", `/returns/${retId}/ship`, { carrier: "India Post", trackingNumber: "IP1234" })).statusCode).toBe(422);
    expect((await call(alice, "POST", `/seller/returns/${retId}/accept`)).json().status).toBe("approved");
    expect((await call(alice, "POST", `/seller/returns/${retId}/received`, { condition: "good" })).statusCode).toBe(422);
    expect((await call(carl, "POST", `/returns/${retId}/ship`, { carrier: "India Post", trackingNumber: "IP1234" })).json().status).toBe("shipped_back");
    expect((await call(carl, "POST", `/returns/${retId}/withdraw`)).statusCode).toBe(422);
    const before = await level("dress");
    const done = (await call(alice, "POST", `/seller/returns/${retId}/received`, { condition: "good" })).json();
    expect(done.status).toBe("refunded");
    const f = await refundRow(done.refund.id);
    expect(Number(f.items_paise)).toBe(100000);
    expect(Number(f.delivery_paise)).toBe(0);
    expect(Number(f.return_shipping_paise)).toBe(9900);
    expect(Number(f.amount_paise)).toBe(100000 + Number(f.buyer_fee_paise) + 9900);
    expect(Number(f.seller_debit_paise)).toBe(100000 - 5000 + 9900); // price − 5% commission + return shipping
    expect(f.seller_account).toBe("pending");
    expect(await level("dress")).toMatchObject({ returned: before.returned + 1, sold: before.sold - 1, on_hand: before.on_hand });
    expect((await call(carl, "GET", `/orders/${o.id}`)).json().paymentStatus).toBe("partially_refunded");
    expect(await balanced()).toBe(true);
  });
  it("after the 7-day window no return can be opened", async () => {
    const o2 = await paidOrder(dave, { belt: 1 });
    const p2 = pkgOf(o2, bobSeller);
    await deliver(bobSeller, p2.id);
    await t.pool.query(`update seller_orders set delivered_at = now() - interval '8 days' where id = $1`, [p2.id]);
    expect((await requestReturn(dave, p2)).json().error.code).toBe("RETURN_WINDOW_ENDED");
  });
  it("seller rejects; the buyer takes it to an admin, whose decision is final", async () => {
    const o3 = await paidOrder(dave, { belt: 1 });
    const p3 = pkgOf(o3, bobSeller);
    await deliver(bobSeller, p3.id);
    const id = (await requestReturn(dave, p3, { reason: "fake" })).json().id;
    expect((await call(bob, "POST", `/seller/returns/${id}/reject`, { reason: "short" })).statusCode).toBe(400);
    expect((await call(bob, "POST", `/seller/returns/${id}/reject`, { reason: "This is genuine; the buyer's photos show a different item." })).json().status).toBe("rejected");
    expect((await call(dave, "POST", `/returns/${id}/escalate`, { note: "The logo stitching is clearly fake, see photos." })).json().status).toBe("disputed");
    expect((await call(alice, "POST", `/admin/returns/${id}/decide`, { approve: true, note: "x" })).statusCode).toBe(403);
    const d = await call(admin, "POST", `/admin/returns/${id}/decide`, { approve: true, note: "Photos confirm a counterfeit." });
    expect(d.json().status).toBe("approved");
    expect((await call(admin, "POST", `/admin/returns/${id}/decide`, { approve: false, note: "Changed mind" })).statusCode).toBe(422);
    expect((await t.pool.query(`select count(*)::int n from audit_logs where action = 'return.admin_decide' and entity_id = $1`, [id])).rows[0].n).toBe(1);
  });
  it("deadlines: silence accepts, no escalation closes, no shipment closes, no receipt confirmation refunds", async () => {
    const mk = async () => {
      const ox = await paidOrder(carl, { belt: 1 });
      const px = pkgOf(ox, bobSeller);
      await deliver(bobSeller, px.id);
      return (await requestReturn(carl, px)).json().id as string;
    };
    const silent = await mk();
    const rejected = await mk();
    await call(bob, "POST", `/seller/returns/${rejected}/reject`, { reason: "The item was fine when I shipped it." });
    const notShipped = await mk();
    await call(bob, "POST", `/seller/returns/${notShipped}/accept`);
    const notConfirmed = await mk();
    await call(bob, "POST", `/seller/returns/${notConfirmed}/accept`);
    await call(carl, "POST", `/returns/${notConfirmed}/ship`, { carrier: "India Post", trackingNumber: "IP7777" });
    await t.pool.query(`update returns set seller_decide_by = now() - interval '1 minute' where id = $1`, [silent]);
    // Too late for the seller to decide now.
    expect((await call(bob, "POST", `/seller/returns/${silent}/reject`, { reason: "Too late but trying anyway." })).json().error.code).toBe("DEADLINE_PASSED");
    await t.pool.query(`update returns set escalate_by = now() - interval '1 minute' where id = $1`, [rejected]);
    await t.pool.query(`update returns set ship_by = now() - interval '1 minute' where id = $1`, [notShipped]);
    await t.pool.query(`update returns set receive_by = now() - interval '1 minute' where id = $1`, [notConfirmed]);
    const res = await processDeadlines(t.pool);
    expect(res.changed).toBe(4);
    expect(res.refunds).toHaveLength(1);
    const st = async (id: string) => (await t.pool.query(`select status, received_condition from returns where id = $1`, [id])).rows[0];
    expect((await st(silent)).status).toBe("approved");
    expect((await st(rejected)).status).toBe("closed");
    expect((await st(notShipped)).status).toBe("closed");
    expect(await st(notConfirmed)).toEqual({ status: "received", received_condition: "damaged" });
    expect(await processPendingRefunds(t.pool, new MockProvider(t.cfg.MOCK_PAYMENT_SECRET))).toBe(1);
    expect((await st(notConfirmed)).status).toBe("refunded");
  });
  it("earnings stay on hold while a return is open, then only what is left is released", async () => {
    const ox = await paidOrder(dave, { scarf: 1, dress: 1 });
    const px = pkgOf(ox, aliceSeller);
    await deliver(aliceSeller, px.id);
    const scarf = px.items.find((i: any) => i.sku === "SKU-scarf");
    const id = (await requestReturn(dave, px, { orderItemIds: [scarf.id] })).json().id;
    // The payout date is fixed once set; simulate its arrival (bypassing the guard only in this test).
    const c = await t.pool.connect();
    try {
      await c.query(`set session_replication_role = replica`);
      await c.query(`update seller_orders set funds_available_at = now() - interval '1 minute' where id = $1`, [px.id]);
    } finally { await c.query(`set session_replication_role = origin`); c.release(); }
    const before = await sellerBalances(t.pool, aliceSeller);
    await releaseHeldFunds(t.pool);
    expect((await t.pool.query(`select funds_released_at from seller_orders where id = $1`, [px.id])).rows[0].funds_released_at).toBeNull();
    await call(alice, "POST", `/seller/returns/${id}/accept`);
    await call(dave, "POST", `/returns/${id}/ship`, { carrier: "India Post", trackingNumber: "IP5555" });
    const done = (await call(alice, "POST", `/seller/returns/${id}/received`, { condition: "damaged" })).json();
    const f = await refundRow(done.refund.id);
    await releaseHeldFunds(t.pool);
    const so = (await t.pool.query(`select seller_earning_paise::int e, funds_released_at from seller_orders where id = $1`, [px.id])).rows[0];
    expect(so.funds_released_at).not.toBeNull();
    const after = await sellerBalances(t.pool, aliceSeller);
    expect(after.availablePaise - before.availablePaise).toBe(so.e - Number(f.seller_debit_paise));
    expect(after.pendingPaise - before.pendingPaise).toBe(-so.e);
    expect(await level("scarf")).toMatchObject({ damaged: 1 });
  });
});

describe("refund delivery problems and payments to give back", () => {
  it("a refund the provider refuses stays pending and is retried", async () => {
    const o = await paidOrder(carl, { belt: 1 });
    MockProvider.failRefunds = 1;
    const r = await call(carl, "POST", `/orders/${o.id}/cancel`, {});
    expect(r.json().paymentStatus).toBe("paid");
    const f = (await t.pool.query(`select * from refunds where order_id = $1`, [o.id])).rows[0];
    expect(f).toMatchObject({ status: "pending", attempts: 1 });
    expect(f.last_error).toMatch(/unavailable/);
    // Backed off: the sweep leaves it alone for now.
    expect(await processPendingRefunds(t.pool, new MockProvider(t.cfg.MOCK_PAYMENT_SECRET))).toBe(0);
    expect((await call(admin, "GET", "/admin/refunds?status=pending")).json().items.map((x: any) => x.id)).toContain(f.id);
    expect((await call(admin, "POST", `/admin/refunds/${f.id}/retry`)).json().status).toBe("processed");
    expect((await call(carl, "GET", `/orders/${o.id}`)).json().paymentStatus).toBe("refunded");
    expect((await call(admin, "POST", `/admin/refunds/${f.id}/retry`)).json().status).toBe("processed"); // harmless
    expect(await ledgerKinds(f.id)).toEqual(["refund_due", "refund_paid"]);
  });
  it("an admin refunds a payment that could not be applied", async () => {
    const ox = await call(dave, "PUT", `/cart/items/${V.belt}`, { quantity: 1 });
    expect(ox.statusCode).toBeLessThan(300);
    const addr = (await call(dave, "GET", "/me/addresses")).json().items[0].id;
    const o = (await call(dave, "POST", "/checkout", { addressId: addr, expectedTotalPaise: await total(dave) }, { "idempotency-key": newKey() })).json();
    const a = (await call(dave, "POST", `/orders/${o.id}/pay`)).json();
    const s = (await call(dave, "POST", "/payments/mock/simulate", { paymentId: a.paymentId, outcome: "success", amountPaise: a.amountPaise - 1000 })).json();
    expect((await call(dave, "POST", "/payments/verify", { providerOrderId: s.providerOrderId, providerPaymentId: s.providerPaymentId, signature: s.signature })).json().outcome).toBe("needs_refund");
    expect((await call(admin, "POST", `/admin/payments/${a.paymentId}/refund`, {})).statusCode).toBe(400);
    const r = await call(admin, "POST", `/admin/payments/${a.paymentId}/refund`, { reason: "Short payment returned" });
    expect(r.json()).toMatchObject({ kind: "unapplied_payment", status: "processed", amountPaise: a.amountPaise - 1000 });
    expect((await t.pool.query(`select status from payments where id = $1`, [a.paymentId])).rows[0].status).toBe("refunded");
    // Asking again returns the same refund.
    expect((await call(admin, "POST", `/admin/payments/${a.paymentId}/refund`, { reason: "again again" })).json().id).toBe(r.json().id);
    expect(await balanced()).toBe(true);
    await call(dave, "POST", `/orders/${o.id}/cancel`);
  });
});

describe("races and database guards", () => {
  it("two cancels of the same package at once refund once", async () => {
    const o = await paidOrder(carl, { scarf: 1 });
    const a = pkgOf(o, aliceSeller);
    const rs = await Promise.all([1, 2, 3].map(() => call(carl, "POST", `/orders/${o.id}/packages/${a.id}/cancel`, {})));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect((await t.pool.query(`select count(*)::int n from refunds where order_id = $1`, [o.id])).rows[0].n).toBe(1);
  });
  it("cancel racing the seller's shipping: exactly one wins", async () => {
    const o = await paidOrder(dave, { belt: 1 });
    const b = pkgOf(o, bobSeller);
    await call(bob, "POST", `/seller/orders/${b.id}/status`, { to: "processing" });
    const [c, s] = await Promise.all([
      call(dave, "POST", `/orders/${o.id}/packages/${b.id}/cancel`, {}),
      call(bob, "POST", `/seller/orders/${b.id}/status`, { to: "shipped", carrier: "Delhivery", trackingNumber: "DL4242" }),
    ]);
    expect([c.statusCode, s.statusCode].sort()).toEqual([200, 422]);
    const st = (await t.pool.query(`select status from seller_orders where id = $1`, [b.id])).rows[0].status;
    const n = (await t.pool.query(`select count(*)::int n from refunds where seller_order_id = $1`, [b.id])).rows[0].n;
    expect(st === "cancelled" ? n === 1 : n === 0).toBe(true);
  });
  it("refunds, refund lines and returns cannot be rewritten; a line is never refunded twice", async () => {
    await expect(t.pool.query(`update refunds set amount_paise = 1`)).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`update refunds set status = 'pending' where status = 'processed'`)).rejects.toThrow(/final/);
    await expect(t.pool.query(`delete from refunds`)).rejects.toThrow(/cannot be deleted/);
    await expect(t.pool.query(`delete from refund_items`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`update returns set reason = 'fake'`)).rejects.toThrow(/cannot be rewritten/);
    await expect(t.pool.query(`update returns set status = 'requested' where status = 'refunded'`)).rejects.toThrow(/final/);
    const ri = (await t.pool.query(`select * from refund_items limit 1`)).rows[0];
    const other = (await t.pool.query(`select id from refunds where id <> $1 limit 1`, [ri.refund_id])).rows[0];
    await expect(t.pool.query(`insert into refund_items (refund_id, order_item_id, net_paise, discount_paise, commission_paise, buyer_fee_paise) values ($1, $2, 0, 0, 0, 0)`,
      [other.id, ri.order_item_id])).rejects.toThrow(/duplicate key/);
  });
});

describe("review findings (regressions)", () => {
  const withDelivery = async (u: U, item: string, code: string) => {
    expect((await call(u, "PUT", `/cart/items/${V[item]}`, { quantity: 1 })).statusCode).toBeLessThan(300);
    expect((await call(u, "PUT", `/cart/delivery/${bobSeller}`, { code })).statusCode).toBeLessThan(300);
    return paidOrder(u, {});
  };
  it("a return never refunds more than the buyer paid for the package: return shipping is capped (pickup ₹59, meet ₹0)", async () => {
    for (const [code, ship] of [["pickup", 5900], ["meet", 0]] as const) {
      const o = await withDelivery(carl, "belt", code);
      const p = pkgOf(o, bobSeller);
      expect(p.delivery.feePaise).toBe(ship);
      await deliver(bobSeller, p.id);
      const id = (await requestReturn(carl, p)).json().id;
      await call(bob, "POST", `/seller/returns/${id}/accept`);
      await call(carl, "POST", `/returns/${id}/ship`, { carrier: "India Post", trackingNumber: "IP8888" });
      const r = await call(bob, "POST", `/seller/returns/${id}/received`, { condition: "good" });
      expect(r.statusCode).toBe(200);
      expect(r.json().status).toBe("refunded");
      expect(r.json().refund.returnShippingPaise).toBe(ship);
      expect(r.json().refund.amountPaise).toBe(o.totals.totalPaise);
    }
    expect(await balanced()).toBe(true);
  });
  it("one return that cannot be processed does not stop the deadline sweep", async () => {
    const mk = async () => {
      const ox = await paidOrder(dave, { belt: 1 });
      const px = pkgOf(ox, bobSeller);
      await deliver(bobSeller, px.id);
      return { id: (await requestReturn(dave, px)).json().id as string, orderId: ox.id as string };
    };
    const broken = await mk();
    await call(bob, "POST", `/seller/returns/${broken.id}/accept`);
    await call(dave, "POST", `/returns/${broken.id}/ship`, { carrier: "India Post", trackingNumber: "IP1111" });
    // Break it: its order no longer has a captured payment (bypassing the guards, test only).
    const c = await t.pool.connect();
    try {
      await c.query(`set session_replication_role = replica`);
      await c.query(`update payments set status = 'needs_refund' where order_id = $1 and status = 'captured'`, [broken.orderId]);
      await c.query(`update returns set receive_by = now() - interval '1 minute', updated_at = now() - interval '1 day' where id = $1`, [broken.id]);
    } finally { await c.query(`set session_replication_role = origin`); c.release(); }
    const fine = await mk();
    await t.pool.query(`update returns set seller_decide_by = now() - interval '1 minute' where id = $1`, [fine.id]);
    const res = await processDeadlines(t.pool);
    expect(res.failed.map((f) => f.id)).toEqual([broken.id]);
    expect((await t.pool.query(`select status from returns where id = $1`, [fine.id])).rows[0].status).toBe("approved");
  });
  it("a decided return cannot be filed again; one withdrawn before any decision can", async () => {
    const ox = await paidOrder(carl, { scarf: 1 });
    const px = pkgOf(ox, aliceSeller);
    await deliver(aliceSeller, px.id);
    const first = (await requestReturn(carl, px)).json().id;
    await call(carl, "POST", `/returns/${first}/withdraw`);
    const second = (await requestReturn(carl, px)).json().id;
    expect(second).toBeTruthy();
    await call(alice, "POST", `/seller/returns/${second}/reject`, { reason: "The scarf was perfect when it left." });
    await call(carl, "POST", `/returns/${second}/escalate`, { note: "There is a big hole, see the photos." });
    await call(admin, "POST", `/admin/returns/${second}/decide`, { approve: false, note: "The hole is from wear after delivery." });
    expect((await requestReturn(carl, px)).json().error.code).toBe("RETURN_EXISTS");
    // Withdrawing after a rejection does not reset anything either.
    const oy = await paidOrder(carl, { scarf: 1 });
    const py = pkgOf(oy, aliceSeller);
    await deliver(aliceSeller, py.id);
    const r1 = (await requestReturn(carl, py)).json().id;
    await call(alice, "POST", `/seller/returns/${r1}/reject`, { reason: "Not damaged at all, sorry." });
    await call(carl, "POST", `/returns/${r1}/withdraw`);
    expect((await requestReturn(carl, py)).json().error.code).toBe("RETURN_EXISTS");
  });
});
