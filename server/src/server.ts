import { loadConfig } from "./lib/config.js";
import { createPool } from "./lib/db.js";
import { buildApp } from "./app.js";

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
