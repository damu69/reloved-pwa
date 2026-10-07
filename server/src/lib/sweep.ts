import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { expireDue, processSearchQueue } from "../modules/inventory/service.js";
import { expireUnpaidOrders } from "../modules/orders/service.js";
import { releaseHeldFunds } from "../modules/finance/service.js";
import { processDeadlines } from "../modules/returns/service.js";
import { processPendingRefunds, processRefund } from "../modules/refunds/service.js";
import { providerFor } from "../modules/payments/provider.js";

type Log = { info: (o: object, m: string) => void; error: (o: object, m: string) => void };

// All background housekeeping, in a fixed order. Each part is independent: one failing never stops
// the others. Every part is safe to run on several instances at once (SKIP LOCKED, unique keys).
// Run every minute: by a timer in a long-running server (server.ts), or by a scheduler calling
// POST /internal/sweep when the API runs as serverless functions (Vercel).
export async function runSweep(db: Db, cfg: Config, log: Log): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const step = async (name: string, fn: () => Promise<number>) => {
    try {
      out[name] = await fn();
      if (out[name]) log.info({ [name]: out[name] }, `sweep: ${name}`);
    } catch (err) {
      out[name] = -1;
      log.error({ err }, `sweep: ${name} failed`);
    }
  };
  const provider = providerFor(cfg);
  await step("unpaidOrdersCancelled", () => expireUnpaidOrders(db));
  await step("stockHoldsExpired", () => expireDue(db));
  await step("returnDeadlines", async () => {
    const r = await processDeadlines(db);
    for (const id of r.refunds) await processRefund(db, provider, id);
    for (const f of r.failed) log.error({ returnId: f.id, error: f.error }, "return deadline could not be processed");
    return r.changed;
  });
  await step("refundsSent", () => processPendingRefunds(db, provider));
  await step("earningsReleased", () => releaseHeldFunds(db));
  await step("searchRefreshed", () => processSearchQueue(db));
  return out;
}
