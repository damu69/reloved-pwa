// Reports and blocks. Anyone signed in can report a listing, a user or a conversation, and block a user.
// Blocking stops both sides from starting or continuing chats with each other. Admins work the report queue.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, uuid } from "../../lib/validate.js";
import { Errors } from "../../lib/errors.js";
import { withTx } from "../../lib/db.js";
import { writeAudit } from "../../lib/audit.js";
import { windowLimiter } from "../../lib/limiter.js";
import { authenticate, requirePermission } from "../auth/guard.js";

const REASONS = ["counterfeit", "prohibited", "misleading", "abusive", "spam", "scam", "other"] as const;

export async function blockedEitherWay(q: { query: (sql: string, p: unknown[]) => Promise<{ rowCount: number | null }> }, a: string, b: string): Promise<boolean> {
  const r = await q.query(`select 1 from user_blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1) limit 1`, [a, b]);
  return (r.rowCount ?? 0) > 0;
}

export async function safetyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const reportLimit = windowLimiter("report", 20, 60 * 60_000, (r) => r.auth!.userId);
  const uid = (r: { auth: { userId: string } | null }) => r.auth!.userId;

  app.post("/reports", { preHandler: [reportLimit] }, async (req, reply) => {
    const b = parse(z.object({
      targetType: z.enum(["product", "user", "conversation"]), targetId: uuid(), reason: z.enum(REASONS),
      details: z.string().trim().max(1000, "Details can be up to 1000 characters").optional(),
    }).strict(), req.body);
    const exists = b.targetType === "product" ? await app.db.query(`select 1 from products where id = $1`, [b.targetId])
      : b.targetType === "user" ? await app.db.query(`select 1 from users where id = $1 and deleted_at is null`, [b.targetId])
      : await app.db.query(`select 1 from conversations where id = $1 and (buyer_id = $2 or seller_user_id = $2)`, [b.targetId, uid(req)]);
    if (!exists.rowCount) throw Errors.notFound("The thing you are reporting");
    if (b.targetType === "user" && b.targetId === uid(req)) throw Errors.conflict("OWN_ACCOUNT", "You cannot report yourself.");
    await app.db.query(
      `insert into reports (reporter_id, target_type, target_id, reason, details) values ($1, $2, $3, $4, $5)
       on conflict (reporter_id, target_type, target_id) where status = 'open' do nothing`,
      [uid(req), b.targetType, b.targetId, b.reason, b.details || null],
    );
    return reply.code(201).send({ message: "Thanks. We will review your report." });
  });

  app.get("/blocks", async (req) => {
    const r = await app.db.query(
      `select u.id, u.full_name as "name", b.created_at as "createdAt" from user_blocks b join users u on u.id = b.blocked_id
        where b.blocker_id = $1 order by b.created_at desc`, [uid(req)]);
    return { items: r.rows };
  });

  app.post("/blocks", async (req, reply) => {
    const b = parse(z.object({ userId: uuid() }).strict(), req.body);
    if (b.userId === uid(req)) throw Errors.conflict("OWN_ACCOUNT", "You cannot block yourself.");
    const t = await app.db.query(`select 1 from users where id = $1 and deleted_at is null`, [b.userId]);
    if (!t.rowCount) throw Errors.notFound("User");
    await app.db.query(`insert into user_blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`, [uid(req), b.userId]);
    return reply.code(204).send();
  });

  app.delete("/blocks/:userId", async (req, reply) => {
    const { userId } = parse(z.object({ userId: uuid() }), req.params);
    await app.db.query(`delete from user_blocks where blocker_id = $1 and blocked_id = $2`, [uid(req), userId]);
    return reply.code(204).send();
  });
}

export async function adminReportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requirePermission("admin.reports.manage"));

  app.get("/", async (req) => {
    const q = parse(z.object({ status: z.enum(["open", "actioned", "dismissed"]).default("open") }), req.query);
    const r = await app.db.query(
      `select r.id, r.target_type as "targetType", r.target_id as "targetId", r.reason, r.details, r.status, r.admin_note as "adminNote",
              r.created_at as "createdAt", ru.full_name as "reporterName",
              case r.target_type when 'product' then (select title from products where id = r.target_id)
                                 when 'user' then (select full_name from users where id = r.target_id)
                                 else 'Conversation' end as "targetLabel"
         from reports r join users ru on ru.id = r.reporter_id where r.status = $1 order by r.created_at desc limit 200`, [q.status]);
    return { items: r.rows };
  });

  // Resolve a report. action "remove" archives a reported listing; "suspend" suspends the reported user
  // (or the seller of a reported listing); "dismiss" closes it with no action.
  app.post("/:id/resolve", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid() }), req.params);
    const b = parse(z.object({ action: z.enum(["dismiss", "remove", "suspend"]), note: z.string().trim().max(500).optional() }).strict(), req.body);
    await withTx(app.db, async (tx) => {
      const r = (await tx.query(`select * from reports where id = $1 and status = 'open' for update`, [id])).rows[0];
      if (!r) throw Errors.notFound("Open report");
      if (b.action === "remove") {
        if (r.target_type !== "product") throw Errors.invalidTransition("Only listings can be removed.");
        await tx.query(`update products set status = 'archived' where id = $1`, [r.target_id]);
      }
      if (b.action === "suspend") {
        const userId = r.target_type === "user" ? r.target_id
          : r.target_type === "product" ? (await tx.query(`select s.user_id from products p join sellers s on s.id = p.seller_id where p.id = $1`, [r.target_id])).rows[0]?.user_id
          : null;
        if (!userId) throw Errors.invalidTransition("This report has no user to suspend.");
        await tx.query(`update users set status = 'suspended' where id = $1 and status = 'active'`, [userId]);
        await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'suspended' where user_id = $1 and revoked_at is null`, [userId]);
      }
      await tx.query(
        `update reports set status = $2, admin_note = $3, resolved_by = $4, resolved_at = now() where id = $1`,
        [id, b.action === "dismiss" ? "dismissed" : "actioned", b.note || null, req.auth!.userId],
      );
      await writeAudit(tx, { actorUserId: req.auth!.userId, action: `report.${b.action}`, entity: "report", entityId: id, ip: req.ip, requestId: req.id });
    });
    return reply.code(204).send();
  });
}
