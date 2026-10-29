// Talks to Google and Facebook. Everything the browser or app hands us is verified here, never trusted:
// Google ID tokens are checked against Google's published keys (signature, issuer, audience, expiry, nonce),
// Facebook access tokens are checked with Facebook's debug_token call to belong to OUR app before use.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";

export type Provider = "google" | "facebook";
export const PROVIDERS: readonly Provider[] = ["google", "facebook"];

export interface SocialProfile {
  provider: Provider;
  subject: string; // the provider's own id for the person; stable, unlike email
  email: string | null;
  emailVerified: boolean;
  name: string;
}

export const SocialErrors = {
  notEnabled: () => new AppError(404, "SOCIAL_NOT_ENABLED", "This sign-in method is not available."),
  failed: (provider: Provider) => new AppError(401, "SOCIAL_FAILED", `We could not verify your ${label(provider)} sign-in. Please try again.`),
  emailRequired: (provider: Provider) =>
    new AppError(400, "SOCIAL_EMAIL_REQUIRED", `${label(provider)} did not share an email address. Allow email access and try again, or sign up with your email.`),
  existsUsePassword: () =>
    new AppError(409, "ACCOUNT_EXISTS_USE_PASSWORD", "An account with this email already exists. Sign in with your email and password, then connect Facebook in Settings."),
  alreadyLinked: (provider: Provider) => new AppError(409, "SOCIAL_ALREADY_LINKED", `This ${label(provider)} account is already connected to a Reloved account.`),
};
export const label = (p: Provider): string => (p === "google" ? "Google" : "Facebook");

export function enabledProviders(cfg: Config): Provider[] {
  const out: Provider[] = [];
  if (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET) out.push("google");
  if (cfg.FACEBOOK_APP_ID && cfg.FACEBOOK_APP_SECRET) out.push("facebook");
  return out;
}

const b64url = (b: Buffer): string => b.toString("base64url");
export const newRandom = (bytes = 32): string => b64url(randomBytes(bytes));
export const pkceChallenge = (verifier: string): string => b64url(createHash("sha256").update(verifier).digest());

const FB_VERSION = "v21.0";
const TIMEOUT_MS = 8000;

export const redirectUri = (cfg: Config, p: Provider): string => `${cfg.APP_URL.replace(/\/$/, "")}/api/v1/auth/social/${p}/callback`;

export function authorizeUrl(cfg: Config, p: Provider, x: { state: string; nonce: string; challenge: string }): string {
  if (p === "google") {
    const q = new URLSearchParams({
      client_id: cfg.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(cfg, p), response_type: "code",
      scope: "openid email profile", state: x.state, nonce: x.nonce,
      code_challenge: x.challenge, code_challenge_method: "S256", prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  const q = new URLSearchParams({
    client_id: cfg.FACEBOOK_APP_ID!, redirect_uri: redirectUri(cfg, p), response_type: "code",
    scope: "email,public_profile", state: x.state,
  });
  return `https://www.facebook.com/${FB_VERSION}/dialog/oauth?${q}`;
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`provider http ${res.status}`);
  return body;
}

let googleKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function verifyGoogleIdToken(cfg: Config, idToken: string, nonce?: string): Promise<SocialProfile> {
  try {
    googleKeys ??= createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
    const { payload } = await jwtVerify(idToken, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: cfg.GOOGLE_CLIENT_ID!,
      algorithms: ["RS256"],
    });
    if (nonce !== undefined && payload.nonce !== nonce) throw new Error("nonce mismatch");
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("no subject");
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;
    const verified = payload.email_verified === true || payload.email_verified === "true";
    const name = typeof payload.name === "string" ? payload.name : "";
    return { provider: "google", subject: payload.sub, email, emailVerified: Boolean(email) && verified, name };
  } catch {
    throw SocialErrors.failed("google");
  }
}

export async function googleFromCode(cfg: Config, code: string, verifier: string, nonce: string): Promise<SocialProfile> {
  try {
    const body = await getJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: cfg.GOOGLE_CLIENT_ID!, client_secret: cfg.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri(cfg, "google"), grant_type: "authorization_code", code_verifier: verifier,
      }),
    });
    if (typeof body?.id_token !== "string") throw new Error("no id_token");
    return await verifyGoogleIdToken(cfg, body.id_token, nonce);
  } catch {
    throw SocialErrors.failed("google");
  }
}

// The token must have been issued to OUR Facebook app, otherwise a token from any other app could be replayed here.
export async function facebookFromAccessToken(cfg: Config, accessToken: string): Promise<SocialProfile> {
  try {
    const appToken = `${cfg.FACEBOOK_APP_ID}|${cfg.FACEBOOK_APP_SECRET}`;
    const dbg = await getJson(`https://graph.facebook.com/${FB_VERSION}/debug_token?${new URLSearchParams({ input_token: accessToken, access_token: appToken })}`);
    if (!dbg?.data?.is_valid || String(dbg.data.app_id) !== cfg.FACEBOOK_APP_ID) throw new Error("token not for this app");
    const proof = createHmac("sha256", cfg.FACEBOOK_APP_SECRET!).update(accessToken).digest("hex");
    const me = await getJson(`https://graph.facebook.com/${FB_VERSION}/me?${new URLSearchParams({ fields: "id,name,email", access_token: accessToken, appsecret_proof: proof })}`);
    if (typeof me?.id !== "string" || !me.id) throw new Error("no id");
    if (dbg.data.user_id && String(dbg.data.user_id) !== me.id) throw new Error("user mismatch");
    const email = typeof me.email === "string" && me.email.includes("@") ? me.email.trim().toLowerCase() : null;
    // Facebook does not promise a verified email, so it is never used to take over an existing account.
    return { provider: "facebook", subject: me.id, email, emailVerified: false, name: typeof me.name === "string" ? me.name : "" };
  } catch {
    throw SocialErrors.failed("facebook");
  }
}

export async function facebookFromCode(cfg: Config, code: string): Promise<SocialProfile> {
  let token: string;
  try {
    const body = await getJson(`https://graph.facebook.com/${FB_VERSION}/oauth/access_token?${new URLSearchParams({
      client_id: cfg.FACEBOOK_APP_ID!, client_secret: cfg.FACEBOOK_APP_SECRET!, redirect_uri: redirectUri(cfg, "facebook"), code,
    })}`);
    if (typeof body?.access_token !== "string") throw new Error("no token");
    token = body.access_token;
  } catch {
    throw SocialErrors.failed("facebook");
  }
  return facebookFromAccessToken(cfg, token);
}
