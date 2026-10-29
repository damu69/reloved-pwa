// Google / Facebook sign-in endpoints.
//  Website:  GET  /:provider/start     -> redirects to the provider (state, nonce and PKCE kept in a short signed cookie)
//            GET  /:provider/callback  -> provider sends the person back here; we sign them in and redirect to the site
//            POST /:provider/link-start (signed in) -> same as start, but connects the provider to the signed-in account
//  App:      POST /:provider/token     -> the Android app gets a Google ID token / Facebook access token natively and
//                                         sends it here; with a bearer token it links, without one it signs in
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { Errors, AppError } from "../../lib/errors.js";
import { parse } from "../../lib/validate.js";
import { authenticate } from "./guard.js";
import { sendTokens, setRefreshCookie } from "./routes.js";
import * as auth from "./service.js";
import * as social from "./social.js";
import {
  PROVIDERS, SocialErrors, authorizeUrl, enabledProviders, facebookFromAccessToken, facebookFromCode, googleFromCode,
  newRandom, pkceChallenge, verifyGoogleIdToken, type Provider, type SocialProfile,
} from "./social-providers.js";

const STATE_COOKIE = "rl_ss";
const STATE_PATH = "/api/v1/auth/social";
const STATE_AUD = "reloved-social-state";

interface StateClaims { st: string; nv: string; cv: string; lk?: string }

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  const { cfg, db } = app;
  const key = new TextEncoder().encode(cfg.JWT_SECRET);
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: "15 minutes", keyGenerator: (r: FastifyRequest) => r.ip } });
  const meta = (req: FastifyRequest): auth.RequestMeta => ({ ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null, requestId: String(req.id) });

  const providerOf = (req: FastifyRequest): Provider => {
    const p = (req.params as { provider?: string }).provider as Provider;
    if (!PROVIDERS.includes(p) || !enabledProviders(cfg).includes(p)) throw SocialErrors.notEnabled();
    return p;
  };

  // The state cookie is SameSite=Lax (not Strict) because the provider's redirect back to us is a cross-site navigation.
  async function beginFlow(reply: FastifyReply, p: Provider, linkUserId?: string): Promise<string> {
    const st = newRandom(24), nv = newRandom(24), cv = newRandom(32);
    const claims: StateClaims = { st, nv, cv, ...(linkUserId ? { lk: linkUserId } : {}) };
    const jwt = await new SignJWT({ ...claims }).setProtectedHeader({ alg: "HS256" }).setAudience(STATE_AUD).setIssuedAt().setExpirationTime("10m").sign(key);
    reply.setCookie(STATE_COOKIE, jwt, { httpOnly: true, secure: cfg.COOKIE_SECURE === "true", sameSite: "lax", path: STATE_PATH, maxAge: 600 });
    return authorizeUrl(cfg, p, { state: st, nonce: nv, challenge: pkceChallenge(cv) });
  }

  app.get("/providers", { config: limit(120) }, async () => {
    const providers = enabledProviders(cfg);
    // These ids are public by design (they appear in the sign-in page URLs); the Android app needs them to start native sign-in.
    const fb = providers.includes("facebook");
    return {
      providers,
      googleClientId: providers.includes("google") ? cfg.GOOGLE_CLIENT_ID : null,
      facebookAppId: fb ? cfg.FACEBOOK_APP_ID : null,
      facebookClientToken: fb ? cfg.FACEBOOK_CLIENT_TOKEN ?? null : null,
    };
  });

  app.get("/:provider/start", { config: limit(30) }, async (req, reply) => {
    const p = providerOf(req);
    return reply.redirect(await beginFlow(reply, p), 302);
  });

  app.post("/:provider/link-start", { preHandler: authenticate, config: limit(30) }, async (req, reply) => {
    const p = providerOf(req);
    return { url: await beginFlow(reply, p, req.auth!.userId) };
  });

  const callbackQuery = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }).passthrough();

  app.get("/:provider/callback", { config: limit(60) }, async (req, reply) => {
    const base = cfg.APP_URL.replace(/\/$/, "");
    const back = (hash: string) => reply.redirect(`${base}/#${hash}`, 302);
    const p = providerOf(req);
    const q = callbackQuery.parse(req.query);
    const raw = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: STATE_PATH });
    if (q.error) return back("social_error=cancelled"); // the person pressed Cancel at the provider
    if (!raw || !q.code || !q.state) return back("social_error=state");
    let st: StateClaims;
    try {
      const { payload } = await jwtVerify(raw, key, { audience: STATE_AUD, algorithms: ["HS256"] });
      st = payload as unknown as StateClaims;
    } catch { return back("social_error=state"); }
    if (st.st !== q.state) return back("social_error=state");
    try {
      const profile = p === "google" ? await googleFromCode(cfg, q.code, st.cv, st.nv) : await facebookFromCode(cfg, q.code);
      if (st.lk) {
        await social.linkProfile(db, st.lk, profile, meta(req));
        return back(`social_linked=${p}`);
      }
      setRefreshCookie(reply, await social.signInWithProfile(cfg, db, profile, meta(req)));
      return back("social=ok");
    } catch (e) {
      req.log.info({ code: e instanceof AppError ? e.code : "error", provider: p }, "social sign-in failed");
      return back(`social_error=${e instanceof AppError ? encodeURIComponent(e.code) : "failed"}`);
    }
  });

  const tokenBody = z.union([z.object({ idToken: z.string().min(20).max(4000) }).strict(), z.object({ accessToken: z.string().min(10).max(4000) }).strict()]);

  app.post("/:provider/token", { config: limit(30) }, async (req, reply) => {
    const p = providerOf(req);
    const body = parse(tokenBody, req.body);
    let profile: SocialProfile;
    if (p === "google") {
      if (!("idToken" in body)) throw Errors.validation([{ path: "idToken", message: "Required." }]);
      profile = await verifyGoogleIdToken(cfg, body.idToken);
    } else {
      if (!("accessToken" in body)) throw Errors.validation([{ path: "accessToken", message: "Required." }]);
      profile = await facebookFromAccessToken(cfg, body.accessToken);
    }
    if (req.headers.authorization) {
      await authenticate(req, reply);
      await social.linkProfile(db, req.auth!.userId, profile, meta(req));
      return { user: await auth.loadPublicUser(db, req.auth!.userId) };
    }
    return sendTokens(req, reply, await social.signInWithProfile(cfg, db, profile, meta(req)));
  });
}
