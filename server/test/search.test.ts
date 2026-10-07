import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { setup } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
let ip = 0;
const get = (url: string) => t.app.inject({ method: "GET", url: `/api/v1/catalogue${url}`, remoteAddress: `10.60.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const ids = async (url: string) => (await get(url)).json().items.map((x: any) => x.title);

let sellerA: string, sellerB: string, jackets: string, tops: string, kurtas: string, levis: string, zara: string;

async function product(o: { seller?: string; cat?: string; brand?: string | null; title: string; desc?: string; cond?: string; price: number; attrs?: object; sku?: string; status?: string; createdAt?: string }) {
  const r = await t.pool.query(
    `insert into products (seller_id, status, title, description, category_id, brand_id, condition, attributes, gst_rate_bp, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 500, coalesce($9::timestamptz, now())) returning id`,
    [o.seller ?? sellerA, o.status ?? "active", o.title, o.desc ?? "", o.cat ?? jackets, o.brand === undefined ? levis : o.brand, o.cond ?? "good", JSON.stringify(o.attrs ?? {}), o.createdAt ?? null],
  );
  const id = r.rows[0].id;
  await t.pool.query(
    `insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) values ($1, $2, $3, $4, $4)`,
    [id, o.seller ?? sellerA, o.sku ?? `SKU-${id.slice(0, 8)}`, o.price * 100],
  );
  return id as string;
}

beforeAll(async () => {
  t = await setup();
  const mkUser = async (e: string) => (await t.pool.query(`insert into users (email, password_hash, full_name) values ($1, 'x', 'X') returning id`, [e])).rows[0].id;
  const mkSeller = async (u: string, name: string) => (await t.pool.query(
    `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
     values ($1, 'approved', $2::text, $2::text, 'individual', 'v1:x', '1234', 'Street', 'Nanded', 'MH', '431601', '9876543210') returning id`, [u, name])).rows[0].id;
  sellerA = await mkSeller(await mkUser("a@x.com"), "Ganga Vintage");
  sellerB = await mkSeller(await mkUser("b@x.com"), "Bombay Closet");
  const cat = async (parent: string | null, slug: string, name: string, path: string, depth: number) =>
    (await t.pool.query(`insert into categories (parent_id, slug, name, path, depth) values ($1, $2, $3, $4, $5) returning id`, [parent, slug, name, path, depth])).rows[0].id;
  const men = await cat(null, "men", "Men", "men", 0);
  jackets = await cat(men, "jackets", "Jackets", "men/jackets", 1);
  const women = await cat(null, "women", "Women", "women", 0);
  tops = await cat(women, "tops", "Tops", "women/tops", 1);
  kurtas = await cat(women, "kurtas", "Kurtas", "women/kurtas", 1);
  levis = (await t.pool.query(`insert into brands (name, slug) values ('Levis', 'levis') returning id`)).rows[0].id;
  zara = (await t.pool.query(`insert into brands (name, slug) values ('Zara', 'zara') returning id`)).rows[0].id;

  await product({ title: "Denim jacket", price: 1800, cond: "very_good", sku: "DJ-001", attrs: { colour: "indigo" } });
  await product({ title: "Leather biker jacket", price: 4500, cond: "good", brand: null });
  await product({ title: "Cotton crop top", price: 450, cat: tops, brand: zara, cond: "new_with_tags", seller: sellerB });
  await product({ title: "Silk blouse", price: 1200, cat: tops, brand: zara, desc: "Pairs well with a denim jacket", seller: sellerB });
  await product({ title: "कुर्ता cotton block print", price: 900, cat: kurtas, brand: null, seller: sellerB });
  await product({ title: "Hidden pending jacket", price: 100, status: "pending" });
  await product({ title: "Hidden archived jacket", price: 100, status: "archived" });
});
afterAll(async () => { await t.close(); });

describe("matching", () => {
  it("finds words in the title, brand, category, attributes, seller name, SKU and description", async () => {
    expect(await ids("/products?q=biker")).toEqual(["Leather biker jacket"]);
    expect((await ids("/products?q=zara")).sort()).toEqual(["Cotton crop top", "Silk blouse"]);
    expect((await ids("/products?q=kurtas"))).toEqual(["कुर्ता cotton block print"]);
    expect(await ids("/products?q=indigo")).toEqual(["Denim jacket"]);
    expect((await ids("/products?q=bombay")).length).toBe(3);
    expect(await ids("/products?q=DJ-001")).toEqual(["Denim jacket"]);
    expect(await ids("/products?q=pairs")).toEqual(["Silk blouse"]);
  });
  it("matches word beginnings, other scripts and small typos", async () => {
    expect((await ids("/products?q=jack")).sort()).toEqual(["Denim jacket", "Leather biker jacket", "Silk blouse"]);
    expect(await ids("/products?q=कुर्ता")).toEqual(["कुर्ता cotton block print"]);
    expect(await ids("/products?q=lether%20bikr")).toEqual(["Leather biker jacket"]);
  });
  it("ranks a title match above a description mention", async () => {
    const r = await ids("/products?q=denim%20jacket");
    expect(r[0]).toBe("Denim jacket");
    expect(r).toContain("Silk blouse");
  });
  it("is safe with search-syntax characters and odd input", async () => {
    for (const q of ["a & b | !c", "':* ) (", "<script>", "%_\\", "   ", "🙂", "x".repeat(200)]) {
      const r = await get(`/products?q=${encodeURIComponent(q)}`);
      expect(r.statusCode).toBe(200);
    }
    expect((await get(`/products?q=${"y".repeat(201)}`)).statusCode).toBe(400);
  });
  it("never shows products that are not live", async () => {
    expect((await ids("/products?q=hidden"))).toEqual([]);
  });
  it("labels prices with the currency", async () => {
    const it0 = (await get("/products?q=denim")).json().items[0];
    expect(it0.currency).toBe("INR");
    expect(it0.minPricePaise).toBe(180000);
  });
});

describe("filters and sorting", () => {
  it("filters by category (with subcategories), brands, condition, seller and price in rupees", async () => {
    expect((await ids("/products?category=women")).length).toBe(3);
    expect((await ids("/products?category=women/tops&brand=zara,levis")).sort()).toEqual(["Cotton crop top", "Silk blouse"]);
    expect(await ids("/products?condition=new_with_tags")).toEqual(["Cotton crop top"]);
    expect((await ids(`/products?sellerId=${sellerB}&maxPrice=1000`)).sort()).toEqual(["Cotton crop top", "कुर्ता cotton block print"]);
    expect(await ids("/products?minPrice=1000&maxPrice=2000&sort=price_asc")).toEqual(["Silk blouse", "Denim jacket"]);
    expect((await get("/products?minPrice=500&maxPrice=100")).statusCode).toBe(400);
    expect((await get("/products?condition=mint")).statusCode).toBe(400);
  });
  it("sorts by price both ways", async () => {
    expect(await ids("/products?sort=price_asc")).toEqual(["Cotton crop top", "कुर्ता cotton block print", "Silk blouse", "Denim jacket", "Leather biker jacket"]);
    expect((await ids("/products?sort=price_desc"))[0]).toBe("Leather biker jacket");
  });
});

describe("pagination", () => {
  it("walks every sort order without gaps or repeats, including tied prices and identical timestamps", async () => {
    const created: string[] = [];
    // 40 products in ONE statement-batch with the same price, so ties are guaranteed.
    for (let i = 0; i < 40; i++) created.push(await product({ title: `Tie item ${i}`, cat: tops, brand: null, price: 777, createdAt: "2026-01-01T00:00:00.123456Z" }));
    for (const sort of ["newest", "price_asc", "price_desc", "relevance"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r = await get(`/products?q=tie&category=women/tops&limit=7&sort=${sort}${cursor ? `&cursor=${cursor}` : ""}`);
        expect(r.statusCode).toBe(200);
        seen.push(...r.json().items.map((x: any) => x.id));
        cursor = r.json().nextCursor;
        pages++;
      } while (cursor && pages < 20);
      expect(new Set(seen).size).toBe(40);
      expect(seen.length).toBe(40);
    }
  });
  it("keeps rows created within the same millisecond", async () => {
    const stamps = ["2025-05-05T05:05:05.100100Z", "2025-05-05T05:05:05.100200Z", "2025-05-05T05:05:05.100300Z", "2025-05-05T05:05:05.100400Z"];
    for (const s of stamps) await product({ title: `Micro ${s.slice(-7, -1)}`, cat: kurtas, brand: null, price: 300, createdAt: s });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await get(`/products?category=women/kurtas&q=micro&sort=newest&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.json().items.map((x: any) => x.title));
      cursor = r.json().nextCursor;
    } while (cursor);
    expect(seen).toEqual(["Micro 100400", "Micro 100300", "Micro 100200", "Micro 100100"]);
  });
  it("rejects cursors from another sort order and tampered cursors", async () => {
    const c = (await get("/products?limit=1&sort=newest")).json().nextCursor;
    expect((await get(`/products?limit=1&sort=price_asc&cursor=${c}`)).statusCode).toBe(400);
    const bad = Buffer.from(JSON.stringify({ s: "price_asc", k: "1; drop table users", id: "00000000-0000-4000-8000-000000000000" })).toString("base64url");
    expect((await get(`/products?sort=price_asc&cursor=${bad}`)).statusCode).toBe(400);
    expect((await get(`/products?cursor=not-base64-json`)).statusCode).toBe(400);
  });
});

