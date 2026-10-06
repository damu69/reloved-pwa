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
  } as any);
  const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 20 });
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
