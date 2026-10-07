import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, safeText, uuid } from "../../lib/validate.js";
import { AppError, Errors } from "../../lib/errors.js";
import { withTx } from "../../lib/db.js";
import { writeAudit } from "../../lib/audit.js";
import { CURRENCY } from "../../lib/money.js";
import { cursorTime, decodeCursor, encodeCursor, page, pageQuery } from "../../lib/pagination.js";
import { authenticate, requirePermission } from "../auth/guard.js";
import * as commission from "./commission.js";
import * as finance from "./service.js";
import { sellerBalances } from "./ledger.js";

const ctxOf = (req: FastifyRequest) => ({ actorUserId: req.auth!.userId, ip: req.ip ?? null, requestId: String(req.id) });
const idParam = z.object({ id: uuid() });
const rateBp = z.number().int().min(0).max(5000);
const isoTime = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const ruleOut = (r: any) => ({
  id: r.id, scope: r.scope, categoryId: r.category_id, sellerId: r.seller_id, productId: r.product_id, rateBp: r.rate_bp,
  startsAt: r.starts_at, endsAt: r.ends_at, note: r.note, createdBy: r.created_by, endedBy: r.ended_by, createdAt: r.created_at,
  state: r.ends_at !== null && new Date(r.ends_at) <= new Date() ? "ended" : new Date(r.starts_at) > new Date() ? "scheduled" : "active",
});

// Two rules for the same target overlapping in time are refused by the database.
const overlap = (e: any) => {
  if (e?.code === "23P01") throw Errors.conflict("RULE_OVERLAP", "Another rule for this target is in force during that time. End it first.");
  throw e;
};

// Admins may not set rates for a shop they own.
async function assertNotOwnShop(db: any, userId: string, scope: string, targetId: string | null) {
  if (!targetId || (scope !== "seller" && scope !== "product")) return;
  const r = await db.query(
    scope === "seller"
      ? `select 1 from sellers where id = $1 and user_id = $2`
      : `select 1 from products p join sellers s on s.id = p.seller_id where p.id = $1 and s.user_id = $2`, [targetId, userId]);
  if (r.rowCount) throw Errors.forbidden("You cannot set commission for your own shop.");
}

// ---------------- admin: commission rules ----------------

