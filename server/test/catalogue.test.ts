import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { setup, multipartFile } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let admin: U, admin2: U, alice: U, bob: U, carl: U;
let ip = 0;
const nextIp = () => `10.50.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

const reg = async (email: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: nextIp(), payload: { email, password: "correct horse battery", fullName: email } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const call = (u: U | null, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, remoteAddress: nextIp(), headers: u ? { authorization: `Bearer ${u.at}` } : {}, ...(payload !== undefined ? { payload: payload as any } : {}) });
const photo = (u: U, productId: string, body: Buffer) => {
  const m = multipartFile("p.jpg", body);
  return t.app.inject({ method: "POST", url: `/api/v1/seller/products/${productId}/images`, remoteAddress: nextIp(), headers: { authorization: `Bearer ${u.at}`, ...m.headers }, payload: m.payload });
};
// Approved seller created directly in the database; the application flow is covered in sellers.test.ts.
const makeSeller = async (u: U, name: string, status = "approved") => {
  const r = await t.pool.query(
    `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
     values ($1, $2, $3::text, $3::text, 'individual', 'v1:test', '1234', 'Street 1', 'Nanded', 'Maharashtra', '431601', '9876543210') returning id`,
    [u.id, status, name],
  );
  if (status === "approved") await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'seller')`, [u.id]);
  return r.rows[0].id as string;
};

let jpeg: Buffer, jpeg2: Buffer, tiny: Buffer;
let topsId: string, womenId: string, brandId: string, productId: string, variantId: string;
let imageIds: string[] = [];

