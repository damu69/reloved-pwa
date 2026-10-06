import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, cookieOf, CSRF } from "./helpers.js";

// Regression tests for the security review findings.
let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.close(); });

const reg = async (email: string) => {
  const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: `10.0.0.${Math.floor(Math.random() * 200) + 2}`, payload: { email, password: "correct horse battery", fullName: "X" } });
  return { id: r.json().user.id as string, at: r.json().accessToken as string, res: r };
};
const login = (email: string, ip: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: ip, headers, payload: { email, password: "wrong password!!" } });

describe("rate limits", () => {
  it("counts padded or re-cased emails as the same account", async () => {
    await reg("victim@example.com");
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const e = `${" ".repeat(i % 4)}${i % 2 ? "VICTIM" : "victim"}@example.com${" ".repeat(i % 3)}`;
      codes.push((await login(e, "10.1.1.1")).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
  it("limits one IP spraying many different accounts", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await login(`user${i}@example.com`, "10.2.2.2")).statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
  });
  it("ignores a spoofed X-Forwarded-For when no proxy is trusted", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login("victim2@example.com", "10.3.3.3", { "x-forwarded-for": `1.2.3.${i}` })).statusCode);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("input edge cases return 400, not 500", () => {
  it("rejects control characters in names", async () => {
    const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/register", remoteAddress: "10.4.4.4", payload: { email: "nul@example.com", password: "correct horse battery", fullName: "a\u0000b" } });
    expect(r.statusCode).toBe(400);
  });
  it("rejects odd but JS-parsable cursor dates", async () => {
    const a = await reg("cursor-admin@example.com");
    await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [a.id]);
    for (const tv of ["0", "1", "+275760-09-13T00:00:00.000Z"]) {
      const c = Buffer.from(JSON.stringify({ t: tv, id: a.id })).toString("base64url");
      const r = await t.app.inject({ method: "GET", url: `/api/v1/admin/users?cursor=${c}`, headers: { authorization: `Bearer ${a.at}` } });
      expect(r.statusCode).toBe(400);
    }
  });
});

describe("admin self-protection", () => {
  it("cannot be bypassed with an upper-case id", async () => {
    const a = await reg("self-admin@example.com");
    await t.pool.query(`insert into user_roles (user_id, role_key) values ($1, 'admin')`, [a.id]);
    const up = a.id.toUpperCase();
    const h = { authorization: `Bearer ${a.at}` };
    expect((await t.app.inject({ method: "DELETE", url: `/api/v1/admin/users/${up}/roles/admin`, headers: h })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "POST", url: `/api/v1/admin/users/${up}/suspend`, headers: h, payload: { reason: "self test" } })).statusCode).toBe(403);
    const still = await t.pool.query(`select 1 from user_roles where user_id = $1 and role_key = 'admin'`, [a.id]);
    expect(still.rowCount).toBe(1);
  });
});

describe("sessions", () => {
  it("a login cannot be refreshed past its absolute lifetime", async () => {
    const u = await reg("longlived@example.com");
    const rt = cookieOf(u.res)!;
    await t.pool.query(`update sessions set family_expires_at = now() - interval '1 second', expires_at = now() - interval '1 second'`);
    const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: CSRF, cookies: { rl_rt: rt } });
    expect(r.statusCode).toBe(401);
  });
  it("rotated tokens keep the family's absolute end date", async () => {
    const u = await reg("rotating@example.com");
    const before = (await t.pool.query(`select family_expires_at from sessions where user_id = $1`, [u.id])).rows[0].family_expires_at;
    const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: CSRF, cookies: { rl_rt: cookieOf(u.res)! } });
    expect(r.statusCode).toBe(200);
    const rows = (await t.pool.query(`select family_expires_at, expires_at from sessions where user_id = $1`, [u.id])).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.family_expires_at.getTime()).toBe(before.getTime());
      expect(row.expires_at.getTime()).toBeLessThanOrEqual(before.getTime());
    }
  });
  it("changing the password invalidates outstanding reset links", async () => {
    const u = await reg("changer@example.com");
    const f = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", remoteAddress: "10.5.5.5", payload: { email: "changer@example.com" } });
    const token = f.json().devResetToken;
    const c = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/change", headers: { authorization: `Bearer ${u.at}` }, payload: { currentPassword: "correct horse battery", newPassword: "a different passphrase" } });
    expect(c.statusCode).toBe(204);
    const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", remoteAddress: "10.5.5.5", payload: { token, password: "attacker passphrase!" } });
    expect(r.statusCode).toBe(400);
  });
  it("forgot-password takes the same minimum time for known and unknown emails", async () => {
    const time = async (email: string) => {
      const s = Date.now();
      await t.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", remoteAddress: "10.6.6.6", payload: { email } });
      return Date.now() - s;
    };
    expect(await time("nobody-here@example.com")).toBeGreaterThanOrEqual(395);
    expect(await time("changer@example.com")).toBeGreaterThanOrEqual(395);
  });
});

describe("request ids", () => {
  it("are always generated by the server", async () => {
    const r = await t.app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "attacker-chosen-id" } });
    expect(r.headers["x-request-id"]).not.toBe("attacker-chosen-id");
  });
});