export async function adminCommissionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const read = requirePermission("admin.finance.read");
  const manage = requirePermission("admin.finance.manage");

  app.get("/rules", { preHandler: read }, async (req) => {
    const q = parse(pageQuery.extend({
      scope: z.enum(["default", "category", "seller", "product"]).optional(), targetId: uuid().optional(),
      state: z.enum(["active", "scheduled", "ended"]).optional(),
    }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select r.*, ${cursorTime("r.created_at")} from commission_rules r
        where ($1::text is null or r.scope = $1)
          and ($2::uuid is null or $2 in (r.category_id, r.seller_id, r.product_id))
          and ($3::text is null
               or ($3 = 'active' and r.starts_at <= now() and (r.ends_at is null or r.ends_at > now()))
               or ($3 = 'scheduled' and r.starts_at > now() and (r.ends_at is null or r.ends_at > r.starts_at))
               or ($3 = 'ended' and r.ends_at is not null and r.ends_at <= now()))
          and ($4::timestamptz is null or (r.created_at, r.id) < ($4, $5::uuid))
        order by r.created_at desc, r.id desc limit $6`,
      [q.scope ?? null, q.targetId ?? null, q.state ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
    const p = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return { items: p.items.map(ruleOut), nextCursor: p.nextCursor };
  });

  // Which rate would apply to a product right now (or at a given time), and why.
  app.get("/preview", { preHandler: read }, async (req) => {
    const q = parse(z.object({ productId: uuid(), at: isoTime.optional() }), req.query);
    const p = (await app.db.query(
      `select p.id, p.seller_id, c.path from products p join categories c on c.id = p.category_id where p.id = $1`, [q.productId])).rows[0];
    if (!p) throw Errors.notFound("Product");
    const [rule] = await commission.resolve(app.db, [{ productId: p.id, sellerId: p.seller_id, categoryPath: p.path }], q.at ?? null);
    return { productId: p.id, ruleId: rule!.ruleId, scope: rule!.scope, rateBp: rule!.rateBp };
  });

  app.post("/rules", { preHandler: manage }, async (req, reply) => {
    const b = parse(z.object({
      scope: z.enum(["category", "seller", "product"]),
      targetId: uuid(),
      rateBp,
      startsAt: isoTime.optional(),
      endsAt: isoTime.optional(),
      note: safeText(3, 300).optional(),
    }).strict(), req.body);
    const startsAt = b.startsAt ?? new Date();
    if (startsAt.getTime() < Date.now() - 60_000) throw Errors.validation([{ path: "startsAt", message: "A rule cannot start in the past." }]);
    if (b.endsAt && b.endsAt <= startsAt) throw Errors.validation([{ path: "endsAt", message: "Must be after the start." }]);
    const table = { category: "categories", seller: "sellers", product: "products" }[b.scope];
    if (!(await app.db.query(`select 1 from ${table} where id = $1`, [b.targetId])).rowCount) {
      throw Errors.validation([{ path: "targetId", message: `Unknown ${b.scope}.` }]);
    }
    await assertNotOwnShop(app.db, req.auth!.userId, b.scope, b.targetId);
    const rule = await withTx(app.db, async (tx) => {
      const r = (await tx.query(
        `insert into commission_rules (scope, category_id, seller_id, product_id, rate_bp, starts_at, ends_at, note, created_by)
         values ($1, $2, $3, $4, $5, greatest($6::timestamptz, now()), $7, $8, $9) returning *`,
        [b.scope, b.scope === "category" ? b.targetId : null, b.scope === "seller" ? b.targetId : null, b.scope === "product" ? b.targetId : null,
         b.rateBp, startsAt, b.endsAt ?? null, b.note ?? null, req.auth!.userId]).catch(overlap)).rows[0];
      await writeAudit(tx, { ...ctxOf(req), action: "commission.rule_create", entity: "commission_rule", entityId: r.id, newValue: b });
      return r;
    });
    return reply.code(201).send(ruleOut(rule));
  });

  // Ends a rule now (or at a later time). A scheduled rule that has not started is called off.
  app.post("/rules/:id/end", { preHandler: manage }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ at: isoTime.optional(), reason: safeText(3, 300) }).strict(), req.body ?? {});
    const rule = await withTx(app.db, async (tx) => {
      const cur = (await tx.query(`select * from commission_rules where id = $1 for update`, [id])).rows[0];
      if (!cur) throw Errors.notFound("Rule");
      if (cur.scope === "default") throw Errors.invalidTransition("The default rate is changed with PUT /admin/commission/default, never left empty.");
      await assertNotOwnShop(tx, req.auth!.userId, cur.scope, cur.seller_id ?? cur.product_id);
      if (cur.ends_at !== null && new Date(cur.ends_at) <= new Date()) throw Errors.invalidTransition("This rule has already ended.");
      const at = b.at ?? new Date();
      if (at.getTime() < Date.now() - 60_000) throw Errors.validation([{ path: "at", message: "A rule can only be ended from now on." }]);
      const r = (await tx.query(
        `update commission_rules set ends_at = greatest(starts_at, greatest($2::timestamptz, now())), ended_by = $3 where id = $1 returning *`,
        [id, at, req.auth!.userId])).rows[0];
      await writeAudit(tx, { ...ctxOf(req), action: "commission.rule_end", entity: "commission_rule", entityId: id, oldValue: ruleOut(cur), newValue: { endsAt: r.ends_at, reason: b.reason } });
      return r;
    });
    return ruleOut(rule);
  });

  // Replaces the default rate from now on. The old default ends exactly when the new one starts,
  // so there is never a gap or an overlap. (Scheduling a future default change is not offered: it
  // could not be called off without leaving a gap.)
  app.put("/default", { preHandler: manage }, async (req) => {
    const b = parse(z.object({ rateBp, reason: safeText(3, 300) }).strict(), req.body);
    const rule = await withTx(app.db, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('commission_default', 0))`);
      const rows = (await tx.query(`select * from commission_rules where scope = 'default' and (ends_at is null or ends_at > now()) for update`)).rows;
      if (rows.length !== 1 || rows[0].ends_at !== null) throw new Error("Commission default is not a single open-ended rule");
      const cur = rows[0];
      const at = (await tx.query(`select greatest(now(), $1::timestamptz) as at`, [cur.starts_at])).rows[0].at;
      await tx.query(`update commission_rules set ends_at = $2, ended_by = $3 where id = $1`, [cur.id, at, req.auth!.userId]);
      const r = (await tx.query(
        `insert into commission_rules (scope, rate_bp, starts_at, note, created_by) values ('default', $1, $2, $3, $4) returning *`,
        [b.rateBp, at, b.reason, req.auth!.userId]).catch(overlap)).rows[0];
      await writeAudit(tx, { ...ctxOf(req), action: "commission.default_change", entity: "commission_rule", entityId: r.id, oldValue: ruleOut(cur), newValue: b });
      return r;
    });
    return ruleOut(rule);
  });
}

