import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";
import { withTx } from "../src/lib/db.js";
import * as orders from "../src/modules/orders/service.js";
import { releaseHeldFunds } from "../src/modules/finance/service.js";
import { post, sellerBalances } from "../src/modules/finance/ledger.js";
import { commissionOn, pickRule, type RuleCandidate } from "../src/modules/finance/commission.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let admin: U, alice: U, bob: U, carl: U, dave: U, erin: U;
let aliceSeller: string, bobSeller: string, adminSeller: string, women: string, tops: string;
const V: Record<string, string> = {};
const P: Record<string, string> = {};
let ip = 0;
const nextIp = () => `10.91.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;
let keyN = 0;
const newKey = () => `fin-${Date.now()}-${++keyN}`;

const reg = async (email: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: "correct horse battery", fullName: email } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, remoteAddress: nextIp(), headers: { ...(u ? { authorization: `Bearer ${u.at}` } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as any } : {}) });
const add = (u: U, key: string, quantity: number) => call(u, "PUT", `/cart/items/${V[key]}`, { quantity });
const total = async (u: U) => (await call(u, "GET", "/cart")).json().totals.totalPaise as number;
const mkAddress = async (u: U) => (await call(u, "POST", "/me/addresses", { name: "Buyer B", phone: "9876543210", line1: "4 MG Road", city: "Pune", state: "MH", pincode: "411001" })).json().id as string;
const buy = async (u: U, items: Record<string, number>) => {
  for (const [k, q] of Object.entries(items)) expect((await add(u, k, q)).statusCode).toBeLessThan(300);
  const addr = (await call(u, "GET", "/me/addresses")).json().items[0]?.id ?? await mkAddress(u);
  const r = await call(u, "POST", "/checkout", { addressId: addr, expectedTotalPaise: await total(u) }, { "idempotency-key": newKey() });
  expect(r.statusCode).toBe(201);
  return r.json();
};
const confirm = (orderId: string) => withTx(t.pool, (tx) => orders.confirmPayment(tx, orderId));
const itemsOf = async (orderId: string) => (await t.pool.query(
  `select v.sku, i.subtotal_paise::int sub, i.commission_rate_bp rate, i.commission_paise::int comm, i.seller_earning_paise::int earn
     from order_items i join product_variants v on v.id = i.variant_id where i.order_id = $1 order by v.sku`, [orderId])).rows;
const txOf = async (referenceId: string) => (await call(admin, "GET", `/admin/finance/transactions?referenceId=${referenceId}`)).json().items;

beforeAll(async () => {
  t = await setup();
  admin = await reg("admin@example.com"); alice = await reg("alice@example.com"); bob = await reg("bob@example.com");
  carl = await reg("carl@example.com"); dave = await reg("dave@example.com"); erin = await reg("erin@example.com");
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
  adminSeller = await mkSeller(admin, "Admin Shop");
  const wh = new Map<string, string>();
  for (const s of [aliceSeller, bobSeller, adminSeller]) wh.set(s, (await t.pool.query(`insert into warehouses (seller_id, name, pincode, is_default) values ($1, 'Main', '431601', true) returning id`, [s])).rows[0].id);
  women = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('women','Women','women',0) returning id`)).rows[0].id;
  tops = (await t.pool.query(`insert into categories (slug, name, path, depth, parent_id) values ('tops','Tops','women/tops',1,$1) returning id`, [women])).rows[0].id;
  const mk = async (key: string, seller: string, cat: string, pricePaise: number, stock: number) => {
    P[key] = (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, 'active', $2, $3, 'good', 500) returning id`, [seller, `Item ${key}`, cat])).rows[0].id;
    V[key] = (await t.pool.query(`insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) values ($1, $2, $3, $4, $4) returning id`, [P[key], seller, `SKU-${key}`, pricePaise])).rows[0].id;
    await t.pool.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1, $2, $3)`, [V[key], wh.get(seller), stock]);
  };
  await mk("dress", aliceSeller, tops, 100000, 50);   // ₹1000, Women > Tops
  await mk("scarf", aliceSeller, women, 30000, 50);   // ₹300, Women
  await mk("boots", bobSeller, women, 200000, 50);    // ₹2000, Women
  await mk("odd", bobSeller, women, 1990, 50);        // ₹19.90, for rounding
  await mk("mine", adminSeller, women, 50000, 5);
});
afterAll(async () => { await t.close(); });

