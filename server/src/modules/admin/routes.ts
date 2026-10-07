import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, safeText, uuid as uuidField } from "../../lib/validate.js";
import { Errors } from "../../lib/errors.js";
import { withTx } from "../../lib/db.js";
import { writeAudit } from "../../lib/audit.js";
import { cursorTime, decodeCursor, encodeCursor, page, pageQuery } from "../../lib/pagination.js";
import { authenticate, requirePermission } from "../auth/guard.js";

const uuid = uuidField();
const idParam = z.object({ id: uuid });
const roleKey = z.enum(["customer", "seller", "admin"]);
const ctx = (req: FastifyRequest) => ({ actorUserId: req.auth!.userId, ip: req.ip ?? null, requestId: String(req.id) });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  app.addHook("preHandler", authenticate);

  app.get("/users", { preHandler: requirePermission("admin.users.read") }, async (req) => {
    const q = parse(pageQuery.extend({
      q: z.string().trim().max(100).optional(),
      status: z.enum(["active", "suspended", "deleted"]).optional(),
      role: roleKey.optional(),
    }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await db.query(
      `select u.id, u.email, u.full_name, u.phone, u.status, u.created_at, ${cursorTime("u.created_at")},
              coalesce((select array_agg(role_key order by role_key) from user_roles where user_id = u.id), '{}') as roles
         from users u
        where ($1::text is null or u.email ilike '%' || $1 || '%' or u.full_name ilike '%' || $1 || '%')
          and ($2::text is null or u.status = $2)
          and ($3::text is null or exists (select 1 from user_roles x where x.user_id = u.id and x.role_key = $3))
          and ($4::timestamptz is null or (u.created_at, u.id) < ($4, $5::uuid))
        order by u.created_at desc, u.id desc
        limit $6`,
      [q.q ?? null, q.status ?? null, q.role ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1],
    );
    const p = page(r.rows, q.limit, (u: any) => encodeCursor(u.cursor_t, u.id));
    return {
      items: p.items.map((u: any) => ({ id: u.id, email: u.email, fullName: u.full_name, phone: u.phone, status: u.status, roles: u.roles, createdAt: u.created_at })),
      nextCursor: p.nextCursor,
    };
  });

  app.post("/users/:id/roles", { preHandler: requirePermission("admin.roles.manage") }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { role } = parse(z.object({ role: roleKey }).strict(), req.body);
    await withTx(db, async (tx) => {
      const u = await tx.query(`select id from users where id = $1 and deleted_at is null for update`, [id]);
      if (!u.rows[0]) throw Errors.notFound("User");
      const r = await tx.query(
        `insert into user_roles (user_id, role_key, granted_by) values ($1, $2, $3) on conflict do nothing`,
        [id, role, req.auth!.userId],
      );
      if (r.rowCount) await writeAudit(tx, { ...ctx(req), action: "role.grant", entity: "user", entityId: id, newValue: { role } });
    });
    return reply.code(204).send();
  });

  app.delete("/users/:id/roles/:role", { preHandler: requirePermission("admin.roles.manage") }, async (req, reply) => {
    const p = parse(z.object({ id: uuid, role: roleKey }), req.params);
    if (p.id === req.auth!.userId && p.role === "admin") throw Errors.forbidden("You cannot remove your own admin role.");
    await withTx(db, async (tx) => {
      // Lock admin role rows so two admins cannot remove each other at the same moment.
      if (p.role === "admin") await tx.query(`select 1 from user_roles where role_key = 'admin' for update`);
      const r = await tx.query(`delete from user_roles where user_id = $1 and role_key = $2`, [p.id, p.role]);
      if (!r.rowCount) throw Errors.notFound("Role assignment");
      if (p.role === "admin") {
        const left = await tx.query(`select count(*)::int as n from user_roles where role_key = 'admin'`);
        if (left.rows[0].n < 1) throw Errors.conflict("LAST_ADMIN", "At least one admin must remain.");
      }
      await writeAudit(tx, { ...ctx(req), action: "role.revoke", entity: "user", entityId: p.id, oldValue: { role: p.role } });
    });
    return reply.code(204).send();
  });

  const setStatus = (to: "active" | "suspended") => async (req: FastifyRequest, reply: any) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ reason: safeText(3, 500) }).strict(), req.body);
    if (id === req.auth!.userId) throw Errors.forbidden("You cannot change your own account status.");
    await withTx(db, async (tx) => {
      const r = await tx.query(`select status from users where id = $1 and deleted_at is null for update`, [id]);
      const cur = r.rows[0];
      if (!cur) throw Errors.notFound("User");
      if (cur.status === to) return;
      if (cur.status === "deleted") throw Errors.invalidTransition("Deleted accounts cannot be changed.");
      await tx.query(`update users set status = $1 where id = $2`, [to, id]);
      if (to === "suspended") {
        await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'suspended' where user_id = $1 and revoked_at is null`, [id]);
      }
      await writeAudit(tx, { ...ctx(req), action: to === "suspended" ? "user.suspend" : "user.reactivate", entity: "user", entityId: id, oldValue: { status: cur.status }, newValue: { status: to, reason: body.reason } });
    });
    return reply.code(204).send();
  };
  app.post("/users/:id/suspend", { preHandler: requirePermission("admin.users.manage") }, setStatus("suspended"));
  app.post("/users/:id/reactivate", { preHandler: requirePermission("admin.users.manage") }, setStatus("active"));

  app.get("/audit-logs", { preHandler: requirePermission("admin.audit.read") }, async (req) => {
    const q = parse(pageQuery.extend({
      entity: z.string().max(50).optional(),
      entityId: z.string().max(100).optional(),
      actorUserId: uuid.optional(),
      action: z.string().max(100).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
    }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await db.query(
      `select id, actor_user_id, action, entity, entity_id, old_value, new_value, ip, request_id, created_at, ${cursorTime("created_at")}
         from audit_logs
        where ($1::text is null or entity = $1) and ($2::text is null or entity_id = $2)
          and ($3::uuid is null or actor_user_id = $3) and ($4::text is null or action = $4)
          and ($5::timestamptz is null or created_at >= $5) and ($6::timestamptz is null or created_at < $6)
          and ($7::timestamptz is null or (created_at, id) < ($7, $8::bigint))
        order by created_at desc, id desc limit $9`,
      [q.entity ?? null, q.entityId ?? null, q.actorUserId ?? null, q.action ?? null, q.from ?? null, q.to ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1],
    );
    const p = page(r.rows, q.limit, (a: any) => encodeCursor(a.cursor_t, a.id));
    return {
      items: p.items.map((a: any) => ({
        id: String(a.id), actorUserId: a.actor_user_id, action: a.action, entity: a.entity, entityId: a.entity_id,
        oldValue: a.old_value, newValue: a.new_value, ip: a.ip, requestId: a.request_id, createdAt: a.created_at,
      })),
      nextCursor: p.nextCursor,
    };
  });
}
