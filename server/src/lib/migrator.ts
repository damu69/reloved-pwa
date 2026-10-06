import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

// Forward-only migrations. Each file runs once, in its own transaction, in name order.
// A changed checksum on an applied file stops the run: never edit an applied migration.
export async function migrate(pool: pg.Pool, dir: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query(`select pg_advisory_lock(727274)`); // one migrator at a time
    await client.query(`create table if not exists schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const applied = new Map<string, string>(
      (await client.query(`select name, checksum from schema_migrations`)).rows.map((r) => [r.name, r.checksum]),
    );
    const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const ran: string[] = [];
    for (const f of files) {
      const sql = await readFile(join(dir, f), "utf8");
      const sum = createHash("sha256").update(sql).digest("hex");
      const prev = applied.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`Migration ${f} was changed after being applied`);
        continue;
      }
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into schema_migrations (name, checksum) values ($1, $2)`, [f, sum]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
      log(`applied ${f}`);
      ran.push(f);
    }
    return ran;
  } finally {
    await client.query(`select pg_advisory_unlock(727274)`).catch(() => {});
    client.release();
  }
}
