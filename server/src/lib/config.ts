import { z } from "zod";

// All settings come from environment variables. Secrets are never committed or sent to the browser.
const schema = z.object({
  // Required, no default: a production deploy that forgets it must not silently run as development.
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  // off: local only. require: encrypted. verify-full: encrypted and certificate checked (set DATABASE_CA_CERT if the provider uses its own CA).
  DATABASE_SSL: z.enum(["off", "require", "verify-full"]).default("off"),
  DATABASE_CA_CERT: z.string().optional(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("reloved-api"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // Absolute limit for one login, however often it is refreshed.
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  // Number of reverse proxies in front of the API (e.g. 1 behind one load balancer). 0 = use the socket address.
  // Never trust the whole X-Forwarded-For chain: clients could fake their IP and dodge rate limits.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // MOCK / TEMPORARY: returns the password-reset token in the API response because no email
  // provider exists yet. Must be false in production; startup refuses otherwise.
  DEV_EXPOSE_RESET_TOKEN: z.enum(["true", "false"]).default("false"),
});

export type Config = z.infer<typeof schema> & { corsOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production") {
    if (c.DEV_EXPOSE_RESET_TOKEN === "true") throw new Error("DEV_EXPOSE_RESET_TOKEN must be false in production");
    if (c.COOKIE_SECURE !== "true") throw new Error("COOKIE_SECURE must be true in production");
    if (/change[-_]?me|example|secret123/i.test(c.JWT_SECRET)) throw new Error("JWT_SECRET looks like a placeholder");
    if (c.DATABASE_SSL === "off") throw new Error("DATABASE_SSL must be require or verify-full in production");
    if (/localhost|127\.0\.0\.1|http:\/\//.test(c.CORS_ORIGINS)) throw new Error("CORS_ORIGINS must list only https production origins");
  }
  return { ...c, corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) };
}
