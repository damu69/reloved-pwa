import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, CSRF } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let alice: U, bob: U, carl: U, admin: U;
let dress: string, bobsItem: string, aliceSeller: string, cat: string;
let ip = 0;
const nextIp = () => `10.96.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;
const PW = "correct horse battery";

const reg = async (email: string, fullName: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: PW, fullName } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, remoteAddress: nextIp(), headers: u ? { authorization: `Bearer ${u.at}` } : {}, ...(payload !== undefined ? { payload: payload as any } : {}) });
const seller = async (u: U, name: string) =>
  (await t.pool.query(
    `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
     values ($1, 'approved', $2::text, $2::text, 'individual', 'v1:x', '1234', 'Street', 'Nanded', 'MH', '431601', '9876543210') returning id`, [u.id, name])).rows[0].id;
const product = async (title: string, sellerId: string) =>
  (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, 'active', $2, $3, 'good', 500) returning id`, [sellerId, title, cat])).rows[0].id;

beforeAll(async () => {
  t = await setup();
  alice = await reg("alice@example.com", "Alice Seller");
  bob = await reg("bob@example.com", "Bob Buyer");
  carl = await reg("carl@example.com", "Carl Other");
  admin = await reg("admin@example.com", "Admin");
  await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [admin.id]);
  cat = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('tops','Tops','tops',0) returning id`)).rows[0].id;
  aliceSeller = await seller(alice, "Alice Attic");
  dress = await product("Linen dress", aliceSeller);
  bobsItem = await product("Bob's scarf", await seller(bob, "Bob Boutique"));
});
afterAll(async () => { await t.close(); });

describe("reports", () => {
  it("needs sign-in and a known reason and target", async () => {
    expect((await call(null, "POST", "/safety/reports", { targetType: "product", targetId: dress, reason: "spam" })).statusCode).toBe(401);
    expect((await call(bob, "POST", "/safety/reports", { targetType: "product", targetId: dress, reason: "rude" })).statusCode).toBe(400);
    expect((await call(bob, "POST", "/safety/reports", { targetType: "product", targetId: "00000000-0000-4000-8000-000000000000", reason: "spam" })).statusCode).toBe(404);
    expect((await call(bob, "POST", "/safety/reports", { targetType: "user", targetId: bob.id, reason: "spam" })).statusCode).toBe(409);
  });

  it("files a report once while it is open", async () => {
    const a = await call(bob, "POST", "/safety/reports", { targetType: "product", targetId: dress, reason: "counterfeit", details: "Fake label" });
    expect(a.statusCode).toBe(201);
    await call(bob, "POST", "/safety/reports", { targetType: "product", targetId: dress, reason: "counterfeit" });
    expect((await t.pool.query(`select count(*)::int n from reports where target_id = $1`, [dress])).rows[0].n).toBe(1);
  });

  it("is visible only to admins, who can remove the listing", async () => {
    expect((await call(bob, "GET", "/admin/reports")).statusCode).toBe(403);
    const list = await call(admin, "GET", "/admin/reports");
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).toMatchObject({ targetType: "product", reason: "counterfeit", targetLabel: "Linen dress", reporterName: "Bob Buyer" });
    const id = list.json().items[0].id;
    expect((await call(admin, "POST", `/admin/reports/${id}/resolve`, { action: "remove", note: "Confirmed" })).statusCode).toBe(204);
    expect((await t.pool.query(`select status from products where id = $1`, [dress])).rows[0].status).toBe("archived");
    expect((await t.pool.query(`select status from reports where id = $1`, [id])).rows[0].status).toBe("actioned");
    expect((await call(admin, "POST", `/admin/reports/${id}/resolve`, { action: "dismiss" })).statusCode).toBe(404);
  });

  it("can suspend the reported user", async () => {
    await call(carl, "POST", "/safety/reports", { targetType: "user", targetId: bob.id, reason: "abusive" });
    const id = (await call(admin, "GET", "/admin/reports")).json().items[0].id;
    expect((await call(admin, "POST", `/admin/reports/${id}/resolve`, { action: "suspend" })).statusCode).toBe(204);
    expect((await t.pool.query(`select status from users where id = $1`, [bob.id])).rows[0].status).toBe("suspended");
    await t.pool.query(`update users set status = 'active' where id = $1`, [bob.id]);
    bob = await relogin("bob@example.com");
  });
});

const relogin = async (email: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: nextIp(), headers: CSRF, payload: { email, password: PW } });
  return { id: r.json().user.id, at: r.json().accessToken };
};

describe("blocks", () => {
  it("stop chats in both directions", async () => {
    const own = await call(carl, "POST", "/safety/blocks", { userId: carl.id });
    expect(own.statusCode).toBe(409);
    const item = await product("Carl's shawl", await seller(carl, "Carl Corner"));
    const conv = await call(bob, "POST", "/chat/conversations", { productId: item, message: "Hello" });
    expect(conv.statusCode).toBe(201);
    expect((await call(carl, "POST", "/safety/blocks", { userId: bob.id })).statusCode).toBe(204);
    expect((await call(carl, "GET", "/safety/blocks")).json().items.map((x: any) => x.name)).toEqual(["Bob Buyer"]);
    const send = await call(bob, "POST", `/chat/conversations/${conv.json().id}/messages`, { body: "Still there?" });
    expect(send.statusCode).toBe(409);
    expect(send.json().error.code).toBe("USER_BLOCKED");
    const reply = await call(carl, "POST", `/chat/conversations/${conv.json().id}/messages`, { body: "Hi" });
    expect(reply.statusCode).toBe(409);
    const otherItem = await product("Carl's stole", (await t.pool.query(`select id from sellers where user_id = $1`, [carl.id])).rows[0].id);
    expect((await call(bob, "POST", "/chat/conversations", { productId: otherItem })).json().error.code).toBe("USER_BLOCKED");
  });

  it("can be lifted", async () => {
    expect((await call(carl, "DELETE", `/safety/blocks/${bob.id}`)).statusCode).toBe(204);
    expect((await call(carl, "GET", "/safety/blocks")).json().items).toEqual([]);
  });
});

describe("deleting an account", () => {
  it("needs the right password", async () => {
    expect((await call(carl, "POST", "/me/delete", { password: "wrong wrong wrong" })).statusCode).toBe(401);
    expect((await call(null, "POST", "/me/delete", { password: PW })).statusCode).toBe(401);
  });

  it("is refused while an order is in progress", async () => {
    await t.pool.query(
      `insert into orders (number, user_id, status, payment_status, items_subtotal_paise, discount_paise, items_net_paise, delivery_paise, buyer_fee_paise, total_paise,
                           gst_included_paise, buyer_fee_fixed_paise, buyer_fee_bp, shipping_address, idempotency_key, request_hash, expires_at)
       values ('RL9000001', $1, 'shipped', 'paid', 100, 0, 100, 0, 0, 100, 0, 0, 0, '{}', 'idem-key-0001', 'h', now() + interval '1 day')`, [carl.id]);
    const r = await call(carl, "POST", "/me/delete", { password: PW });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("OPEN_ORDERS");
    await t.pool.query(`delete from orders where number = 'RL9000001'`);
  });

  it("anonymises the user, hides their listings and ends their sessions", async () => {
    const del = await call(alice, "POST", "/me/delete", { password: PW });
    expect(del.statusCode).toBe(204);
    const u = (await t.pool.query(`select email, full_name, status, deleted_at, phone from users where id = $1`, [alice.id])).rows[0];
    expect(u.email).toMatch(/^deleted\+.*@deleted\.reloved\.invalid$/);
    expect(u).toMatchObject({ full_name: "Deleted user", status: "deleted", phone: null });
    expect(u.deleted_at).not.toBeNull();
    expect((await t.pool.query(`select status from products where seller_id = $1 and status <> 'archived'`, [aliceSeller])).rowCount).toBe(0);
    expect((await call(alice, "GET", "/me")).statusCode).toBe(401);
    const login = await t.app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: nextIp(), headers: CSRF, payload: { email: "alice@example.com", password: PW } });
    expect(login.statusCode).toBe(401);
  });

  it("lets the same email register again", async () => {
    const again = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email: "alice@example.com", password: PW, fullName: "Alice Again" } });
    expect(again.statusCode).toBe(201);
  });
});
