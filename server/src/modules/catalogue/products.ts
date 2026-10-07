import { randomUUID } from "node:crypto";
import type { Db, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import type { Storage } from "../../lib/storage.js";
import { IMAGE_SIZES, ImageError, processProductImage, type ImageSize } from "../../lib/images.js";
import { CONTENT_COLUMNS, checkRefs, contentOf, notSellable, sellableProblems, type Content } from "./content.js";

export interface Ctx { actorUserId: string; ip: string | null; requestId: string }
export interface Deps { db: Db; storage: Storage }

const MAX_IMAGES = 10;
const DIRECT_EDIT = ["draft", "rejected"];       // content changes apply at once
const LIVE = ["active", "archived"];              // content changes become a pending revision
const VISIBLE_IMAGE = ["active", "pending_remove"];

// ---------- helpers ----------

async function lockOwn(tx: Tx, sellerId: string, productId: string) {
  const r = await tx.query(`select * from products where id = $1 and seller_id = $2 and deleted_at is null for update`, [productId, sellerId]);
  if (!r.rows[0]) throw Errors.notFound("Product");
  return r.rows[0];
}

async function lockAny(tx: Tx, productId: string) {
  const r = await tx.query(
    `select p.*, s.user_id as seller_user_id, s.status as seller_status
       from products p join sellers s on s.id = p.seller_id
      where p.id = $1 and p.deleted_at is null for update of p`,
    [productId],
  );
  if (!r.rows[0]) throw Errors.notFound("Product");
  return r.rows[0];
}

const locked = (status: string) =>
  Errors.invalidTransition(
    status === "pending" ? "This product is waiting for review. Withdraw it to make changes."
    : status === "blocked" ? "This product was removed by the marketplace and cannot be changed."
    : "This product cannot be changed now.",
  );

async function pendingRevision(tx: Tx, productId: string) {
  const r = await tx.query(`select * from product_revisions where product_id = $1 and status = 'pending' for update`, [productId]);
  return r.rows[0] ?? null;
}

// Every change to a live product's content or photos goes through one pending revision.
async function ensureRevision(tx: Tx, product: any, actor: string, patch: Partial<Content> = {}) {
  const rev = await pendingRevision(tx, product.id);
  const data: Content = { ...(rev ? rev.data : contentOf(product)), ...patch };
  await checkRefs(tx, data);
  if (rev) {
    await tx.query(`update product_revisions set data = $2, version = version + 1 where id = $1`, [rev.id, JSON.stringify(data)]);
    return { id: rev.id as string, version: rev.version + 1 };
  }
  const id = randomUUID();
  const r = await tx.query(
    `insert into product_revisions (id, product_id, data, created_by, version)
     values ($1, $2, $3, $4, (select coalesce(max(version), 0) + 1 from product_revisions where product_id = $2))
     returning version`,
    [id, product.id, JSON.stringify(data), actor],
  );
  return { id, version: r.rows[0].version as number };
}

async function applyContent(tx: Tx, productId: string, c: Partial<Content>) {
  const cols = (Object.keys(c) as (keyof Content)[]).filter((k) => c[k] !== undefined);
  if (!cols.length) return;
  // Column names come from the fixed CONTENT_COLUMNS map, never from the request.
  await tx.query(
    `update products set ${cols.map((k, i) => `${CONTENT_COLUMNS[k]} = $${i + 2}`).join(", ")} where id = $1`,
    [productId, ...cols.map((k) => (k === "attributes" ? JSON.stringify(c[k]) : c[k]))],
  );
}

function uniqueViolation(e: any): AppError | null {
  if (e?.code !== "23505") return null;
  const c = String(e.constraint ?? "");
  if (c.includes("sku")) return Errors.conflict("SKU_TAKEN", "You already use this SKU on another variant.");
  if (c.includes("options")) return Errors.conflict("VARIANT_EXISTS", "A variant with these options already exists.");
  return Errors.conflict("DUPLICATE", "This record already exists.");
}

// ---------- seller: products ----------

export async function create(d: Deps, ctx: Ctx, sellerId: string, c: Content): Promise<string> {
  return withTx(d.db, async (tx) => {
    await checkRefs(tx, c);
    const id = randomUUID();
    await tx.query(
      `insert into products (id, seller_id, title, description, category_id, brand_id, condition, attributes, gst_rate_bp, hsn_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, sellerId, c.title, c.description, c.categoryId, c.brandId, c.condition, JSON.stringify(c.attributes), c.gstRateBp, c.hsnCode],
    );
    await writeAudit(tx, { ...ctx, action: "product.create", entity: "product", entityId: id });
    return id;
  });
}

export async function updateContent(d: Deps, ctx: Ctx, sellerId: string, productId: string, patch: Partial<Content>) {
  return withTx(d.db, async (tx) => {
    const p = await lockOwn(tx, sellerId, productId);
    if (DIRECT_EDIT.includes(p.status)) {
      const merged = { ...contentOf(p), ...patch };
      await checkRefs(tx, merged);
      await applyContent(tx, p.id, patch);
      if (p.status === "rejected") await tx.query(`update products set status = 'draft', review_note = null where id = $1`, [p.id]);
      await writeAudit(tx, { ...ctx, action: "product.update", entity: "product", entityId: p.id, newValue: { fields: Object.keys(patch) } });
      return { mode: "applied" as const };
    }
    if (LIVE.includes(p.status)) {
      const rev = await ensureRevision(tx, p, ctx.actorUserId, patch);
      await writeAudit(tx, { ...ctx, action: "product.revision_update", entity: "product", entityId: p.id, newValue: { revisionId: rev.id, version: rev.version, fields: Object.keys(patch) } });
      return { mode: "pending_review" as const };
    }
    throw locked(p.status);
  });
}

type SellerAction = "submit" | "withdraw" | "archive" | "unarchive";
export async function sellerTransition(d: Deps, ctx: Ctx, sellerId: string, productId: string, action: SellerAction) {
  await withTx(d.db, async (tx) => {
    const p = await lockOwn(tx, sellerId, productId);
    const rules: Record<SellerAction, { from: string[]; to: string }> = {
      submit: { from: ["draft", "rejected"], to: "pending" },
      withdraw: { from: ["pending"], to: "draft" },
      archive: { from: ["active"], to: "archived" },
      unarchive: { from: ["archived"], to: "active" },
    };
    const rule = rules[action];
    if (!rule.from.includes(p.status)) throw Errors.invalidTransition(`Cannot ${action} a product whose status is ${p.status}.`);
    if (action === "submit") {
      await checkRefs(tx, contentOf(p));
      const problems = await sellableProblems(tx, p.id, ["active"]);
      if (problems.length) throw notSellable(problems);
      await tx.query(`update products set status = 'pending', submitted_at = now(), review_note = null, submission = submission + 1 where id = $1`, [p.id]);
    } else {
      await tx.query(`update products set status = $2 where id = $1`, [p.id, rule.to]);
    }
    await writeAudit(tx, { ...ctx, action: `product.${action}`, entity: "product", entityId: p.id, oldValue: { status: p.status }, newValue: { status: rule.to } });
  });
}

export async function remove(d: Deps, ctx: Ctx, sellerId: string, productId: string) {
  await withTx(d.db, async (tx) => {
    const p = await lockOwn(tx, sellerId, productId);
    // A product that was ever live may appear in orders and reviews: it is archived, never deleted.
    if (p.approved_at || !DIRECT_EDIT.includes(p.status)) {
      throw Errors.invalidTransition("Only products that were never published can be deleted. Archive it instead.");
    }
    await tx.query(`update products set deleted_at = now() where id = $1`, [p.id]);
    await tx.query(`update product_images set status = 'removed' where product_id = $1`, [p.id]);
    await tx.query(`update product_variants set deleted_at = now() where product_id = $1 and deleted_at is null`, [p.id]);
    await writeAudit(tx, { ...ctx, action: "product.delete", entity: "product", entityId: p.id });
  });
}

export async function discardRevision(d: Deps, ctx: Ctx, sellerId: string, productId: string) {
  await withTx(d.db, async (tx) => {
    const p = await lockOwn(tx, sellerId, productId);
    const rev = await pendingRevision(tx, p.id);
    if (!rev) throw Errors.notFound("Pending change");
    await tx.query(`update product_revisions set status = 'discarded' where id = $1`, [rev.id]);
    await revertImages(tx, p.id);
    await writeAudit(tx, { ...ctx, action: "product.revision_discard", entity: "product", entityId: p.id, newValue: { revisionId: rev.id } });
  });
}

async function revertImages(tx: Tx, productId: string) {
  await tx.query(`update product_images set status = 'removed' where product_id = $1 and status = 'pending_add'`, [productId]);
  await tx.query(`update product_images set status = 'active' where product_id = $1 and status = 'pending_remove'`, [productId]);
}

// ---------- seller: variants ----------

export interface VariantInput { sku: string; options: Record<string, string>; pricePaise: number; mrpPaise: number }

async function checkOptionKeys(tx: Tx, productId: string, options: Record<string, string>, exceptVariantId?: string) {
  const r = await tx.query(
    `select options from product_variants where product_id = $1 and deleted_at is null and ($2::uuid is null or id <> $2) limit 1`,
    [productId, exceptVariantId ?? null],
  );
  if (!r.rows[0]) return;
  const want = Object.keys(r.rows[0].options).sort().join(",");
  if (Object.keys(options).sort().join(",") !== want) {
    throw Errors.validation([{ path: "options", message: `Every variant of a product uses the same options (${want || "none"}).` }]);
  }
}

export async function addVariant(d: Deps, ctx: Ctx, sellerId: string, productId: string, v: VariantInput): Promise<string> {
  try {
    return await withTx(d.db, async (tx) => {
      const p = await lockOwn(tx, sellerId, productId);
      if (p.status === "blocked" || p.status === "pending") throw locked(p.status);
      await checkOptionKeys(tx, p.id, v.options);
      const id = randomUUID();
      await tx.query(
        `insert into product_variants (id, product_id, seller_id, sku, options, price_paise, mrp_paise) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, p.id, sellerId, v.sku, JSON.stringify(v.options), v.pricePaise, v.mrpPaise],
      );
      await writeAudit(tx, { ...ctx, action: "variant.create", entity: "product", entityId: p.id, newValue: { variantId: id, sku: v.sku, pricePaise: v.pricePaise, mrpPaise: v.mrpPaise } });
      return id;
    });
  } catch (e) {
    throw uniqueViolation(e) ?? e;
  }
}

