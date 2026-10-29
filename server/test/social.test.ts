import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { setup, cookieOf, CSRF } from "./helpers.js";

const GOOGLE_ID = "test-google-client-id.apps.googleusercontent.com";
const FB_ID = "1234567890";
let t: Awaited<ReturnType<typeof setup>>;
let privateKey: CryptoKey;
let jwks: { keys: unknown[] };

// What the fake Facebook returns for the next call.
let fbToken = { valid: true, appId: FB_ID, userId: "fb-1", me: { id: "fb-1", name: "Fay Book", email: "fay@example.com" } as Record<string, unknown> };

const idToken = (o: { sub?: string; email?: string | null; verified?: boolean; aud?: string; nonce?: string; name?: string; exp?: string } = {}) => {
  const claims: Record<string, unknown> = { name: o.name ?? "Gita Google", email_verified: o.verified ?? true };
  if (o.email !== null) claims.email = o.email ?? "gita@example.com";
  if (o.nonce) claims.nonce = o.nonce;
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://accounts.google.com")
    .setAudience(o.aud ?? GOOGLE_ID).setSubject(o.sub ?? "g-1").setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(privateKey);
};

let nextIdToken = "";
const realFetch = globalThis.fetch;
function fakeFetch(input: any, init?: any) {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }));
  if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return json(jwks);
  if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ id_token: nextIdToken });
  if (url.includes("/oauth/access_token")) return json({ access_token: "fb-access-token-abc" });
  if (url.includes("/debug_token")) return json({ data: { is_valid: fbToken.valid, app_id: fbToken.appId, user_id: fbToken.userId } });
  if (url.includes("/me?")) return json(fbToken.me);
  return realFetch(input, init);
}

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  vi.stubGlobal("fetch", fakeFetch);
  t = await setup({ GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_CLIENT_SECRET: "google-secret-1234567890", FACEBOOK_APP_ID: FB_ID, FACEBOOK_APP_SECRET: "facebook-secret-1234567890", FACEBOOK_CLIENT_TOKEN: "fb-client-token-123", APP_URL: "http://localhost:5173" });
});
afterAll(async () => { vi.unstubAllGlobals(); await t.close(); });
afterEach(() => { fbToken = { valid: true, appId: FB_ID, userId: "fb-1", me: { id: "fb-1", name: "Fay Book", email: "fay@example.com" } }; });

const post = (url: string, payload: object, headers: Record<string, string> = {}) => t.app.inject({ method: "POST", url: `/api/v1/auth/social${url}`, payload, headers });
const google = async (o: Parameters<typeof idToken>[0] = {}) => post("/google/token", { idToken: await idToken(o) });
const facebook = (headers: Record<string, string> = {}) => post("/facebook/token", { accessToken: "fb-access-token-abc" }, headers);
const register = (email: string, password = "correct horse battery") =>
  t.app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password, fullName: "Existing Person" } });
const login = (email: string, password = "correct horse battery") =>
  t.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
const rows = async (sql: string, args: unknown[] = []) => (await t.pool.query(sql, args)).rows;

describe("providers", () => {
  it("lists the enabled providers and refuses unknown ones", async () => {
    const r = await t.app.inject({ method: "GET", url: "/api/v1/auth/social/providers" });
    expect(r.json()).toEqual({ providers: ["google", "facebook"], googleClientId: GOOGLE_ID, facebookAppId: FB_ID, facebookClientToken: "fb-client-token-123" });
    const bad = await t.app.inject({ method: "GET", url: "/api/v1/auth/social/apple/start" });
    expect(bad.statusCode).toBe(404);
  });
});