beforeAll(async () => {
  t = await setup();
  admin = await reg("admin@example.com");
  admin2 = await reg("admin2@example.com");
  alice = await reg("alice@example.com");
  bob = await reg("bob@example.com");
  carl = await reg("carl@example.com");
  await t.pool.query(`insert into user_roles (user_id, role_key) select id, 'admin' from users where email like 'admin%'`);
  await makeSeller(alice, "Alice Attic");
  await makeSeller(bob, "Bob Boutique");
  await makeSeller(admin2, "Admin Two Shop");
  // A real photo with GPS metadata, so we can check it is stripped.
  jpeg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .jpeg().withExif({ IFD0: { Copyright: "secret-owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "19/1 9/1 0/1" } }).toBuffer();
  jpeg2 = await sharp({ create: { width: 900, height: 900, channels: 3, background: { r: 20, g: 120, b: 240 } } }).png().toBuffer();
  tiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer();
});
afterAll(async () => { await t.close(); });

describe("categories and brands (admin)", () => {
  it("only admins manage categories", async () => {
    expect((await call(alice, "POST", "/admin/catalogue/categories", { name: "Women" })).statusCode).toBe(403);
    const w = await call(admin, "POST", "/admin/catalogue/categories", { name: "Women" });
    expect(w.statusCode).toBe(201);
    womenId = w.json().id;
    const tops = await call(admin, "POST", "/admin/catalogue/categories", { name: "Tops & T-shirts", parentId: womenId });
    topsId = tops.json().id;
    expect((await call(admin, "POST", "/admin/catalogue/categories", { name: "Women" })).statusCode).toBe(409);
    const list = (await call(null, "GET", "/catalogue/categories")).json().items;
    expect(list.map((c: any) => c.path)).toEqual(["women", "women/tops-t-shirts"]);
  });
  it("brands are unique regardless of case", async () => {
    brandId = (await call(admin, "POST", "/admin/catalogue/brands", { name: "Zara" })).json().id;
    expect((await call(admin, "POST", "/admin/catalogue/brands", { name: "ZARA" })).statusCode).toBe(409);
  });
  it("GST rates are public for sellers to choose from", async () => {
    const r = (await call(null, "GET", "/catalogue/gst-rates")).json().items.map((g: any) => g.rateBp);
    expect(r).toEqual([0, 300, 500, 1800, 4000]);
  });
});

const product = (over: object = {}) => ({ title: "Linen shirt", description: "Barely worn.\nFits small.", categoryId: topsId, brandId, condition: "very_good", gstRateBp: 500, attributes: { material: "linen" }, ...over });

describe("creating products", () => {
  it("is only for approved sellers", async () => {
    const r = await call(carl, "POST", "/seller/products", product());
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("NOT_A_SELLER");
  });
  it("requires a leaf category and an allowed GST rate", async () => {
    const a = await call(alice, "POST", "/seller/products", product({ categoryId: womenId }));
    expect(a.json().error.details[0].path).toBe("categoryId");
    const b = await call(alice, "POST", "/seller/products", product({ gstRateBp: 1200 }));
    expect(b.json().error.details[0].path).toBe("gstRateBp");
  });
  it("creates a draft", async () => {
    const r = await call(alice, "POST", "/seller/products", product());
    expect(r.statusCode).toBe(201);
    productId = r.json().id;
    expect(r.json().status).toBe("draft");
    expect(r.json().description).toBe("Barely worn.\nFits small.");
  });
  it("a category in use cannot get subcategories", async () => {
    const r = await call(admin, "POST", "/admin/catalogue/categories", { name: "Crop tops", parentId: topsId });
    expect(r.json().error.code).toBe("CATEGORY_HAS_PRODUCTS");
  });
  it("cannot be submitted without photos and a variant", async () => {
    const r = await call(alice, "POST", `/seller/products/${productId}/submit`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details.map((d: any) => d.path).sort()).toEqual(["images", "variants"]);
  });
});

describe("variants", () => {
  it("validates price, MRP, SKU uniqueness and consistent options", async () => {
    expect((await call(alice, "POST", `/seller/products/${productId}/variants`, { sku: "LS-S", options: { size: "S" }, pricePaise: 50000, mrpPaise: 40000 })).statusCode).toBe(400);
    const ok = await call(alice, "POST", `/seller/products/${productId}/variants`, { sku: "LS-S", options: { size: "S" }, pricePaise: 49900, mrpPaise: 99900 });
    expect(ok.statusCode).toBe(201);
    variantId = ok.json().id;
    expect((await call(alice, "POST", `/seller/products/${productId}/variants`, { sku: "ls-s", options: { size: "M" }, pricePaise: 49900, mrpPaise: 99900 })).json().error.code).toBe("SKU_TAKEN");
    expect((await call(alice, "POST", `/seller/products/${productId}/variants`, { sku: "LS-S2", options: { size: "S" }, pricePaise: 49900, mrpPaise: 99900 })).json().error.code).toBe("VARIANT_EXISTS");
    expect((await call(alice, "POST", `/seller/products/${productId}/variants`, { sku: "LS-X", options: { colour: "red" }, pricePaise: 49900, mrpPaise: 99900 })).statusCode).toBe(400);
    expect((await call(alice, "POST", `/seller/products/${productId}/variants`, { sku: "LS-M", options: { size: "M" }, pricePaise: 54900, mrpPaise: 99900 })).statusCode).toBe(201);
    // A different seller may use the same SKU.
    const bobP = (await call(bob, "POST", "/seller/products", product({ title: "Bob shirt" }))).json().id;
    expect((await call(bob, "POST", `/seller/products/${bobP}/variants`, { sku: "LS-S", pricePaise: 10000, mrpPaise: 10000 })).statusCode).toBe(201);
  });
});

describe("photos", () => {
  it("rejects non-images and tiny images", async () => {
    expect((await photo(alice, productId, Buffer.from("%PDF-1.4 not a photo"))).statusCode).toBe(422);
    expect((await photo(alice, productId, Buffer.from("just text"))).statusCode).toBe(422);
    const r = await photo(alice, productId, tiny);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("INVALID_IMAGE");
  });
  it("stores three WebP sizes with metadata stripped", async () => {
    const r = await photo(alice, productId, jpeg);
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe("active");
    imageIds.push(r.json().id);
    const big = await call(alice, "GET", `/seller/products/${productId}/images/${imageIds[0]}/1200`);
    expect(big.headers["content-type"]).toBe("image/webp");
    const meta = await sharp(big.rawPayload).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(1200);
    expect(meta.exif).toBeUndefined();
    expect(big.rawPayload.includes(Buffer.from("secret-owner"))).toBe(false);
    const small = await sharp((await call(alice, "GET", `/seller/products/${productId}/images/${imageIds[0]}/200`)).rawPayload).metadata();
    expect(small.width).toBe(200);
  });
  it("keeps other sellers out", async () => {
    expect((await call(bob, "GET", `/seller/products/${productId}`)).statusCode).toBe(404);
    expect((await call(bob, "PATCH", `/seller/products/${productId}`, { title: "Hijacked" })).statusCode).toBe(404);
    expect((await call(bob, "POST", `/seller/products/${productId}/variants`, { sku: "B1", options: { size: "L" }, pricePaise: 100, mrpPaise: 100 })).statusCode).toBe(404);
    expect((await call(bob, "PATCH", `/seller/products/${productId}/variants/${variantId}`, { pricePaise: 100 })).statusCode).toBe(404);
    expect((await call(bob, "GET", `/seller/products/${productId}/images/${imageIds[0]}/200`)).statusCode).toBe(404);
    expect((await photo(bob, productId, jpeg2)).statusCode).toBe(404);
  });
});

describe("review", () => {
  it("submits, locks editing while pending, and hides the product from the public", async () => {
    expect((await call(alice, "POST", `/seller/products/${productId}/submit`)).json().status).toBe("pending");
    expect((await call(alice, "PATCH", `/seller/products/${productId}`, { title: "Changed" })).statusCode).toBe(422);
    expect((await call(null, "GET", `/catalogue/products/${productId}`)).statusCode).toBe(404);
    expect((await call(null, "GET", "/catalogue/products")).json().items).toEqual([]);
  });
  it("cannot be approved by a non-admin or by the seller's own admin account", async () => {
    expect((await call(alice, "POST", `/admin/catalogue/products/${productId}/approve`, { submission: 1 })).statusCode).toBe(403);
    const own = (await call(admin2, "POST", "/seller/products", product({ title: "Admin's own" }))).json().id;
    await t.pool.query(`insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) select id, seller_id, 'A2', 1000, 1000 from products where id = $1`, [own]);
    await photo(admin2, own, jpeg2);
    await call(admin2, "POST", `/seller/products/${own}/submit`);
    expect((await call(admin2, "POST", `/admin/catalogue/products/${own}/approve`, { submission: 1 })).statusCode).toBe(403);
  });
  it("approves and the product appears publicly, filterable by category prefix and brand", async () => {
    expect((await call(admin, "POST", `/admin/catalogue/products/${productId}/approve`, {})).statusCode).toBe(400);
    const submission = (await call(admin, "GET", `/admin/catalogue/products/${productId}`)).json().submission;
    const r = await call(admin, "POST", `/admin/catalogue/products/${productId}/approve`, { submission });
    expect(r.json().status).toBe("active");
    // Live but no stock yet: hidden from search by default, shown as sold out when asked.
    expect((await call(null, "GET", "/catalogue/products")).json().items).toHaveLength(0);
    expect((await call(null, "GET", "/catalogue/products?includeOutOfStock=true")).json().items[0].inStock).toBe(false);
    for (const v of r.json().variants) {
      expect((await call(alice, "PUT", `/seller/inventory/${v.id}`, { onHand: 4, expectedOnHand: 0 })).statusCode).toBe(200);
    }
    const list = (await call(null, "GET", "/catalogue/products?category=women")).json().items;
    expect(list.map((x: any) => x.id)).toEqual([productId]);
    expect(list[0].minPricePaise).toBe(49900);
    expect(list[0].coverImageId).toBe(imageIds[0]);
    expect((await call(null, "GET", "/catalogue/products?brand=zara")).json().items).toHaveLength(1);
    expect((await call(null, "GET", "/catalogue/products?category=men")).json().items).toHaveLength(0);
    const pub = (await call(null, "GET", `/catalogue/products/${productId}`)).json();
    expect(pub.reviewNote).toBeUndefined();
    expect(pub.variants.map((v: any) => v.sku).sort()).toEqual(["LS-M", "LS-S"]);
    const media = await call(null, "GET", `/catalogue/media/products/${productId}/${imageIds[0]}/600`);
    expect(media.statusCode).toBe(200);
    expect(media.headers["cache-control"]).toBe("public, max-age=3600");
  });
});

describe("editing a live product", () => {
  let version: number;
  it("keeps the live version while an edit waits for review", async () => {
    const r = await call(alice, "PATCH", `/seller/products/${productId}`, { title: "Linen shirt, sky blue" });
    expect(r.json().changeMode).toBe("pending_review");
    expect(r.json().title).toBe("Linen shirt");
    expect(r.json().pendingChange.data.title).toBe("Linen shirt, sky blue");
    const img = await photo(alice, productId, jpeg2);
    expect(img.json().status).toBe("pending_add");
    imageIds.push(img.json().id);
    expect((await call(null, "GET", `/catalogue/products/${productId}`)).json().title).toBe("Linen shirt");
    expect((await call(null, "GET", `/catalogue/media/products/${productId}/${imageIds[1]}/200`)).statusCode).toBe(404);
    expect((await call(alice, "GET", `/seller/products/${productId}/images/${imageIds[1]}/200`)).statusCode).toBe(200);
    version = (await call(admin, "GET", `/admin/catalogue/products/${productId}`)).json().pendingChange.version;
    expect(version).toBe(2);
  });
  it("refuses an approval for a version the admin did not see", async () => {
    await call(alice, "PATCH", `/seller/products/${productId}`, { description: "Sneaky extra change" });
    const r = await call(admin, "POST", `/admin/catalogue/products/${productId}/pending-change/approve`, { version });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("REVISION_CHANGED");
  });
  it("applies the change and the new photo once approved; two admins cannot both apply it", async () => {
    const v = (await call(admin, "GET", `/admin/catalogue/products/${productId}`)).json().pendingChange.version;
    const [a, b] = await Promise.all([
      call(admin, "POST", `/admin/catalogue/products/${productId}/pending-change/approve`, { version: v }),
      call(admin, "POST", `/admin/catalogue/products/${productId}/pending-change/approve`, { version: v }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
    const pub = (await call(null, "GET", `/catalogue/products/${productId}`)).json();
    expect(pub.title).toBe("Linen shirt, sky blue");
    expect(pub.description).toBe("Sneaky extra change");
    expect(pub.images.map((i: any) => i.id)).toEqual(imageIds);
    const audit = await t.pool.query(`select old_value->>'title' as old, new_value->>'title' as new from audit_logs where action = 'product.revision_approve'`);
    expect(audit.rows[0]).toEqual({ old: "Linen shirt", new: "Linen shirt, sky blue" });
  });
  it("a rejected change leaves the live product untouched and drops its new photos", async () => {
    await call(alice, "PATCH", `/seller/products/${productId}`, { title: "FREE iPhone click here" });
    const extra = (await photo(alice, productId, jpeg)).json().id;
    const v = (await call(admin, "GET", `/admin/catalogue/products/${productId}`)).json().pendingChange.version;
    expect((await call(admin, "POST", `/admin/catalogue/products/${productId}/pending-change/reject`, { version: v })).statusCode).toBe(400);
    const r = await call(admin, "POST", `/admin/catalogue/products/${productId}/pending-change/reject`, { version: v, reason: "Misleading title" });
    expect(r.json().title).toBe("Linen shirt, sky blue");
    expect(r.json().images.map((i: any) => i.id)).not.toContain(extra);
    expect((await call(alice, "GET", `/seller/products/${productId}`)).json().lastChangeReview.note).toBe("Misleading title");
  });
  it("cannot end up live without photos", async () => {
    for (const id of imageIds) expect((await call(alice, "DELETE", `/seller/products/${productId}/images/${id}`)).json().status).toBe("pending_remove");
    expect((await call(null, "GET", `/catalogue/products/${productId}`)).json().images).toHaveLength(2);
    const v = (await call(admin, "GET", `/admin/catalogue/products/${productId}`)).json().pendingChange.version;
    const r = await call(admin, "POST", `/admin/catalogue/products/${productId}/pending-change/approve`, { version: v });
    expect(r.statusCode).toBe(422);
    expect((await call(alice, "DELETE", `/seller/products/${productId}/pending-change`)).statusCode).toBe(204);
    expect((await call(alice, "GET", `/seller/products/${productId}`)).json().images.every((i: any) => i.status === "active")).toBe(true);
  });
  it("price changes apply at once and are audited with old and new values", async () => {
    expect((await call(alice, "PATCH", `/seller/products/${productId}/variants/${variantId}`, { pricePaise: 120000 })).statusCode).toBe(400);
    expect((await call(alice, "PATCH", `/seller/products/${productId}/variants/${variantId}`, { pricePaise: 44900 })).statusCode).toBe(204);
    expect((await call(null, "GET", "/catalogue/products")).json().items[0].minPricePaise).toBe(44900);
    const a = await t.pool.query(`select old_value->>'pricePaise' as old, new_value->>'pricePaise' as new from audit_logs where action = 'variant.update'`);
    expect(a.rows.at(-1)).toEqual({ old: "49900", new: "44900" });
  });
  it("published products and their variants are archived, never deleted", async () => {
    expect((await call(alice, "DELETE", `/seller/products/${productId}`)).statusCode).toBe(422);
    expect((await call(alice, "DELETE", `/seller/products/${productId}/variants/${variantId}`)).statusCode).toBe(422);
    expect((await call(alice, "POST", `/seller/products/${productId}/archive`)).json().status).toBe("archived");
    expect((await call(null, "GET", `/catalogue/products/${productId}`)).statusCode).toBe(404);
    expect((await call(alice, "POST", `/seller/products/${productId}/unarchive`)).json().status).toBe("active");
  });
});

describe("marketplace controls", () => {
  it("a blocked product disappears, cannot be edited or relisted, and comes back only as archived", async () => {
    expect((await call(admin, "POST", `/admin/catalogue/products/${productId}/block`, {})).statusCode).toBe(400);
    expect((await call(admin, "POST", `/admin/catalogue/products/${productId}/block`, { reason: "Counterfeit report" })).json().status).toBe("blocked");
    expect((await call(null, "GET", `/catalogue/products/${productId}`)).statusCode).toBe(404);
    expect((await call(null, "GET", `/catalogue/media/products/${productId}/${imageIds[0]}/200`)).statusCode).toBe(404);
    expect((await call(alice, "PATCH", `/seller/products/${productId}`, { title: "Back again" })).statusCode).toBe(422);
    expect((await call(alice, "POST", `/seller/products/${productId}/unarchive`)).statusCode).toBe(422);
    expect((await call(admin, "POST", `/admin/catalogue/products/${productId}/unblock`, { reason: "Verified genuine" })).json().status).toBe("archived");
    await call(alice, "POST", `/seller/products/${productId}/unarchive`);
  });
  it("suspending a seller hides their products and locks their seller routes", async () => {
    const sid = (await t.pool.query(`select id from sellers where user_id = $1`, [alice.id])).rows[0].id;
    await t.pool.query(`update sellers set status = 'suspended' where id = $1`, [sid]);
    expect((await call(null, "GET", "/catalogue/products")).json().items).toHaveLength(0);
    const r = await call(alice, "GET", "/seller/products");
    expect(r.json().error.code).toBe("SELLER_SUSPENDED");
    await t.pool.query(`update sellers set status = 'approved' where id = $1`, [sid]);
    expect((await call(null, "GET", "/catalogue/products")).json().items).toHaveLength(1);
  });
  it("a category with live products cannot be deactivated", async () => {
    const r = await call(admin, "PATCH", `/admin/catalogue/categories/${topsId}`, { isActive: false });
    expect(r.json().error.code).toBe("CATEGORY_HAS_PRODUCTS");
  });
  it("a never-published draft can be deleted", async () => {
    const d = (await call(alice, "POST", "/seller/products", product({ title: "Temporary" }))).json().id;
    expect((await call(alice, "DELETE", `/seller/products/${d}`)).statusCode).toBe(204);
    expect((await call(alice, "GET", `/seller/products/${d}`)).statusCode).toBe(404);
  });
  it("caps photos at 10 per product", async () => {
    const d = (await call(bob, "POST", "/seller/products", product({ title: "Many photos" }))).json().id;
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await photo(bob, d, jpeg2)).statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(10);
    expect(codes.at(-1)).toBe(409);
  });
});

describe("review findings (regressions)", () => {
  let pid: string;
  const ready = async (title: string) => {
    const id = (await call(bob, "POST", "/seller/products", product({ title }))).json().id;
    await call(bob, "POST", `/seller/products/${id}/variants`, { sku: `SKU-${Math.random().toString(36).slice(2, 8)}`, pricePaise: 10000, mrpPaise: 10000 });
    await photo(bob, id, jpeg2);
    return id;
  };
  it("a discarded edit followed by a new edit gets a new version, so the old approval cannot apply", async () => {
    pid = await ready("Plain jacket");
    await call(bob, "POST", `/seller/products/${pid}/submit`);
    const sub1 = (await call(admin, "GET", `/admin/catalogue/products/${pid}`)).json().submission;
    await call(admin, "POST", `/admin/catalogue/products/${pid}/approve`, { submission: sub1 });
    await call(bob, "PATCH", `/seller/products/${pid}`, { title: "Harmless title" });
    const seen = (await call(admin, "GET", `/admin/catalogue/products/${pid}`)).json().pendingChange.version;
    await call(bob, "DELETE", `/seller/products/${pid}/pending-change`);
    await call(bob, "PATCH", `/seller/products/${pid}`, { title: "SCAM buy on whatsapp" });
    const r = await call(admin, "POST", `/admin/catalogue/products/${pid}/pending-change/approve`, { version: seen });
    expect(r.statusCode).toBe(409);
    expect((await call(null, "GET", `/catalogue/products/${pid}`)).json().title).toBe("Plain jacket");
  });
  it("removing a photo from a pending change also gives it a new version", async () => {
    const extra = (await photo(bob, pid, jpeg)).json().id;
    const before = (await call(admin, "GET", `/admin/catalogue/products/${pid}`)).json().pendingChange.version;
    expect((await call(bob, "DELETE", `/seller/products/${pid}/images/${extra}`)).json().status).toBe("removed");
    const after = (await call(admin, "GET", `/admin/catalogue/products/${pid}`)).json().pendingChange.version;
    expect(after).toBe(before + 1);
  });
  it("withdraw, edit and resubmit after the admin opened it cannot be approved with the old submission", async () => {
    const id = await ready("Original listing");
    await call(bob, "POST", `/seller/products/${id}/submit`);
    const seen = (await call(admin, "GET", `/admin/catalogue/products/${id}`)).json().submission;
    await call(bob, "POST", `/seller/products/${id}/withdraw`);
    await call(bob, "PATCH", `/seller/products/${id}`, { title: "Swapped after review" });
    await call(bob, "POST", `/seller/products/${id}/submit`);
    const r = await call(admin, "POST", `/admin/catalogue/products/${id}/approve`, { submission: seen });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("PRODUCT_CHANGED");
  });
  it("a corrupt or truncated image returns 422, not 500", async () => {
    const id = (await call(bob, "POST", "/seller/products", product({ title: "Broken photos" }))).json().id;
    const big = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    const half = await photo(bob, id, big.subarray(0, Math.floor(big.length / 2)));
    expect(half.statusCode).toBe(422);
    const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer();
    expect((await photo(bob, id, png.subarray(0, png.length - 40))).statusCode).toBe(422);
  });
});
