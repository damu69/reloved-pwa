import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, uuid, safeText } from "../../lib/validate.js";
import { Errors } from "../../lib/errors.js";
import { withTx, type Queryable } from "../../lib/db.js";
import { windowLimiter } from "../../lib/limiter.js";
import { writeAudit } from "../../lib/audit.js";
import { authenticate, requirePermission } from "../auth/guard.js";

// A seller shows under "Top rated sellers" only with at least this many ratings, so one 5-star rating cannot rank a new seller first.
export const TOP_MIN_RATINGS = 3;
export const TOP_LIMIT = 8;
const EDIT_DAYS = 7;
// A product a buyer can actually open: live, with an active variant, in an active category (same rule as the public catalogue).
const LIVE = (alias: string) => `${alias}.status = 'active' and ${alias}.deleted_at is null
  and exists (select 1 from categories c where c.id = ${alias}.category_id and c.is_active)
  and exists (select 1 from product_variants v where v.product_id = ${alias}.id and v.is_active and v.deleted_at is null)`;

const idParam = z.object({ id: uuid() });
const body = z.object({
  stars: z.number().int().min(1, "Choose 1 to 5 stars").max(5, "Choose 1 to 5 stars"),
  comment: safeText(0, 300).optional().transform((s) => (s ? s : null)),
}).strict();

const ratingOut = (r: any) => ({
  id: r.id, packageId: r.seller_order_id, sellerId: r.seller_id, stars: r.stars, comment: r.comment,
  createdAt: r.created_at, updatedAt: r.updated_at,
  canEdit: !r.removed_at && Date.now() < new Date(r.created_at).getTime() + EDIT_DAYS * 86_400_000,
});

// Average (one decimal) and count of a seller's ratings that have not been removed.
export async function sellerRatingSummary(db: Queryable, sellerId: string): Promise<{ ratingAvg: number | null; ratingCount: number }> {
  const r = await db.query(`select count(*)::int n, avg(stars)::float8 a from seller_ratings where seller_id = $1 and removed_at is null`, [sellerId]);
  const n: number = r.rows[0].n;
  return { ratingAvg: n ? Math.round(r.rows[0].a * 10) / 10 : null, ratingCount: n };
}

// Signed-in buyer: rate the seller of a delivered package, see your ratings.
export async function ratingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const uid = (req: FastifyRequest) => req.auth!.userId;
  const writeLimit = windowLimiter("rating-write", 30, 60 * 60_000, uid);

  // Every rating the signed-in user has given, so the order screens can show "Rated 4 stars" or "Rate this seller".
  app.get("/mine", async (req) => {
    const r = await app.db.query(`select * from seller_ratings where buyer_id = $1 and removed_at is null order by created_at desc limit 200`, [uid(req)]);
    return { items: r.rows.map(ratingOut) };
  });

  // Create or change the rating for one package. Only the buyer of a delivered package; changes only within 7 days of the first rating.
  app.put("/packages/:id", { preHandler: [writeLimit] }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(body, req.body);
    const out = await withTx(app.db, async (tx) => {
      const p = (await tx.query(
        `select so.id, so.status, so.seller_id, o.user_id as buyer_id, s.user_id as seller_user_id
           from seller_orders so join orders o on o.id = so.order_id join sellers s on s.id = so.seller_id
          where so.id = $1 for share of so`, [id])).rows[0];
      // Someone else's package looks the same as a missing one.
      if (!p || p.buyer_id !== uid(req)) throw Errors.notFound("Order");
      if (p.seller_user_id === uid(req)) throw Errors.conflict("OWN_SELLER", "You cannot rate your own shop.");
      if (p.status !== "delivered") throw Errors.conflict("NOT_DELIVERED", "You can rate a seller once your package has been delivered.");
      const ex = (await tx.query(`select * from seller_ratings where seller_order_id = $1 for update`, [id])).rows[0];
      if (!ex) {
        const ins = await tx.query(
          `insert into seller_ratings (seller_order_id, seller_id, buyer_id, stars, comment) values ($1, $2, $3, $4, $5) returning *`,
          [id, p.seller_id, uid(req), b.stars, b.comment]);
        return { row: ins.rows[0], created: true };
      }
      if (ex.removed_at) throw Errors.conflict("RATING_REMOVED", "This rating was removed and cannot be changed.");
      if (!ratingOut(ex).canEdit) throw Errors.conflict("RATING_LOCKED", `A rating can be changed within ${EDIT_DAYS} days of giving it.`);
      const upd = await tx.query(`update seller_ratings set stars = $2, comment = $3 where id = $1 returning *`, [ex.id, b.stars, b.comment]);
      return { row: upd.rows[0], created: false };
    });
    return reply.code(out.created ? 201 : 200).send(ratingOut(out.row));
  });
}

