import { loadConfig } from "./lib/config.js";
import { createPool } from "./lib/db.js";
import { buildApp } from "./app.js";
import { expireDue, processSearchQueue } from "./modules/inventory/service.js";

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
  expireDue(db)
    .then((n) => { if (n) app.log.info({ released: n }, "expired stock reservations"); })
    .catch((err) => app.log.error({ err }, "reservation sweep failed"))
    .then(() => processSearchQueue(db))
    .then((n) => { if (n) app.log.info({ refreshed: n }, "search refresh queue processed"); })
    .catch((err) => app.log.error({ err }, "search refresh sweep failed"))
    .finally(() => { sweeping = false; });
}, 60_000);
sweep.unref();
