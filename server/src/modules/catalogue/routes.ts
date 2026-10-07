import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, safeText, uuid } from "../../lib/validate.js";
import { AppError, Errors } from "../../lib/errors.js";
import { withTx } from "../../lib/db.js";
import { writeAudit } from "../../lib/audit.js";
import { cursorTime, decodeCursor, encodeCursor, page, pageQuery } from "../../lib/pagination.js";
import { MAX_IMAGE_BYTES } from "../../lib/images.js";
import { authenticate, requirePermission } from "../auth/guard.js";
import { requireApprovedSeller } from "../sellers/guard.js";
import { createSchema, keyValues, patchSchema, type Content } from "./content.js";
import * as svc from "./products.js";
import { availability } from "../inventory/service.js";
import { refreshSearchSoon } from "../inventory/routes.js";

const ctxOf = (req: FastifyRequest): svc.Ctx => ({ actorUserId: req.auth!.userId, ip: req.ip ?? null, requestId: String(req.id) });
const productParam = z.object({ id: uuid() });
const sizeParam = z.enum(["200", "600", "1200"]).transform(Number) as unknown as z.ZodType<200 | 600 | 1200>;
const imageParams = z.object({ id: uuid(), imageId: uuid(), size: sizeParam });
const money = z.number().int().min(100).max(100_000_000);
const sku = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Letters, digits, dot, dash or underscore; up to 64");
const variantBody = z.object({
  sku,
  options: keyValues(5).default({}),
  pricePaise: money,
  mrpPaise: money,
}).strict().refine((v) => v.mrpPaise >= v.pricePaise, { path: ["mrpPaise"], message: "MRP cannot be lower than the price." });
const variantPatch = z.object({
  sku, options: keyValues(5), pricePaise: money, mrpPaise: money, isActive: z.boolean(),
}).partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to update");
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

function sendImage(reply: FastifyReply, body: Buffer, cache: string) {
  return reply.type("image/webp").header("cache-control", cache).header("x-content-type-options", "nosniff").send(body);
}

// Public visibility: live product, approved seller, active category, at least one active variant.
const VISIBLE = `p.status = 'active' and p.deleted_at is null and s.status = 'approved' and c.is_active
  and exists (select 1 from product_variants v where v.product_id = p.id and v.is_active and v.deleted_at is null)`;

// ---------------- seller ----------------

