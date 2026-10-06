import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { basename } from "node:path";
import { parse, safeText, uuid } from "../../lib/validate.js";
import { AppError, Errors } from "../../lib/errors.js";
import { sniffDocumentType } from "../../lib/storage.js";
import { authenticate, requirePermission } from "../auth/guard.js";
import { decodeCursor, encodeCursor, page, pageQuery } from "../../lib/pagination.js";
import { ADMIN_ACTIONS, GSTIN_RE, IFSC_RE, PAN_RE, type AdminAction } from "./rules.js";
import * as svc from "./service.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const upper = (re: RegExp, msg: string) => z.string().trim().toUpperCase().regex(re, msg);

const applicationFields = {
  displayName: safeText(2, 60),
  businessName: safeText(2, 160),
  businessType: z.enum(["individual", "proprietorship", "partnership", "llp", "private_limited", "public_limited", "other"]),
  pan: upper(PAN_RE, "Enter a valid PAN, for example ABCDE1234F"),
  gstin: upper(GSTIN_RE, "Enter a valid 15-character GSTIN").nullable().optional(),
  addressLine1: safeText(3, 200),
  addressLine2: safeText(1, 200).nullable().optional(),
  city: safeText(2, 80),
  state: safeText(2, 80),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, "Enter a 6-digit PIN code"),
  contactPhone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, "Use 10 to 15 digits, optionally starting with +"),
};
const applyBody = z.object(applicationFields).strict();
const patchBody = z.object(applicationFields).partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to update");
const bankBody = z.object({
  accountHolderName: safeText(2, 120),
  accountNumber: z.string().trim().regex(/^[0-9]{9,18}$/, "Enter 9 to 18 digits"),
  accountNumberConfirm: z.string().trim(),
  ifsc: upper(IFSC_RE, "Enter a valid 11-character IFSC"),
}).strict().refine((v) => v.accountNumber === v.accountNumberConfirm, { path: ["accountNumberConfirm"], message: "Account numbers do not match" });
const docTypeQuery = z.object({ docType: z.enum(["pan_card", "gst_certificate", "address_proof", "bank_proof", "other"]) });

const ctxOf = (req: FastifyRequest): svc.Ctx => ({ actorUserId: req.auth!.userId, ip: req.ip ?? null, requestId: String(req.id) });

function sendFile(reply: FastifyReply, f: { body: Buffer; mime: string; ext: string }) {
  return reply
    .type(f.mime)
    .header("content-disposition", `attachment; filename="document.${f.ext}"`)
    .header("x-content-type-options", "nosniff")
    .send(f.body);
}

export async function sellerRoutes(app: FastifyInstance): Promise<void> {
  const deps = (): svc.Deps => ({ db: app.db, cipher: app.cipher, storage: app.storage });
  app.addHook("preHandler", authenticate);

  app.post("/application", async (req, reply) => {
    const body = parse(applyBody, req.body);
    const id = await svc.apply(deps(), ctxOf(req), body);
    return reply.code(201).send(await svc.view(app.db, id, false));
  });

  app.get("/application", async (req) => svc.view(app.db, await svc.ownSellerId(app.db, req.auth!.userId), false));

  app.patch("/application", async (req) => {
    const body = parse(patchBody, req.body);
    return svc.view(app.db, await svc.update(deps(), ctxOf(req), body), false);
  });

  app.post("/application/submit", async (req) => {
    await svc.submit(deps(), ctxOf(req));
    return svc.view(app.db, await svc.ownSellerId(app.db, req.auth!.userId), false);
  });

  app.put("/bank-account", async (req) => {
    const b = parse(bankBody, req.body);
    await svc.setBankAccount(deps(), ctxOf(req), { accountHolderName: b.accountHolderName, accountNumber: b.accountNumber, ifsc: b.ifsc });
    return svc.view(app.db, await svc.ownSellerId(app.db, req.auth!.userId), false);
  });

  // Upload: multipart/form-data with one "file" part; the document type is a query parameter.
  app.post("/documents", { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { docType } = parse(docTypeQuery, req.query);
    if (!req.isMultipart()) throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload the file as multipart/form-data.");
    const tooLarge = () => new AppError(413, "FILE_TOO_LARGE", "Files can be up to 5 MB.");
    let part: Awaited<ReturnType<typeof req.file>>;
    let body: Buffer;
    try {
      part = await req.file({ limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0 } });
      if (!part) throw Errors.validation([{ path: "file", message: "Attach a file." }]);
      body = await part.toBuffer();
    } catch (e: any) {
      if (e instanceof AppError) throw e;
      if (e?.code === "FST_REQ_FILE_TOO_LARGE" || e?.statusCode === 413) throw tooLarge();
      throw new AppError(400, "BAD_REQUEST", "The upload could not be read. Try again.");
    }
    if (part.file.truncated) throw tooLarge();
    if (body.length === 0) throw Errors.validation([{ path: "file", message: "The file is empty." }]);
    const kind = sniffDocumentType(body);
    if (!kind) throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "Upload a PDF, JPEG, PNG or WebP file.");
    const name = basename(part.filename || "document").replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "document";
    const id = await svc.addDocument(deps(), ctxOf(req), docType, { body, mime: kind.mime, ext: kind.ext, name });
    return reply.code(201).send({ id });
  });

  app.delete("/documents/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid() }), req.params);
    await svc.removeDocument(deps(), ctxOf(req), id);
    return reply.code(204).send();
  });

  app.get("/documents/:id/file", async (req, reply) => {
    const { id } = parse(z.object({ id: uuid() }), req.params);
    const sellerId = await svc.ownSellerId(app.db, req.auth!.userId);
    return sendFile(reply, await svc.readDocument(deps(), sellerId, id));
  });
}

