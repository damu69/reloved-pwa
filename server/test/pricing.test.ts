import { describe, expect, it } from "vitest";
import { allocate, gstIncluded, priceOrder, type CouponRule, type DeliveryOption, type PriceLine } from "../src/modules/cart/pricing.js";

const home: DeliveryOption = { code: "home", label: "Home delivery", feePaise: 9900 };
const pickup: DeliveryOption = { code: "pickup", label: "Pickup point", feePaise: 5900 };
const meet: DeliveryOption = { code: "meet", label: "Meet and collect", feePaise: 0 };
const fee = { buyerFeeFixedPaise: 1500, buyerFeeBp: 500 };
const line = (o: Partial<PriceLine>): PriceLine => ({ variantId: "v", sellerId: "A", categoryPath: "women/tops", unitPricePaise: 100000, quantity: 1, gstRateBp: 500, ...o });
const coupon = (o: Partial<CouponRule>): CouponRule => ({ id: "c", code: "SAVE", discountType: "percent", percentBp: 1000, amountPaise: null, maxDiscountPaise: null, minOrderPaise: 0, scopeAll: true, categoryPaths: [], sellerIds: [], ...o });

describe("pricing", () => {
  it("a ₹1,000 item with home delivery costs ₹1,000 + ₹99 + ₹65 Buyer Protection", () => {
    const q = priceOrder([line({})], null, new Map([["A", home]]), fee);
    expect(q).toMatchObject({ itemsNetPaise: 100000, deliveryPaise: 9900, buyerFeePaise: 6500, totalPaise: 116400 });
    expect(q.gstIncludedInItemsPaise).toBe(4762); // 5% GST inside ₹1,000 = ₹47.62
  });
  it("charges delivery per seller package and Buyer Protection once", () => {
    const q = priceOrder(
      [line({ variantId: "a1", sellerId: "A" }), line({ variantId: "b1", sellerId: "B", unitPricePaise: 50000, quantity: 2 }), line({ variantId: "c1", sellerId: "C" })],
      null, new Map([["A", home], ["B", pickup], ["C", meet]]), fee,
    );
    expect(q.packages.map((p) => [p.sellerId, p.itemsNetPaise, p.delivery.feePaise])).toEqual([["A", 100000, 9900], ["B", 100000, 5900], ["C", 100000, 0]]);
    expect(q.deliveryPaise).toBe(15800);
    expect(q.buyerFeePaise).toBe(1500 + 15000);
  });
  it("applies a percentage coupon to eligible items only, with a cap and a minimum", () => {
    const lines = [line({ variantId: "t", categoryPath: "women/tops/crop" }), line({ variantId: "s", categoryPath: "men/shoes", sellerId: "B" })];
    const d = new Map([["A", home], ["B", home]]);
    const q = priceOrder(lines, coupon({ scopeAll: false, categoryPaths: ["women/tops"], maxDiscountPaise: 7500 }), d, fee);
    expect(q.discountPaise).toBe(7500);
    expect(q.packages[0]!.lines[0]!.discountPaise).toBe(7500);
    expect(q.packages[1]!.lines[0]!.discountPaise).toBe(0);
    const min = priceOrder(lines, coupon({ scopeAll: false, categoryPaths: ["women/tops"], minOrderPaise: 150000 }), d, fee);
    expect(min.coupon).toBeNull();
    expect(min.couponProblem).toEqual({ reason: "MIN_ORDER", shortfallPaise: 50000 });
    expect(priceOrder(lines, coupon({ scopeAll: false, sellerIds: ["Z"] }), d, fee).couponProblem).toEqual({ reason: "NOT_ELIGIBLE" });
    // "women/top" must not match "women/tops".
    expect(priceOrder(lines, coupon({ scopeAll: false, categoryPaths: ["women/top"] }), d, fee).couponProblem).toEqual({ reason: "NOT_ELIGIBLE" });
  });
  it("a fixed coupon never discounts more than the eligible items cost", () => {
    const q = priceOrder([line({ unitPricePaise: 30000 })], coupon({ discountType: "fixed", percentBp: null, amountPaise: 50000 }), new Map([["A", meet]]), fee);
    expect(q.discountPaise).toBe(30000);
    expect(q.itemsNetPaise).toBe(0);
    expect(q.totalPaise).toBe(1500);
  });
  it("percentage discounts round down so the platform never over-discounts", () => {
    const q = priceOrder([line({ unitPricePaise: 333 })], coupon({ percentBp: 1000 }), new Map([["A", meet]]), fee);
    expect(q.discountPaise).toBe(33);
  });
  it("allocates exactly, deterministically", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(7, [0, 0])).toEqual([0, 0]);
    expect(allocate(1, [1, 1])).toEqual([1, 0]);
  });
  it("GST included is computed half-up from integer paise", () => {
    expect(gstIncluded(10500, 500)).toBe(500);
    expect(gstIncluded(11800, 1800)).toBe(1800);
    expect(gstIncluded(100, 1800)).toBe(15); // 15.25 → 15
    expect(gstIncluded(0, 1800)).toBe(0);
  });
  it("rejects fractional or negative money", () => {
    expect(() => priceOrder([line({ unitPricePaise: 10.5 })], null, new Map([["A", home]]), fee)).toThrow();
    expect(() => priceOrder([line({ quantity: 0 })], null, new Map([["A", home]]), fee)).toThrow();
  });
  it("always adds up, over 2,000 random orders", () => {
    let seed = 42;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let k = 0; k < 2000; k++) {
      const sellers = ["A", "B", "C", "D"];
      const lines = Array.from({ length: 1 + rnd(8) }, (_, i) => line({
        variantId: `v${i}`, sellerId: sellers[rnd(4)]!, categoryPath: ["women/tops", "men/shoes", "kids"][rnd(3)]!,
        unitPricePaise: 100 + rnd(5_000_000), quantity: 1 + rnd(5), gstRateBp: [0, 300, 500, 1800, 4000][rnd(5)]!,
      }));
      const c = rnd(3) === 0 ? null : coupon({
        discountType: rnd(2) ? "percent" : "fixed", percentBp: 1 + rnd(9000), amountPaise: rnd(1_000_000),
        maxDiscountPaise: rnd(2) ? rnd(500_000) : null, minOrderPaise: rnd(2) ? rnd(2_000_000) : 0,
        scopeAll: rnd(2) === 0, categoryPaths: rnd(2) ? ["women"] : [], sellerIds: rnd(2) ? ["B"] : [],
      });
      const q = priceOrder(lines, c, new Map(sellers.map((s) => [s, [home, pickup, meet][rnd(3)]!])), fee);
      const all = q.packages.flatMap((p) => p.lines);
      expect(all.reduce((a, l) => a + l.discountPaise, 0)).toBe(q.discountPaise);
      expect(all.reduce((a, l) => a + l.netPaise, 0)).toBe(q.itemsNetPaise);
      expect(q.itemsSubtotalPaise - q.discountPaise).toBe(q.itemsNetPaise);
      expect(q.totalPaise).toBe(q.itemsNetPaise + q.deliveryPaise + q.buyerFeePaise);
      for (const l of all) {
        expect(l.discountPaise).toBeGreaterThanOrEqual(0);
        expect(l.netPaise).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(l.gstIncludedPaise) && l.gstIncludedPaise <= l.netPaise).toBe(true);
      }
      if (c && q.coupon) {
        if (c.maxDiscountPaise !== null) expect(q.discountPaise).toBeLessThanOrEqual(c.maxDiscountPaise);
      }
    }
  });
});