export async function sellerCatalogueRoutes(app: FastifyInstance): Promise<void> {
  const deps = (): svc.Deps => ({ db: app.db, storage: app.storage });
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireApprovedSeller);
  const sid = (req: FastifyRequest) => req.seller!.id;

  app.get("/", async (req) => {
    const q = parse(pageQuery.extend({ status: z.enum(["draft", "pending", "active", "rejected", "archived", "blocked"]).optional() }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select p.id, p.title, p.status, p.created_at, p.updated_at, ${cursorTime("p.created_at")},
              exists (select 1 from product_revisions r where r.product_id = p.id and r.status = 'pending') as has_pending_change,
              (select min(price_paise) from product_variants v where v.product_id = p.id and v.deleted_at is null and v.is_active) as min_price
         from products p
        where p.seller_id = $1 and p.deleted_at is null and ($2::text is null or p.status = $2)
          and ($3::timestamptz is null or (p.created_at, p.id) < ($3, $4::uuid))
        order by p.created_at desc, p.id desc limit $5`,
      [sid(req), q.status ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1],
    );
    const pg = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return {
      items: pg.items.map((x: any) => ({ id: x.id, title: x.title, status: x.status, hasPendingChange: x.has_pending_change, minPricePaise: x.min_price === null ? null : Number(x.min_price), createdAt: x.created_at, updatedAt: x.updated_at })),
      nextCursor: pg.nextCursor,
    };
  });

  app.post("/", async (req, reply) => {
    const body = parse(createSchema, req.body) as Content;
    const id = await svc.create(deps(), ctxOf(req), sid(req), body);
    return reply.code(201).send(await svc.detail(app.db, id, { sellerId: sid(req) }));
  });

  app.get("/:id", async (req) => svc.detail(app.db, parse(productParam, req.params).id, { sellerId: sid(req) }));

  app.patch("/:id", async (req) => {
    const { id } = parse(productParam, req.params);
    const res = await svc.updateContent(deps(), ctxOf(req), sid(req), id, parse(patchSchema, req.body) as Partial<Content>);
    return { ...(await svc.detail(app.db, id, { sellerId: sid(req) })), changeMode: res.mode };
  });

  app.delete("/:id", async (req, reply) => {
    await svc.remove(deps(), ctxOf(req), sid(req), parse(productParam, req.params).id);
    return reply.code(204).send();
  });

  for (const action of ["submit", "withdraw", "archive", "unarchive"] as const) {
    app.post(`/:id/${action}`, async (req) => {
      const { id } = parse(productParam, req.params);
      await svc.sellerTransition(deps(), ctxOf(req), sid(req), id, action);
      return svc.detail(app.db, id, { sellerId: sid(req) });
    });
  }

  app.delete("/:id/pending-change", async (req, reply) => {
    await svc.discardRevision(deps(), ctxOf(req), sid(req), parse(productParam, req.params).id);
    return reply.code(204).send();
  });

  app.post("/:id/variants", async (req, reply) => {
    const { id } = parse(productParam, req.params);
    const vid = await svc.addVariant(deps(), ctxOf(req), sid(req), id, parse(variantBody, req.body));
    return reply.code(201).send({ id: vid });
  });

  app.patch("/:id/variants/:variantId", async (req, reply) => {
    const p = parse(z.object({ id: uuid(), variantId: uuid() }), req.params);
    await svc.updateVariant(deps(), ctxOf(req), sid(req), p.id, p.variantId, parse(variantPatch, req.body));
    return reply.code(204).send();
  });

  app.delete("/:id/variants/:variantId", async (req, reply) => {
    const p = parse(z.object({ id: uuid(), variantId: uuid() }), req.params);
    await svc.removeVariant(deps(), ctxOf(req), sid(req), p.id, p.variantId);
    return reply.code(204).send();
  });

  app.post("/:id/images", { config: { rateLimit: { max: 60, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { id } = parse(productParam, req.params);
    if (!req.isMultipart()) throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload the photo as multipart/form-data.");
    const tooLarge = () => new AppError(413, "FILE_TOO_LARGE", "Photos can be up to 8 MB.");
    let body: Buffer;
    try {
      const part = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 } });
      if (!part) throw Errors.validation([{ path: "file", message: "Attach a photo." }]);
      body = await part.toBuffer();
      if (part.file.truncated) throw tooLarge();
    } catch (e: any) {
      if (e instanceof AppError) throw e;
      if (e?.code === "FST_REQ_FILE_TOO_LARGE" || e?.statusCode === 413) throw tooLarge();
      throw new AppError(400, "BAD_REQUEST", "The upload could not be read. Try again.");
    }
    return reply.code(201).send(await svc.addImage(deps(), ctxOf(req), sid(req), id, body));
  });

  app.delete("/:id/images/:imageId", async (req) => {
    const p = parse(z.object({ id: uuid(), imageId: uuid() }), req.params);
    return svc.removeImage(deps(), ctxOf(req), sid(req), p.id, p.imageId);
  });

  // Preview of any photo of your own product, including ones waiting for review.
  app.get("/:id/images/:imageId/:size", async (req, reply) => {
    const p = parse(imageParams, req.params);
    await svc.detail(app.db, p.id, { sellerId: sid(req) }); // ownership check (404 otherwise)
    return sendImage(reply, await svc.readImage(deps(), p.id, p.imageId, p.size, ["active", "pending_add", "pending_remove"]), "private, no-store");
  });
}

// ---------------- admin ----------------

export async function adminCatalogueRoutes(app: FastifyInstance): Promise<void> {
  const deps = (): svc.Deps => ({ db: app.db, storage: app.storage });
  const manage = requirePermission("admin.catalogue.manage");
  const review = requirePermission("admin.products.review");
  app.addHook("preHandler", authenticate);

  // Categories. Slugs never change (they form the paths used in links); products attach only to leaf categories.
  app.post("/categories", { preHandler: manage }, async (req, reply) => {
    const b = parse(z.object({
      name: safeText(1, 80), slug: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60).optional(),
      parentId: uuid().nullable().optional(), sortOrder: z.number().int().min(-1000).max(1000).optional(),
    }).strict(), req.body);
    const slug = b.slug ?? slugify(b.name);
    if (!slug) throw Errors.validation([{ path: "slug", message: "Give a slug using letters or digits." }]);
    const id = await withTx(app.db, async (tx) => {
      let path = slug, depth = 0;
      if (b.parentId) {
        const par = (await tx.query(`select path, depth from categories where id = $1 for update`, [b.parentId])).rows[0];
        if (!par) throw Errors.notFound("Parent category");
        const used = await tx.query(`select 1 from products where category_id = $1 and deleted_at is null limit 1`, [b.parentId]);
        if (used.rowCount) throw Errors.conflict("CATEGORY_HAS_PRODUCTS", "Products use this category, so it cannot get subcategories.");
        path = `${par.path}/${slug}`;
        depth = par.depth + 1;
        if (depth > 4) throw Errors.validation([{ path: "parentId", message: "Categories can be at most 5 levels deep." }]);
      }
      try {
        const r = await tx.query(
          `insert into categories (parent_id, slug, name, path, depth, sort_order) values ($1, $2, $3, $4, $5, $6) returning id`,
          [b.parentId ?? null, slug, b.name, path, depth, b.sortOrder ?? 0],
        );
        await writeAudit(tx, { ...ctxOf(req), action: "category.create", entity: "category", entityId: r.rows[0].id, newValue: { name: b.name, path } });
        return r.rows[0].id as string;
      } catch (e: any) {
        if (e?.code === "23505") throw Errors.conflict("CATEGORY_EXISTS", "A category with this slug already exists here.");
        throw e;
      }
    });
    return reply.code(201).send({ id });
  });

  app.patch("/categories/:id", { preHandler: manage }, async (req) => {
    const { id } = parse(productParam, req.params);
    const b = parse(z.object({ name: safeText(1, 80), sortOrder: z.number().int().min(-1000).max(1000), isActive: z.boolean() }).partial().strict(), req.body);
    await withTx(app.db, async (tx) => {
      const cur = (await tx.query(`select * from categories where id = $1 for update`, [id])).rows[0];
      if (!cur) throw Errors.notFound("Category");
      if (b.isActive === false && cur.is_active) {
        const kids = await tx.query(`select 1 from categories where parent_id = $1 and is_active limit 1`, [id]);
        if (kids.rowCount) throw Errors.conflict("CATEGORY_HAS_CHILDREN", "Deactivate its subcategories first.");
        const live = await tx.query(`select 1 from products where category_id = $1 and status in ('active', 'pending') and deleted_at is null limit 1`, [id]);
        if (live.rowCount) throw Errors.conflict("CATEGORY_HAS_PRODUCTS", "Live or pending products use this category. Move them first.");
      }
      await tx.query(
        `update categories set name = coalesce($2, name), sort_order = coalesce($3, sort_order), is_active = coalesce($4, is_active) where id = $1`,
        [id, b.name ?? null, b.sortOrder ?? null, b.isActive ?? null],
      );
      await writeAudit(tx, { ...ctxOf(req), action: "category.update", entity: "category", entityId: id, oldValue: { name: cur.name, sortOrder: cur.sort_order, isActive: cur.is_active }, newValue: b });
    });
    await refreshSearchSoon(app);
    return { ok: true };
  });

  app.post("/brands", { preHandler: manage }, async (req, reply) => {
    const b = parse(z.object({ name: safeText(1, 80) }).strict(), req.body);
    const slug = slugify(b.name);
    if (!slug) throw Errors.validation([{ path: "name", message: "Use letters or digits." }]);
    try {
      const r = await app.db.query(`insert into brands (name, slug) values ($1, $2) returning id`, [b.name, slug]);
      await writeAudit(app.db, { ...ctxOf(req), action: "brand.create", entity: "brand", entityId: r.rows[0].id, newValue: b });
      return reply.code(201).send({ id: r.rows[0].id });
    } catch (e: any) {
      if (e?.code === "23505") throw Errors.conflict("BRAND_EXISTS", "This brand already exists.");
      throw e;
    }
  });

  app.patch("/brands/:id", { preHandler: manage }, async (req) => {
    const { id } = parse(productParam, req.params);
    const b = parse(z.object({ isActive: z.boolean() }).strict(), req.body);
    const r = await app.db.query(`update brands set is_active = $2 where id = $1 returning id`, [id, b.isActive]);
    if (!r.rowCount) throw Errors.notFound("Brand");
    await writeAudit(app.db, { ...ctxOf(req), action: "brand.update", entity: "brand", entityId: id, newValue: b });
    return { ok: true };
  });

  app.post("/gst-rates", { preHandler: manage }, async (req, reply) => {
    const b = parse(z.object({ rateBp: z.number().int().min(0).max(10000), label: safeText(1, 20) }).strict(), req.body);
    try {
      await app.db.query(`insert into gst_rates (rate_bp, label) values ($1, $2)`, [b.rateBp, b.label]);
    } catch (e: any) {
      if (e?.code === "23505") throw Errors.conflict("GST_RATE_EXISTS", "This rate already exists.");
      throw e;
    }
    await writeAudit(app.db, { ...ctxOf(req), action: "gst_rate.create", entity: "gst_rate", entityId: String(b.rateBp), newValue: b });
    return reply.code(201).send({ ok: true });
  });

  app.patch("/gst-rates/:rateBp", { preHandler: manage }, async (req) => {
    const { rateBp } = parse(z.object({ rateBp: z.coerce.number().int().min(0).max(10000) }), req.params);
    const b = parse(z.object({ isActive: z.boolean() }).strict(), req.body);
    const r = await app.db.query(`update gst_rates set is_active = $2 where rate_bp = $1 returning rate_bp`, [rateBp, b.isActive]);
    if (!r.rowCount) throw Errors.notFound("GST rate");
    await writeAudit(app.db, { ...ctxOf(req), action: "gst_rate.update", entity: "gst_rate", entityId: String(rateBp), newValue: b });
    return { ok: true };
  });

  // Review queues.
  app.get("/products", { preHandler: review }, async (req) => {
    const q = parse(pageQuery.extend({
      status: z.enum(["draft", "pending", "active", "rejected", "archived", "blocked"]).optional(),
      sellerId: uuid().optional(),
    }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select p.id, p.title, p.status, p.submitted_at, p.created_at, ${cursorTime("p.created_at")}, s.display_name
         from products p join sellers s on s.id = p.seller_id
        where p.deleted_at is null and ($1::text is null or p.status = $1) and ($2::uuid is null or p.seller_id = $2)
          and ($3::timestamptz is null or (p.created_at, p.id) < ($3, $4::uuid))
        order by p.created_at desc, p.id desc limit $5`,
      [q.status ?? null, q.sellerId ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1],
    );
    const pg = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return { items: pg.items.map((x: any) => ({ id: x.id, title: x.title, status: x.status, sellerName: x.display_name, submittedAt: x.submitted_at, createdAt: x.created_at })), nextCursor: pg.nextCursor };
  });

  app.get("/pending-changes", { preHandler: review }, async (req) => {
    const q = parse(pageQuery, req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select r.id, r.product_id, r.version, r.created_at, ${cursorTime("r.created_at")}, p.title, s.display_name
         from product_revisions r join products p on p.id = r.product_id join sellers s on s.id = p.seller_id
        where r.status = 'pending' and ($1::timestamptz is null or (r.created_at, r.id) < ($1, $2::uuid))
        order by r.created_at desc, r.id desc limit $3`,
      [c?.t ?? null, c?.id ?? null, q.limit + 1],
    );
    const pg = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return { items: pg.items.map((x: any) => ({ revisionId: x.id, productId: x.product_id, version: x.version, title: x.title, sellerName: x.display_name, createdAt: x.created_at })), nextCursor: pg.nextCursor };
  });

  app.get("/products/:id", { preHandler: review }, async (req) => svc.detail(app.db, parse(productParam, req.params).id, { admin: true }));

  app.get("/products/:id/images/:imageId/:size", { preHandler: review }, async (req, reply) => {
    const p = parse(imageParams, req.params);
    return sendImage(reply, await svc.readImage(deps(), p.id, p.imageId, p.size, ["active", "pending_add", "pending_remove"]), "private, no-store");
  });

  // approve and reject name the submission the admin reviewed (from GET /products/:id).
  const decisionBody = z.object({ submission: z.number().int().min(1), reason: safeText(3, 500).optional() }).strict();
  const reasonBody = z.object({ reason: safeText(3, 500).optional() }).strict();
  for (const action of ["approve", "reject", "block", "unblock"] as const) {
    app.post(`/products/:id/${action}`, { preHandler: review }, async (req) => {
      const { id } = parse(productParam, req.params);
      const b = action === "approve" || action === "reject"
        ? parse(decisionBody, req.body ?? {})
        : { ...parse(reasonBody, req.body ?? {}), submission: undefined };
      await svc.adminTransition(deps(), ctxOf(req), id, action, b.reason ?? null, b.submission);
      return svc.detail(app.db, id, { admin: true });
    });
  }

  const revBody = z.object({ version: z.number().int().min(1), reason: safeText(3, 500).optional() }).strict();
  for (const decision of ["approve", "reject"] as const) {
    app.post(`/products/:id/pending-change/${decision}`, { preHandler: review }, async (req) => {
      const { id } = parse(productParam, req.params);
      const b = parse(revBody, req.body);
      await svc.reviewRevision(deps(), ctxOf(req), id, b.version, decision, b.reason ?? null);
      return svc.detail(app.db, id, { admin: true });
    });
  }
}

// ---------------- public ----------------

export async function publicCatalogueRoutes(app: FastifyInstance): Promise<void> {
  const deps = (): svc.Deps => ({ db: app.db, storage: app.storage });

  app.get("/categories", async () => {
    const r = await app.db.query(`select id, parent_id, slug, name, path, depth from categories where is_active order by path`);
    return { items: r.rows.map((c) => ({ id: c.id, parentId: c.parent_id, slug: c.slug, name: c.name, path: c.path, depth: c.depth })) };
  });

  app.get("/brands", async () => {
    const r = await app.db.query(`select id, name, slug from brands where is_active order by name`);
    return { items: r.rows };
  });

  app.get("/gst-rates", async () => {
    const r = await app.db.query(`select rate_bp, label from gst_rates where is_active order by rate_bp`);
    return { items: r.rows.map((g) => ({ rateBp: g.rate_bp, label: g.label })) };
  });

  // Browse and search. Full-text with typo tolerance, filters, sorting and cursor pagination.
  const list = (max: number) => z.string().trim().max(400).optional()
    .transform((v) => (v ? [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean))] : undefined))
    .refine((v) => !v || v.length <= max, `At most ${max} values`);
  const rupees = z.coerce.number().min(0).max(1_000_000).optional();
  app.get("/products", async (req) => {
    const q = parse(z.object({
      q: z.string().max(200).optional(),
      category: z.string().trim().regex(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/).max(300).optional(),
      brand: list(10).refine((v) => !v || v.every((b) => /^[a-z0-9-]{1,60}$/.test(b)), "Invalid brand"),
      sellerId: uuid().optional(),
      condition: list(5).refine((v) => !v || v.every((c) => ["new_with_tags", "new", "very_good", "good", "satisfactory"].includes(c)), "Invalid condition"),
      // Price filters are in rupees for convenience; results carry prices in paise.
      minPrice: rupees,
      maxPrice: rupees,
      sort: z.enum(["relevance", "newest", "price_asc", "price_desc"]).optional(),
      includeOutOfStock: z.enum(["true", "false"]).optional(),
      limit: z.coerce.number().int().min(1).max(60).default(24),
      cursor: z.string().max(300).optional(),
    }), req.query);
    return app.searchService.search({
      q: q.q, category: q.category, brands: q.brand, sellerId: q.sellerId, conditions: q.condition,
      minPricePaise: q.minPrice === undefined ? undefined : Math.round(q.minPrice * 100),
      maxPricePaise: q.maxPrice === undefined ? undefined : Math.round(q.maxPrice * 100),
      sort: q.sort, limit: q.limit, cursor: q.cursor, includeOutOfStock: q.includeOutOfStock === "true",
    });
  });

  app.get("/products/:id", async (req) => {
    const { id } = parse(productParam, req.params);
    const ok = await app.db.query(
      `select 1 from products p join sellers s on s.id = p.seller_id join categories c on c.id = p.category_id where p.id = $1 and ${VISIBLE}`,
      [id],
    );
    if (!ok.rowCount) throw Errors.notFound("Product");
    const d = await svc.detail(app.db, id, {});
    const avail = await availability(app.db, d.variants.map((v) => v.id));
    // Public view: live content only. Pending edits, inactive variants and review notes stay private.
    return {
      id: d.id, title: d.title, description: d.description, condition: d.condition, attributes: d.attributes,
      categoryPath: d.categoryPath, categoryName: d.categoryName, brandName: d.brandName, gstRateBp: d.gstRateBp, currency: d.currency,
      seller: { id: d.seller.id, displayName: d.seller.displayName },
      // Exact stock is not published; buyers see whether a variant can be bought and "only N left" when few remain.
      variants: d.variants.filter((v) => v.isActive).map(({ isActive: _a, ...v }) => {
        const n = avail.get(v.id) ?? 0;
        return { ...v, inStock: n > 0, onlyLeft: n > 0 && n <= 3 ? n : null };
      }),
      images: d.images.filter((i) => svc.VISIBLE_IMAGE.includes(i.status)).map(({ status: _s, ...i }) => i),
    };
  });

  // Live photos of visible products. Cached for an hour, so a removed photo disappears within that time.
  app.get("/media/products/:id/:imageId/:size", async (req, reply) => {
    const p = parse(imageParams, req.params);
    const ok = await app.db.query(
      `select 1 from products p join sellers s on s.id = p.seller_id join categories c on c.id = p.category_id where p.id = $1 and ${VISIBLE}`,
      [p.id],
    );
    if (!ok.rowCount) throw Errors.notFound("Photo");
    return sendImage(reply, await svc.readImage(deps(), p.id, p.imageId, p.size, svc.VISIBLE_IMAGE), "public, max-age=3600");
  });
}
