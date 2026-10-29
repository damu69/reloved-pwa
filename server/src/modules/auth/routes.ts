import { deleteAccount } from "./deletion.js";
import { createMailer } from "../../lib/email.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { normEmail, parse, safeText } from "../../lib/validate.js";
import { Errors } from "../../lib/errors.js";
import { windowLimiter } from "../../lib/limiter.js";
import * as auth from "./service.js";
import { authenticate } from "./guard.js";

export const REFRESH_COOKIE = "rl_rt";
export const COOKIE_PATH = "/api/v1/auth";

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
// Length limits: 10 minimum for strength, 128 maximum so hashing cannot be abused.
const password = z.string().min(10, "Use at least 10 characters").max(128).refine((p) => p.trim().length >= 10, "Use at least 10 non-space characters");

const registerBody = z.object({
  email,
  password,
  fullName: safeText(1, 120),
  phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, "Use 10 to 15 digits, optionally starting with +").optional(),
}).strict();
const loginBody = z.object({ email, password: z.string().min(1).max(128) }).strict();
const forgotBody = z.object({ email }).strict();
const resetBody = z.object({ token: z.string().min(20).max(200), password }).strict();
const changeBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).strict();

const meta = (req: FastifyRequest): auth.RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.headers["user-agent"] ?? null,
  requestId: String(req.id),
});

// Cookie-authenticated routes need CSRF protection: SameSite=Strict, plus a custom header a
// cross-site form cannot send, plus an Origin allowlist when the browser sends Origin.
function csrfCheck(req: FastifyRequest): void {
  if (req.headers["x-requested-with"] !== "reloved") throw Errors.forbidden("Missing request header.");
  const origin = req.headers.origin;
  if (origin && !req.server.cfg.corsOrigins.includes(origin)) throw Errors.forbidden("Origin not allowed.");
}

// The Android/iOS app (served from its own origin, so the cookie would be third-party and blocked) sends
// `X-Client: app` and keeps the refresh token itself: it is returned in the body and read back from the body.
// The website keeps using the httpOnly cookie. Either way the token is single-use and rotates.
export const isApp = (req: FastifyRequest): boolean => req.headers["x-client"] === "app";
const bodyToken = (req: FastifyRequest): string | undefined => {
  const t = (req.body as { refreshToken?: unknown } | null | undefined)?.refreshToken;
  return typeof t === "string" && t.length > 0 && t.length <= 300 ? t : undefined;
};

export function setRefreshCookie(reply: FastifyReply, t: auth.IssuedTokens): void {
  reply.setCookie(REFRESH_COOKIE, t.refreshToken, {
    httpOnly: true,
    secure: reply.server.cfg.COOKIE_SECURE === "true",
    sameSite: "strict",
    path: COOKIE_PATH,
    expires: t.refreshExpiresAt,
  });
}

