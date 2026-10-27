import pg from "pg";
import type { Config } from "./config.js";
import { SUPABASE_ROOT_CA_2021 } from "./supabase-ca.js";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

// DATABASE_CA_CERT may arrive with literal "\n" sequences or stray quotes when pasted into a hosting dashboard.
function normalizePem(v: string): string {
  return v.trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
}

// The pg driver lets a sslmode=... inside the connection URL override the ssl option below, which would
// silently bypass the certificate settings. TLS is configured only through DATABASE_SSL / DATABASE_CA_CERT.
function withoutSslMode(url: string | undefined): string | undefined {
  return url?.replace(/([?&])sslmode=[^&]*&?/i, "$1").replace(/[?&]$/, "");
}

export function createPool(cfg: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: cfg.DATABASE_SSL === "off" ? cfg.DATABASE_URL : withoutSslMode(cfg.DATABASE_URL),
    // "require" = encrypt but do not verify the server certificate: an explicit opt-in; the default verifies.
    // "verify-full" checks the chain and host name against DATABASE_CA_CERT, or the bundled Supabase root CA.
    ssl:
      cfg.DATABASE_SSL === "off" ? undefined
      : cfg.DATABASE_SSL === "require" ? { rejectUnauthorized: false } // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      : { rejectUnauthorized: true, ca: cfg.DATABASE_CA_CERT?.trim() ? normalizePem(cfg.DATABASE_CA_CERT) : SUPABASE_ROOT_CA_2021 },
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
