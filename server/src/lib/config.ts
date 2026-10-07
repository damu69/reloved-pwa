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
  // How long checkout holds stock (and the order waits) for payment.
  PAYMENT_WINDOW_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  // Number of reverse proxies in front of the API (e.g. 1 behind one load balancer). 0 = use the socket address.
  // Never trust the whole X-Forwarded-For chain: clients could fake their IP and dodge rate limits.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // 32 random bytes, base64. Encrypts PAN and bank account numbers. Losing it makes them unreadable;
  // keep it in the secrets manager and back it up separately from the database.
  DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  // local: files on this machine's disk (development and tests only).
  // supabase: private Supabase Storage bucket, accessed only by this server with the service-role key.
  STORAGE_DRIVER: z.enum(["local", "supabase"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./.storage"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  STORAGE_BUCKET: z.string().regex(/^[a-z0-9-]{3,63}$/).default("seller-kyc"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // MOCK / TEMPORARY: returns the password-reset token in the API response because no email
  // provider exists yet. Must be false in production; startup refuses otherwise.
  DEV_EXPOSE_RESET_TOKEN: z.enum(["true", "false"]).default("false"),
  // Payment provider. none (default): checkout works but orders cannot be paid (they expire).
  // mock: a fake provider for development and tests, only when set explicitly; refused in production,
  // because anyone signed in could mark their own orders paid. Razorpay arrives later.
  PAYMENT_PROVIDER: z.enum(["none", "mock"]).default("none"),
  // MOCK / TEMPORARY: signs the mock provider's events. Required with PAYMENT_PROVIDER=mock outside tests.
  MOCK_PAYMENT_SECRET: z.string().min(32).optional(),
});

export type Config = Omit<z.infer<typeof schema>, "MOCK_PAYMENT_SECRET"> & { corsOrigins: string[]; MOCK_PAYMENT_SECRET: string };

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
    if (c.STORAGE_DRIVER !== "supabase") throw new Error("STORAGE_DRIVER must be supabase in production (local disk is lost on redeploy)");
    if (/localhost|127\.0\.0\.1|http:\/\//.test(c.CORS_ORIGINS)) throw new Error("CORS_ORIGINS must list only https production origins");
    if (c.PAYMENT_PROVIDER === "mock") throw new Error("PAYMENT_PROVIDER=mock is not allowed in production: fake payments would mark real orders paid");
  }
  if (c.STORAGE_DRIVER === "supabase" && (!c.SUPABASE_URL || !c.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when STORAGE_DRIVER=supabase");
  }
  let MOCK_PAYMENT_SECRET = c.MOCK_PAYMENT_SECRET ?? "";
  if (c.PAYMENT_PROVIDER === "mock" && !MOCK_PAYMENT_SECRET) {
    if (c.NODE_ENV !== "test") throw new Error("MOCK_PAYMENT_SECRET (32+ random characters) is required with PAYMENT_PROVIDER=mock");
    MOCK_PAYMENT_SECRET = "mock-payment-secret-used-only-by-automated-tests";
  }
  return { ...c, MOCK_PAYMENT_SECRET, corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) };
}
