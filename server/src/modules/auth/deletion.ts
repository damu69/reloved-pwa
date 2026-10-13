// Account deletion (required by Google Play and the App Store).
// The users row is kept but anonymised, because orders, invoices and the ledger must keep pointing at
// something. Personal details are removed; legally required order and seller tax records stay.
import type { Db } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { verifyPassword } from "../../lib/crypto.js";
import { writeAudit } from "../../lib/audit.js";

export async function deleteAccount(db: Db, userId: string, password: string, meta: { ip?: string | null; requestId?: string | null }): Promise<void> {
  const u = await db.query(`select password_hash, status from users where id = $1 and deleted_at is null`, [userId]);
  if (!u.rows[0] || !(await verifyPassword(u.rows[0].password_hash, password))) throw Errors.invalidCredentials();

  await withTx(db, async (tx) => {
    await tx.query(`select id from users where id = $1 for update`, [userId]);
    const seller = (await tx.query(`select id from sellers where user_id = $1`, [userId])).rows[0];

    const buying = await tx.query(
      `select 1 from orders where user_id = $1 and status in ('confirmed','processing','partially_shipped','shipped','partially_delivered')
       union all
       select 1 from returns where user_id = $1 and status in ('requested','approved','disputed','shipped_back','received') limit 1`,
      [userId],
    );
    let selling = { rowCount: 0 };
    if (seller) {
      selling = await tx.query(
        `select 1 from seller_orders where seller_id = $1 and status in ('confirmed','processing','shipped','out_for_delivery') limit 1`,
        [seller.id],
      ) as any;
    }
    if (buying.rowCount || selling.rowCount) {
      throw Errors.conflict("OPEN_ORDERS", "You still have orders or returns in progress. Finish or cancel them first, then delete your account.");
    }

    if (seller) {
      await tx.query(`update products set status = 'archived' where seller_id = $1 and status <> 'archived'`, [seller.id]);
      await tx.query(`update sellers set status = 'suspended' where id = $1`, [seller.id]);
    }
    await tx.query(`delete from cart_items where cart_id in (select id from carts where user_id = $1)`, [userId]);
    await tx.query(`delete from wishlists where user_id = $1`, [userId]);
    await tx.query(`delete from user_blocks where blocker_id = $1 or blocked_id = $1`, [userId]);
    await tx.query(
      `update addresses set name = 'Deleted user', phone = '0000000000', line1 = 'Deleted', line2 = null, deleted_at = coalesce(deleted_at, now()), is_default = false
        where user_id = $1`,
      [userId],
    );
    await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'logout_all' where user_id = $1 and revoked_at is null`, [userId]);
    await tx.query(`update password_resets set used_at = now() where user_id = $1 and used_at is null`, [userId]);
    await tx.query(
      `update users set email = 'deleted+' || id || '@deleted.reloved.invalid', phone = null, password_hash = '!deleted',
                        full_name = 'Deleted user', status = 'deleted', deleted_at = now() where id = $1`,
      [userId],
    );
    await writeAudit(tx, { actorUserId: userId, action: "account.deleted", entity: "user", entityId: userId, ip: meta.ip, requestId: meta.requestId });
  });
}