// ---------------- admin: finance ----------------

export async function adminFinanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const read = requirePermission("admin.finance.read");
  const manage = requirePermission("admin.finance.manage");

  app.get("/settings", { preHandler: read }, async () => finance.settings(app.db));

  // Changes apply to orders paid and returns requested from now on.
  app.patch("/settings", { preHandler: manage }, async (req) => {
    const b = parse(z.object({
      payoutHoldDays: z.number().int().min(0).max(90).optional(),
      returnWindowDays: z.number().int().min(1).max(30).optional(),
      sellerDecisionDays: z.number().int().min(1).max(14).optional(),
      escalationDays: z.number().int().min(1).max(14).optional(),
      returnShipDays: z.number().int().min(1).max(30).optional(),
      returnReceiptDays: z.number().int().min(1).max(30).optional(),
      returnShippingPaise: z.number().int().min(0).max(100_000).optional(),
      reason: safeText(3, 300),
    }).strict().refine((v) => Object.keys(v).length > 1, "Nothing to update"), req.body);
    await withTx(app.db, async (tx) => {
      await tx.query(`select id from finance_settings where id = 1 for update`);
      const old = await finance.settings(tx);
      await tx.query(
        `update finance_settings set payout_hold_days = coalesce($1, payout_hold_days), return_window_days = coalesce($2, return_window_days),
                seller_decision_days = coalesce($3, seller_decision_days), escalation_days = coalesce($4, escalation_days),
                return_ship_days = coalesce($5, return_ship_days), return_receipt_days = coalesce($6, return_receipt_days),
                return_shipping_paise = coalesce($7, return_shipping_paise), updated_by = $8, updated_at = now() where id = 1`,
        [b.payoutHoldDays ?? null, b.returnWindowDays ?? null, b.sellerDecisionDays ?? null, b.escalationDays ?? null,
         b.returnShipDays ?? null, b.returnReceiptDays ?? null, b.returnShippingPaise ?? null, req.auth!.userId]);
      await writeAudit(tx, { ...ctxOf(req), action: "finance.settings_update", entity: "finance_settings", entityId: "1", oldValue: old, newValue: b });
    });
    return finance.settings(app.db);
  });

  app.get("/sellers/:id/balance", { preHandler: read }, async (req) => {
    const { id } = parse(idParam, req.params);
    if (!(await app.db.query(`select 1 from sellers where id = $1`, [id])).rowCount) throw Errors.notFound("Seller");
    return { sellerId: id, currency: CURRENCY, ...(await sellerBalances(app.db, id)) };
  });

  // Every account's balance. Debits and credits over all accounts always add up to zero.
  app.get("/trial-balance", { preHandler: read }, async () => {
    const r = await app.db.query(
      `select a.code, a.kind, a.name, a.seller_id,
              coalesce(sum(e.amount_paise) filter (where e.direction = 'debit'), 0)::bigint as debit,
              coalesce(sum(e.amount_paise) filter (where e.direction = 'credit'), 0)::bigint as credit
         from ledger_accounts a left join ledger_entries e on e.account_id = a.id
        group by a.id order by a.seller_id nulls first, a.code`);
    const accounts = r.rows.map((x) => ({ code: x.code, kind: x.kind, name: x.name, sellerId: x.seller_id, debitPaise: Number(x.debit), creditPaise: Number(x.credit) }));
    const debit = accounts.reduce((a, x) => a + x.debitPaise, 0);
    const credit = accounts.reduce((a, x) => a + x.creditPaise, 0);
    return { currency: CURRENCY, accounts, totals: { debitPaise: debit, creditPaise: credit, balanced: debit === credit } };
  });

  app.get("/transactions", { preHandler: read }, async (req) => {
    const q = parse(pageQuery.extend({ referenceId: uuid().optional(), kind: z.enum(["order_payment", "hold_release", "unapplied_payment", "refund_due", "refund_paid"]).optional() }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select t.*, ${cursorTime("t.created_at")},
              (select json_agg(json_build_object('account', a.code, 'direction', e.direction, 'amountPaise', e.amount_paise) order by e.id)
                 from ledger_entries e join ledger_accounts a on a.id = e.account_id where e.transaction_id = t.id) as lines
         from ledger_transactions t
        where ($1::uuid is null or t.reference_id = $1) and ($2::text is null or t.kind = $2)
          and ($3::timestamptz is null or (t.created_at, t.id) < ($3, $4::uuid))
        order by t.created_at desc, t.id desc limit $5`,
      [q.referenceId ?? null, q.kind ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
    const p = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return {
      items: p.items.map((x: any) => ({ id: x.id, kind: x.kind, referenceType: x.reference_type, referenceId: x.reference_id, memo: x.memo, createdAt: x.created_at,
        lines: x.lines.map((l: any) => ({ ...l, amountPaise: Number(l.amountPaise) })) })),
      currency: CURRENCY, nextCursor: p.nextCursor,
    };
  });
}

// ---------------- seller: earnings ----------------

// Sellers keep access to their money even while suspended, so this does not require approval.
async function anySeller(req: FastifyRequest): Promise<void> {
  const s = (await req.server.db.query(`select id from sellers where user_id = $1`, [req.auth!.userId])).rows[0];
  if (!s) throw new AppError(403, "NOT_A_SELLER", "Apply to become a seller first.");
  req.seller = { id: s.id };
}

export async function sellerFinanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", anySeller);
  const sid = (req: FastifyRequest) => req.seller!.id;

  app.get("/balance", async (req) => {
    const next = (await app.db.query(
      `select min(funds_available_at) as at from seller_orders where seller_id = $1 and funds_released_at is null and funds_available_at is not null and status <> 'cancelled'`,
      [sid(req)])).rows[0].at;
    const { payoutHoldDays } = await finance.settings(app.db);
    return { currency: CURRENCY, ...(await sellerBalances(app.db, sid(req))), nextReleaseAt: next, holdDaysFromPayment: payoutHoldDays };
  });

  // One row per paid package: what was sold, the commission, the delivery fee and when it is released.
  app.get("/earnings", async (req) => {
    const q = parse(pageQuery.extend({ state: z.enum(["on_hold", "available"]).optional() }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select so.id, so.number, so.status, so.items_subtotal_paise, so.commission_paise, so.delivery_paise, so.seller_earning_paise,
              so.funds_available_at, so.funds_released_at, so.confirmed_at, ${cursorTime("so.confirmed_at")}
         from seller_orders so
        where so.seller_id = $1 and so.funds_available_at is not null
          and ($2::text is null or ($2 = 'on_hold' and so.funds_released_at is null) or ($2 = 'available' and so.funds_released_at is not null))
          and ($3::timestamptz is null or (so.confirmed_at, so.id) < ($3, $4::uuid))
        order by so.confirmed_at desc, so.id desc limit $5`,
      [sid(req), q.state ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1]);
    const p = page(r.rows, q.limit, (x: any) => encodeCursor(x.cursor_t, x.id));
    return {
      items: p.items.map((x: any) => ({
        id: x.id, number: x.number, status: x.status, itemsSubtotalPaise: Number(x.items_subtotal_paise), commissionPaise: Number(x.commission_paise),
        deliveryFeePaise: Number(x.delivery_paise), sellerEarningPaise: Number(x.seller_earning_paise),
        state: x.funds_released_at ? "available" : "on_hold", availableAt: x.funds_available_at, releasedAt: x.funds_released_at, paidAt: x.confirmed_at,
      })),
      currency: CURRENCY, nextCursor: p.nextCursor,
    };
  });
}