export async function updateVariant(
  d: Deps, ctx: Ctx, sellerId: string, productId: string, variantId: string,
  patch: Partial<Pick<VariantInput, "sku" | "options" | "pricePaise" | "mrpPaise">> & { isActive?: boolean | undefined },
) {
  try {
    await withTx(d.db, async (tx) => {
      const p = await lockOwn(tx, sellerId, productId);
      if (p.status === "blocked" || p.status === "pending") throw locked(p.status);
      const r = await tx.query(`select * from product_variants where id = $1 and product_id = $2 and deleted_at is null for update`, [variantId, p.id]);
      const v = r.rows[0];
      if (!v) throw Errors.notFound("Variant");
      if (patch.options) await checkOptionKeys(tx, p.id, patch.options, v.id);
      const price = patch.pricePaise ?? Number(v.price_paise);
      const mrp = patch.mrpPaise ?? Number(v.mrp_paise);
      if (mrp < price) throw Errors.validation([{ path: "mrpPaise", message: "MRP cannot be lower than the price." }]);
      await tx.query(
        `update product_variants set sku = $2, options = $3, price_paise = $4, mrp_paise = $5, is_active = $6 where id = $1`,
        [v.id, patch.sku ?? v.sku, JSON.stringify(patch.options ?? v.options), price, mrp, patch.isActive ?? v.is_active],
      );
      // Price changes are applied at once (they do not need review) and always recorded.
      await writeAudit(tx, {
        ...ctx, action: "variant.update", entity: "product", entityId: p.id,
        oldValue: { variantId: v.id, sku: v.sku, pricePaise: Number(v.price_paise), mrpPaise: Number(v.mrp_paise), isActive: v.is_active },
        newValue: { variantId: v.id, sku: patch.sku ?? v.sku, pricePaise: price, mrpPaise: mrp, isActive: patch.isActive ?? v.is_active },
      });
    });
  } catch (e) {
    throw uniqueViolation(e) ?? e;
  }
}

