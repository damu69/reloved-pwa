import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { setup } from "./helpers.js";
import { MockProvider, providerFor } from "../src/modules/payments/provider.js";
import { loadConfig } from "../src/lib/config.js";
import { expireUnpaidOrders } from "../src/modules/orders/service.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let admin: U, alice: U, carl: U, dave: U;
let aliceSeller: string;
const V: Record<string, string> = {};
let ip = 0;
const nextIp = () => `10.92.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;
let keyN = 0;
const newKey = () => `pay-${Date.now()}-${++keyN}`;

const reg = async (email: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: "correct horse battery", fullName: email } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, remoteAddress: nextIp(), headers: { ...(u ? { authorization: `Bearer ${u.at}` } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as any } : {}) });
const total = async (u: U) => (await call(u, "GET", "/cart")).json().totals.totalPaise as number;
const order = async (u: U, item = "dress", qty = 1) => {
  expect((await call(u, "PUT", `/cart/items/${V[item]}`, { quantity: qty })).statusCode).toBeLessThan(300);
  let addr = (await call(u, "GET", "/me/addresses")).json().items[0]?.id;
  if (!addr) addr = (await call(u, "POST", "/me/addresses", { name: "Buyer B", phone: "9876543210", line1: "4 MG Road", city: "Pune", state: "MH", pincode: "411001" })).json().id;
  const r = await call(u, "POST", "/checkout", { addressId: addr, expectedTotalPaise: await total(u) }, { "idempotency-key": newKey() });
  expect(r.statusCode).toBe(201);
  expect(r.json().payment).toEqual({ provider: "mock", available: true });
  return r.json();
};
const pay = (u: U, orderId: string) => call(u, "POST", `/orders/${orderId}/pay`);
const simulate = (u: U, paymentId: string, outcome: "success" | "failure", extra: Record<string, unknown> = {}) =>
  call(u, "POST", "/payments/mock/simulate", { paymentId, outcome, ...extra });
const verify = (u: U, s: any) => call(u, "POST", "/payments/verify", { providerOrderId: s.providerOrderId, providerPaymentId: s.providerPaymentId, signature: s.signature });
const orderRow = async (id: string) => (await t.pool.query(`select status, payment_status from orders where id = $1`, [id])).rows[0];
const ledgerKinds = async (ref: string) => (await t.pool.query(`select kind from ledger_transactions where reference_id = $1 order by created_at`, [ref])).rows.map((x) => x.kind);
const mock = () => new MockProvider(t.cfg.MOCK_PAYMENT_SECRET);
const sendWebhook = (body: Buffer, headers: Record<string, string>) =>
  t.app.inject({ method: "POST", url: "/api/v1/payments/webhook/mock", remoteAddress: nextIp(), headers, payload: body });

beforeAll(async () => {
  t = await setup();
  admin = await reg("admin@example.com"); alice = await reg("alice@example.com"); carl = await reg("carl@example.com"); dave = await reg("dave@example.com");
  await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [admin.id]);
  aliceSeller = (await t.pool.query(
    `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
     values ($1, 'approved', 'Alice', 'Alice', 'individual', 'v1:x', '1234', 'Street', 'Nanded', 'MH', '431601', '9876543210') returning id`, [alice.id])).rows[0].id;
  await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'seller')`, [alice.id]);
  const wh = (await t.pool.query(`insert into warehouses (seller_id, name, pincode, is_default) values ($1, 'Main', '431601', true) returning id`, [aliceSeller])).rows[0].id;
  const cat = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('tops','Tops','tops',0) returning id`)).rows[0].id;
  for (const [k, price] of [["dress", 100000], ["scarf", 30000]] as const) {
    const p = (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, 'active', $2, $3, 'good', 500) returning id`, [aliceSeller, k, cat])).rows[0].id;
    V[k] = (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) values ($1, $2, $3, $4, $4) returning id`, [p, aliceSeller, `SKU-${k}`, price])).rows[0].id;
    await t.pool.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1, $2, 100)`, [V[k], wh]);
  }
});
afterAll(async () => { await t.close(); });

