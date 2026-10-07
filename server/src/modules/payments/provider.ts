// Payment providers behind one interface. The rest of the system never talks to a provider
// directly, so Razorpay (later) replaces the mock without changes elsewhere.
//
// Security rules every provider follows:
//  - Nothing from the browser is trusted on its own: a payment counts only after its signature is
//    checked on the server with a secret the browser never sees.
//  - Webhooks are accepted only with a valid signature over the exact bytes received.
//  - The amount is fixed when the provider order is created, from the order total in the database.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../../lib/config.js";

export type ProviderName = "mock";

export interface ProviderEvent {
  eventId: string;
  type: "payment.captured" | "payment.failed" | "other";
  rawType: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  amountPaise: number | null;
  currency: string | null;
  failureReason: string | null;
}

export interface FetchedPayment {
  providerOrderId: string;
  status: "captured" | "authorized" | "failed" | "other";
  amountPaise: number;
  currency: string;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  // Creates the provider-side order for an exact amount. clientData is safe to send to the browser.
  createOrder(input: { amountPaise: number; currency: "INR"; receipt: string }): Promise<{ providerOrderId: string; clientData: Record<string, unknown> }>;
  // The browser returns (providerOrderId, providerPaymentId, signature) after a successful payment.
  verifyClientSignature(input: { providerOrderId: string; providerPaymentId: string; signature: string }): boolean;
  // Asks the provider, server to server, what really happened to a payment. A browser signature
  // proves the buyer went through checkout, not that the money was captured or how much it was.
  fetchPayment(providerPaymentId: string): Promise<FetchedPayment | null>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  // Only called after verifyWebhook. Throws on a body it cannot read.
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent;
}

const hmac = (secret: string, data: string | Buffer) => createHmac("sha256", secret).update(data).digest("hex");
const safeEqualHex = (a: string, b: string) => {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
};
const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? "" : "";
};

// MOCK / TEMPORARY: a fake provider shaped like Razorpay (signature over "order_id|payment_id",
// webhook signature over the raw body, event id in a header). Refused in production by config.
export class MockProvider implements PaymentProvider {
  readonly name = "mock" as const;
  // The fake gateway's own records, shared by every instance in this process (development and tests only).
  private static readonly gateway = new Map<string, FetchedPayment>();
  constructor(private readonly secret: string) {}

  async fetchPayment(providerPaymentId: string): Promise<FetchedPayment | null> {
    return MockProvider.gateway.get(providerPaymentId) ?? null;
  }

  async createOrder(input: { amountPaise: number; currency: "INR"; receipt: string }) {
    const providerOrderId = `order_mock_${randomBytes(9).toString("hex")}`;
    return { providerOrderId, clientData: { provider: "mock", providerOrderId, amountPaise: input.amountPaise, currency: input.currency, receipt: input.receipt } };
  }

  verifyClientSignature(i: { providerOrderId: string; providerPaymentId: string; signature: string }) {
    return safeEqualHex(i.signature, hmac(this.secret, `${i.providerOrderId}|${i.providerPaymentId}`));
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    return safeEqualHex(header(headers, "x-mock-signature"), hmac(this.secret, rawBody));
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const eventId = header(headers, "x-mock-event-id");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(eventId)) throw new Error("missing event id");
    const body = JSON.parse(rawBody.toString("utf8"));
    const e = body?.payload?.payment?.entity ?? {};
    const rawType = String(body?.event ?? "");
    const str = (v: unknown) => (typeof v === "string" && v.length <= 100 ? v : null);
    return {
      eventId, rawType,
      type: rawType === "payment.captured" || rawType === "payment.failed" ? rawType : "other",
      providerOrderId: str(e.order_id), providerPaymentId: str(e.id),
      amountPaise: Number.isSafeInteger(e.amount) && e.amount > 0 ? e.amount : null,
      currency: str(e.currency),
      failureReason: typeof e.error_description === "string" ? e.error_description.slice(0, 300) : null,
    };
  }

  // ---- the fake gateway itself (development and tests only) ----
  simulate(providerOrderId: string, outcome: "success" | "failure", amountPaise: number) {
    const providerPaymentId = `pay_mock_${randomBytes(9).toString("hex")}`;
    MockProvider.gateway.set(providerPaymentId, { providerOrderId, status: outcome === "success" ? "captured" : "failed", amountPaise, currency: "INR" });
    const signature = hmac(this.secret, `${providerOrderId}|${providerPaymentId}`);
    const event = outcome === "success" ? "payment.captured" : "payment.failed";
    const body = Buffer.from(JSON.stringify({
      event, payload: { payment: { entity: {
        id: providerPaymentId, order_id: providerOrderId, amount: amountPaise, currency: "INR",
        status: outcome === "success" ? "captured" : "failed",
        ...(outcome === "failure" ? { error_description: "Card declined (mock)" } : {}),
      } } },
    }));
    const headers = { "x-mock-event-id": `evt_mock_${randomBytes(9).toString("hex")}`, "x-mock-signature": hmac(this.secret, body), "content-type": "application/json" };
    return { providerPaymentId, signature: outcome === "success" ? signature : null, webhook: { body, headers } };
  }
}

export function providerFor(cfg: Pick<Config, "PAYMENT_PROVIDER" | "MOCK_PAYMENT_SECRET" | "NODE_ENV">): PaymentProvider | null {
  if (cfg.PAYMENT_PROVIDER === "mock") {
    if (cfg.NODE_ENV === "production") throw new Error("mock payments are never allowed in production");
    return new MockProvider(cfg.MOCK_PAYMENT_SECRET);
  }
  return null;
}