export async function removeVariant(d: Deps, ctx: Ctx, sellerId: string, productId: string, variantId: string) {
  await withTx(d.db, async (tx) => {
    const p = await lockOwn(tx, sellerId, productId);
    if (p.approved_at) throw Errors.invalidTransition("Variants of a published product can be deactivated, not deleted.");
    if (!DIRECT_EDIT.includes(p.status)) throw locked(p.status);
    const r = await tx.query(`update product_variants set deleted_at = now() where id = $1 and product_id = $2 and deleted_at is null`, [variantId, p.id]);
    if (!r.rowCount) throw Errors.notFound("Variant");
    await writeAudit(tx, { ...ctx, action: "variant.delete", entity: "product", entityId: p.id, oldValue: { variantId } });
  });
}

// ---------- seller: images ----------

async function imageCapacity(tx: Tx, productId: string) {
  const n = await tx.query(`select count(*)::int as n from product_images where product_id = $1 and status <> 'removed'`, [productId]);
  if (n.rows[0].n >= MAX_IMAGES) throw Errors.conflict("TOO_MANY_IMAGES", `A product can have up to ${MAX_IMAGES} photos.`);
}

const keyFor = (prefix: string, size: ImageSize) => `${prefix}-${size}.webp`;

export async function addImage(d: Deps, ctx: Ctx, sellerId: string, productId: string, input: Buffer): Promise<{ id: string; status: string }> {
  await withTx(d.db, async (tx) => {
    const p = await lockOwn(tx, sellerId, productId);
    if (!DIRECT_EDIT.includes(p.status) && !LIVE.includes(p.status)) throw locked(p.status);
    await imageCapacity(tx, p.id);
  });
  let processed;
  try {
    processed = await processProductImage(input);
  } catch (e) {
    if (e instanceof ImageError) throw new AppError(422, "INVALID_IMAGE", e.message);
    throw e;
  }
  const id = randomUUID();
  const prefix = `products/${productId}/${id}`;
  const written: string[] = [];
  try {
    for (const o of processed.outputs) {
      await d.storage.put(keyFor(prefix, o.size), o.body, "image/webp");
      written.push(keyFor(prefix, o.size));
    }
    return await withTx(d.db, async (tx) => {
      const p = await lockOwn(tx, sellerId, productId);
      // Re-check under the lock: status or photo count may have changed while processing.
      if (!DIRECT_EDIT.includes(p.status) && !LIVE.includes(p.status)) throw locked(p.status);
      await imageCapacity(tx, p.id);
      const status = LIVE.includes(p.status) ? "pending_add" : "active";
      if (status === "pending_add") await ensureRevision(tx, p, ctx.actorUserId);
      await tx.query(
        `insert into product_images (id, product_id, key_prefix, width, height, bytes, sort_order, status)
         values ($1, $2, $3, $4, $5, $6, (select coalesce(max(sort_order), -1) + 1 from product_images where product_id = $2), $7)`,
        [id, p.id, prefix, processed.width, processed.height, processed.outputs.reduce((a, o) => a + o.body.length, 0), status],
      );
      await writeAudit(tx, { ...ctx, action: "product.image_add", entity: "product", entityId: p.id, newValue: { imageId: id, status } });
      return { id, status };
    });
  } catch (e) {
    await Promise.all(written.map((k) => d.storage.remove(k).catch(() => {})));
    throw e;
  }
}

