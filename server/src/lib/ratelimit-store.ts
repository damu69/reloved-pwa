import type { Config } from "./config.js";

// Shared rate-limit counters in Upstash Redis, called over HTTPS (no extra npm package, works on serverless).
// Without UPSTASH_REDIS_REST_URL / _TOKEN nothing here is used and limits stay in memory, per instance.
// If Redis is unreachable the limiter falls back to its in-memory counters (fail open to per-instance limits)
// instead of blocking every request.
export interface WindowCounter {
  hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
}

export function createRestCounter(cfg: Pick<Config, "UPSTASH_REDIS_REST_URL" | "UPSTASH_REDIS_REST_TOKEN">): WindowCounter | null {
  const url = cfg.UPSTASH_REDIS_REST_URL;
  const token = cfg.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const endpoint = url.replace(/\/+$/, "") + "/pipeline";
  return {
    async hit(key, windowMs) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        // INCR, then start the window only if none is running (NX), then read what is left of it.
        body: JSON.stringify([["INCR", key], ["PEXPIRE", key, String(windowMs), "NX"], ["PTTL", key]]),
        signal: AbortSignal.timeout(1000),
      });
      if (!res.ok) throw new Error(`rate-limit store HTTP ${res.status}`);
      const out = (await res.json()) as Array<{ result?: unknown; error?: string }>;
      if (!Array.isArray(out) || out.length < 3 || out.some((o) => o?.error)) throw new Error("rate-limit store error");
      const count = Number(out[0]?.result);
      let ttlMs = Number(out[2]?.result);
      if (!Number.isFinite(count)) throw new Error("rate-limit store returned no count");
      if (!(ttlMs > 0)) ttlMs = windowMs;
      return { count, ttlMs };
    },
  };
}

// In-memory fixed window, used as the fallback when Redis fails.
export class MemoryWindows {
  private hits = new Map<string, { n: number; resetAt: number }>();
  hit(key: string, windowMs: number, now = Date.now()): { count: number; ttlMs: number } {
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { n: 0, resetAt: now + windowMs };
      this.hits.set(key, e);
    }
    e.n += 1;
    return { count: e.n, ttlMs: e.resetAt - now };
  }
}

// Store class for @fastify/rate-limit (`store` option). The plugin calls `new Store(params)` for the global
// limit and `.child(routeParams)` for routes with their own settings; each route gets its own key prefix.
export function createRateLimitStore(counter: WindowCounter, log: (msg: string) => void = () => {}) {
  type Cb = (err: Error | null, res?: { current: number; ttl: number }) => void;
  return class RedisRestStore {
    private mem = new MemoryWindows();
    private prefix: string;
    constructor(params?: { routeInfo?: { method?: unknown; url?: unknown } }) {
      const r = params?.routeInfo;
      this.prefix = r && (r.method || r.url) ? `rl:${String(r.method)}:${String(r.url)}|` : "rl:global|";
    }
    incr(key: string, cb: Cb, timeWindow = 60_000): void {
      counter.hit(this.prefix + key, timeWindow).then(
        (r) => cb(null, { current: r.count, ttl: r.ttlMs }),
        (e: unknown) => {
          log(`rate-limit store unavailable, using memory: ${(e as Error)?.message ?? e}`);
          const r = this.mem.hit(this.prefix + key, timeWindow);
          cb(null, { current: r.count, ttl: r.ttlMs });
        },
      );
    }
    child(routeParams: { routeInfo?: { method?: unknown; url?: unknown } }): RedisRestStore {
      return new RedisRestStore(routeParams);
    }
  };
}
