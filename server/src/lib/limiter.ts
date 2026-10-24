import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";
import { MemoryWindows, type WindowCounter } from "./ratelimit-store.js";

// Second limit on a route (the rate-limit plugin runs only one limiter per request).
// Counts live in Redis when a backend is configured (shared by every serverless instance); otherwise,
// and whenever Redis is unreachable, in memory per instance.
let backend: WindowCounter | null = null;
export function setLimiterBackend(b: WindowCounter | null): void {
  backend = b;
}

export function windowLimiter(name: string, max: number, windowMs: number, key: (req: FastifyRequest) => string) {
  const mem = new MemoryWindows();
  return async (req: FastifyRequest): Promise<void> => {
    const k = `rl:${name}|${key(req)}`;
    let r: { count: number; ttlMs: number } | null = null;
    if (backend) {
      try {
        r = await backend.hit(k, windowMs);
      } catch (e) {
        req.log.warn({ err: (e as Error)?.message }, "rate-limit store unavailable, using memory");
      }
    }
    if (!r) r = mem.hit(k, windowMs);
    if (r.count > max) {
      throw new AppError(429, "RATE_LIMITED", `Too many requests. Try again in ${Math.ceil(r.ttlMs / 1000)} seconds.`);
    }
  };
}