export async function removeImage(d: Deps, ctx: Ctx, sellerId: string, productId: string, imageId: string) {
  return withTx(d.db, async (tx) => {
    const p = await lockOwn(tx, sellerId, productId);
    const r = await tx.query(`select status from product_images where id = $1 and product_id = $2 and status <> 'removed' for update`, [imageId, p.id]);
    const img = r.rows[0];
    if (!img) throw Errors.notFound("Photo");
    let next: string;
    if (DIRECT_EDIT.includes(p.status)) next = "removed";
    else if (LIVE.includes(p.status) && img.status === "pending_add") {
      next = "removed";
      await ensureRevision(tx, p, ctx.actorUserId); // the pending change differs now: new version
    }
    else if (LIVE.includes(p.status)) {
      if (img.status === "pending_remove") return { status: img.status };
      next = "pending_remove";
      await ensureRevision(tx, p, ctx.actorUserId);
    } else throw locked(p.status);
    await tx.query(`update product_images set status = $2 where id = $1`, [imageId, next]);
    await writeAudit(tx, { ...ctx, action: "product.image_remove", entity: "product", entityId: p.id, newValue: { imageId, status: next } });
    return { status: next };
  });
}

export async function readImage(d: Deps, productId: string, imageId: string, size: ImageSize, statuses: string[]) {
  const r = await d.db.query(`select key_prefix from product_images where id = $1 and product_id = $2 and status = any($3)`, [imageId, productId, statuses]);
  if (!r.rows[0]) throw Errors.notFound("Photo");
  return d.storage.get(keyFor(r.rows[0].key_prefix, size));
}

