import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { Config } from "../../lib/config.js";
import { Errors } from "../../lib/errors.js";

// Short-lived access token. Holds only ids: roles and permissions are read fresh from the
// database on every request, so a suspension or role change applies immediately.
export interface AccessClaims { sub: string; sid: string }

const key = (cfg: Config) => new TextEncoder().encode(cfg.JWT_SECRET);

export async function signAccessToken(cfg: Config, c: AccessClaims): Promise<string> {
  return new SignJWT({ sid: c.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(c.sub)
    .setIssuer(cfg.JWT_ISSUER)
    .setAudience("reloved")
    .setIssuedAt()
    .setExpirationTime(`${cfg.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key(cfg));
}

export async function verifyAccessToken(cfg: Config, token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, key(cfg), {
      issuer: cfg.JWT_ISSUER,
      audience: "reloved",
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") throw Errors.unauthenticated();
    return { sub: payload.sub, sid: payload.sid };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw Errors.sessionExpired();
    throw Errors.unauthenticated();
  }
}
