import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";
import { createPool } from "../lib/db.js";
import { migrate } from "../lib/migrator.js";

const cfg = loadConfig();
const pool = createPool(cfg);
try {
  const ran = await migrate(pool, fileURLToPath(new URL("../../migrations", import.meta.url)));
  console.log(ran.length ? `done, ${ran.length} applied` : "up to date");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