describe("paying an order", () => {
  let o: any, attempt: any;
  it("starts a payment for exactly the order total; asking again returns the same attempt; others cannot", async () => {
    o = await order(carl);
    const r = await pay(carl, o.id);
    expect(r.statusCode).toBe(200);
    attempt = r.json();
    expect(attempt).toMatchObject({ provider: "mock", status: "created", amountPaise: o.totals.totalPaise, currency: "INR", reused: false });
    expect(attempt.clientData.providerOrderId).toBe(attempt.providerOrderId);
    const again = (await pay(carl, o.id)).json();
    expect(again).toMatchObject({ paymentId: attempt.paymentId, reused: true });
    expect((await pay(dave, o.id)).statusCode).toBe(404);
    expect((await simulate(dave, attempt.paymentId, "success")).statusCode).toBe(404);
  });
  it("the browser's confirmation counts only with a valid signature from the server's secret", async () => {
    const s = (await simulate(carl, attempt.paymentId, "success")).json();
    expect((await verify(carl, { ...s, signature: "0".repeat(64) })).json().error.code).toBe("INVALID_SIGNATURE");
    expect((await verify(carl, { ...s, providerPaymentId: "pay_mock_other1" })).json().error.code).toBe("INVALID_SIGNATURE");
    expect((await verify(dave, s)).statusCode).toBe(404); // valid signature, someone else's payment
    expect(await orderRow(o.id)).toEqual({ status: "pending_payment", payment_status: "unpaid" });
    const r = await verify(carl, s);
    expect(r.statusCode).toBe(200);
    expect(r.json().outcome).toBe("captured");
    expect(r.json().order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(r.json().order.payments).toEqual([expect.objectContaining({ status: "captured", amountPaise: o.totals.totalPaise, receivedPaise: o.totals.totalPaise })]);
    expect(await ledgerKinds(o.id)).toEqual(["order_payment"]);
    // Repeats from the browser are harmless.
    expect((await verify(carl, s)).json().outcome).toBe("already_captured");
    expect((await pay(carl, o.id)).json().error.code).toBe("ALREADY_PAID");
    // Sellers never see payment details.
    const pkg = (await call(alice, "GET", "/seller/orders")).json().items[0];
    expect((await call(alice, "GET", `/seller/orders/${pkg.id}`)).json().payments).toBeUndefined();
  });
});

describe("webhooks", () => {
  it("captures from a signed webhook alone, and a repeated event is processed once", async () => {
    const o = await order(dave);
    const a = (await pay(dave, o.id)).json();
    const sim = mock().simulate(a.providerOrderId, "success", a.amountPaise);
    const h = sim.webhook.headers as Record<string, string>;
    expect((await sendWebhook(sim.webhook.body, { ...h, "x-mock-signature": "f".repeat(64) })).json().error.code).toBe("INVALID_SIGNATURE");
    // Changing one byte breaks the signature.
    const tampered = Buffer.from(sim.webhook.body.toString().replace(String(a.amountPaise), String(a.amountPaise - 1)));
    expect((await sendWebhook(tampered, h)).statusCode).toBe(400);
    expect((await t.pool.query(`select count(*)::int n from payment_events`)).rows[0].n).toBe(0); // unsigned events are never stored
    expect((await sendWebhook(sim.webhook.body, h)).json()).toEqual({ ok: true, outcome: "captured" });
    expect((await sendWebhook(sim.webhook.body, h)).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(await orderRow(o.id)).toEqual({ status: "confirmed", payment_status: "paid" });
    // The browser's confirmation arriving after the webhook changes nothing.
    expect((await verify(dave, { providerOrderId: a.providerOrderId, providerPaymentId: sim.providerPaymentId, signature: sim.signature })).json().outcome).toBe("already_captured");
    expect(await ledgerKinds(o.id)).toEqual(["order_payment"]);
  });
  it("unknown event types and unknown provider orders are recorded and ignored", async () => {
    const m = mock();
    const body = Buffer.from(JSON.stringify({ event: "order.paid", payload: {} }));
    const sig = (b: Buffer) => createHmac("sha256", t.cfg.MOCK_PAYMENT_SECRET).update(b).digest("hex");
    expect((await sendWebhook(body, { "x-mock-event-id": "evt_other_1", "x-mock-signature": sig(body), "content-type": "application/json" })).json().outcome).toBe("ignored");
    const sim = m.simulate("order_mock_doesnotexist", "success", 100);
    expect((await sendWebhook(sim.webhook.body, sim.webhook.headers as any)).json().outcome).toBe("unknown_payment");
    expect((await call(null, "POST", "/payments/webhook/razorpay", {})).statusCode).toBe(404);
  });
});

describe("failures and money that cannot be applied", () => {
  it("a failed attempt can be retried with a new one", async () => {
    const o = await order(carl, "scarf");
    const a = (await pay(carl, o.id)).json();
    expect((await simulate(carl, a.paymentId, "failure", { sendWebhook: true })).json().webhook.outcome).toBe("failed");
    const b = (await pay(carl, o.id)).json();
    expect(b.paymentId).not.toBe(a.paymentId);
    const s = (await simulate(carl, b.paymentId, "success")).json();
    expect((await verify(carl, s)).json().outcome).toBe("captured");
    // A late success on the failed first attempt: the order is already paid, so that money is refunded.
    const late = (await simulate(carl, a.paymentId, "success", { sendWebhook: true })).json();
    expect(late.webhook.outcome).toBe("needs_refund");
    const rows = (await t.pool.query(`select status, refund_reason from payments where order_id = $1 order by created_at`, [o.id])).rows;
    expect(rows.map((r) => r.status)).toEqual(["needs_refund", "captured"]);
    expect(rows[0].refund_reason).toMatch(/already paid/);
    expect(await ledgerKinds(a.paymentId)).toEqual(["unapplied_payment"]);
    // A second payment on the already-paid attempt is kept as its own row, also to refund.
    const again = (await simulate(carl, b.paymentId, "success", { sendWebhook: true })).json();
    expect(again.webhook.outcome).toBe("needs_refund");
    expect((await t.pool.query(`select count(*)::int n from payments where order_id = $1`, [o.id])).rows[0].n).toBe(3);
    expect((await t.pool.query(`select count(*)::int n from ledger_transactions where kind = 'order_payment' and reference_id = $1`, [o.id])).rows[0].n).toBe(1);
  });
  it("a wrong amount never pays the order", async () => {
    const o = await order(dave);
    const a = (await pay(dave, o.id)).json();
    const r = (await simulate(dave, a.paymentId, "success", { sendWebhook: true, amountPaise: a.amountPaise - 100 })).json();
    expect(r.webhook.outcome).toBe("needs_refund");
    expect(await orderRow(o.id)).toEqual({ status: "pending_payment", payment_status: "unpaid" });
    const p = (await t.pool.query(`select status, received_paise::int rec, refund_reason from payments where id = $1`, [a.paymentId])).rows[0];
    expect(p).toMatchObject({ status: "needs_refund", rec: a.amountPaise - 100 });
    const tb = (await call(admin, "GET", "/admin/finance/trial-balance")).json();
    expect(tb.totals.balanced).toBe(true);
    expect(tb.accounts.find((x: any) => x.code === "platform:refunds_payable").creditPaise).toBeGreaterThanOrEqual(a.amountPaise - 100);
    await call(dave, "POST", `/orders/${o.id}/cancel`);
  });
  it("money arriving after the order was cancelled is marked for refund", async () => {
    const o = await order(dave);
    const a = (await pay(dave, o.id)).json();
    await call(dave, "POST", `/orders/${o.id}/cancel`);
    expect((await pay(dave, o.id)).json().error.code).toBe("ORDER_NOT_PAYABLE");
    const r = (await simulate(dave, a.paymentId, "success", { sendWebhook: true })).json();
    expect(r.webhook.outcome).toBe("needs_refund");
    expect(await orderRow(o.id)).toEqual({ status: "cancelled", payment_status: "unpaid" });
    const list = (await call(admin, "GET", "/admin/payments?status=needs_refund")).json().items;
    expect(list.map((x: any) => x.id)).toContain(a.paymentId);
    const detail = (await call(admin, "GET", `/admin/payments/${a.paymentId}`)).json();
    expect(detail.events).toEqual([expect.objectContaining({ type: "payment.captured", outcome: "needs_refund" })]);
    expect((await call(carl, "GET", "/admin/payments")).statusCode).toBe(403);
    expect((await t.pool.query(`select count(*)::int n from outbox_events where type = 'payment.needs_refund' and aggregate_id = $1`, [a.paymentId])).rows[0].n).toBe(1);
  });
  it("after the window ends a new payment cannot start, but money arriving before the sweep still counts", async () => {
    const o = await order(carl);
    const a = (await pay(carl, o.id)).json();
    await t.pool.query(`update orders set expires_at = now() - interval '1 minute' where id = $1`, [o.id]);
    const s = (await simulate(carl, a.paymentId, "success")).json();
    expect((await verify(carl, s)).json().outcome).toBe("captured");
    expect(await expireUnpaidOrders(t.pool)).toBe(0);
    const o2 = await order(carl, "scarf");
    await t.pool.query(`update orders set expires_at = now() - interval '1 minute' where id = $1`, [o2.id]);
    expect((await pay(carl, o2.id)).json().error.code).toBe("PAYMENT_WINDOW_ENDED");
    expect(await expireUnpaidOrders(t.pool)).toBe(1);
  });
});

describe("races", () => {
  it("the browser's confirmation and the webhook arriving together pay the order once", async () => {
    const o = await order(dave, "scarf");
    const a = (await pay(dave, o.id)).json();
    const sim = mock().simulate(a.providerOrderId, "success", a.amountPaise);
    const [x, y] = await Promise.all([
      verify(dave, { providerOrderId: a.providerOrderId, providerPaymentId: sim.providerPaymentId, signature: sim.signature }),
      sendWebhook(sim.webhook.body, sim.webhook.headers as any),
    ]);
    const outcomes = [x.json().outcome, y.json().outcome].sort();
    expect(outcomes).toEqual(["already_captured", "captured"]);
    expect(await ledgerKinds(o.id)).toEqual(["order_payment"]);
  });
  it("five 'pay' clicks at once open one attempt", async () => {
    const o = await order(carl, "scarf");
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => pay(carl, o.id)));
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.json().paymentId)).size).toBe(1);
    await call(carl, "POST", `/orders/${o.id}/cancel`);
  });
});