// ---------- admin ----------

type AdminAction = "approve" | "reject" | "block" | "unblock";
export async function adminTransition(d: Deps, ctx: Ctx, productId: string, action: AdminAction, reason: string | null, submission?: number) {
  if (action !== "approve" && !reason) throw Errors.validation([{ path: "reason", message: "A reason is required." }]);
  await withTx(d.db, async (tx) => {
    const p = await lockAny(tx, productId);
    if (p.seller_user_id === ctx.actorUserId) throw Errors.forbidden("You cannot review your own products.");
    const from: Record<AdminAction, string[]> = {
      approve: ["pending"], reject: ["pending"], block: ["pending", "active", "archived"], unblock: ["blocked"],
    };
    if (!from[action].includes(p.status)) throw Errors.invalidTransition(`Cannot ${action} a product whose status is ${p.status}.`);
    if ((action === "approve" || action === "reject") && submission !== p.submission) {
      throw Errors.conflict("PRODUCT_CHANGED", "The seller resubmitted this product after you opened it. Reload and review again.");
    }
    let to: string;
    if (action === "approve") {
      if (p.seller_status !== "approved") throw Errors.invalidTransition("The seller is not approved, so their products cannot go live.");
      await checkRefs(tx, contentOf(p));
      const problems = await sellableProblems(tx, p.id, ["active"]);
      if (problems.length) throw notSellable(problems);
      to = "active";
      await tx.query(
        `update products set status = 'active', review_note = null, approved_at = coalesce(approved_at, now()), approved_by = coalesce(approved_by, $2) where id = $1`,
        [p.id, ctx.actorUserId],
      );
    } else {
      // Unblocking never puts a product straight back on sale: the seller relists it.
      to = action === "reject" ? "rejected" : action === "block" ? "blocked" : p.approved_at ? "archived" : "draft";
      await tx.query(`update products set status = $2, review_note = $3 where id = $1`, [p.id, to, reason]);
      if (action === "block") {
        const rev = await pendingRevision(tx, p.id);
        if (rev) {
          await tx.query(`update product_revisions set status = 'rejected', review_note = $2, reviewed_by = $3, reviewed_at = now() where id = $1`, [rev.id, "Product removed by the marketplace", ctx.actorUserId]);
          await revertImages(tx, p.id);
        }
      }
    }
    await writeAudit(tx, { ...ctx, action: `product.${action}`, entity: "product", entityId: p.id, oldValue: { status: p.status }, newValue: { status: to, reason } });
  });
}

