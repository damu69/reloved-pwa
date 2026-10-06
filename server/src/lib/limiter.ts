import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";

// Fixed-window counter used for a second limit on a route (the rate-limit plugin runs only one
// limiter per request). In memory, per instance. TODO before running several API instances:
// move both limiters to Redis so counts are shared.
export function windowLimiter(name: string, max: number, windowMs: number, key: (req: FastifyRequest) => string) {
  const hits = new Map<string, { n: number; resetAt: number }>();
  let lastSweep = Date.now();
  return async (req: FastifyRequest): Promise<void> => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const k = `${name}|${key(req)}`;
    let e = hits.get(k);
    if (!e || e.resetAt <= now) {
      e = { n: 0, resetAt: now + windowMs };
      hits.set(k, e);
    }
    e.n += 1;
    if (e.n > max) {
      const secs = Math.ceil((e.resetAt - now) / 1000);
      throw new AppError(429, "RATE_LIMITED", `Too many requests. Try again in ${secs} seconds.`);
    }
  };
}