describe("commission rules (pure)", () => {
  const rules: RuleCandidate[] = [
    { id: "d", scope: "default", rateBp: 500, productId: null, sellerId: null, categoryPath: null },
    { id: "cw", scope: "category", rateBp: 600, productId: null, sellerId: null, categoryPath: "women" },
    { id: "ct", scope: "category", rateBp: 800, productId: null, sellerId: null, categoryPath: "women/tops" },
    { id: "s", scope: "seller", rateBp: 300, productId: null, sellerId: "S1", categoryPath: null },
    { id: "p", scope: "product", rateBp: 1000, productId: "P1", sellerId: null, categoryPath: null },
  ];
  it("most specific wins: product > seller > deepest category > default", () => {
    expect(pickRule(rules, { productId: "P1", sellerId: "S1", categoryPath: "women/tops" })!.ruleId).toBe("p");
    expect(pickRule(rules, { productId: "P2", sellerId: "S1", categoryPath: "women/tops" })!.ruleId).toBe("s");
    expect(pickRule(rules, { productId: "P2", sellerId: "S2", categoryPath: "women/tops/silk" })!.ruleId).toBe("ct");
    expect(pickRule(rules, { productId: "P2", sellerId: "S2", categoryPath: "women" })!.ruleId).toBe("cw");
    // "women-sale" is not inside "women".
    expect(pickRule(rules, { productId: "P2", sellerId: "S2", categoryPath: "women-sale" })!.ruleId).toBe("d");
    expect(pickRule([], { productId: "P2", sellerId: "S2", categoryPath: "x" })).toBeNull();
  });
  it("rounds half up in paise", () => {
    expect(commissionOn(1990, 500)).toBe(100);  // 99.5 → 100
    expect(commissionOn(1970, 500)).toBe(99);   // 98.5 → 99
    expect(commissionOn(1960, 500)).toBe(98);
    expect(commissionOn(0, 500)).toBe(0);
  });
});

