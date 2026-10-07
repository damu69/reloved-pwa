// Pure order pricing in integer paise. No database, no floating point money: the same function
// prices the cart preview and (in step 8) the order itself, so the two can never disagree.
//
// Rules (decided 2026-10-07):
//  - Prices include GST. The GST inside each line is derived from its rate for invoices.
//  - One coupon per order, created by admins and paid for by the platform. Its discount is spread
//    over the eligible lines in proportion to their value; sellers still earn on the full price.
//  - Delivery is charged per seller package, using the option the buyer chose for that seller.
//  - Buyer Protection is charged once per order: fixed + a percentage of the item total after discount.

export interface PriceLine {
  variantId: string;
  sellerId: string;
  categoryPath: string;
  unitPricePaise: number;
  quantity: number;
  gstRateBp: number;
}

export interface CouponRule {
  id: string;
  code: string;
  discountType: "percent" | "fixed";
  percentBp: number | null;          // 1000 = 10%
  amountPaise: number | null;
  maxDiscountPaise: number | null;   // cap for percentage coupons
  minOrderPaise: number;             // on the eligible items
  scopeAll: boolean;
  categoryPaths: string[];           // includes subcategories
  sellerIds: string[];
}

export interface PricingSettings {
  buyerFeeFixedPaise: number;
  buyerFeeBp: number;
}

export interface DeliveryOption { code: string; label: string; feePaise: number }

export interface PricedLine extends PriceLine {
  subtotalPaise: number;
  discountPaise: number;
  netPaise: number;            // what the buyer pays for this line (GST included)
  gstIncludedPaise: number;
}

export interface PricedPackage {
  sellerId: string;
  lines: PricedLine[];
  itemsNetPaise: number;
  delivery: DeliveryOption;
}

export interface Quote {
  packages: PricedPackage[];
  itemsSubtotalPaise: number;
  discountPaise: number;
  itemsNetPaise: number;
  deliveryPaise: number;
  buyerFeePaise: number;
  totalPaise: number;
  gstIncludedInItemsPaise: number;
  coupon: { code: string; discountPaise: number } | null;
  couponProblem: { reason: "NOT_ELIGIBLE" | "MIN_ORDER"; shortfallPaise?: number } | null;
}

