import { randomUUID, createHash } from "node:crypto";
import type { Db, Queryable, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import type { FieldCipher } from "../../lib/encryption.js";
import type { Storage } from "../../lib/storage.js";
import { ADMIN_ACTIONS, EDITABLE, gstinMatchesPan, requiredDocTypes, type AdminAction, type DocType, type SellerStatus } from "./rules.js";

export interface Ctx { actorUserId: string; ip: string | null; requestId: string }
export interface Deps { db: Db; cipher: FieldCipher; storage: Storage }

export interface ApplicationInput {
  displayName: string; businessName: string; businessType: string; pan: string; gstin?: string | null | undefined;
  addressLine1: string; addressLine2?: string | null | undefined; city: string; state: string; pincode: string; contactPhone: string;
}

const MAX_ACTIVE_DOCS = 20;
const panAad = (sellerId: string) => `seller:${sellerId}:pan`;
const bankAad = (bankId: string) => `bank:${bankId}`;

function uniqueViolation(e: any): AppError | null {
  if (e?.code !== "23505") return null;
  const c = String(e.constraint ?? "");
  if (c.includes("display_name")) return Errors.conflict("STORE_NAME_TAKEN", "That store name is already taken.");
  if (c.includes("gstin")) return Errors.conflict("GSTIN_IN_USE", "This GSTIN is already registered to another seller.");
  if (c.includes("user_id")) return Errors.conflict("APPLICATION_EXISTS", "You already have a seller application.");
  return Errors.conflict("DUPLICATE", "This record already exists.");
}

async function history(tx: Tx, sellerId: string, from: SellerStatus | null, to: SellerStatus, actor: string, reason?: string | null) {
  await tx.query(
    `insert into seller_status_history (seller_id, from_status, to_status, actor_id, reason) values ($1, $2, $3, $4, $5)`,
    [sellerId, from, to, actor, reason ?? null],
  );
}

async function resetReviews(tx: Tx, sellerId: string, docTypes: string[]): Promise<void> {
  await tx.query(
    `update seller_documents set status = 'pending', review_note = 'Details changed; needs review again', reviewed_by = null, reviewed_at = null
      where seller_id = $1 and doc_type = any($2) and status = 'accepted' and removed_at is null`,
    [sellerId, docTypes],
  );
}

async function lockOwn(tx: Tx, userId: string) {
  const r = await tx.query(`select * from sellers where user_id = $1 for update`, [userId]);
  if (!r.rows[0]) throw Errors.notFound("Seller application");
  return r.rows[0];
}

// After approval the only document a seller may add is proof for a new bank account.
function assertCanUpload(status: SellerStatus, docType: DocType) {
  if (status === "approved" && docType === "bank_proof") return;
  assertEditable(status);
}

function assertEditable(status: SellerStatus) {
  if (!EDITABLE.includes(status)) {
    throw Errors.invalidTransition(
      status === "submitted" ? "Your application is under review and cannot be changed now."
      : "This application can no longer be edited.",
    );
  }
}

function checkGstin(pan: string, gstin: string | null | undefined) {
  if (gstin && !gstinMatchesPan(gstin, pan)) {
    throw Errors.validation([{ path: "gstin", message: "The GSTIN does not belong to this PAN." }]);
  }
}

// ---------- reads ----------

export async function missingRequirements(db: Queryable, seller: { id: string; gstin: string | null }): Promise<string[]> {
  const docs = await db.query(
    `select distinct doc_type from seller_documents where seller_id = $1 and removed_at is null and status <> 'rejected'`,
    [seller.id],
  );
  const have = new Set(docs.rows.map((r) => r.doc_type));
  const missing: string[] = requiredDocTypes(!!seller.gstin).filter((t) => !have.has(t)).map((t) => `document:${t}`);
  const bank = await db.query(`select 1 from seller_bank_accounts where seller_id = $1 and status in ('pending', 'verified')`, [seller.id]);
  if (!bank.rowCount) missing.push("bank_account");
  return missing;
}

export async function view(db: Queryable, sellerId: string, forAdmin: boolean) {
  const s = (await db.query(`select * from sellers where id = $1`, [sellerId])).rows[0];
  if (!s) throw Errors.notFound("Seller");
  const docs = await db.query(
    `select id, doc_type, original_name, mime_type, size_bytes, status, review_note, reviewed_at, created_at
       from seller_documents where seller_id = $1 and removed_at is null order by created_at`,
    [sellerId],
  );
  const banks = await db.query(
    `select id, account_holder_name, account_last4, ifsc, status, review_note, verified_at, created_at
       from seller_bank_accounts where seller_id = $1 and status in ('pending', 'verified', 'rejected') order by created_at desc limit 5`,
    [sellerId],
  );
  const hist = await db.query(
    `select from_status, to_status, reason, created_at ${forAdmin ? ", actor_id" : ""}
       from seller_status_history where seller_id = $1 order by created_at, id`,
    [sellerId],
  );
  return {
    id: s.id, userId: forAdmin ? s.user_id : undefined, status: s.status,
    displayName: s.display_name, businessName: s.business_name, businessType: s.business_type,
    panMasked: `XXXXXX${s.pan_last4}`, gstin: s.gstin,
    address: { line1: s.address_line1, line2: s.address_line2, city: s.city, state: s.state, pincode: s.pincode },
    contactPhone: s.contact_phone, submittedAt: s.submitted_at, approvedAt: s.approved_at, createdAt: s.created_at,
    missing: await missingRequirements(db, s),
    documents: docs.rows.map((d) => ({
      id: d.id, docType: d.doc_type, originalName: d.original_name, mimeType: d.mime_type, sizeBytes: d.size_bytes,
      status: d.status, reviewNote: d.review_note, reviewedAt: d.reviewed_at, createdAt: d.created_at,
    })),
    bankAccounts: banks.rows.map((b) => ({
      id: b.id, accountHolderName: b.account_holder_name, accountNumberMasked: `XXXX${b.account_last4}`, ifsc: b.ifsc,
      status: b.status, reviewNote: b.review_note, verifiedAt: b.verified_at, createdAt: b.created_at,
    })),
    history: hist.rows.map((h) => ({ from: h.from_status, to: h.to_status, reason: h.reason, at: h.created_at, actorId: forAdmin ? h.actor_id : undefined })),
  };
}

export async function ownSellerId(db: Queryable, userId: string): Promise<string> {
  const r = await db.query(`select id from sellers where user_id = $1`, [userId]);
  if (!r.rows[0]) throw Errors.notFound("Seller application");
  return r.rows[0].id;
}

// ---------- seller actions ----------

export async function apply(d: Deps, ctx: Ctx, input: ApplicationInput): Promise<string> {
  checkGstin(input.pan, input.gstin);
  const id = randomUUID();
  try {
    await withTx(d.db, async (tx) => {
      await tx.query(
        `insert into sellers (id, user_id, display_name, business_name, business_type, pan_encrypted, pan_last4, gstin,
                              address_line1, address_line2, city, state, pincode, contact_phone)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, ctx.actorUserId, input.displayName, input.businessName, input.businessType,
         d.cipher.encrypt(input.pan, panAad(id)), input.pan.slice(-4), input.gstin ?? null,
         input.addressLine1, input.addressLine2 ?? null, input.city, input.state, input.pincode, input.contactPhone],
      );
      await history(tx, id, null, "draft", ctx.actorUserId);
      await writeAudit(tx, { ...ctx, action: "seller.apply", entity: "seller", entityId: id, newValue: { displayName: input.displayName, businessType: input.businessType } });
    });
  } catch (e) {
    throw uniqueViolation(e) ?? e;
  }
  return id;
}

export async function update(d: Deps, ctx: Ctx, patch: Partial<ApplicationInput>): Promise<string> {
  try {
    return await withTx(d.db, async (tx) => {
      const s = await lockOwn(tx, ctx.actorUserId);
      assertEditable(s.status);
      const pan = patch.pan ?? d.cipher.decrypt(s.pan_encrypted, panAad(s.id));
      const gstin = patch.gstin === undefined ? s.gstin : patch.gstin;
      checkGstin(pan, gstin);
      const set: Record<string, unknown> = {
        display_name: patch.displayName, business_name: patch.businessName, business_type: patch.businessType,
        address_line1: patch.addressLine1, address_line2: patch.addressLine2, city: patch.city, state: patch.state,
        pincode: patch.pincode, contact_phone: patch.contactPhone, gstin: patch.gstin,
      };
      if (patch.pan) { set.pan_encrypted = d.cipher.encrypt(patch.pan, panAad(s.id)); set.pan_last4 = patch.pan.slice(-4); }
      // Column names come from the fixed list above, never from the request.
      const cols = Object.entries(set).filter(([, v]) => v !== undefined);
      // Accepted documents only prove the details they were checked against. When those details
      // change, the matching documents go back to pending and must be reviewed again.
      const changed = (k: keyof ApplicationInput) => patch[k] !== undefined;
      const recheck: string[] = [];
      if (changed("pan")) recheck.push("pan_card", "gst_certificate");
      if (changed("gstin")) recheck.push("gst_certificate");
      if (changed("addressLine1") || changed("addressLine2") || changed("city") || changed("state") || changed("pincode")) recheck.push("address_proof");
      if (changed("businessName") || changed("businessType")) recheck.push("pan_card", "gst_certificate");
      if (recheck.length) await resetReviews(tx, s.id, recheck);
      if (cols.length) {
        await tx.query(
          `update sellers set ${cols.map(([k], i) => `${k} = $${i + 2}`).join(", ")} where id = $1`,
          [s.id, ...cols.map(([, v]) => v)],
        );
        await writeAudit(tx, { ...ctx, action: "seller.update", entity: "seller", entityId: s.id, newValue: { fields: cols.map(([k]) => k.replace("_encrypted", "")) } });
      }
      return s.id as string;
    });
  } catch (e) {
    throw uniqueViolation(e) ?? e;
  }
}

export async function addDocument(d: Deps, ctx: Ctx, docType: DocType, file: { body: Buffer; mime: string; ext: string; name: string }) {
  const sellerId = await withTx(d.db, async (tx) => {
    const s = await lockOwn(tx, ctx.actorUserId);
    assertCanUpload(s.status, docType);
    await assertDocCapacity(tx, s.id);
    return s.id as string;
  });
  const docId = randomUUID();
  const key = `kyc/${sellerId}/${docId}.${file.ext}`;
  await d.storage.put(key, file.body, file.mime);
  try {
    await withTx(d.db, async (tx) => {
      const s = await lockOwn(tx, ctx.actorUserId);
      // Re-check under the lock: status or document count may have changed during the upload.
      assertCanUpload(s.status, docType);
      await assertDocCapacity(tx, s.id);
      await tx.query(
        `insert into seller_documents (id, seller_id, doc_type, storage_key, original_name, mime_type, size_bytes, sha256)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [docId, sellerId, docType, key, file.name, file.mime, file.body.length, createHash("sha256").update(file.body).digest("hex")],
      );
      await writeAudit(tx, { ...ctx, action: "seller.document_upload", entity: "seller", entityId: sellerId, newValue: { documentId: docId, docType } });
    });
  } catch (e) {
    await d.storage.remove(key).catch(() => {});
    throw e;
  }
  return docId;
}

async function assertDocCapacity(tx: Tx, sellerId: string): Promise<void> {
  const n = await tx.query(`select count(*)::int as n from seller_documents where seller_id = $1 and removed_at is null`, [sellerId]);
  if (n.rows[0].n >= MAX_ACTIVE_DOCS) throw Errors.conflict("TOO_MANY_DOCUMENTS", `You can keep up to ${MAX_ACTIVE_DOCS} documents. Remove one first.`);
}

export async function removeDocument(d: Deps, ctx: Ctx, docId: string): Promise<void> {
  await withTx(d.db, async (tx) => {
    const s = await lockOwn(tx, ctx.actorUserId);
    assertEditable(s.status);
    const r = await tx.query(
      `update seller_documents set removed_at = now() where id = $1 and seller_id = $2 and removed_at is null returning id`,
      [docId, s.id],
    );
    if (!r.rowCount) throw Errors.notFound("Document");
    await writeAudit(tx, { ...ctx, action: "seller.document_remove", entity: "seller", entityId: s.id, oldValue: { documentId: docId } });
  });
}

export async function readDocument(d: Deps, sellerId: string, docId: string) {
  const r = await d.db.query(
    `select storage_key, mime_type from seller_documents where id = $1 and seller_id = $2 and removed_at is null`,
    [docId, sellerId],
  );
  const doc = r.rows[0];
  if (!doc) throw Errors.notFound("Document");
  return { body: await d.storage.get(doc.storage_key), mime: doc.mime_type as string, ext: (doc.storage_key as string).split(".").pop()! };
}

export async function setBankAccount(d: Deps, ctx: Ctx, input: { accountHolderName: string; accountNumber: string; ifsc: string }): Promise<string> {
  return withTx(d.db, async (tx) => {
    const s = await lockOwn(tx, ctx.actorUserId);
    // Before approval: while editable. After approval: a change goes to admin review and is not used until verified.
    if (!EDITABLE.includes(s.status) && s.status !== "approved") {
      throw Errors.invalidTransition("Bank details cannot be changed while the application is in this state.");
    }
    await tx.query(`update seller_bank_accounts set status = 'replaced' where seller_id = $1 and status = 'pending'`, [s.id]);
    await resetReviews(tx, s.id, ["bank_proof"]);
    const id = randomUUID();
    await tx.query(
      `insert into seller_bank_accounts (id, seller_id, account_holder_name, account_number_encrypted, account_last4, ifsc)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, s.id, input.accountHolderName, d.cipher.encrypt(input.accountNumber, bankAad(id)), input.accountNumber.slice(-4), input.ifsc],
    );
    await writeAudit(tx, { ...ctx, action: "seller.bank_account_set", entity: "seller", entityId: s.id, newValue: { bankAccountId: id, last4: input.accountNumber.slice(-4), ifsc: input.ifsc } });
    return id;
  });
}

export async function submit(d: Deps, ctx: Ctx): Promise<void> {
  await withTx(d.db, async (tx) => {
    const s = await lockOwn(tx, ctx.actorUserId);
    assertEditable(s.status);
    const missing = await missingRequirements(tx, s);
    if (missing.length) {
      throw new AppError(422, "APPLICATION_INCOMPLETE", "Some required items are missing.", missing.map((m) => ({ path: m, message: "Required" })));
    }
    await tx.query(`update sellers set status = 'submitted', submitted_at = now() where id = $1`, [s.id]);
    await history(tx, s.id, s.status, "submitted", ctx.actorUserId);
    await writeAudit(tx, { ...ctx, action: "seller.submit", entity: "seller", entityId: s.id, oldValue: { status: s.status }, newValue: { status: "submitted" } });
  });
}

// ---------- admin actions ----------

async function lockForAdmin(tx: Tx, ctx: Ctx, sellerId: string) {
  const r = await tx.query(`select * from sellers where id = $1 for update`, [sellerId]);
  const s = r.rows[0];
  if (!s) throw Errors.notFound("Seller");
  // No admin may act on their own seller account.
  if (s.user_id === ctx.actorUserId) throw Errors.forbidden("You cannot review your own seller account.");
  return s;
}

export async function adminTransition(d: Deps, ctx: Ctx, sellerId: string, action: AdminAction, reason: string | null): Promise<void> {
  const rule = ADMIN_ACTIONS[action];
  if (rule.reasonRequired && !reason) throw Errors.validation([{ path: "reason", message: "A reason is required." }]);
  await withTx(d.db, async (tx) => {
    const s = await lockForAdmin(tx, ctx, sellerId);
    if (!(rule.from as readonly string[]).includes(s.status)) {
      throw Errors.invalidTransition(`Cannot ${action.replace("_", " ")} a seller whose status is ${s.status}.`);
    }
    if (action === "approve") {
      const required = requiredDocTypes(!!s.gstin);
      const ok = await tx.query(
        `select distinct doc_type from seller_documents where seller_id = $1 and removed_at is null and status = 'accepted'`,
        [s.id],
      );
      const accepted = new Set(ok.rows.map((r) => r.doc_type));
      const notAccepted = required.filter((t) => !accepted.has(t));
      if (notAccepted.length) {
        throw new AppError(422, "DOCUMENTS_NOT_ACCEPTED", "Accept every required document before approving.", notAccepted.map((t) => ({ path: `document:${t}`, message: "Not accepted yet" })));
      }
      const bank = await tx.query(
        `update seller_bank_accounts set status = 'verified', verified_by = $2, verified_at = now()
          where seller_id = $1 and status = 'pending'
            and not exists (select 1 from seller_bank_accounts v where v.seller_id = $1 and v.status = 'verified')
          returning id`,
        [s.id, ctx.actorUserId],
      );
      const hasVerified = bank.rowCount || (await tx.query(`select 1 from seller_bank_accounts where seller_id = $1 and status = 'verified'`, [s.id])).rowCount;
      if (!hasVerified) throw new AppError(422, "BANK_ACCOUNT_MISSING", "The seller has no bank account to verify.");
      await tx.query(`update sellers set status = 'approved', approved_at = now(), approved_by = $2 where id = $1`, [s.id, ctx.actorUserId]);
    } else {
      await tx.query(`update sellers set status = $2 where id = $1`, [s.id, rule.to]);
    }
    // The seller role exists exactly while the seller is approved.
    if (rule.to === "approved") {
      await tx.query(`insert into user_roles (user_id, role_key, granted_by) values ($1, 'seller', $2) on conflict do nothing`, [s.user_id, ctx.actorUserId]);
    } else {
      await tx.query(`delete from user_roles where user_id = $1 and role_key = 'seller'`, [s.user_id]);
    }
    await history(tx, s.id, s.status, rule.to, ctx.actorUserId, reason);
    await writeAudit(tx, { ...ctx, action: `seller.${action}`, entity: "seller", entityId: s.id, oldValue: { status: s.status }, newValue: { status: rule.to, reason } });
  });
}

export async function reviewDocument(d: Deps, ctx: Ctx, sellerId: string, docId: string, decision: "accepted" | "rejected", note: string | null) {
  if (decision === "rejected" && !note) throw Errors.validation([{ path: "note", message: "Say why the document was rejected." }]);
  await withTx(d.db, async (tx) => {
    const s = await lockForAdmin(tx, ctx, sellerId);
    if (!["submitted", "approved"].includes(s.status)) throw Errors.invalidTransition("Documents can be reviewed only after the seller submits.");
    const r = await tx.query(
      `update seller_documents set status = $3, review_note = $4, reviewed_by = $5, reviewed_at = now()
        where id = $1 and seller_id = $2 and removed_at is null returning id, doc_type`,
      [docId, s.id, decision, note, ctx.actorUserId],
    );
    if (!r.rowCount) throw Errors.notFound("Document");
    await writeAudit(tx, { ...ctx, action: "seller.document_review", entity: "seller", entityId: s.id, newValue: { documentId: docId, decision, note } });
  });
}

export async function reviewBankAccount(d: Deps, ctx: Ctx, sellerId: string, bankId: string, decision: "verified" | "rejected", note: string | null) {
  if (decision === "rejected" && !note) throw Errors.validation([{ path: "note", message: "Say why the account was rejected." }]);
  await withTx(d.db, async (tx) => {
    const s = await lockForAdmin(tx, ctx, sellerId);
    if (s.status !== "approved") throw Errors.invalidTransition("Before approval the bank account is verified as part of approving the seller.");
    const cur = await tx.query(`select id, created_at from seller_bank_accounts where id = $1 and seller_id = $2 and status = 'pending' for update`, [bankId, s.id]);
    if (!cur.rowCount) throw Errors.notFound("Pending bank account");
    if (decision === "verified") {
      // Money goes to this account, so it needs its own proof, uploaded and accepted after it was entered.
      const proof = await tx.query(
        `select 1 from seller_documents where seller_id = $1 and doc_type = 'bank_proof' and status = 'accepted'
            and removed_at is null and created_at >= $2`,
        [s.id, cur.rows[0].created_at],
      );
      if (!proof.rowCount) {
        throw new AppError(422, "BANK_PROOF_REQUIRED", "Accept a bank proof document uploaded for this account first.");
      }
      await tx.query(`update seller_bank_accounts set status = 'replaced' where seller_id = $1 and status = 'verified'`, [s.id]);
    }
    await tx.query(
      `update seller_bank_accounts set status = $2, review_note = $3, verified_by = $4, verified_at = case when $2 = 'verified' then now() end where id = $1`,
      [bankId, decision, note, ctx.actorUserId],
    );
    await writeAudit(tx, { ...ctx, action: "seller.bank_account_review", entity: "seller", entityId: s.id, newValue: { bankAccountId: bankId, decision, note } });
  });
}

// Full PAN and account numbers, for an admin checking them against the uploaded documents. Audited.
export async function revealSensitive(d: Deps, ctx: Ctx, sellerId: string) {
  const s = (await d.db.query(`select id, user_id, pan_encrypted from sellers where id = $1`, [sellerId])).rows[0];
  if (!s) throw Errors.notFound("Seller");
  if (s.user_id === ctx.actorUserId) throw Errors.forbidden("You cannot review your own seller account.");
  const banks = await d.db.query(
    `select id, account_number_encrypted, status from seller_bank_accounts where seller_id = $1 and status in ('pending', 'verified')`,
    [sellerId],
  );
  await writeAudit(d.db, { ...ctx, action: "seller.sensitive_viewed", entity: "seller", entityId: sellerId });
  return {
    pan: d.cipher.decrypt(s.pan_encrypted, panAad(s.id)),
    bankAccounts: banks.rows.map((b) => ({ id: b.id, status: b.status, accountNumber: d.cipher.decrypt(b.account_number_encrypted, bankAad(b.id)) })),
  };
}