describe("default commission, frozen at checkout and booked at payment", () => {
  let order: any;
  it("checkout freezes 5% on the full item price and the seller's earning includes delivery", async () => {
    order = await buy(carl, { dress: 2, boots: 1, odd: 1 });
    expect(await itemsOf(order.id)).toEqual([
      { sku: "SKU-boots", sub: 200000, rate: 500, comm: 10000, earn: 190000 },
      { sku: "SKU-dress", sub: 200000, rate: 500, comm: 10000, earn: 190000 },
      { sku: "SKU-odd", sub: 1990, rate: 500, comm: 100, earn: 1890 },
    ]);
    const so = (await t.pool.query(`select seller_id, commission_paise::int c, seller_earning_paise::int e, delivery_paise::int d from seller_orders where order_id = $1`, [order.id])).rows;
    const a = so.find((x) => x.seller_id === aliceSeller), b = so.find((x) => x.seller_id === bobSeller);
    expect(a).toMatchObject({ c: 10000, e: 190000 + a.d });
    expect(b).toMatchObject({ c: 10100, e: 201990 - 10100 + b.d });
    // Nothing is booked before payment.
    expect(await txOf(order.id)).toEqual([]);
    // The customer never sees commission; the seller sees their own.
    const mine = (await call(carl, "GET", `/orders/${order.id}`)).json();
    expect(mine.packages[0].earnings).toBeUndefined();
    expect(mine.packages[0].items[0].commissionPaise).toBeUndefined();
    const pkg = (await call(bob, "GET", "/seller/orders")).json().items[0];
    const view = (await call(bob, "GET", `/seller/orders/${pkg.id}`)).json();
    expect(view.packages[0].earnings).toMatchObject({ commissionPaise: 10100, sellerEarningPaise: b.e, availableAt: null });
  });
  it("payment books one balanced ledger transaction; repeating it books nothing more", async () => {
    await confirm(order.id);
    await confirm(order.id);
    const txs = await txOf(order.id);
    expect(txs).toHaveLength(1);
    const lines = txs[0].lines as { account: string; direction: string; amountPaise: number }[];
    const amt = (account: string, direction: string) => lines.filter((l) => l.account === account && l.direction === direction).reduce((a, l) => a + l.amountPaise, 0);
    const o = (await t.pool.query(`select total_paise::int total, buyer_fee_paise::int fee from orders where id = $1`, [order.id])).rows[0];
    const so = (await t.pool.query(`select seller_id, seller_earning_paise::int e from seller_orders where order_id = $1`, [order.id])).rows;
    expect(amt("platform:payments_receivable", "debit")).toBe(o.total);
    expect(amt("platform:commission_revenue", "credit")).toBe(20100);
    expect(amt("platform:buyer_fee_revenue", "credit")).toBe(o.fee);
    for (const s of so) expect(amt(`seller:${s.seller_id}:pending`, "credit")).toBe(s.e);
    expect(lines.some((l) => l.account === "platform:coupon_expense")).toBe(false); // no coupon, no zero line
    const tb = (await call(admin, "GET", "/admin/finance/trial-balance")).json();
    expect(tb.totals.balanced).toBe(true);
  });
  it("earnings are on hold for 14 days from payment", async () => {
    const r = (await t.pool.query(`select extract(epoch from (so.funds_available_at - o.paid_at))::int s from seller_orders so join orders o on o.id = so.order_id where o.id = $1`, [order.id])).rows;
    for (const x of r) expect(Math.abs(x.s - 14 * 86400)).toBeLessThan(5);
    const bal = (await call(bob, "GET", "/seller/finance/balance")).json();
    const e = (await t.pool.query(`select seller_earning_paise::int e from seller_orders where order_id = $1 and seller_id = $2`, [order.id, bobSeller])).rows[0].e;
    expect(bal).toMatchObject({ currency: "INR", pendingPaise: e, availablePaise: 0, paidOutPaise: 0, holdDaysFromPayment: 14 });
    expect(await releaseHeldFunds(t.pool)).toBe(0); // not due yet
    const earn = (await call(bob, "GET", "/seller/finance/earnings")).json().items;
    expect(earn).toHaveLength(1);
    expect(earn[0]).toMatchObject({ commissionPaise: 10100, sellerEarningPaise: e, state: "on_hold" });
    // Sellers only see their own money; customers are not sellers.
    expect((await call(alice, "GET", "/seller/finance/earnings")).json().items.every((x: any) => x.id !== earn[0].id)).toBe(true);
    expect((await call(carl, "GET", "/seller/finance/balance")).json().error.code).toBe("NOT_A_SELLER");
    expect((await call(bob, "GET", `/admin/finance/sellers/${bobSeller}/balance`)).statusCode).toBe(403);
    expect((await call(admin, "GET", `/admin/finance/sellers/${bobSeller}/balance`)).json().pendingPaise).toBe(e);
  });
});

