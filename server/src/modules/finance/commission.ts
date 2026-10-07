// Commission: which rule applies to an order line, and how much it is. Pure functions plus one
// query; the result is frozen on the order line at checkout, so later rule changes never alter
// an existing order.
import type { Queryable } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { divRound } from "../cart/pricing.js";

export interface RuleCandidate {
  id: string;
  scope: "default" | "category" | "seller" | "product";
  rateBp: number;
  productId: string | null;
  sellerId: string | null;
  categoryPath: string | null;
}
export interface CommissionLine { productId: string; sellerId: string; categoryPath: string }
export interface AppliedRule { ruleId: string; rateBp: number; scope: RuleCandidate["scope"] }

const inCategory = (linePath: string, rulePath: string) => linePath === rulePath || linePath.startsWith(rulePath + "/");

// Most specific wins (decided 2026-10-07): product > seller > category (deepest first) > default.
export function pickRule(candidates: RuleCandidate[], line: CommissionLine): AppliedRule | null {
  const byProduct = candidates.find((c) => c.scope === "product" && c.productId === line.productId);
  const bySeller = candidates.find((c) => c.scope === "seller" && c.sellerId === line.sellerId);
  const byCategory = candidates
    .filter((c) => c.scope === "category" && c.categoryPath !== null && inCategory(line.categoryPath, c.categoryPath))
    .sort((a, b) => b.categoryPath!.length - a.categoryPath!.length)[0];
  const byDefault = candidates.find((c) => c.scope === "default");
  const r = byProduct ?? bySeller ?? byCategory ?? byDefault;
  return r ? { ruleId: r.id, rateBp: r.rateBp, scope: r.scope } : null;
}

// Commission on the item price before any coupon (the platform pays for coupons), half-up.
export const commissionOn = (subtotalPaise: number, rateBp: number): number =>
  Number(divRound(BigInt(subtotalPaise) * BigInt(rateBp), 10_000n));

// The rules in force at the database's current time (one transaction = one instant) for these lines.
export async function rulesFor(db: Queryable, lines: CommissionLine[], at: Date | null = null): Promise<RuleCandidate[]> {
  const r = await db.query(
    `select r.id, r.scope, r.rate_bp, r.product_id, r.seller_id, c.path as category_path
       from commission_rules r left join categories c on c.id = r.category_id
      where r.starts_at <= coalesce($4::timestamptz, now()) and (r.ends_at is null or r.ends_at > coalesce($4::timestamptz, now()))
        and (r.scope = 'default'
             or r.product_id = any($1::uuid[])
             or r.seller_id = any($2::uuid[])
             or (r.scope = 'category' and exists (
                   select 1 from unnest($3::text[]) p where p = c.path or starts_with(p, c.path || '/'))))`,
    [[...new Set(lines.map((l) => l.productId))], [...new Set(lines.map((l) => l.sellerId))], [...new Set(lines.map((l) => l.categoryPath))], at],
  );
  return r.rows.map((x) => ({
    id: x.id, scope: x.scope, rateBp: x.rate_bp, productId: x.product_id, sellerId: x.seller_id, categoryPath: x.category_path,
  }));
}

export async function resolve(db: Queryable, lines: CommissionLine[], at: Date | null = null): Promise<AppliedRule[]> {
  const candidates = await rulesFor(db, lines, at);
  return lines.map((l) => {
    const r = pickRule(candidates, l);
    // Never guess a rate: without a rule in force the sale cannot be priced for the seller.
    if (!r) throw new AppError(503, "COMMISSION_NOT_CONFIGURED", "Checkout is temporarily unavailable. Please try again later.");
    return r;
  });
}
