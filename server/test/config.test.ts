import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/lib/config.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x", JWT_SECRET: "a-real-looking-secret-value-0123456789abcdef", DATA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64") };
describe("production safety checks", () => {
  it("refuses the mock reset-token exposure in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", DATABASE_SSL: "require", DEV_EXPOSE_RESET_TOKEN: "true" } as any)).toThrow(/DEV_EXPOSE_RESET_TOKEN/);
  });
  it("refuses insecure cookies and placeholder secrets in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", COOKIE_SECURE: "false" } as any)).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", JWT_SECRET: "change-me-change-me-change-me-change-me" } as any)).toThrow(/placeholder/);
  });
  it("refuses short secrets everywhere", () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: "short" } as any)).toThrow(/JWT_SECRET/);
  });
});

describe("environment must be explicit and production must be locked down", () => {
  const prod = { ...base, NODE_ENV: "production", DATABASE_SSL: "require", CORS_ORIGINS: "https://reloved-pwa.vercel.app",
    STORAGE_DRIVER: "supabase", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789" };
  it("requires NODE_ENV", () => {
    const { NODE_ENV: _n, ...noEnv } = base;
    expect(() => loadConfig(noEnv as any)).toThrow(/NODE_ENV/);
  });
  it("accepts a correct production config", () => {
    expect(() => loadConfig(prod as any)).not.toThrow();
  });
  it("refuses an unencrypted database and localhost or http origins in production", () => {
    expect(() => loadConfig({ ...prod, DATABASE_SSL: "off" } as any)).toThrow(/DATABASE_SSL/);
    expect(() => loadConfig({ ...prod, CORS_ORIGINS: "http://localhost:5173" } as any)).toThrow(/CORS_ORIGINS/);
  });
});

describe("files and encryption settings", () => {
  const prod = { ...base, NODE_ENV: "production", DATABASE_SSL: "require", CORS_ORIGINS: "https://reloved-pwa.vercel.app" };
  it("refuses local-disk storage in production", () => {
    expect(() => loadConfig({ ...prod, STORAGE_DRIVER: "local" } as any)).toThrow(/STORAGE_DRIVER/);
  });
  it("requires Supabase credentials for Supabase storage", () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "supabase" } as any)).toThrow(/SUPABASE_URL/);
  });
  it("requires a 32-byte encryption key", () => {
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") } as any)).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});
