import pg from "pg";
import type { Config } from "./config.js";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(cfg: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    ssl:
      cfg.DATABASE_SSL === "off" ? undefined
      : cfg.DATABASE_SSL === "require" ? { rejectUnauthorized: false }
      : { rejectUnauthorized: true, ...(cfg.DATABASE_CA_CERT ? { ca: cfg.DATABASE_CA_CERT } : {}) },
    max: cfg.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(cfg.DATABASE_STATEMENT_TIMEOUT_MS ? { statement_timeout: cfg.DATABASE_STATEMENT_TIMEOUT_MS } : {}),
  });
  // An idle connection can be closed by the database (restart, failover). Without this handler
  // Node treats it as an unhandled error and the whole API process exits.
  pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "idle database connection lost", err: err.message })));
  return pool;
}

// Runs fn inside one transaction. Rolls back on any error, so partial writes never persist.
export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
