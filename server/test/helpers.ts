import pg from "pg";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/lib/config.js";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/lib/migrator.js";
import type { FastifyInstance } from "fastify";

// Each test file gets a fresh database, created from TEST_DATABASE_URL's server.
export async function setup(): Promise<{ app: FastifyInstance; pool: pg.Pool; cfg: Config; close: () => Promise<void> }> {
  const base = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/postgres";
  const name = `reloved_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const cfg = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: url.toString(),
    JWT_SECRET: "test-only-secret-that-is-long-enough-1234567890",
    COOKIE_SECURE: "false",
    LOG_LEVEL: "silent",
    DEV_EXPOSE_RESET_TOKEN: "true",
    CORS_ORIGINS: "http://localhost:5173",
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: `/tmp/reloved-test-storage/${name}`,
    PAYMENT_PROVIDER: "mock",
  } as any);
  const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 20 });
  pool.on("error", () => {}); // connections are force-closed when the test database is dropped
  await migrate(pool, fileURLToPath(new URL("../migrations", import.meta.url)), () => {});
  const app = await buildApp(cfg, pool);
  return {
    app, pool, cfg,
    close: async () => {
      await app.close();
      await pool.end();
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export const cookieOf = (res: { headers: Record<string, unknown> }): string | undefined => {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const c = list.find((x) => x.startsWith("rl_rt="));
  return c?.split(";")[0]?.slice("rl_rt=".length);
};

export const CSRF = { "x-requested-with": "reloved", origin: "http://localhost:5173" };

// Builds a multipart/form-data body with one file part.
export function multipartFile(filename: string, content: Buffer, contentType = "application/octet-stream") {
  const boundary = "----relovedtest" + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