export function sendTokens(req: FastifyRequest, reply: FastifyReply, t: auth.IssuedTokens, status = 200) {
  const app = isApp(req);
  if (!app) setRefreshCookie(reply, t);
  return reply.code(status).send({
    user: t.user,
    accessToken: t.accessToken,
    expiresIn: reply.server.cfg.ACCESS_TOKEN_TTL_SECONDS,
    ...(app ? { refreshToken: t.refreshToken, refreshExpiresAt: t.refreshExpiresAt } : {}),
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;
  const mailer = createMailer(cfg, app.log);
  const strict = (max: number, minutes: number, by: (req: FastifyRequest) => string) => ({
    rateLimit: { max, timeWindow: `${minutes} minutes`, keyGenerator: by },
  });
  // Keyed on the normalised email, so " a@x.com" and "A@x.com " share one counter.
  const byIpAndEmail = (req: FastifyRequest) => `${req.ip}|${normEmail((req.body as any)?.email)}`;
  // Second limit per IP across all emails, against one IP trying a password on many accounts.
  const perIp = (name: string, max: number) => windowLimiter(name, max, 15 * 60_000, (req) => req.ip);
  const loginPerIp = perIp("login", 30);
  const forgotPerIp = perIp("forgot", 15);

  app.post("/register", { config: strict(5, 15, (r) => r.ip) }, async (req, reply) => {
    const body = parse(registerBody, req.body);
    return sendTokens(req, reply, await auth.register(cfg, db, body, meta(req)), 201);
  });

  app.post("/login", { config: strict(10, 15, byIpAndEmail), preHandler: loginPerIp }, async (req, reply) => {
    const body = parse(loginBody, req.body);
    return sendTokens(req, reply, await auth.login(cfg, db, body, meta(req)));
  });

  app.post("/refresh", { config: strict(60, 15, (r) => r.ip) }, async (req, reply) => {
    csrfCheck(req);
    const token = isApp(req) ? bodyToken(req) : req.cookies[REFRESH_COOKIE];
    if (!token) throw Errors.unauthenticated();
    try {
      return sendTokens(req, reply, await auth.refresh(cfg, db, token, meta(req)));
    } catch (e) {
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      throw e;
    }
  });

  app.post("/logout", async (req, reply) => {
    csrfCheck(req);
    await auth.logout(db, isApp(req) ? bodyToken(req) : req.cookies[REFRESH_COOKIE], null, false, null);
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return reply.code(204).send();
  });

  app.post("/logout-all", { preHandler: authenticate }, async (req, reply) => {
    await auth.logout(db, undefined, null, true, req.auth!.userId);
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return reply.code(204).send();
  });

  app.post("/password/forgot", { config: strict(5, 15, byIpAndEmail), preHandler: forgotPerIp }, async (req, reply) => {
    const body = parse(forgotBody, req.body);
    // Same response time whether or not the account exists, so timing cannot reveal accounts.
    const started = Date.now();
    const token = await auth.requestPasswordReset(cfg, db, body.email, meta(req));
    // Not awaited: the response time must not reveal whether the account exists.
    if (token) void mailer.send({
      to: body.email,
      subject: "Reset your Reloved password",
      text: `Hi,\n\nSomeone asked to reset the password for your Reloved account. Open this link to choose a new one (valid for ${cfg.PASSWORD_RESET_TTL_MINUTES} minutes):\n\n${cfg.APP_URL}/#reset=${token}\n\nIf this was not you, you can ignore this email. Your password stays the same.\n\nReloved`,
    });
    const wait = 400 + Math.floor(Math.random() * 50) - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res: Record<string, unknown> = { message: "If that email has an account, a reset link has been sent." };
    // MOCK / TEMPORARY: see requestPasswordReset. Never enabled in production.
    if (cfg.DEV_EXPOSE_RESET_TOKEN === "true" && cfg.NODE_ENV !== "production") res.devResetToken = token;
    return reply.code(202).send(res);
  });

  app.post("/password/reset", { config: strict(10, 15, (r) => r.ip) }, async (req, reply) => {
    const body = parse(resetBody, req.body);
    await auth.resetPassword(db, body.token, body.password, meta(req));
    return reply.code(204).send();
  });

  app.post("/password/change", { preHandler: authenticate, config: strict(10, 15, (r) => r.ip) }, async (req, reply) => {
    const body = parse(changeBody, req.body);
    await auth.changePassword(db, req.auth!.userId, body.currentPassword, body.newPassword, req.auth!.sid, meta(req));
    return reply.code(204).send();
  });
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  // Deletes (anonymises) the signed-in account after re-entering the password. See auth/deletion.ts.
  app.post("/delete", { config: { rateLimit: { max: 5, timeWindow: "15 minutes", keyGenerator: (r: FastifyRequest) => r.ip } } }, async (req, reply) => {
    const body = parse(z.object({ password: z.string().min(1).max(200).optional(), confirm: z.string().max(20).optional() }).strict(), req.body);
    await deleteAccount(app.db, req.auth!.userId, body, meta(req));
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return reply.code(204).send();
  });
  app.get("/", async (req) => ({ user: await auth.loadPublicUser(app.db, req.auth!.userId), permissions: [...req.auth!.permissions].sort() }));
  app.patch("/", async (req) => {
    const body = parse(z.object({ fullName: safeText(1, 120) }).strict(), req.body);
    await app.db.query(`update users set full_name = $1 where id = $2`, [body.fullName, req.auth!.userId]);
    return { user: await auth.loadPublicUser(app.db, req.auth!.userId) };
  });
}
