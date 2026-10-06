import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, cookieOf, CSRF } from "./helpers.js";

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.close(); });

const reg = (email: string, password = "correct horse battery", extra: object = {}) =>
  t.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password, fullName: "Test User", ...extra } });
const login = (email: string, password = "correct horse battery") =>
  t.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
const refresh = (rt: string) =>
  t.app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: CSRF, cookies: { rl_rt: rt } });
const me = (at: string) => t.app.inject({ method: "GET", url: "/api/v1/me", headers: { authorization: `Bearer ${at}` } });

describe("registration", () => {
  it("creates a customer, returns an access token and sets an httpOnly strict refresh cookie", async () => {
    const r = await reg("Alice@Example.com");
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.user.email).toBe("alice@example.com");
    expect(b.user.roles).toEqual(["customer"]);
    expect(b.accessToken).toBeTypeOf("string");
    const setCookie = String(r.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(b.passwordHash ?? b.user.passwordHash).toBeUndefined();
  });
  it("rejects duplicate email regardless of case", async () => {
    const r = await reg("ALICE@example.com");
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("ACCOUNT_EXISTS");
  });
  it("validates input with field details and rejects unknown fields", async () => {
    const r = await reg("not-an-email", "short");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("VALIDATION_FAILED");
    expect(r.json().error.details.map((d: any) => d.path).sort()).toEqual(["email", "password"]);
    const r2 = await reg("bob@example.com", "correct horse battery", { roles: ["admin"] });
    expect(r2.statusCode).toBe(400);
  });
  it("stores an argon2id hash, never the password", async () => {
    const row = (await t.pool.query(`select password_hash from users where email = 'alice@example.com'`)).rows[0];
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
  });
});

describe("login and sessions", () => {
  it("logs in and reads /me", async () => {
    const r = await login("alice@example.com");
    expect(r.statusCode).toBe(200);
    const m = await me(r.json().accessToken);
    expect(m.statusCode).toBe(200);
    expect(m.json().user.email).toBe("alice@example.com");
  });
  it("gives the same error for wrong password and unknown email", async () => {
    const a = await login("alice@example.com", "wrong password here");
    const b = await login("nobody@example.com", "wrong password here");
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.code).toBe(b.json().error.code);
  });
  it("rejects missing, malformed and tampered tokens", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
    expect((await me("garbage")).statusCode).toBe(401);
    const at = (await login("alice@example.com")).json().accessToken as string;
    const parts = at.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1]!, "base64url").toString()), sub: "00000000-0000-0000-0000-000000000000" })).toString("base64url");
    expect((await me(`${parts[0]}.${forged}.${parts[2]}`)).statusCode).toBe(401);
  });
  it("rotates refresh tokens and revokes the whole login when an old token is replayed", async () => {
    const l = await login("alice@example.com");
    const rt1 = cookieOf(l)!;
    const r1 = await refresh(rt1);
    expect(r1.statusCode).toBe(200);
    const rt2 = cookieOf(r1)!;
    expect(rt2).not.toBe(rt1);
    const replay = await refresh(rt1);
    expect(replay.statusCode).toBe(401);
    // The newer token from the same login is now dead too, and so is its access token.
    expect((await refresh(rt2)).statusCode).toBe(401);
    expect((await me(r1.json().accessToken)).statusCode).toBe(401);
    const audit = await t.pool.query(`select 1 from audit_logs where action = 'auth.refresh_reuse_detected'`);
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });
  it("requires the CSRF header and an allowed origin on cookie routes", async () => {
    const rt = cookieOf(await login("alice@example.com"))!;
    const noHeader = await t.app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rl_rt: rt } });
    expect(noHeader.statusCode).toBe(403);
    const badOrigin = await t.app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { "x-requested-with": "reloved", origin: "https://evil.example" }, cookies: { rl_rt: rt } });
    expect(badOrigin.statusCode).toBe(403);
  });
  it("logout revokes the session immediately, including its access token", async () => {
    const l = await login("alice@example.com");
    const at = l.json().accessToken;
    const out = await t.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: CSRF, cookies: { rl_rt: cookieOf(l)! } });
    expect(out.statusCode).toBe(204);
    expect((await me(at)).statusCode).toBe(401);
  });
});

describe("password reset", () => {
  it("does not reveal whether an email exists", async () => {
    const a = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email: "nobody@example.com" } });
    expect(a.statusCode).toBe(202);
    expect(a.json().message).toMatch(/If that email/);
  });
  it("resets once, signs out every session, and the token cannot be reused", async () => {
    const before = (await login("alice@example.com")).json().accessToken;
    const f = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email: "alice@example.com" } });
    const token = f.json().devResetToken;
    expect(token).toBeTypeOf("string");
    const ok = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token, password: "a brand new passphrase" } });
    expect(ok.statusCode).toBe(204);
    expect((await me(before)).statusCode).toBe(401);
    const again = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token, password: "another new passphrase" } });
    expect(again.statusCode).toBe(400);
    expect((await login("alice@example.com", "a brand new passphrase")).statusCode).toBe(200);
  });
  it("rejects expired tokens", async () => {
    const f = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email: "alice@example.com" } });
    await t.pool.query(`update password_resets set expires_at = now() - interval '1 minute' where used_at is null`);
    const r = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token: f.json().devResetToken, password: "expired attempt pass" } });
    expect(r.statusCode).toBe(400);
  });
});

describe("expired access token", () => {
  it("returns SESSION_EXPIRED", async () => {
    const { SignJWT } = await import("jose");
    const l = (await login("alice@example.com", "a brand new passphrase")).json();
    const old = await new SignJWT({ sid: "00000000-0000-0000-0000-000000000000" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(l.user.id).setIssuer(t.cfg.JWT_ISSUER).setAudience("reloved")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(t.cfg.JWT_SECRET));
    const r = await me(old);
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("SESSION_EXPIRED");
  });
});