// Public: top rated sellers for the home page, and one seller's rating summary with recent comments.
export async function publicRatingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/top", async (_req, reply) => {
    const r = await app.db.query(
      `select s.id, s.display_name, round(avg(r.stars)::numeric, 1)::float8 as avg, count(*)::int as n,
              (select count(*)::int from products p where p.seller_id = s.id and ${LIVE("p")}) as items
         from sellers s join seller_ratings r on r.seller_id = s.id and r.removed_at is null
        where s.status = 'approved'
          and exists (select 1 from products p where p.seller_id = s.id and ${LIVE("p")})
        group by s.id
       having count(*) >= $1
        order by avg(r.stars) desc, count(*) desc, s.display_name, s.id
        limit $2`, [TOP_MIN_RATINGS, TOP_LIMIT]);
    reply.header("cache-control", "public, max-age=60");
    return { minRatings: TOP_MIN_RATINGS, items: r.rows.map((x) => ({ id: x.id, displayName: x.display_name, ratingAvg: x.avg, ratingCount: x.n, itemCount: x.items })) };
  });

  app.get("/:id/ratings", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const s = (await app.db.query(`select id, display_name from sellers where id = $1 and status = 'approved'`, [id])).rows[0];
    if (!s) throw Errors.notFound("Seller");
    const sum = await sellerRatingSummary(app.db, id);
    const dist = (await app.db.query(`select stars, count(*)::int n from seller_ratings where seller_id = $1 and removed_at is null group by stars`, [id])).rows;
    const recent = (await app.db.query(
      `select r.stars, r.comment, r.created_at, split_part(u.full_name, ' ', 1) as buyer
         from seller_ratings r join users u on u.id = r.buyer_id
        where r.seller_id = $1 and r.removed_at is null order by r.created_at desc, r.id limit 20`, [id])).rows;
    reply.header("cache-control", "public, max-age=60");
    return {
      seller: { id: s.id, displayName: s.display_name }, ...sum,
      distribution: [5, 4, 3, 2, 1].map((st) => ({ stars: st, count: dist.find((d) => d.stars === st)?.n ?? 0 })),
      recent: recent.map((x) => ({ stars: x.stars, comment: x.comment, buyerName: x.buyer || "Buyer", createdAt: x.created_at })),
    };
  });
}

// Admin: take an abusive rating out of every average. The row stays for the record.
export async function adminRatingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requirePermission("admin.reports.manage"));
  // Newest ratings first, so an admin can find and remove abusive ones. status=removed shows the ones already taken out.
  app.get("/", async (req) => {
    const q = parse(z.object({ status: z.enum(["live", "removed"]).default("live"), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const r = await app.db.query(
      `select r.id, r.stars, r.comment, r.created_at, r.removed_at, r.removal_reason, r.seller_id, s.display_name as seller, u.full_name as buyer
         from seller_ratings r join sellers s on s.id = r.seller_id join users u on u.id = r.buyer_id
        where (r.removed_at is not null) = ($1 = 'removed') order by r.created_at desc, r.id limit $2`, [q.status, q.limit]);
    return { items: r.rows.map((x) => ({ id: x.id, stars: x.stars, comment: x.comment, createdAt: x.created_at, sellerId: x.seller_id, sellerName: x.seller, buyerName: x.buyer, removedAt: x.removed_at, removalReason: x.removal_reason })) };
  });
  app.post("/:id/remove", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: safeText(3, 300) }).strict(), req.body);
    await withTx(app.db, async (tx) => {
      const r = (await tx.query(`select * from seller_ratings where id = $1 for update`, [id])).rows[0];
      if (!r) throw Errors.notFound("Rating");
      if (r.removed_at) return;
      await tx.query(`update seller_ratings set removed_at = now(), removed_by = $2, removal_reason = $3 where id = $1`, [id, req.auth!.userId, b.reason]);
      await writeAudit(tx, { actorUserId: req.auth!.userId, action: "rating.remove", entity: "seller_rating", entityId: id, oldValue: { stars: r.stars, comment: r.comment }, newValue: { reason: b.reason }, ip: req.ip, requestId: String(req.id) });
    });
    return { ok: true };
  });
}