export async function reviewRevision(d: Deps, ctx: Ctx, productId: string, version: number, decision: "approve" | "reject", reason: string | null) {
  if (decision === "reject" && !reason) throw Errors.validation([{ path: "reason", message: "A reason is required." }]);
  await withTx(d.db, async (tx) => {
    const p = await lockAny(tx, productId);
    if (p.seller_user_id === ctx.actorUserId) throw Errors.forbidden("You cannot review your own products.");
    const rev = await pendingRevision(tx, p.id);
    if (!rev) throw Errors.notFound("Pending change");
    if (rev.version !== version) {
      throw Errors.conflict("REVISION_CHANGED", "The seller changed this edit after you opened it. Reload and review again.");
    }
    if (decision === "approve") {
      if (!LIVE.includes(p.status)) throw Errors.invalidTransition(`Cannot apply changes to a product whose status is ${p.status}.`);
      const data: Content = rev.data;
      await checkRefs(tx, data);
      const problems = await sellableProblems(tx, p.id, ["active", "pending_add"]);
      if (problems.length) throw notSellable(problems);
      const before = contentOf(p);
      await applyContent(tx, p.id, data);
      await tx.query(`update product_images set status = 'active' where product_id = $1 and status = 'pending_add'`, [p.id]);
      await tx.query(`update product_images set status = 'removed' where product_id = $1 and status = 'pending_remove'`, [p.id]);
      await tx.query(`update product_revisions set status = 'approved', reviewed_by = $2, reviewed_at = now() where id = $1`, [rev.id, ctx.actorUserId]);
      await writeAudit(tx, { ...ctx, action: "product.revision_approve", entity: "product", entityId: p.id, oldValue: before, newValue: data });
    } else {
      await tx.query(`update product_revisions set status = 'rejected', review_note = $2, reviewed_by = $3, reviewed_at = now() where id = $1`, [rev.id, reason, ctx.actorUserId]);
      await revertImages(tx, p.id);
      await writeAudit(tx, { ...ctx, action: "product.revision_reject", entity: "product", entityId: p.id, newValue: { revisionId: rev.id, reason } });
    }
  });
}

// ---------- views ----------

export async function detail(db: Db, productId: string, opts: { sellerId?: string; admin?: boolean }) {
  const p = (await db.query(
    `select p.*, s.display_name as seller_name, s.status as seller_status, c.path as category_path, c.name as category_name, b.name as brand_name
       from products p join sellers s on s.id = p.seller_id join categories c on c.id = p.category_id left join brands b on b.id = p.brand_id
      where p.id = $1 and p.deleted_at is null and ($2::uuid is null or p.seller_id = $2)`,
    [productId, opts.sellerId ?? null],
  )).rows[0];
  if (!p) throw Errors.notFound("Product");
  const variants = await db.query(
    `select id, sku, options, price_paise, mrp_paise, is_active from product_variants where product_id = $1 and deleted_at is null order by created_at`,
    [p.id],
  );
  const images = await db.query(
    `select id, width, height, status, sort_order from product_images where product_id = $1 and status <> 'removed' order by sort_order, created_at`,
    [p.id],
  );
  const rev = (await db.query(`select id, data, version, created_at, updated_at from product_revisions where product_id = $1 and status = 'pending'`, [p.id])).rows[0];
  const lastRev = rev ? null : (await db.query(
    `select status, review_note, reviewed_at from product_revisions where product_id = $1 and status in ('approved', 'rejected') order by reviewed_at desc limit 1`, [p.id],
  )).rows[0];
  return {
    id: p.id, status: p.status, reviewNote: p.review_note, submission: p.submission,
    ...contentOf(p),
    categoryPath: p.category_path, categoryName: p.category_name, brandName: p.brand_name,
    seller: { id: p.seller_id, displayName: p.seller_name, status: opts.admin ? p.seller_status : undefined },
    submittedAt: p.submitted_at, approvedAt: p.approved_at, createdAt: p.created_at, updatedAt: p.updated_at,
    variants: variants.rows.map((v) => ({ id: v.id, sku: v.sku, options: v.options, pricePaise: Number(v.price_paise), mrpPaise: Number(v.mrp_paise), isActive: v.is_active })),
    images: images.rows.map((i) => ({ id: i.id, width: i.width, height: i.height, status: i.status })),
    pendingChange: rev ? { id: rev.id, version: rev.version, data: rev.data, createdAt: rev.created_at, updatedAt: rev.updated_at } : null,
    lastChangeReview: lastRev ? { status: lastRev.status, note: lastRev.review_note, at: lastRev.reviewed_at } : null,
  };
}

export { IMAGE_SIZES, VISIBLE_IMAGE };
