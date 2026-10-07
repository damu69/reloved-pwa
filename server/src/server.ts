import { loadConfig } from "./lib/config.js";
import { createPool } from "./lib/db.js";
import { buildApp } from "./app.js";
import { expireDue, processSearchQueue } from "./modules/inventory/service.js";
import { expireUnpaidOrders } from "./modules/orders/service.js";
import { releaseHeldFunds } from "./modules/finance/service.js";
import { processDeadlines } from "./modules/returns/service.js";
import { processPendingRefunds, processRefund } from "./modules/refunds/service.js";
import { providerFor } from "./modules/payments/provider.js";

const cfg = loadConfig();
const db = createPool(cfg);
const app = await buildApp(cfg, db);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: cfg.PORT, host: "0.0.0.0" });

// Background sweep that gives back stock held by checkouts that were never paid.
// TODO when a job queue (Redis + BullMQ) is added: move this there. Safe to run on several
// instances at once (each reservation is released exactly once).
// It also finishes any search refreshes queued by bulk changes.
let sweeping = false;
const sweep = setInterval(() => {
  if (sweeping) return; // never overlap with a slow previous run
  sweeping = true;
  expireUnpaidOrders(db)
    .then((n) => { if (n) app.log.info({ cancelled: n }, "cancelled unpaid orders past their payment window"); })
    .catch((err) => app.log.error({ err }, "unpaid order sweep failed"))
    .then(() => expireDue(db))
    .then((n) => { if (n) app.log.info({ released: n }, "expired stock reservations"); })
    .catch((err) => app.log.error({ err }, "reservation sweep failed"))
    .then(() => processDeadlines(db))
    .then(async (r) => {
      for (const id of r.refunds) await processRefund(db, providerFor(cfg), id);
      if (r.changed) app.log.info({ changed: r.changed }, "return deadlines processed");
      for (const f of r.failed) app.log.error({ returnId: f.id, error: f.error }, "return deadline could not be processed");
    })
    .catch((err) => app.log.error({ err }, "return deadline sweep failed"))
    .then(() => processPendingRefunds(db, providerFor(cfg)))
    .then((n) => { if (n) app.log.info({ processed: n }, "pending refunds sent"); })
    .catch((err) => app.log.error({ err }, "refund retry sweep failed"))
    .then(() => releaseHeldFunds(db))
    .then((n) => { if (n) app.log.info({ released: n }, "seller earnings moved from on hold to available"); })
    .catch((err) => app.log.error({ err }, "earnings release sweep failed"))
    .then(() => processSearchQueue(db))
    .then((n) => { if (n) app.log.info({ refreshed: n }, "search refresh queue processed"); })
    .catch((err) => app.log.error({ err }, "search refresh sweep failed"))
    .finally(() => { sweeping = false; });
}, 60_000);
sweep.unref();