describe("index stays current", () => {
  it("follows price changes, deactivated variants, suspended sellers and inactive categories", async () => {
    await t.pool.query(`update product_variants set price_paise = 99900, mrp_paise = 99900 where sku = 'DJ-001'`);
    expect((await get("/products?q=denim%20jacket")).json().items[0].minPricePaise).toBe(99900);
    await t.pool.query(`update product_variants set is_active = false where sku = 'DJ-001'`);
    expect(await ids("/products?q=indigo")).toEqual([]);
    await t.pool.query(`update product_variants set is_active = true where sku = 'DJ-001'`);
    await t.pool.query(`update sellers set status = 'suspended' where id = $1`, [sellerB]);
    expect(await ids("/products?q=zara")).toEqual([]);
    await t.pool.query(`update sellers set status = 'approved' where id = $1`, [sellerB]);
    await t.pool.query(`update categories set is_active = false where id = $1`, [kurtas]);
    expect(await ids("/products?q=कुर्ता")).toEqual([]);
    await t.pool.query(`update categories set is_active = true where id = $1`, [kurtas]);
    await t.pool.query(`update sellers set display_name = 'Mumbai Closet' where id = $1`, [sellerB]);
    expect((await ids("/products?q=mumbai")).length).toBeGreaterThan(0);
  });
});

