import type { FastifyRequest } from "fastify";
import { AppError, Errors } from "../../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    seller: { id: string } | null;
  }
}

// For seller-only routes. Runs after authenticate. Checks the seller's CURRENT status on every
// request, so a suspension takes effect immediately.
export async function requireApprovedSeller(req: FastifyRequest): Promise<void> {
  if (!req.auth) throw Errors.unauthenticated();
  const r = await req.server.db.query(`select id, status from sellers where user_id = $1`, [req.auth.userId]);
  const s = r.rows[0];
  if (!s) throw new AppError(403, "NOT_A_SELLER", "Apply to become a seller first.");
  if (s.status === "suspended") throw new AppError(403, "SELLER_SUSPENDED", "Your seller account is suspended. Contact support.");
  if (s.status !== "approved") throw new AppError(403, "SELLER_NOT_APPROVED", "Your seller account is not approved yet.");
  req.seller = { id: s.id };
}