describe("Google token sign-in (Android app)", () => {
  it("creates a customer with no password, and signs the same person in next time", async () => {
    const r = await google();
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.user).toMatchObject({ email: "gita@example.com", fullName: "Gita Google", roles: ["customer"], hasPassword: false, providers: ["google"] });
    expect(b.accessToken).toBeTypeOf("string");
    expect((await rows(`select password_hash, email_verified_at from users where email = 'gita@example.com'`))[0]).toMatchObject({ password_hash: "!social" });
    const again = await google();
    expect(again.json().user.id).toBe(b.user.id);
    expect(await rows(`select 1 from user_identities where user_id = $1`, [b.user.id])).toHaveLength(1);
  });
  it("the password login path cannot be used on a social-only account", async () => {
    const r = await login("gita@example.com", "!social");
    expect(r.statusCode).toBe(401);
  });
  it("returns the refresh token in the body for the app", async () => {
    const r = await post("/google/token", { idToken: await idToken() }, { "x-client": "app" });
    expect(r.json().refreshToken).toBeTypeOf("string");
    expect(String(r.headers["set-cookie"] ?? "")).not.toMatch(/rl_rt=/);
  });
  it("rejects a token made for another app, an expired token, and a forged signature", async () => {
    expect((await google({ aud: "someone-elses-client-id" })).json().error.code).toBe("SOCIAL_FAILED");
    expect((await google({ exp: "-1m" })).statusCode).toBe(401);
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: "x@example.com", email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://accounts.google.com").setAudience(GOOGLE_ID).setSubject("g-evil").setExpirationTime("5m").sign(other.privateKey);
    expect((await post("/google/token", { idToken: forged })).statusCode).toBe(401);
    expect(await rows(`select 1 from users where email = 'x@example.com'`)).toHaveLength(0);
  });
  it("rejects a token without an email", async () => {
    const r = await google({ email: null, sub: "g-noemail" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("SOCIAL_EMAIL_REQUIRED");
  });
  it("rejects unknown body fields", async () => {
    expect((await post("/google/token", { idToken: await idToken(), roles: ["admin"] })).statusCode).toBe(400);
  });
});

describe("linking to an existing password account", () => {
  it("Google (verified email) takes over an account whose email was never verified: old password and sessions are dropped", async () => {
    const reg = await register("pat@example.com");
    const oldToken = reg.json().accessToken;
    const g = await google({ email: "pat@example.com", sub: "g-pat" });
    expect(g.statusCode).toBe(200);
    expect(g.json().user.id).toBe(reg.json().user.id);
    expect((await login("pat@example.com")).statusCode).toBe(401); // attacker-set password no longer works
    const me = await t.app.inject({ method: "GET", url: "/api/v1/me", headers: { authorization: `Bearer ${oldToken}` } });
    expect(me.statusCode).toBe(401); // old session revoked
    expect((await rows(`select email_verified_at from users where email = 'pat@example.com'`))[0].email_verified_at).not.toBeNull();
  });
  it("Google keeps the password when the email was already verified", async () => {
    await register("quinn@example.com");
    await t.pool.query(`update users set email_verified_at = now() where email = 'quinn@example.com'`);
    const g = await google({ email: "quinn@example.com", sub: "g-quinn" });
    expect(g.json().user).toMatchObject({ hasPassword: true, providers: ["google"] });
    expect((await login("quinn@example.com")).statusCode).toBe(200);
  });
  it("Facebook never attaches by email alone; after a password sign-in the person can connect it", async () => {
    await register("fay@example.com");
    const blocked = await facebook();
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("ACCOUNT_EXISTS_USE_PASSWORD");
    const l = await login("fay@example.com");
    const linked = await facebook({ authorization: `Bearer ${l.json().accessToken}` });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().user.providers).toEqual(["facebook"]);
    const viaFb = await facebook();
    expect(viaFb.json().user.id).toBe(l.json().user.id);
  });
  it("a provider account cannot be connected to two Reloved accounts", async () => {
    const other = await login("quinn@example.com"); // a different account from the one Facebook is already connected to
    const r = await facebook({ authorization: `Bearer ${other.json().accessToken}` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("SOCIAL_ALREADY_LINKED");
  });
});

describe("Facebook token checks", () => {
  it("creates a new customer from a valid token", async () => {
    fbToken.userId = "fb-9"; fbToken.me = { id: "fb-9", name: "Newt Face", email: "newt@example.com" };
    const r = await facebook();
    expect(r.statusCode).toBe(200);
    expect(r.json().user).toMatchObject({ email: "newt@example.com", providers: ["facebook"], hasPassword: false });
    expect((await rows(`select email_verified_at from users where email = 'newt@example.com'`))[0].email_verified_at).toBeNull();
  });
  it("rejects a token issued to a different Facebook app, and an invalid token", async () => {
    fbToken.appId = "999";
    expect((await facebook()).json().error.code).toBe("SOCIAL_FAILED");
    fbToken.appId = FB_ID; fbToken.valid = false;
    expect((await facebook()).statusCode).toBe(401);
  });
  it("asks for an email when Facebook shares none", async () => {
    fbToken.userId = "fb-10"; fbToken.me = { id: "fb-10", name: "No Mail" };
    const r = await facebook();
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("SOCIAL_EMAIL_REQUIRED");
  });
});

describe("website redirect flow", () => {
  const stateCookie = (res: { headers: Record<string, unknown> }) => {
    const raw = res.headers["set-cookie"]; const list = Array.isArray(raw) ? raw : [String(raw)];
    return list.find((c) => c.startsWith("rl_ss="))?.split(";")[0]?.slice("rl_ss=".length);
  };
  it("start redirects to Google with state, nonce and PKCE, and sets a short signed cookie", async () => {
    const r = await t.app.inject({ method: "GET", url: "/api/v1/auth/social/google/start" });
    expect(r.statusCode).toBe(302);
    const u = new URL(String(r.headers.location));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(GOOGLE_ID);
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:5173/api/v1/auth/social/google/callback");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(String(r.headers["set-cookie"])).toMatch(/rl_ss=.*HttpOnly.*SameSite=Lax/i);
  });
  it("callback signs in, sets the refresh cookie and returns to the site", async () => {
    const s = await t.app.inject({ method: "GET", url: "/api/v1/auth/social/google/start" });
    const u = new URL(String(s.headers.location));
    nextIdToken = await idToken({ sub: "g-web", email: "web@example.com", nonce: u.searchParams.get("nonce")! });
    const cb = await t.app.inject({ method: "GET", url: `/api/v1/auth/social/google/callback?code=abc&state=${u.searchParams.get("state")}`, cookies: { rl_ss: stateCookie(s)! } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("http://localhost:5173/#social=ok");
    const rt = cookieOf(cb);
    expect(rt).toBeTruthy();
    const ref = await t.app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: CSRF, cookies: { rl_rt: rt! } });
    expect(ref.json().user.email).toBe("web@example.com");
  });
  it("callback refuses a wrong state, a missing cookie, a wrong nonce, and a cancelled sign-in", async () => {
    const s = await t.app.inject({ method: "GET", url: "/api/v1/auth/social/google/start" });
    const u = new URL(String(s.headers.location));
    const get = (qs: string, cookie?: string) => t.app.inject({ method: "GET", url: `/api/v1/auth/social/google/callback?${qs}`, ...(cookie ? { cookies: { rl_ss: cookie } } : {}) });
    expect((await get("code=abc&state=wrong", stateCookie(s))).headers.location).toBe("http://localhost:5173/#social_error=state");
    expect((await get(`code=abc&state=${u.searchParams.get("state")}`)).headers.location).toBe("http://localhost:5173/#social_error=state");
    nextIdToken = await idToken({ sub: "g-n", email: "n@example.com", nonce: "not-the-nonce" });
    expect((await get(`code=abc&state=${u.searchParams.get("state")}`, stateCookie(s))).headers.location).toBe("http://localhost:5173/#social_error=SOCIAL_FAILED");
    expect((await get("error=access_denied")).headers.location).toBe("http://localhost:5173/#social_error=cancelled");
    expect(await rows(`select 1 from users where email = 'n@example.com'`)).toHaveLength(0);
  });
  it("link-start needs a signed-in user and the callback then connects Facebook to that user", async () => {
    expect((await t.app.inject({ method: "POST", url: "/api/v1/auth/social/facebook/link-start" })).statusCode).toBe(401);
    const reg = await register("lena@example.com");
    const ls = await t.app.inject({ method: "POST", url: "/api/v1/auth/social/facebook/link-start", headers: { authorization: `Bearer ${reg.json().accessToken}` } });
    const u = new URL(ls.json().url);
    expect(u.hostname).toBe("www.facebook.com");
    fbToken.userId = "fb-lena"; fbToken.me = { id: "fb-lena", name: "Lena", email: "lena@example.com" };
    const cb = await t.app.inject({ method: "GET", url: `/api/v1/auth/social/facebook/callback?code=abc&state=${u.searchParams.get("state")}`, cookies: { rl_ss: stateCookie(ls)! } });
    expect(cb.headers.location).toBe("http://localhost:5173/#social_linked=facebook");
    expect(await rows(`select provider from user_identities where user_id = $1`, [reg.json().user.id])).toEqual([{ provider: "facebook" }]);
  });
});

describe("accounts without a password", () => {
  it("a suspended account cannot sign in with Google", async () => {
    const g = await google({ sub: "g-sus", email: "sus@example.com" });
    await t.pool.query(`update users set status = 'suspended' where id = $1`, [g.json().user.id]);
    expect((await google({ sub: "g-sus", email: "sus@example.com" })).statusCode).toBe(403);
  });
  it("can be deleted by typing DELETE, which also removes the connected provider", async () => {
    const g = await google({ sub: "g-del", email: "del@example.com" });
    const h = { authorization: `Bearer ${g.json().accessToken}` };
    const no = await t.app.inject({ method: "POST", url: "/api/v1/me/delete", headers: h, payload: { confirm: "nope" } });
    expect(no.statusCode).toBe(400);
    const yes = await t.app.inject({ method: "POST", url: "/api/v1/me/delete", headers: h, payload: { confirm: "DELETE" } });
    expect(yes.statusCode).toBe(204);
    expect(await rows(`select 1 from user_identities where user_id = $1`, [g.json().user.id])).toHaveLength(0);
    // the same Google account may start fresh afterwards
    const again = await google({ sub: "g-del", email: "del@example.com" });
    expect(again.statusCode).toBe(200);
    expect(again.json().user.id).not.toBe(g.json().user.id);
  });
  it("an account with a password still has to give the password to delete itself", async () => {
    const reg = await register("pw@example.com");
    const h = { authorization: `Bearer ${reg.json().accessToken}` };
    expect((await t.app.inject({ method: "POST", url: "/api/v1/me/delete", headers: h, payload: { confirm: "DELETE" } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "POST", url: "/api/v1/me/delete", headers: h, payload: { password: "correct horse battery" } })).statusCode).toBe(204);
  });
  it("can add a password with the email reset flow", async () => {
    await google({ sub: "g-reset", email: "reset@example.com" });
    const f = await t.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email: "reset@example.com" } });
    const token = f.json().devResetToken;
    expect((await t.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token, password: "a brand new password" } })).statusCode).toBe(204);
    expect((await login("reset@example.com", "a brand new password")).json().user).toMatchObject({ hasPassword: true, providers: ["google"] });
  });
});
