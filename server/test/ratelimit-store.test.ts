import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryWindows, createRateLimitStore, createRestCounter } from "../src/lib/ratelimit-store.js";

afterEach(() => vi.unstubAllGlobals());

describe("shared rate-limit counter", () => {
  it("is off without Upstash settings", () => {
    expect(createRestCounter({ UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined })).toBeNull();
  });

  it("counts through the REST pipeline", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ result: 3 }, { result: 0 }, { result: 42_000 }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = createRestCounter({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io/", UPSTASH_REDIS_REST_TOKEN: "token-0123456789" })!;
    expect(await c.hit("k", 60_000)).toEqual({ count: 3, ttlMs: 42_000 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.upstash.io/pipeline");
    expect(JSON.parse(String(init.body))[0]).toEqual(["INCR", "k"]);
  });

  it("falls back to memory when Redis fails", async () => {
    const store = new (createRateLimitStore({ hit: async () => { throw new Error("down"); } }))({ routeInfo: { method: "POST", url: "/x" } });
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) store.incr("ip", (_e, r) => seen.push(r!.current), 60_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("memory windows", () => {
  it("resets after the window", () => {
    const m = new MemoryWindows();
    expect(m.hit("a", 1000, 0).count).toBe(1);
    expect(m.hit("a", 1000, 500).count).toBe(2);
    expect(m.hit("a", 1000, 1500).count).toBe(1);
  });
});

describe("config", () => {
  const base = { NODE_ENV: "test", DATABASE_URL: "postgres://x", JWT_SECRET: "a-real-looking-secret-value-0123456789abcdef", DATA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64") };
  it("needs both Upstash settings or neither", async () => {
    const { loadConfig } = await import("../src/lib/config.js");
    expect(() => loadConfig({ ...base, UPSTASH_REDIS_REST_URL: "https://x.upstash.io" } as any)).toThrow(/together/);
    expect(loadConfig({ ...base, UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "token-0123456789" } as any).UPSTASH_REDIS_REST_URL).toBeTruthy();
  });
  it("refuses debug diagnostics in production", async () => {
    const { loadConfig } = await import("../src/lib/config.js");
    expect(() => loadConfig({ ...base, NODE_ENV: "production", DATABASE_SSL: "require", DEBUG_DIAGNOSTICS: "true" } as any)).toThrow(/DEBUG_DIAGNOSTICS/);
  });
});