describe("safety", () => {
  it("the database guards payments and the event log", async () => {
    await expect(t.pool.query(`update payments set amount_paise = 1`)).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`update payments set status = 'failed' where status = 'captured'`)).rejects.toThrow(/cannot become/);
    await expect(t.pool.query(`update payments set received_paise = 1 where received_paise is not null`)).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`delete from payments`)).rejects.toThrow(/cannot be deleted/);
    await expect(t.pool.query(`update payment_events set outcome = 'x'`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`truncate payment_events`)).rejects.toThrow(/append-only/);
  });
  it("mock payments are refused in production; production defaults to no provider", () => {
    const prod = { NODE_ENV: "production", DATABASE_URL: "postgres://x", JWT_SECRET: "a-real-looking-secret-value-0123456789abcdef",
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"), DATABASE_SSL: "require", CORS_ORIGINS: "https://reloved-pwa.vercel.app",
      STORAGE_DRIVER: "supabase", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789" };
    expect(() => loadConfig({ ...prod, PAYMENT_PROVIDER: "mock" } as any)).toThrow(/not allowed in production/);
    const c = loadConfig(prod as any);
    expect(c.PAYMENT_PROVIDER).toBe("none");
    expect(providerFor(c)).toBeNull();
    expect(() => providerFor({ ...c, PAYMENT_PROVIDER: "mock" })).toThrow();
  });
});