describe("concurrency (review regressions)", () => {
  const client = async () => { const c = new pg.Client({ connectionString: t.cfg.DATABASE_URL }); await c.connect(); return c; };
  it("a seller suspended while a price edit is in flight stays hidden", async () => {
    const id = await product({ title: "Race coat", price: 1000, seller: sellerB, cat: tops, brand: null, sku: "RACE-1" });
    const c1 = await client(), c2 = await client();
    try {
      await c1.query("begin");
      await c1.query(`update sellers set status = 'suspended' where id = $1`, [sellerB]);
      await c2.query(`update product_variants set price_paise = 90000, mrp_paise = 90000 where sku = 'RACE-1'`);
      await c1.query("commit");
      expect(await ids("/products?q=race")).toEqual([]);
    } finally {
      await t.pool.query(`update sellers set status = 'approved' where id = $1`, [sellerB]);
      await c1.end(); await c2.end();
    }
    expect((await get("/products?q=race")).json().items[0].minPricePaise).toBe(90000);
    expect(id).toBeTruthy();
  });
  it("two price edits on one product in parallel leave the true lowest price", async () => {
    const id = await product({ title: "Twin price shirt", price: 5000, sku: "TWIN-A", cat: tops, brand: null });
    await t.pool.query(`insert into product_variants (product_id, seller_id, sku, options, price_paise, mrp_paise) values ($1, $2, 'TWIN-B', '{"size":"L"}', 500000, 500000)`, [id, sellerA]);
    const c1 = await client(), c2 = await client();
    try {
      await c1.query("begin");
      await c1.query(`update product_variants set price_paise = 300000, mrp_paise = 300000 where sku = 'TWIN-A'`);
      const second = c2.query(`update product_variants set price_paise = 200000, mrp_paise = 200000 where sku = 'TWIN-B'`);
      await new Promise((r) => setTimeout(r, 200));
      await c1.query("commit");
      await second;
    } finally {
      await c1.end(); await c2.end();
    }
    expect((await get("/products?q=twin")).json().items[0].minPricePaise).toBe(200000);
  });
});

describe("scale", () => {
  it("searches 10,000 products quickly", async () => {
    await t.pool.query(`
      with p as (
        insert into products (seller_id, status, title, description, category_id, condition, gst_rate_bp)
        select $1, 'active', 'Bulk item ' || g || ' ' || (array['shirt','jeans','saree','kurta','jacket','dress','sneakers'])[1 + g % 7],
               'Generated listing number ' || g, $2, 'good', 500
          from generate_series(1, 10000) g
        returning id, seller_id
      )
      insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise)
      select id, seller_id, 'BULK-' || substr(id::text, 1, 12), 10000 + (random() * 500000)::int, 600000 from p`, [sellerA, tops]);
    await t.pool.query("analyze product_search");
    const timings: number[] = [];
    for (const url of ["/products?q=saree", "/products?q=sareee", "/products?category=women&sort=price_asc", "/products?q=bulk%20jacket&maxPrice=2000", "/products"]) {
      const s = performance.now();
      const r = await get(url);
      timings.push(performance.now() - s);
      expect(r.statusCode).toBe(200);
      expect(r.json().items.length).toBeGreaterThan(0);
    }
    console.log("search timings (ms):", timings.map((x) => Math.round(x)).join(", "));
    expect(Math.max(...timings)).toBeLessThan(500);
    // Renaming a category with 10,000+ products rebuilds their search text in one statement.
    const s = performance.now();
    await t.pool.query(`update categories set name = 'Tops and blouses' where id = $1`, [tops]);
    const renameMs = performance.now() - s;
    console.log("category rename over 10k products (ms):", Math.round(renameMs));
    expect(renameMs).toBeLessThan(10_000);
    expect((await get("/products?q=blouses&limit=1")).json().items.length).toBe(1);
  }, 120_000);
});
