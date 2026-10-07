import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import type { Config } from "./lib/config.js";
import type { Db } from "./lib/db.js";
import { AppError } from "./lib/errors.js";
import { authRoutes, meRoutes } from "./modules/auth/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { adminSellerRoutes, sellerRoutes } from "./modules/sellers/routes.js";
import { adminCatalogueRoutes, publicCatalogueRoutes, sellerCatalogueRoutes } from "./modules/catalogue/routes.js";
import { createFieldCipher, type FieldCipher } from "./lib/encryption.js";
import { createStorage, type Storage } from "./lib/storage.js";
import { PostgresSearch, type SearchService } from "./modules/search/service.js";

declare module "fastify" {
  interface FastifyInstance {
    cfg: Config;
    db: Db;
    cipher: FieldCipher;
    storage: Storage;
    searchService: SearchService;
  }
}

export async function buildApp(cfg: Config, db: Db, overrides: { storage?: Storage } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: cfg.LOG_LEVEL,
      // Never log credentials, tokens or cookies.
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']", "*.password", "*.token"],
    },
    trustProxy: cfg.TRUST_PROXY_HOPS > 0 ? (_addr: string, hop: number) => hop < cfg.TRUST_PROXY_HOPS : false,
    bodyLimit: 1_048_576,
    // Always server-generated, because it is stored in audit rows; a client id is only logged.
    genReqId: () => randomUUID(),
  });

  app.decorate("cfg", cfg);
  app.decorate("db", db);
  app.decorate("cipher", createFieldCipher(cfg));
  app.decorate("storage", overrides.storage ?? createStorage(cfg));
  app.decorate("searchService", new PostgresSearch(db));
  app.decorateRequest("auth", null);
  app.decorateRequest("seller", null);

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: cfg.NODE_ENV === "production" ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: cfg.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Idempotency-Key", "X-Request-Id"],
    maxAge: 600,
  });
  await app.register(cookie);
  // Only the document upload route reads multipart; limits are tightened again there.
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 0, parts: 2, headerPairs: 50 } });
  // In-memory limits are per instance. TODO before running several instances: Redis store.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    hook: "preHandler",
    errorResponseBuilder: (_req, ctx) => new AppError(429, "RATE_LIMITED", `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)} seconds.`),
  });

  app.addHook("onRequest", async (req) => {
    const client = req.headers["x-request-id"];
    if (typeof client === "string" && client.length <= 64) req.log.info({ clientRequestId: client }, "client request id");
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    // Default: never cache API responses. Routes that serve public media set their own policy.
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found.", requestId: req.id } });
  });

  app.setErrorHandler((err: any, req, reply) => {
    const requestId = String(req.id);
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, err.message);
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    }
    // Fastify's own client errors (bad JSON, body too large, wrong content type).
    if (typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      const code = err.statusCode === 413 ? "PAYLOAD_TOO_LARGE" : err.statusCode === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "BAD_REQUEST";
      return reply.code(err.statusCode).send({ error: { code, message: "The request could not be read.", requestId } });
    }
    // Postgres invalid input (for example a malformed id in a cursor).
    if (typeof err?.code === "string" && err.code.startsWith("22")) {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "Some values are invalid.", requestId } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Something went wrong on our side. Please try again.", requestId } });
  });

  app.get("/health", { config: { rateLimit: false } }, async () => ({ status: "ok" }));
  app.get("/ready", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await db.query("select 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ error: { code: "NOT_READY", message: "Database unavailable." } });
    }
  });

  await app.register(async (v1) => {
    await v1.register(authRoutes, { prefix: "/auth" });
    await v1.register(meRoutes, { prefix: "/me" });
    await v1.register(adminRoutes, { prefix: "/admin" });
    await v1.register(sellerRoutes, { prefix: "/seller" });
    await v1.register(adminSellerRoutes, { prefix: "/admin/sellers" });
    await v1.register(sellerCatalogueRoutes, { prefix: "/seller/products" });
    await v1.register(adminCatalogueRoutes, { prefix: "/admin/catalogue" });
    await v1.register(publicCatalogueRoutes, { prefix: "/catalogue" });
  }, { prefix: "/api/v1" });

  return app;
}