const assertInt = (n: number, what: string) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} must be a non-negative integer, got ${n}`);
};

// Half-up rounding of a/b for non-negative integers, without floating point.
export const divRound = (a: bigint, b: bigint): bigint => (a * 2n + b) / (2n * b);

// GST contained in a GST-inclusive amount: amount × rate / (100% + rate).
export const gstIncluded = (amountPaise: number, rateBp: number): number =>
  Number(divRound(BigInt(amountPaise) * BigInt(rateBp), BigInt(10_000 + rateBp)));

// Splits `total` over `weights` proportionally so the parts add up exactly (largest remainder;
// ties go to the earlier line, so the result is deterministic).
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const T = BigInt(total), S = BigInt(sum);
  const raw = weights.map((w) => BigInt(w) * T);
  const base = raw.map((r) => r / S);
  let left = total - base.reduce((a, b) => a + Number(b), 0);
  const order = raw.map((r, i) => ({ i, rem: r % S })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  const out = base.map(Number);
  for (const { i } of order) { if (left <= 0) break; out[i]! += 1; left--; }
  return out;
}

// A scoped coupon applies to items that match every list it sets: categories (including
// subcategories) AND sellers. "Tops from Bob" means Bob's tops, not all tops plus all of Bob's items.
// (Safer reading, pending the owner's confirmation.)
const inScope = (c: CouponRule, l: PriceLine) =>
  c.scopeAll || (
    (c.categoryPaths.length === 0 || c.categoryPaths.some((p) => l.categoryPath === p || l.categoryPath.startsWith(p + "/"))) &&
    (c.sellerIds.length === 0 || c.sellerIds.includes(l.sellerId))
  );

export function priceOrder(
  lines: PriceLine[], coupon: CouponRule | null, deliveryBySeller: Map<string, DeliveryOption>, settings: PricingSettings,
): Quote {
  for (const l of lines) {
    assertInt(l.unitPricePaise, "unitPricePaise"); assertInt(l.quantity, "quantity"); assertInt(l.gstRateBp, "gstRateBp");
    if (l.quantity < 1) throw new Error("quantity must be at least 1");
  }
  const subtotals = lines.map((l) => l.unitPricePaise * l.quantity);
  lines.forEach((_, i) => assertInt(subtotals[i]!, "line subtotal"));

  // Coupon
  let discounts = lines.map(() => 0);
  let couponOut: Quote["coupon"] = null;
  let couponProblem: Quote["couponProblem"] = null;
  if (coupon) {
    const eligible = lines.map((l) => inScope(coupon, l));
    const eligibleSubtotal = subtotals.reduce((a, s, i) => a + (eligible[i] ? s : 0), 0);
    if (eligibleSubtotal === 0) couponProblem = { reason: "NOT_ELIGIBLE" };
    else if (eligibleSubtotal < coupon.minOrderPaise) couponProblem = { reason: "MIN_ORDER", shortfallPaise: coupon.minOrderPaise - eligibleSubtotal };
    else {
      let d = coupon.discountType === "percent"
        ? Number((BigInt(eligibleSubtotal) * BigInt(coupon.percentBp ?? 0)) / 10_000n) // round down: never over-discount
        : coupon.amountPaise ?? 0;
      if (coupon.maxDiscountPaise !== null) d = Math.min(d, coupon.maxDiscountPaise);
      d = Math.min(d, eligibleSubtotal);
      const shares = allocate(d, subtotals.map((s, i) => (eligible[i] ? s : 0)));
      discounts = shares;
      couponOut = { code: coupon.code, discountPaise: d };
    }
  }

  const priced: PricedLine[] = lines.map((l, i) => {
    const net = subtotals[i]! - discounts[i]!;
    return { ...l, subtotalPaise: subtotals[i]!, discountPaise: discounts[i]!, netPaise: net, gstIncludedPaise: gstIncluded(net, l.gstRateBp) };
  });

  // Packages, one per seller, in first-seen order.
  const bySeller = new Map<string, PricedLine[]>();
  for (const p of priced) bySeller.set(p.sellerId, [...(bySeller.get(p.sellerId) ?? []), p]);
  const packages: PricedPackage[] = [...bySeller.entries()].map(([sellerId, ls]) => {
    const delivery = deliveryBySeller.get(sellerId);
    if (!delivery) throw new Error(`No delivery option for seller ${sellerId}`);
    assertInt(delivery.feePaise, "delivery fee");
    return { sellerId, lines: ls, itemsNetPaise: ls.reduce((a, x) => a + x.netPaise, 0), delivery };
  });

  const itemsSubtotalPaise = subtotals.reduce((a, b) => a + b, 0);
  const discountPaise = discounts.reduce((a, b) => a + b, 0);
  const itemsNetPaise = itemsSubtotalPaise - discountPaise;
  const deliveryPaise = packages.reduce((a, p) => a + p.delivery.feePaise, 0);
  const buyerFeePaise = lines.length
    ? settings.buyerFeeFixedPaise + Number(divRound(BigInt(itemsNetPaise) * BigInt(settings.buyerFeeBp), 10_000n))
    : 0;
  return {
    packages, itemsSubtotalPaise, discountPaise, itemsNetPaise, deliveryPaise, buyerFeePaise,
    totalPaise: itemsNetPaise + deliveryPaise + buyerFeePaise,
    gstIncludedInItemsPaise: priced.reduce((a, p) => a + p.gstIncludedPaise, 0),
    coupon: couponOut, couponProblem,
  };
}
