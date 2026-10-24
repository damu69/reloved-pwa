// Creates a small, repeatable marketplace in an EMPTY test database: one approved seller with a few listed items.
// Usage: DATABASE_URL=... API_URL=http://127.0.0.1:4000 node seed.mjs   (run after the migrations, with the API running)
import pg from "pg";

const API = process.env.API_URL ?? "http://127.0.0.1:4000";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function register(email, fullName) {
  const r = await fetch(`${API}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.99.0.${Math.floor(Math.random() * 250) + 1}` },
    body: JSON.stringify({ email, password: "correct horse battery", fullName }),
  });
  if (!r.ok) throw new Error(`register ${email}: ${r.status} ${await r.text()}`);
  return (await r.json()).user.id;
}

const sellerUser = await register("seller@e2e.test", "Sara Seller");
const seller = (await db.query(
  `insert into sellers (user_id, status, display_name, business_name, business_type, pan_encrypted, pan_last4, address_line1, city, state, pincode, contact_phone)
   values ($1, 'approved', 'E2E Attic', 'E2E Attic', 'individual', 'v1:x', '1234', 'Street 1', 'Nanded', 'MH', '431601', '9876543210') returning id`, [sellerUser])).rows[0].id;
await db.query(`insert into user_roles (user_id, role_key) values ($1, 'seller') on conflict do nothing`, [sellerUser]);
const wh = (await db.query(`insert into warehouses (seller_id, name, pincode, is_default) values ($1, 'Main', '431601', true) returning id`, [seller])).rows[0].id;
const women = (await db.query(`insert into categories (slug, name, path, depth) values ('women','Women','women',0) returning id`)).rows[0].id;
const tops = (await db.query(`insert into categories (parent_id, slug, name, path, depth) values ($1,'tops','Tops','women/tops',1) returning id`, [women])).rows[0].id;

const items = [["E2E Denim Jacket", 1000, 5], ["E2E Silk Scarf", 500, 3], ["E2E Last Piece Kurta", 750, 1]];
for (const [title, price, stock] of items) {
  const p = (await db.query(`insert into products (seller_id, status, title, category_id, condition, gst_rate_bp) values ($1,'active',$2,$3,'good',500) returning id`, [seller, title, tops])).rows[0].id;
  const v = (await db.query(`insert into product_variants (product_id, seller_id, sku, price_paise, mrp_paise) values ($1,$2,$3,$4,$4) returning id`, [p, seller, `E2E-${p.slice(0, 6)}`, price * 100])).rows[0].id;
  await db.query(`insert into inventory_levels (variant_id, warehouse_id, on_hand) values ($1,$2,$3)`, [v, wh, stock]);
}
await db.end();
console.log("seeded: seller@e2e.test and", items.length, "items");