describe("commission rules (admin)", () => {
  let topsRule: string;
  it("creates category, seller and product rules; the preview shows which applies", async () => {
    const mk = (b: any) => call(admin, "POST", "/admin/commission/rules", b);
    const r1 = await mk({ scope: "category", targetId: tops, rateBp: 800, note: "Tops launch rate" });
    expect(r1.statusCode).toBe(201);
    topsRule = r1.json().id;
    expect((await mk({ scope: "category", targetId: women, rateBp: 600 })).statusCode).toBe(201);
    expect((await mk({ scope: "seller", targetId: bobSeller, rateBp: 300 })).statusCode).toBe(201);
    expect((await mk({ scope: "product", targetId: P.scarf, rateBp: 1000 })).statusCode).toBe(201);
    const pv = async (k: string) => (await call(admin, "GET", `/admin/commission/preview?productId=${P[k]}`)).json();
    expect(await pv("dress")).toMatchObject({ scope: "category", rateBp: 800 });
    expect(await pv("scarf")).toMatchObject({ scope: "product", rateBp: 1000 });
    expect(await pv("boots")).toMatchObject({ scope: "seller", rateBp: 300 });
    const audit = await t.pool.query(`select count(*)::int n from audit_logs where action = 'commission.rule_create'`);
    expect(audit.rows[0].n).toBe(4);
  });
  it("refuses overlaps, unknown targets, past starts, bad rates, non-admins and an admin's own shop", async () => {
    const mk = (b: any, u = admin) => call(u, "POST", "/admin/commission/rules", b);
    expect((await mk({ scope: "category", targetId: tops, rateBp: 700 })).json().error.code).toBe("RULE_OVERLAP");
    expect((await mk({ scope: "seller", targetId: women, rateBp: 700 })).statusCode).toBe(400);
    expect((await mk({ scope: "seller", targetId: aliceSeller, rateBp: 700, startsAt: "2020-01-01T00:00:00Z" })).statusCode).toBe(400);
    expect((await mk({ scope: "seller", targetId: aliceSeller, rateBp: 5001 })).statusCode).toBe(400);
    expect((await mk({ scope: "seller", targetId: aliceSeller, rateBp: 100 }, alice)).statusCode).toBe(403);
    expect((await mk({ scope: "seller", targetId: adminSeller, rateBp: 0 })).statusCode).toBe(403);
    expect((await mk({ scope: "product", targetId: P.mine, rateBp: 0 })).statusCode).toBe(403);
    expect((await mk({ scope: "default", targetId: women, rateBp: 100 })).statusCode).toBe(400);
  });
  it("a later scheduled rule is allowed and not applied early", async () => {
    const at = new Date(Date.now() + 3 * 86400_000).toISOString();
    const r = await call(admin, "POST", "/admin/commission/rules", { scope: "seller", targetId: aliceSeller, rateBp: 200, startsAt: at });
    expect(r.json().state).toBe("scheduled");
    expect((await call(admin, "GET", `/admin/commission/preview?productId=${P.dress}`)).json().rateBp).toBe(800);
    expect((await call(admin, "GET", `/admin/commission/preview?productId=${P.dress}&at=${encodeURIComponent(new Date(Date.now() + 4 * 86400_000).toISOString())}`)).json()).toMatchObject({ scope: "seller", rateBp: 200 });
    // Called off before it starts.
    const off = await call(admin, "POST", `/admin/commission/rules/${r.json().id}/end`, { reason: "Deal cancelled" });
    expect(off.statusCode).toBe(200);
    expect((await call(admin, "GET", `/admin/commission/preview?productId=${P.dress}&at=${encodeURIComponent(new Date(Date.now() + 4 * 86400_000).toISOString())}`)).json().rateBp).toBe(800);
  });
  it("orders keep the rate they were placed with when rules change", async () => {
    const o = await buy(dave, { dress: 1, scarf: 1, boots: 1 });
    const before = await itemsOf(o.id);
    expect(before.map((x: any) => [x.sku, x.rate, x.comm])).toEqual([["SKU-boots", 300, 6000], ["SKU-dress", 800, 8000], ["SKU-scarf", 1000, 3000]]);
    const end = await call(admin, "POST", `/admin/commission/rules/${topsRule}/end`, { reason: "Launch period over" });
    expect(end.json().state).toBe("ended");
    expect((await call(admin, "POST", `/admin/commission/rules/${topsRule}/end`, { reason: "again" })).statusCode).toBe(422);
    expect((await call(admin, "GET", `/admin/commission/preview?productId=${P.dress}`)).json()).toMatchObject({ scope: "category", rateBp: 600 });
    await confirm(o.id);
    expect(await itemsOf(o.id)).toEqual(before);
  });
  it("the default rate is replaced, never left empty", async () => {
    const def = (await call(admin, "GET", "/admin/commission/rules?scope=default&state=active")).json().items[0];
    expect(def.rateBp).toBe(500);
    expect((await call(admin, "POST", `/admin/commission/rules/${def.id}/end`, { reason: "x x x" })).statusCode).toBe(422);
    const r = await call(admin, "PUT", "/admin/commission/default", { rateBp: 700, reason: "New pricing" });
    expect(r.json()).toMatchObject({ scope: "default", rateBp: 700, state: "active" });
    // Erin buys something with no specific rule? Every product here has one, so check through the preview of a new category.
    const misc = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('misc','Misc','misc',0) returning id`)).rows[0].id;
    await t.pool.query(`update products set category_id = $1 where id = $2`, [misc, P.mine]);
    expect((await call(admin, "GET", `/admin/commission/preview?productId=${P.mine}`)).json()).toMatchObject({ scope: "default", rateBp: 700 });
    const all = (await call(admin, "GET", "/admin/commission/rules?scope=default")).json().items;
    expect(all.map((x: any) => x.state).sort()).toEqual(["active", "ended"]);
    expect((await call(admin, "PUT", "/admin/commission/default", { rateBp: 500, reason: "Back to launch rate" })).statusCode).toBe(200);
  });
});

describe("coupons and the hold release", () => {
  it("a coupon is a platform cost: sellers still earn on the full price", async () => {
    await call(admin, "POST", "/admin/coupons", { code: "FINANCE100", discountType: "fixed", amountPaise: 10000, perUserLimit: 1 });
    await add(erin, "boots", 1);
    expect((await call(erin, "POST", "/cart/coupon", { code: "FINANCE100" })).statusCode).toBe(200);
    const o = await buy(erin, {});
    expect(o.totals.discountPaise).toBe(10000);
    await confirm(o.id);
    const lines = (await txOf(o.id))[0].lines;
    expect(lines.find((l: any) => l.account === "platform:coupon_expense")).toMatchObject({ direction: "debit", amountPaise: 10000 });
    const so = (await t.pool.query(`select seller_earning_paise::int e, delivery_paise::int d from seller_orders where order_id = $1`, [o.id])).rows[0];
    expect(so.e).toBe(200000 - 6000 + so.d); // Bob's 3% on ₹2000, coupon ignored
  });
  it("with a 0-day hold the sweep makes earnings available, exactly once even when run twice at once", async () => {
    expect((await call(admin, "PATCH", "/admin/finance/settings", { payoutHoldDays: 0 })).statusCode).toBe(400); // reason required
    expect((await call(admin, "PATCH", "/admin/finance/settings", { payoutHoldDays: 0, reason: "Testing payouts" })).json().payoutHoldDays).toBe(0);
    const before = (await call(alice, "GET", "/seller/finance/balance")).json();
    const o = await buy(carl, { scarf: 2 });
    await confirm(o.id);
    const e = (await t.pool.query(`select seller_earning_paise::int e from seller_orders where order_id = $1`, [o.id])).rows[0].e;
    const [a, b] = await Promise.all([releaseHeldFunds(t.pool), releaseHeldFunds(t.pool)]);
    expect(a + b).toBe(1);
    const after = (await call(alice, "GET", "/seller/finance/balance")).json();
    expect(after.availablePaise - before.availablePaise).toBe(e);
    expect(after.pendingPaise).toBe(before.pendingPaise);
    const so = (await t.pool.query(`select id from seller_orders where order_id = $1`, [o.id])).rows[0].id;
    expect((await txOf(so)).map((x: any) => x.kind)).toEqual(["hold_release"]);
    expect((await call(alice, "GET", "/seller/finance/earnings?state=available")).json().items.map((x: any) => x.id)).toContain(so);
    // Earlier orders keep their 14-day date.
    expect(await releaseHeldFunds(t.pool)).toBe(0);
    await call(admin, "PATCH", "/admin/finance/settings", { payoutHoldDays: 14, reason: "Back to 14 days" });
    const tb = (await call(admin, "GET", "/admin/finance/trial-balance")).json();
    expect(tb.totals.balanced).toBe(true);
  });
});

describe("the database protects the money", () => {
  it("ledger lines cannot be edited or deleted, and an unbalanced transaction cannot be committed", async () => {
    await expect(t.pool.query(`update ledger_entries set amount_paise = 1`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`delete from ledger_transactions`)).rejects.toThrow(/append-only/);
    const acct = (await t.pool.query(`select id from ledger_accounts where code = 'platform:commission_revenue'`)).rows[0].id;
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      const tx = (await c.query(`insert into ledger_transactions (kind, reference_type, reference_id, memo) values ('order_payment', 'order', gen_random_uuid(), 'bad') returning id`)).rows[0].id;
      await c.query(`insert into ledger_entries (transaction_id, account_id, direction, amount_paise) values ($1, $2, 'credit', 100)`, [tx, acct]);
      await expect(c.query("commit")).rejects.toThrow(/not balanced/);
    } finally { c.release(); }
  });
  it("commission rules, frozen commission and payout dates cannot be rewritten", async () => {
    await expect(t.pool.query(`update commission_rules set rate_bp = 1`)).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`delete from commission_rules`)).rejects.toThrow(/cannot be deleted/);
    await expect(t.pool.query(`update commission_rules set ends_at = '2020-01-01' where ends_at is null and scope = 'seller'`)).rejects.toThrow(/from now on/);
    await expect(t.pool.query(`update seller_orders set commission_paise = 0`)).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`update seller_orders set funds_available_at = now() where funds_available_at is not null`)).rejects.toThrow(/cannot be changed/);
    await expect(t.pool.query(`update order_items set commission_paise = 0`)).rejects.toThrow(/cannot be changed/);
    // A new line with the wrong commission arithmetic is refused.
    const any = (await t.pool.query(`select * from order_items limit 1`)).rows[0];
    await expect(t.pool.query(
      `insert into order_items (order_id, seller_order_id, variant_id, product_id, warehouse_id, reservation_id, title, sku, options, unit_price_paise, quantity,
                                subtotal_paise, discount_paise, net_paise, gst_rate_bp, gst_included_paise, commission_rate_bp, commission_paise, seller_earning_paise)
       values ($1, $2, $3, $4, $5, gen_random_uuid(), 't', 's', '{}', 1000, 1, 1000, 0, 1000, 0, 0, 500, 0, 1000)`,
      [any.order_id, any.seller_order_id, any.variant_id, any.product_id, any.warehouse_id])).rejects.toThrow(/order_items_commission_set/);
  });
  it("checkout stops instead of guessing when no commission rule is in force", async () => {
    await t.pool.query(`update commission_rules set ends_at = now() where scope = 'default' and ends_at is null`);
    await add(dave, "mine", 1);
    const addr = (await call(dave, "GET", "/me/addresses")).json().items[0].id;
    const r = await call(dave, "POST", "/checkout", { addressId: addr, expectedTotalPaise: await total(dave) }, { "idempotency-key": newKey() });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("COMMISSION_NOT_CONFIGURED");
    expect((await t.pool.query(`select count(*)::int n from orders where user_id = $1 and status = 'pending_payment'`, [dave.id])).rows[0].n).toBe(0);
    await t.pool.query(`insert into commission_rules (scope, rate_bp, starts_at) values ('default', 500, now())`);
  });
});

describe("review findings (regressions)", () => {
  it("packages created before commission existed can still change status, but new ones must carry commission", async () => {
    const o = await buy(erin, { odd: 1 });
    const c = await t.pool.connect();
    let legacyId = "";
    try {
      await c.query(`set session_replication_role = replica`); // simulate a row from before migration 0008
      legacyId = (await c.query(
        `insert into seller_orders (order_id, seller_id, number, status, items_subtotal_paise, discount_paise, items_net_paise, delivery_code, delivery_label, delivery_paise)
         values ($1, $2, $3, 'confirmed', 100, 0, 100, 'home', 'Home', 0) returning id`, [o.id, adminSeller, o.number + "-L"])).rows[0].id;
    } finally { await c.query(`set session_replication_role = origin`); c.release(); }
    await t.pool.query(`update seller_orders set status = 'processing' where id = $1`, [legacyId]);
    await expect(t.pool.query(
      `insert into seller_orders (order_id, seller_id, number, items_subtotal_paise, discount_paise, items_net_paise, delivery_code, delivery_label, delivery_paise)
       values ($1, $2, 'RLX-9', 100, 0, 100, 'home', 'Home', 0)`, [o.id, aliceSeller])).rejects.toThrow(/must carry its commission/);
    // Payment refuses to book an order with a package that has no commission.
    await expect(confirm(o.id)).rejects.toThrow(/no frozen commission/);
    const cc = await t.pool.connect();
    try { await cc.query(`set session_replication_role = replica`); await cc.query(`delete from seller_orders where id = $1`, [legacyId]); }
    finally { await cc.query(`set session_replication_role = origin`); cc.release(); }
    await call(erin, "POST", `/orders/${o.id}/cancel`);
  });
  it("the ledger cannot be truncated", async () => {
    await expect(t.pool.query(`truncate ledger_entries`)).rejects.toThrow();
    await expect(t.pool.query(`truncate ledger_transactions cascade`)).rejects.toThrow();
  });
  it("a seller's first two postings at the same moment both succeed", async () => {
    const u = await reg("fresh-seller@example.com");
    const sid = (await t.pool.query(
      `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
       values ($1, 'approved', 'Fresh', 'Fresh', 'individual', 'v1:x', '1234', 'Street', 'Nanded', 'MH', '431601', '9876543210') returning id`, [u.id])).rows[0].id;
    const one = () => withTx(t.pool, (tx) => post(tx, {
      kind: "hold_release", referenceType: "test", referenceId: crypto.randomUUID(), memo: "race",
      lines: [{ account: `seller:${sid}:pending`, direction: "debit", amountPaise: 5 }, { account: `seller:${sid}:available`, direction: "credit", amountPaise: 5 }],
    }));
    await Promise.all([one(), one(), one()]);
    expect(await sellerBalances(t.pool, sid)).toMatchObject({ pendingPaise: -15, availablePaise: 15 });
  });
});