export async function adminSellerRoutes(app: FastifyInstance): Promise<void> {
  const deps = (): svc.Deps => ({ db: app.db, cipher: app.cipher, storage: app.storage });
  const read = requirePermission("admin.sellers.read");
  const manage = requirePermission("admin.sellers.manage");
  const docs = requirePermission("admin.sellers.documents");
  const sellerParam = z.object({ id: uuid() });
  app.addHook("preHandler", authenticate);

  app.get("/", { preHandler: read }, async (req) => {
    const q = parse(pageQuery.extend({
      status: z.enum(["draft", "submitted", "changes_requested", "approved", "rejected", "suspended"]).optional(),
      q: z.string().trim().max(100).optional(),
    }), req.query);
    const c = decodeCursor(q.cursor);
    const r = await app.db.query(
      `select s.id, s.status, s.display_name, s.business_name, s.city, s.state, s.submitted_at, s.created_at, u.email
         from sellers s join users u on u.id = s.user_id
        where ($1::text is null or s.status = $1)
          and ($2::text is null or s.display_name ilike '%' || $2 || '%' or s.business_name ilike '%' || $2 || '%' or u.email ilike '%' || $2 || '%')
          and ($3::timestamptz is null or (s.created_at, s.id) < ($3, $4::uuid))
        order by s.created_at desc, s.id desc limit $5`,
      [q.status ?? null, q.q ?? null, c?.t ?? null, c?.id ?? null, q.limit + 1],
    );
    const p = page(r.rows, q.limit, (s: any) => encodeCursor(s.created_at, s.id));
    return {
      items: p.items.map((s: any) => ({ id: s.id, status: s.status, displayName: s.display_name, businessName: s.business_name, email: s.email, city: s.city, state: s.state, submittedAt: s.submitted_at, createdAt: s.created_at })),
      nextCursor: p.nextCursor,
    };
  });

  app.get("/:id", { preHandler: read }, async (req) => svc.view(app.db, parse(sellerParam, req.params).id, true));

  app.get("/:id/sensitive", { preHandler: docs }, async (req) => svc.revealSensitive(deps(), ctxOf(req), parse(sellerParam, req.params).id));

  app.get("/:id/documents/:docId/file", { preHandler: docs }, async (req, reply) => {
    const p = parse(z.object({ id: uuid(), docId: uuid() }), req.params);
    const s = (await app.db.query(`select user_id from sellers where id = $1`, [p.id])).rows[0];
    if (!s) throw Errors.notFound("Seller");
    if (s.user_id === req.auth!.userId) throw Errors.forbidden("You cannot review your own seller account.");
    const f = await svc.readDocument(deps(), p.id, p.docId);
    const { writeAudit } = await import("../../lib/audit.js");
    await writeAudit(app.db, { ...ctxOf(req), action: "seller.document_viewed", entity: "seller", entityId: p.id, newValue: { documentId: p.docId } });
    return sendFile(reply, f);
  });

  app.post("/:id/documents/:docId/review", { preHandler: manage }, async (req, reply) => {
    const p = parse(z.object({ id: uuid(), docId: uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(["accepted", "rejected"]), note: safeText(3, 500).optional() }).strict(), req.body);
    await svc.reviewDocument(deps(), ctxOf(req), p.id, p.docId, b.decision, b.note ?? null);
    return reply.code(204).send();
  });

  app.post("/:id/bank-accounts/:bankId/review", { preHandler: manage }, async (req, reply) => {
    const p = parse(z.object({ id: uuid(), bankId: uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(["verified", "rejected"]), note: safeText(3, 500).optional() }).strict(), req.body);
    await svc.reviewBankAccount(deps(), ctxOf(req), p.id, p.bankId, b.decision, b.note ?? null);
    return reply.code(204).send();
  });

  const actionBody = z.object({ reason: safeText(3, 500).optional() }).strict();
  for (const action of Object.keys(ADMIN_ACTIONS) as AdminAction[]) {
    app.post(`/:id/${action.replace("_", "-")}`, { preHandler: manage }, async (req) => {
      const { id } = parse(sellerParam, req.params);
      const { reason } = parse(actionBody, req.body ?? {});
      await svc.adminTransition(deps(), ctxOf(req), id, action, reason ?? null);
      return svc.view(app.db, id, true);
    });
  }
}
