import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";
import { createPool } from "../lib/db.js";
import { migrate } from "../lib/migrator.js";

// Migrations run as the schema owner (MIGRATE_DATABASE_URL); the API itself connects with a role
// that can only read and write rows (DATABASE_URL). Locally both can be the same.
const cfg = loadConfig({ ...process.env, DATABASE_URL: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL } as NodeJS.ProcessEnv);
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
