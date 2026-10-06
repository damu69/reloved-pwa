import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, multipartFile, PDF, PNG } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
type U = { id: string; at: string };
let admin: U, admin2: U, sam: U, eve: U;

const reg = async (email: string): Promise<U> => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, payload: { email, password: "correct horse battery", fullName: email } });
  return { id: r.json().user.id, at: r.json().accessToken };
};
const h = (u: U) => ({ authorization: `Bearer ${u.at}` });
const req = (u: U, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as any, url: `/api/v1${url}`, headers: h(u), ...(payload !== undefined ? { payload: payload as any } : {}) });
const upload = (u: U, docType: string, name: string, body: Buffer) => {
  const m = multipartFile(name, body);
  // Fresh address per upload so the per-IP upload rate limit does not interfere with these tests.
  return t.app.inject({ method: "POST", url: `/api/v1/seller/documents?docType=${docType}`, remoteAddress: `10.20.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, headers: { ...h(u), ...m.headers }, payload: m.payload });
};

const application = (over: object = {}) => ({
  displayName: "Sam's Finds", businessName: "Sam Traders", businessType: "proprietorship",
  pan: "abcpe1234f", addressLine1: "12 Market Road", city: "Nanded", state: "Maharashtra",
  pincode: "431601", contactPhone: "+919876543210", ...over,
});
const bank = { accountHolderName: "Sam Traders", accountNumber: "123456789012", accountNumberConfirm: "123456789012", ifsc: "hdfc0001234" };

beforeAll(async () => {
  t = await setup();
  admin = await reg("admin@example.com");
  admin2 = await reg("admin2@example.com");
  sam = await reg("sam@example.com");
  eve = await reg("eve@example.com");
  await t.pool.query(`insert into user_roles (user_id, role_key) select id, 'admin' from users where email in ('admin@example.com', 'admin2@example.com')`);
});
afterAll(async () => { await t.close(); });

let sellerId: string;
let docIds: Record<string, string> = {};

describe("applying", () => {
  it("validates PAN and that the GSTIN belongs to the PAN", async () => {
    expect((await req(sam, "POST", "/seller/application", application({ pan: "12345" }))).statusCode).toBe(400);
    const r = await req(sam, "POST", "/seller/application", application({ gstin: "27ZZZZZ9999Z1Z5" }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details[0].path).toBe("gstin");
  });
  it("creates a draft with the PAN encrypted at rest and masked in responses", async () => {
    const r = await req(sam, "POST", "/seller/application", application());
    expect(r.statusCode).toBe(201);
    const b = r.json();
    sellerId = b.id;
    expect(b.status).toBe("draft");
    expect(b.panMasked).toBe("XXXXXX234F");
    expect(JSON.stringify(b)).not.toContain("ABCPE1234F");
    const row = (await t.pool.query(`select pan_encrypted from sellers where id = $1`, [sellerId])).rows[0];
    expect(row.pan_encrypted).toMatch(/^v1:/);
    expect(row.pan_encrypted).not.toContain("ABCPE");
    expect(b.missing.sort()).toEqual(["bank_account", "document:address_proof", "document:bank_proof", "document:pan_card"]);
  });
  it("allows one application per user and unique store names", async () => {
    expect((await req(sam, "POST", "/seller/application", application({ displayName: "Other" }))).json().error.code).toBe("APPLICATION_EXISTS");
    expect((await req(eve, "POST", "/seller/application", application({ displayName: "SAM'S FINDS", pan: "ABCPE9999F" }))).json().error.code).toBe("STORE_NAME_TAKEN");
  });
  it("cannot submit while documents or bank account are missing", async () => {
    const r = await req(sam, "POST", "/seller/application/submit");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("APPLICATION_INCOMPLETE");
  });
});

describe("documents", () => {
  it("rejects files that are not PDF or images, whatever their name says", async () => {
    const r = await upload(sam, "pan_card", "pan.pdf", Buffer.from("MZ\x90\x00 this is an exe"));
    expect(r.statusCode).toBe(415);
    const html = await upload(sam, "pan_card", "pan.png", Buffer.from("<script>alert(1)</script>"));
    expect(html.statusCode).toBe(415);
  });
  it("rejects files over 5 MB", async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024 + 10, 0x20)]);
    const r = await upload(sam, "pan_card", "big.pdf", big);
    expect(r.statusCode).toBe(413);
  });
  it("accepts a PDF and an image, and stores them outside the database", async () => {
    for (const [type, name, body] of [["pan_card", "pan.pdf", PDF], ["address_proof", "bill.png", PNG], ["bank_proof", "../../etc/cheque.pdf", PDF]] as const) {
      const r = await upload(sam, type, name, body);
      expect(r.statusCode).toBe(201);
      docIds[type] = r.json().id;
    }
    const row = (await t.pool.query(`select storage_key, original_name, sha256 from seller_documents where id = $1`, [docIds.bank_proof])).rows[0];
    expect(row.storage_key).toMatch(new RegExp(`^kyc/${sellerId}/[0-9a-f-]+\\.pdf$`));
    expect(row.original_name).not.toContain("/");
  });
  it("lets the owner download a document but hides it from everyone else", async () => {
    const own = await req(sam, "GET", `/seller/documents/${docIds.pan_card}/file`);
    expect(own.statusCode).toBe(200);
    expect(own.headers["content-type"]).toBe("application/pdf");
    expect(own.headers["content-disposition"]).toMatch(/attachment/);
    expect(own.rawPayload.equals(PDF)).toBe(true);
    await req(eve, "POST", "/seller/application", application({ displayName: "Eve Shop", pan: "ABCPE9999F" }));
    expect((await req(eve, "GET", `/seller/documents/${docIds.pan_card}/file`)).statusCode).toBe(404);
    expect((await req(eve, "GET", `/admin/sellers/${sellerId}/documents/${docIds.pan_card}/file`)).statusCode).toBe(403);
  });
});

describe("bank account", () => {
  it("requires matching confirmation and valid IFSC", async () => {
    expect((await req(sam, "PUT", "/seller/bank-account", { ...bank, accountNumberConfirm: "123456789013" })).statusCode).toBe(400);
    expect((await req(sam, "PUT", "/seller/bank-account", { ...bank, ifsc: "HDFC1001234" })).statusCode).toBe(400);
  });
  it("stores the account number encrypted and shows only the last 4 digits", async () => {
    const r = await req(sam, "PUT", "/seller/bank-account", bank);
    expect(r.statusCode).toBe(200);
    expect(r.json().bankAccounts[0].accountNumberMasked).toBe("XXXX9012");
    expect(r.json().bankAccounts[0].ifsc).toBe("HDFC0001234");
    expect(JSON.stringify(r.json())).not.toContain("123456789012");
    const enc = (await t.pool.query(`select account_number_encrypted from seller_bank_accounts where seller_id = $1`, [sellerId])).rows[0];
    expect(enc.account_number_encrypted).not.toContain("123456789012");
  });
});

describe("submission and review", () => {
  it("submits a complete application and then locks editing", async () => {
    const r = await req(sam, "POST", "/seller/application/submit");
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("submitted");
    expect((await req(sam, "PATCH", "/seller/application", { city: "Pune" })).statusCode).toBe(422);
    expect((await upload(sam, "other", "x.pdf", PDF)).statusCode).toBe(422);
    expect((await req(sam, "PUT", "/seller/bank-account", bank)).statusCode).toBe(422);
  });
  it("is invisible to non-admins", async () => {
    expect((await req(eve, "GET", "/admin/sellers")).statusCode).toBe(403);
    expect((await req(eve, "POST", `/admin/sellers/${sellerId}/approve`, {})).statusCode).toBe(403);
    expect((await req(sam, "POST", `/admin/sellers/${sellerId}/approve`, {})).statusCode).toBe(403);
  });
  it("cannot be approved until every required document is accepted", async () => {
    const r = await req(admin, "POST", `/admin/sellers/${sellerId}/approve`, {});
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("DOCUMENTS_NOT_ACCEPTED");
  });
  it("needs a note to reject a document; a rejection makes it missing again", async () => {
    expect((await req(admin, "POST", `/admin/sellers/${sellerId}/documents/${docIds.address_proof}/review`, { decision: "rejected" })).statusCode).toBe(400);
    expect((await req(admin, "POST", `/admin/sellers/${sellerId}/documents/${docIds.address_proof}/review`, { decision: "rejected", note: "Blurry photo" })).statusCode).toBe(204);
    const v = (await req(admin, "GET", `/admin/sellers/${sellerId}`)).json();
    expect(v.missing).toEqual(["document:address_proof"]);
  });
  it("request changes reopens editing; the seller fixes it and resubmits", async () => {
    expect((await req(admin, "POST", `/admin/sellers/${sellerId}/request-changes`, {})).statusCode).toBe(400);
    const rc = await req(admin, "POST", `/admin/sellers/${sellerId}/request-changes`, { reason: "Upload a clearer address proof" });
    expect(rc.statusCode).toBe(200);
    expect(rc.json().status).toBe("changes_requested");
    const up = await upload(sam, "address_proof", "bill2.png", PNG);
    docIds.address_proof = up.json().id;
    expect((await req(sam, "POST", "/seller/application/submit")).statusCode).toBe(200);
  });
  it("admins view documents with an audit entry, and can reveal PAN and account number with an audit entry", async () => {
    const f = await req(admin, "GET", `/admin/sellers/${sellerId}/documents/${docIds.pan_card}/file`);
    expect(f.statusCode).toBe(200);
    const s = await req(admin, "GET", `/admin/sellers/${sellerId}/sensitive`);
    expect(s.json().pan).toBe("ABCPE1234F");
    expect(s.json().bankAccounts[0].accountNumber).toBe("123456789012");
    const a = await t.pool.query(`select action from audit_logs where entity_id = $1 and action in ('seller.document_viewed', 'seller.sensitive_viewed')`, [sellerId]);
    expect(a.rows.map((x) => x.action).sort()).toEqual(["seller.document_viewed", "seller.sensitive_viewed"]);
  });
  it("approves once, grants the seller role, verifies the bank account, and records history", async () => {
    for (const id of Object.values(docIds)) {
      expect((await req(admin, "POST", `/admin/sellers/${sellerId}/documents/${id}/review`, { decision: "accepted" })).statusCode).toBe(204);
    }
    // Two admins approving at the same moment: exactly one wins.
    const [a, b] = await Promise.all([
      req(admin, "POST", `/admin/sellers/${sellerId}/approve`, {}),
      req(admin2, "POST", `/admin/sellers/${sellerId}/approve`, {}),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 422]);
    const me = (await req(sam, "GET", "/me")).json();
    expect(me.user.roles).toContain("seller");
    const v = (await req(sam, "GET", "/seller/application")).json();
    expect(v.status).toBe("approved");
    expect(v.bankAccounts[0].status).toBe("verified");
    expect(v.history.map((x: any) => x.to)).toEqual(["draft", "submitted", "changes_requested", "submitted", "approved"]);
    expect(v.history[0].actorId).toBeUndefined();
  });
});

describe("after approval", () => {
  it("a new bank account waits for review while the verified one stays in force", async () => {
    const r = await req(sam, "PUT", "/seller/bank-account", { ...bank, accountNumber: "999988887777", accountNumberConfirm: "999988887777" });
    expect(r.statusCode).toBe(200);
    const accounts = r.json().bankAccounts;
    expect(accounts.map((x: any) => x.status).sort()).toEqual(["pending", "verified"]);
    const pending = accounts.find((x: any) => x.status === "pending");
    // Not without proof for the new account.
    const noProof = await req(admin, "POST", `/admin/sellers/${sellerId}/bank-accounts/${pending.id}/review`, { decision: "verified" });
    expect(noProof.json().error.code).toBe("BANK_PROOF_REQUIRED");
    // After approval the seller may upload only a bank proof.
    expect((await upload(sam, "address_proof", "a.pdf", PDF)).statusCode).toBe(422);
    const proof = await upload(sam, "bank_proof", "cheque2.pdf", PDF);
    expect(proof.statusCode).toBe(201);
    expect((await req(admin, "POST", `/admin/sellers/${sellerId}/documents/${proof.json().id}/review`, { decision: "accepted" })).statusCode).toBe(204);
    expect((await req(admin, "POST", `/admin/sellers/${sellerId}/bank-accounts/${pending.id}/review`, { decision: "verified" })).statusCode).toBe(204);
    const after = (await req(sam, "GET", "/seller/application")).json().bankAccounts;
    expect(after.filter((x: any) => x.status === "verified").map((x: any) => x.accountNumberMasked)).toEqual(["XXXX7777"]);
  });
  it("only allows valid transitions", async () => {
    expect((await req(admin, "POST", `/admin/sellers/${sellerId}/approve`, {})).statusCode).toBe(422);
    expect((await req(admin, "POST", `/admin/sellers/${sellerId}/reinstate`, { reason: "n/a" })).statusCode).toBe(422);
    expect((await req(admin, "POST", `/admin/sellers/${sellerId}/suspend`, { reason: "Counterfeit reports" })).json().status).toBe("suspended");
    expect((await req(sam, "GET", "/me")).json().user.roles).not.toContain("seller");
    expect((await req(admin, "POST", `/admin/sellers/${sellerId}/reinstate`, { reason: "Resolved" })).json().status).toBe("approved");
    expect((await req(sam, "GET", "/me")).json().user.roles).toContain("seller");
  });
  it("an admin cannot approve or inspect their own seller account", async () => {
    await req(admin2, "POST", "/seller/application", application({ displayName: "Admin Two Store", pan: "AAAPA1111A" }));
    const own = (await t.pool.query(`select id from sellers where user_id = $1`, [admin2.id])).rows[0].id;
    await t.pool.query(`update sellers set status = 'submitted' where id = $1`, [own]);
    expect((await req(admin2, "POST", `/admin/sellers/${own}/approve`, {})).statusCode).toBe(403);
    expect((await req(admin2, "GET", `/admin/sellers/${own}/sensitive`)).statusCode).toBe(403);
  });
  it("lists sellers by status with pagination", async () => {
    const r = await req(admin, "GET", "/admin/sellers?status=approved");
    expect(r.json().items.map((x: any) => x.id)).toEqual([sellerId]);
  });
  it("keeps status history append-only", async () => {
    await expect(t.pool.query(`delete from seller_status_history`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`truncate seller_status_history`)).rejects.toThrow(/append-only/);
  });
});

describe("encryption binding", () => {
  it("a PAN ciphertext copied to another seller does not decrypt", async () => {
    const eveId = (await t.pool.query(`select id from sellers where user_id = $1`, [eve.id])).rows[0].id;
    await t.pool.query(`update sellers set pan_encrypted = (select pan_encrypted from sellers where id = $1) where id = $2`, [sellerId, eveId]);
    const r = await req(admin, "GET", `/admin/sellers/${eveId}/sensitive`);
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.json())).not.toContain("ABCPE1234F");
  });
});

describe("review findings (regressions)", () => {
  let carl: U, carlSeller: string;
  const docs: Record<string, string> = {};
  it("changing PAN or bank account after documents were accepted sends them back for review", async () => {
    carl = await reg("carl@example.com");
    carlSeller = (await req(carl, "POST", "/seller/application", application({ displayName: "Carl Co", pan: "CCCPC1111C" }))).json().id;
    for (const [type, body] of [["pan_card", PDF], ["address_proof", PNG], ["bank_proof", PDF]] as const) {
      docs[type] = (await upload(carl, type, `${type}.pdf`, body)).json().id;
    }
    await req(carl, "PUT", "/seller/bank-account", bank);
    await req(carl, "POST", "/seller/application/submit");
    for (const id of Object.values(docs)) await req(admin, "POST", `/admin/sellers/${carlSeller}/documents/${id}/review`, { decision: "accepted" });
    await req(admin, "POST", `/admin/sellers/${carlSeller}/request-changes`, { reason: "Fix the phone number" });
    expect((await req(carl, "PATCH", "/seller/application", { pan: "ZZZPZ9999Z" })).statusCode).toBe(200);
    await req(carl, "PUT", "/seller/bank-account", { ...bank, accountNumber: "999900001111", accountNumberConfirm: "999900001111" });
    await req(carl, "POST", "/seller/application/submit");
    const r = await req(admin, "POST", `/admin/sellers/${carlSeller}/approve`, {});
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details.map((d: any) => d.path).sort()).toEqual(["document:bank_proof", "document:pan_card"]);
    const v = (await req(admin, "GET", `/admin/sellers/${carlSeller}`)).json();
    expect(v.documents.find((d: any) => d.docType === "address_proof").status).toBe("accepted");
  });
  it("parallel uploads cannot exceed the 20-document cap", async () => {
    const dan = await reg("dan@example.com");
    await req(dan, "POST", "/seller/application", application({ displayName: "Dan Depot", pan: "DDDPD2222D" }));
    for (let i = 0; i < 15; i++) await upload(dan, "other", `o${i}.pdf`, PDF);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => upload(dan, "other", `p${i}.pdf`, PDF)));
    expect(results.filter((r) => r.statusCode === 201).length).toBe(5);
    expect(results.filter((r) => r.statusCode === 409).length).toBe(7);
    const n = await t.pool.query(`select count(*)::int as n from seller_documents d join sellers s on s.id = d.seller_id where s.user_id = $1 and d.removed_at is null`, [dan.id]);
    expect(n.rows[0].n).toBe(20);
  });
  it("malformed multipart returns 400, not 500", async () => {
    const noBoundary = await t.app.inject({ method: "POST", url: "/api/v1/seller/documents?docType=other", remoteAddress: "10.30.0.1", headers: { ...h(carl), "content-type": "multipart/form-data" }, payload: "garbage" });
    expect(noBoundary.statusCode).toBe(400);
    const m = multipartFile("x.pdf", PDF);
    const truncated = await t.app.inject({ method: "POST", url: "/api/v1/seller/documents?docType=other", remoteAddress: "10.30.0.2", headers: { ...h(carl), ...m.headers }, payload: m.payload.subarray(0, m.payload.length - 20) });
    expect([400, 422]).toContain(truncated.statusCode);
  });
});

describe("upload rate limit", () => {
  it("still applies per IP", async () => {
    const fay = await reg("fay@example.com");
    await req(fay, "POST", "/seller/application", application({ displayName: "Fay Finds", pan: "FFFPF3333F" }));
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) {
      const m = multipartFile("x.pdf", PDF);
      codes.push((await t.app.inject({ method: "POST", url: "/api/v1/seller/documents?docType=other", remoteAddress: "10.40.0.1", headers: { ...h(fay), ...m.headers }, payload: m.payload })).statusCode);
    }
    expect(codes.at(-1)).toBe(429);
  });
});
