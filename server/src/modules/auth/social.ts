// Sign in, sign up and linking for Google/Facebook identities. The provider-specific checks live in
// social-providers.ts; by the time a SocialProfile gets here it has been verified.
import type { Config } from "../../lib/config.js";
import type { Db } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { writeAudit } from "../../lib/audit.js";
import { issueSession, type IssuedTokens, type RequestMeta } from "./service.js";
import { SocialErrors, type SocialProfile } from "./social-providers.js";

const PG_UNIQUE = "23505";
export const NO_PASSWORD = "!social";

const cleanName = (name: string, email: string): string => {
  const n = name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 120);
  return n || email.split("@")[0]!.slice(0, 120);
};

export async function signInWithProfile(cfg: Config, db: Db, p: SocialProfile, meta: RequestMeta): Promise<IssuedTokens> {
  try {
    return await withTx(db, async (tx) => {
      // 1. Already connected: just sign in.
      const known = (await tx.query(
        `select i.id, i.user_id, u.status from user_identities i join users u on u.id = i.user_id
          where i.provider = $1 and i.provider_user_id = $2 and u.deleted_at is null`,
        [p.provider, p.subject],
      )).rows[0];
      if (known) {
        if (known.status !== "active") throw Errors.accountSuspended();
        await tx.query(`update user_identities set last_login_at = now() where id = $1`, [known.id]);
        await writeAudit(tx, { actorUserId: known.user_id, action: "auth.social_login", entity: "user", entityId: known.user_id, ip: meta.ip, requestId: meta.requestId });
        return issueSession(cfg, tx, known.user_id, null, meta);
      }

      if (!p.email) throw SocialErrors.emailRequired(p.provider);

      // 2. An account with this email exists.
      const existing = (await tx.query(
        `select id, status, email_verified_at from users where email = $1 and deleted_at is null for update`,
        [p.email],
      )).rows[0];
      if (existing) {
        // Only an email the provider vouches for may attach to an existing account.
        if (!p.emailVerified) throw SocialErrors.existsUsePassword();
        if (existing.status !== "active") throw Errors.accountSuspended();
        await tx.query(`insert into user_identities (user_id, provider, provider_user_id, email) values ($1, $2, $3, $4)`, [existing.id, p.provider, p.subject, p.email]);
        if (!existing.email_verified_at) {
          // Reloved never verified this email when the account was created, so whoever typed it then may not own it.
          // Now the real owner has proved it: drop the old password and every old session, so nobody else keeps access.
          // The owner uses this provider, or "Forgot your password?", to get back in.
          await tx.query(`update users set email_verified_at = now(), password_hash = $2 where id = $1`, [existing.id, NO_PASSWORD]);
          await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'password_reset' where user_id = $1 and revoked_at is null`, [existing.id]);
        }
        await writeAudit(tx, { actorUserId: existing.id, action: "auth.social_linked", entity: "user", entityId: existing.id, ip: meta.ip, requestId: meta.requestId });
        return issueSession(cfg, tx, existing.id, null, meta);
      }

      // 3. New account.
      const u = (await tx.query(
        `insert into users (email, password_hash, full_name, email_verified_at) values ($1, $2, $3, $4) returning id`,
        [p.email, NO_PASSWORD, cleanName(p.name, p.email), p.emailVerified ? new Date() : null],
      )).rows[0];
      await tx.query(`insert into user_roles (user_id, role_key) values ($1, 'customer')`, [u.id]);
      await tx.query(`insert into user_identities (user_id, provider, provider_user_id, email) values ($1, $2, $3, $4)`, [u.id, p.provider, p.subject, p.email]);
      await writeAudit(tx, { actorUserId: u.id, action: "user.register", entity: "user", entityId: u.id, ip: meta.ip, requestId: meta.requestId });
      return issueSession(cfg, tx, u.id, null, meta);
    });
  } catch (e: any) {
    // Two sign-ins for the same new person at the same moment: one wins, the other asks to try again.
    if (e?.code === PG_UNIQUE) throw Errors.conflict("SOCIAL_RETRY", "Please try signing in again.");
    throw e;
  }
}

// Connects a provider to the account that is signed in (used when a Facebook email matched an existing account).
export async function linkProfile(db: Db, userId: string, p: SocialProfile, meta: RequestMeta): Promise<void> {
  try {
    await withTx(db, async (tx) => {
      const same = (await tx.query(`select user_id from user_identities where provider = $1 and provider_user_id = $2`, [p.provider, p.subject])).rows[0];
      if (same) {
        if (same.user_id === userId) return; // already connected: nothing to do
        throw SocialErrors.alreadyLinked(p.provider);
      }
      const mine = (await tx.query(`select 1 from user_identities where user_id = $1 and provider = $2`, [userId, p.provider])).rows[0];
      if (mine) throw SocialErrors.alreadyLinked(p.provider);
      await tx.query(`insert into user_identities (user_id, provider, provider_user_id, email) values ($1, $2, $3, $4)`, [userId, p.provider, p.subject, p.email]);
      await writeAudit(tx, { actorUserId: userId, action: "auth.social_linked", entity: "user", entityId: userId, ip: meta.ip, requestId: meta.requestId });
    });
  } catch (e: any) {
    if (e?.code === PG_UNIQUE) throw SocialErrors.alreadyLinked(p.provider);
    throw e;
  }
}
