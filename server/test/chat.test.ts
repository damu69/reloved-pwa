import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let alice: U, bob: U, carl: U;
let dress: string, hidden: string, bobsItem: string;
let ip = 0;
const nextIp = () => `10.95.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

const reg = async (email: string, fullName: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: "correct horse battery", fullName } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as any, url: `/api/v1/chat${url}`, remoteAddress: nextIp(), headers: u ? { authorization: `Bearer ${u.at}` } : {}, ...(payload !== undefined ? { payload: payload as any } : {}) });

beforeAll(async () => {
  t = await setup();
  alice = await reg("alice@example.com", "Alice Seller");
  bob = await reg("bob@example.com", "Bob Buyer");
  carl = await reg("carl@example.com", "Carl Other");
  const sellerId = (await t.pool.query(
    `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
     values ($1, 'approved', 'Alice Attic', 'Alice Attic', 'individual', 'v1:x', '1234', 'Street', 'Nanded', 'MH', '431601', '9876543210') returning id`, [alice.id])).rows[0].id;
  const cat = (await t.pool.query(`insert into categories (slug, name, path, depth) values ('tops','Tops','tops',0) returning id`)).rows[0].id;
  const mk = async (title: string, status: string, seller = sellerId) =>
    (await t.pool.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1, $2, $3, $4, 'good', 500) returning id`, [seller, status, title, cat])).rows[0].id as string;
  dress = await mk("Linen dress", "active");
  hidden = await mk("Draft dress", "draft");
  const bobSeller = (await t.pool.query(
    `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
     values ($1, 'approved', 'Bob Boutique', 'Bob Boutique', 'individual', 'v1:x', '1234', 'Street', 'Nanded', 'MH', '431601', '9876543210') returning id`, [bob.id])).rows[0].id;
  bobsItem = await mk("Bob's scarf", "active", bobSeller);
});
afterAll(async () => { await t.close(); });

describe("starting a conversation", () => {
  it("needs sign-in", async () => {
    expect((await call(null, "GET", "/conversations")).statusCode).toBe(401);
    expect((await call(null, "POST", "/conversations", { productId: dress })).statusCode).toBe(401);
  });

  it("opens one conversation per buyer and item, with an optional first message", async () => {
    const a = await call(bob, "POST", "/conversations", { productId: dress, message: "  Is this still available?  " });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ created: true, role: "buyer", otherName: "Alice Attic", productTitle: "Linen dress", lastMessagePreview: "Is this still available?", unread: 0 });
    const b = await call(bob, "POST", "/conversations", { productId: dress });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ id: a.json().id, created: false });
    expect((await t.pool.query(`select count(*)::int n from conversations`)).rows[0].n).toBe(1);
  });

  it("refuses your own item, items that are not live, and unknown items", async () => {
    const own = await call(alice, "POST", "/conversations", { productId: dress });
    expect(own.statusCode).toBe(409);
    expect(own.json().error.code).toBe("OWN_PRODUCT");
    expect((await call(bob, "POST", "/conversations", { productId: hidden })).statusCode).toBe(404);
    expect((await call(bob, "POST", "/conversations", { productId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
  });

  it("rejects bad input with field errors", async () => {
    const r = await call(bob, "POST", "/conversations", { productId: "nope", extra: 1 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("VALIDATION_FAILED");
    const long = await call(carl, "POST", "/conversations", { productId: dress, message: "x".repeat(1001) });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.details[0].path).toBe("message");
  });
});

describe("messages", () => {
  let convo: string;
  it("shows the buyer's message to the seller as unread, and clears it when opened", async () => {
    convo = (await call(bob, "GET", "/conversations")).json().items[0].id;
    const aliceList = (await call(alice, "GET", "/conversations")).json().items;
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0]).toMatchObject({ role: "seller", otherName: "Bob", unread: 1, productTitle: "Linen dress" });
    expect((await call(alice, "GET", "/unread")).json()).toEqual({ messages: 1, conversations: 1 });

    const opened = await call(alice, "GET", `/conversations/${convo}/messages`);
    expect(opened.json().items.map((m: any) => [m.mine, m.body])).toEqual([[false, "Is this still available?"]]);
    expect((await call(alice, "GET", "/unread")).json()).toEqual({ messages: 0, conversations: 0 });
  });

  it("delivers replies in order and returns only newer messages when polling", async () => {
    const r1 = await call(alice, "POST", `/conversations/${convo}/messages`, { body: "Yes, it is!" });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().mine).toBe(true);
    const r2 = await call(bob, "POST", `/conversations/${convo}/messages`, { body: "Great,\r\ncan you do 800?" });
    expect(r2.json().body).toBe("Great,\ncan you do 800?");
    const all = (await call(bob, "GET", `/conversations/${convo}/messages`)).json().items;
    expect(all.map((m: any) => m.body)).toEqual(["Is this still available?", "Yes, it is!", "Great,\ncan you do 800?"]);
    const newer = (await call(bob, "GET", `/conversations/${convo}/messages?after=${all[1].id}`)).json().items;
    expect(newer.map((m: any) => m.body)).toEqual(["Great,\ncan you do 800?"]);
    expect((await call(bob, "GET", `/conversations/${convo}/messages?after=${all[2].id}`)).json().items).toEqual([]);
  });

  it("updates the list preview and unread counts per side", async () => {
    const aliceList = (await call(alice, "GET", "/conversations")).json().items[0];
    expect(aliceList.lastMessagePreview).toBe("Great, can you do 800?");
    expect(aliceList.unread).toBe(1);
    expect((await call(bob, "GET", "/conversations")).json().items[0].unread).toBe(0);
  });

  it("keeps outsiders out", async () => {
    expect((await call(carl, "GET", `/conversations/${convo}/messages`)).statusCode).toBe(404);
    expect((await call(carl, "POST", `/conversations/${convo}/messages`, { body: "hi" })).statusCode).toBe(404);
    expect((await call(carl, "GET", "/conversations")).json().items).toEqual([]);
  });

  it("validates message text", async () => {
    for (const body of ["", "   ", "x".repeat(1001), "bad\u0000byte", 5, undefined]) {
      expect((await call(bob, "POST", `/conversations/${convo}/messages`, { body })).statusCode).toBe(400);
    }
    expect((await call(bob, "POST", `/conversations/not-a-uuid/messages`, { body: "hi" })).statusCode).toBe(400);
  });

  it("works both ways: a seller can also be a buyer in other conversations", async () => {
    const r = await call(alice, "POST", "/conversations", { productId: bobsItem, message: "Love this scarf" });
    expect(r.statusCode).toBe(201);
    const list = (await call(alice, "GET", "/conversations")).json().items;
    expect(list.map((c: any) => c.role).sort()).toEqual(["buyer", "seller"]);
    expect((await call(bob, "GET", "/unread")).json().conversations).toBe(1);
  });
});
