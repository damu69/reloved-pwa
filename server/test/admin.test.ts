import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
let admin: { id: string; at: string };
let alice: { id: string; at: string };
let bob: { id: string; at: string };

const reg = async (email: string) => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password: "correct horse battery", fullName: email } });
  return { id: r.json().user.id as string, at: r.json().accessToken as string };
};
const as = (at: string) => ({ authorization: `Bearer ${at}` });

beforeAll(async () => {
  t = await setup();
  admin = await reg("admin@example.com");
  alice = await reg("alice@example.com");
  bob = await reg("bob@example.com");
  await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [admin.id]);
});
afterAll(async () => { await t.close(); });

describe("authorization", () => {
  it("blocks customers from admin routes with 403", async () => {
    for (const [method, url] of [["GET", "/api/v1/admin/users"], ["GET", "/api/v1/admin/audit-logs"]] as const) {
      expect((await t.app.inject({ method, url, headers: as(alice.at) })).statusCode).toBe(403);
    }
  });
  it("blocks a customer from granting themselves admin", async () => {
    const r = await t.app.inject({ method: "POST", url: `/api/v1/admin/users/${alice.id}/roles`, headers: as(alice.at), payload: { role: "admin" } });
    expect(r.statusCode).toBe(403);
    const roles = await t.pool.query(`select role_key from user_roles where user_id = $1`, [alice.id]);
    expect(roles.rows.map((x) => x.role_key)).toEqual(["customer"]);
  });
  it("lets an admin list users with cursor pagination", async () => {
    const p1 = await t.app.inject({ method: "GET", url: "/api/v1/admin/users?limit=2", headers: as(admin.at) });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().items).toHaveLength(2);
    const p2 = await t.app.inject({ method: "GET", url: `/api/v1/admin/users?limit=2&cursor=${p1.json().nextCursor}`, headers: as(admin.at) });
    expect(p2.json().items).toHaveLength(1);
    expect(p2.json().nextCursor).toBeNull();
    const all = [...p1.json().items, ...p2.json().items].map((u: any) => u.email).sort();
    expect(all).toEqual(["admin@example.com", "alice@example.com", "bob@example.com"]);
  });
  it("rejects a forged cursor with 400, not 500", async () => {
    const bad = Buffer.from(JSON.stringify({ t: "2026-01-01T00:00:00Z", id: "x" })).toString("base64url");
    const r = await t.app.inject({ method: "GET", url: `/api/v1/admin/users?cursor=${bad}`, headers: as(admin.at) });
    expect(r.statusCode).toBe(400);
  });
});

describe("role changes and suspension", () => {
  it("applies a role grant on the next request and audits it", async () => {
    const g = await t.app.inject({ method: "POST", url: `/api/v1/admin/users/${bob.id}/roles`, headers: as(admin.at), payload: { role: "seller" } });
    expect(g.statusCode).toBe(204);
    const m = await t.app.inject({ method: "GET", url: "/api/v1/me", headers: as(bob.at) });
    expect(m.json().user.roles).toEqual(["customer", "seller"]);
    const a = await t.pool.query(`select actor_user_id, new_value from audit_logs where action = 'role.grant' and entity_id = $1`, [bob.id]);
    expect(a.rows[0].actor_user_id).toBe(admin.id);
    expect(a.rows[0].new_value).toEqual({ role: "seller" });
  });
  it("suspending a user kills their live access token at once", async () => {
    const s = await t.app.inject({ method: "POST", url: `/api/v1/admin/users/${bob.id}/suspend`, headers: as(admin.at), payload: { reason: "Testing suspension" } });
    expect(s.statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/me", headers: as(bob.at) })).statusCode).toBe(401);
    const l = await t.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "bob@example.com", password: "correct horse battery" } });
    expect(l.statusCode).toBe(403);
    expect(l.json().error.code).toBe("ACCOUNT_SUSPENDED");
  });
  it("prevents an admin from removing their own admin role or suspending themselves", async () => {
    expect((await t.app.inject({ method: "DELETE", url: `/api/v1/admin/users/${admin.id}/roles/admin`, headers: as(admin.at) })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "POST", url: `/api/v1/admin/users/${admin.id}/suspend`, headers: as(admin.at), payload: { reason: "self test" } })).statusCode).toBe(403);
  });
  it("returns 404 for unknown users", async () => {
    const r = await t.app.inject({ method: "POST", url: `/api/v1/admin/users/00000000-0000-4000-8000-000000000000/roles`, headers: as(admin.at), payload: { role: "seller" } });
    expect(r.statusCode).toBe(404);
  });
});

describe("audit log", () => {
  it("is readable by admins with filters", async () => {
    const r = await t.app.inject({ method: "GET", url: `/api/v1/admin/audit-logs?entity=user&entityId=${bob.id}`, headers: as(admin.at) });
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((x: any) => x.action)).toContain("user.suspend");
  });
  it("cannot be updated, deleted or truncated, even by the database owner", async () => {
    await expect(t.pool.query(`update audit_logs set action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`delete from audit_logs`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`truncate audit_logs`)).rejects.toThrow(/append-only/);
  });
});

describe("error format", () => {
  it("uses the standard error shape with a request id for unknown routes and bad JSON", async () => {
    const nf = await t.app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.requestId).toBeTypeOf("string");
    const bad = await t.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("BAD_REQUEST");
    expect(bad.headers["x-request-id"]).toBeTypeOf("string");
  });
});
