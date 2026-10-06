// Bootstrap: makes an existing registered user an admin. Run once from a trusted machine:
//   npm run grant-admin -- someone@example.com
// It is audited with action "role.grant.bootstrap" and no actor.
import { loadConfig } from "../lib/config.js";
import { createPool, withTx } from "../lib/db.js";
import { writeAudit } from "../lib/audit.js";

const email = process.argv[2];
if (!email) {
  console.error("Usage: npm run grant-admin -- <email>");
  process.exit(1);
}
const pool = createPool(loadConfig());
try {
  await withTx(pool, async (tx) => {
    const u = await tx.query(`select id from users where email = $1 and deleted_at is null`, [email]);
    if (!u.rows[0]) throw new Error(`No user with email ${email}. Register first.`);
    const id = u.rows[0].id;
    const r = await tx.query(`insert into user_roles (user_id, role_key) values ($1, 'admin') on conflict do nothing`, [id]);
    if (r.rowCount) await writeAudit(tx, { actorUserId: null, action: "role.grant.bootstrap", entity: "user", entityId: id, newValue: { role: "admin" } });
    console.log(r.rowCount ? `${email} is now an admin` : `${email} was already an admin`);
  });
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