describe("review findings (regressions)", () => {
  const sign = (b: Buffer) => createHmac("sha256", t.cfg.MOCK_PAYMENT_SECRET).update(b).digest("hex");
  const event = (id: string, entity: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity } } }));
    return sendWebhook(body, { "x-mock-event-id": id, "x-mock-signature": sign(body), "content-type": "application/json" });
  };
  it("the browser's confirmation uses the amount the provider reports, so a short payment never pays the order", async () => {
    const o = await order(dave, "scarf");
    const a = (await pay(dave, o.id)).json();
    const s = (await simulate(dave, a.paymentId, "success", { amountPaise: a.amountPaise - 5000 })).json();
    expect((await verify(dave, s)).json().outcome).toBe("needs_refund");
    expect(await orderRow(o.id)).toEqual({ status: "pending_payment", payment_status: "unpaid" });
    await call(dave, "POST", `/orders/${o.id}/cancel`);
  });
  it("a payment the provider has not captured is not accepted from the browser", async () => {
    const o = await order(dave, "scarf");
    const a = (await pay(dave, o.id)).json();
    const f = (await simulate(dave, a.paymentId, "failure")).json();
    const signature = createHmac("sha256", t.cfg.MOCK_PAYMENT_SECRET).update(`${a.providerOrderId}|${f.providerPaymentId}`).digest("hex");
    expect((await verify(dave, { providerOrderId: a.providerOrderId, providerPaymentId: f.providerPaymentId, signature })).json().error.code).toBe("PAYMENT_NOT_CAPTURED");
    // A validly signed id the provider has never heard of is refused too.
    const ghost = "pay_mock_ghost00001";
    const gs = createHmac("sha256", t.cfg.MOCK_PAYMENT_SECRET).update(`${a.providerOrderId}|${ghost}`).digest("hex");
    expect((await verify(dave, { providerOrderId: a.providerOrderId, providerPaymentId: ghost, signature: gs })).json().error.code).toBe("INVALID_SIGNATURE");
    expect(await orderRow(o.id)).toEqual({ status: "pending_payment", payment_status: "unpaid" });
    await call(dave, "POST", `/orders/${o.id}/cancel`);
  });
  it("two reports disagreeing on a payment's amount raise an alert", async () => {
    const o = await order(carl, "scarf");
    const a = (await pay(carl, o.id)).json();
    const s = (await simulate(carl, a.paymentId, "success")).json();
    expect((await verify(carl, s)).json().outcome).toBe("captured");
    const r = await event("evt_disagree_1", { id: s.providerPaymentId, order_id: a.providerOrderId, amount: a.amountPaise + 1, currency: "INR" });
    expect(r.json().outcome).toBe("discrepancy");
    expect((await t.pool.query(`select count(*)::int n from outbox_events where type = 'payment.discrepancy' and aggregate_id = $1`, [a.paymentId])).rows[0].n).toBe(1);
  });
  it("captures with missing data are refused for retry; a foreign currency is kept for refund", async () => {
    const before = (await t.pool.query(`select count(*)::int n from payment_events`)).rows[0].n;
    expect((await event("evt_noamount_1", { id: "pay_mock_x00000001", order_id: "order_mock_x" })).statusCode).toBe(400);
    expect((await t.pool.query(`select count(*)::int n from payment_events`)).rows[0].n).toBe(before);
    const o = await order(dave, "scarf");
    const a = (await pay(dave, o.id)).json();
    const r = await event("evt_usd_1", { id: "pay_mock_usd000001", order_id: a.providerOrderId, amount: a.amountPaise, currency: "USD" });
    expect(r.json().outcome).toBe("needs_refund");
    expect((await t.pool.query(`select refund_reason from payments where id = $1`, [a.paymentId])).rows[0].refund_reason).toMatch(/USD/);
    await call(dave, "POST", `/orders/${o.id}/cancel`);
  });
  it("if the order cannot take the payment, the money is kept for refund instead of being lost", async () => {
    const o = await order(dave, "scarf");
    const a = (await pay(dave, o.id)).json();
    await t.pool.query(`update stock_reservations set status = 'released', closed_at = now() where reference_id = $1`, [o.id]);
    const r = (await simulate(dave, a.paymentId, "success", { sendWebhook: true })).json();
    expect(r.webhook.outcome).toBe("needs_refund");
    expect(await orderRow(o.id)).toEqual({ status: "pending_payment", payment_status: "unpaid" });
    expect((await t.pool.query(`select status, refund_reason from payments where id = $1`, [a.paymentId])).rows[0]).toMatchObject({ status: "needs_refund", refund_reason: expect.stringMatching(/stock hold/) });
    expect(await ledgerKinds(a.paymentId)).toEqual(["unapplied_payment"]);
    expect(await ledgerKinds(o.id)).toEqual([]);
  });
  it("mock payments must be switched on explicitly, with a secret outside tests", () => {
    const dev = { NODE_ENV: "development", DATABASE_URL: "postgres://x", JWT_SECRET: "a-real-looking-secret-value-0123456789abcdef", DATA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64") };
    expect(loadConfig(dev as any).PAYMENT_PROVIDER).toBe("none");
    expect(() => loadConfig({ ...dev, PAYMENT_PROVIDER: "mock" } as any)).toThrow(/MOCK_PAYMENT_SECRET/);
    expect(loadConfig({ ...dev, PAYMENT_PROVIDER: "mock", MOCK_PAYMENT_SECRET: "x".repeat(40) } as any).PAYMENT_PROVIDER).toBe("mock");
  });
});
