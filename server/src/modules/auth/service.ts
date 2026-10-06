import type { Config } from "../../lib/config.js";
import type { Db, Queryable, Tx } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { burnPasswordCheck, hashPassword, hashToken, newOpaqueToken, verifyPassword } from "../../lib/crypto.js";
import { writeAudit } from "../../lib/audit.js";
import { signAccessToken } from "./tokens.js";

export interface RequestMeta { ip: string | null; userAgent: string | null; requestId: string }
export interface IssuedTokens { accessToken: string; refreshToken: string; refreshExpiresAt: Date; user: PublicUser }
export interface PublicUser { id: string; email: string; fullName: string; phone: string | null; roles: string[] }

const PG_UNIQUE = "23505";

async function loadPublicUser(db: Queryable, userId: string): Promise<PublicUser> {
  const r = await db.query(
    `select u.id, u.email, u.full_name, u.phone,
            coalesce(array_agg(ur.role_key order by ur.role_key) filter (where ur.role_key is not null), '{}') as roles
       from users u left join user_roles ur on ur.user_id = u.id
      where u.id = $1 group by u.id`,
    [userId],
  );
  const u = r.rows[0];
  if (!u) throw Errors.notFound("User");
  return { id: u.id, email: u.email, fullName: u.full_name, phone: u.phone, roles: u.roles };
}

async function issueSession(
  cfg: Config, tx: Tx, userId: string, family: { id: string; expiresAt: Date } | null, meta: RequestMeta,
): Promise<IssuedTokens> {
  const refreshToken = newOpaqueToken();
  const familyExpires = family?.expiresAt ?? new Date(Date.now() + cfg.SESSION_MAX_DAYS * 86_400_000);
  const expires = new Date(Math.min(Date.now() + cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000, familyExpires.getTime()));
  const r = await tx.query(
    `insert into sessions (family_id, user_id, refresh_token_hash, user_agent, ip, expires_at, family_expires_at)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7) returning family_id`,
    [family?.id ?? null, userId, hashToken(refreshToken), meta.userAgent?.slice(0, 300) ?? null, meta.ip, expires, familyExpires],
  );
  const sid: string = r.rows[0].family_id;
  return {
    accessToken: await signAccessToken(cfg, { sub: userId, sid }),
    refreshToken,
    refreshExpiresAt: expires,
    user: await loadPublicUser(tx, userId),
  };
}

export async function register(
  cfg: Config, db: Db,
  input: { email: string; password: string; fullName: string; phone?: string | undefined },
  meta: RequestMeta,
): Promise<IssuedTokens> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTx(db, async (tx) => {
      const r = await tx.query(
        `insert into users (email, password_hash, full_name, phone) values ($1, $2, $3, $4) returning id`,
        [input.email, passwordHash, input.fullName, input.phone ?? null],
      );
      const userId: string = r.rows[0].id;
      await tx.query(`insert into user_roles (user_id, role_key) values ($1, 'customer')`, [userId]);
      await writeAudit(tx, { actorUserId: userId, action: "user.register", entity: "user", entityId: userId, ip: meta.ip, requestId: meta.requestId });
      return issueSession(cfg, tx, userId, null, meta);
    });
  } catch (e: any) {
    if (e?.code === PG_UNIQUE) {
      // Phone and email are both unique; one message avoids revealing which accounts exist.
      throw Errors.conflict("ACCOUNT_EXISTS", "An account with this email or phone already exists.");
    }
    throw e;
  }
}

export async function login(cfg: Config, db: Db, input: { email: string; password: string }, meta: RequestMeta): Promise<IssuedTokens> {
  const r = await db.query(`select id, password_hash, status from users where email = $1 and deleted_at is null`, [input.email]);
  const u = r.rows[0];
  if (!u) {
    await burnPasswordCheck(input.password);
    throw Errors.invalidCredentials();
  }
  if (!(await verifyPassword(u.password_hash, input.password))) {
    await writeAudit(db, { actorUserId: u.id, action: "auth.login_failed", entity: "user", entityId: u.id, ip: meta.ip, requestId: meta.requestId });
    throw Errors.invalidCredentials();
  }
  if (u.status !== "active") throw Errors.accountSuspended();
  return withTx(db, async (tx) => {
    await writeAudit(tx, { actorUserId: u.id, action: "auth.login", entity: "user", entityId: u.id, ip: meta.ip, requestId: meta.requestId });
    return issueSession(cfg, tx, u.id, null, meta);
  });
}

// Rotates the refresh token. A token that was already rotated or revoked means it was stolen
// or replayed, so the whole login (family) is revoked and the caller must sign in again.
export async function refresh(cfg: Config, db: Db, refreshToken: string, meta: RequestMeta): Promise<IssuedTokens> {
  const outcome = await withTx(db, async (tx) => {
    const r = await tx.query(
      `select s.id, s.family_id, s.family_expires_at, s.user_id, s.expires_at, s.revoked_at, u.status
         from sessions s join users u on u.id = s.user_id
        where s.refresh_token_hash = $1 for update of s`,
      [hashToken(refreshToken)],
    );
    const s = r.rows[0];
    if (!s) return { error: Errors.unauthenticated() };
    if (s.revoked_at) {
      await tx.query(
        `update sessions set revoked_at = now(), revoked_reason = 'reuse_detected' where family_id = $1 and revoked_at is null`,
        [s.family_id],
      );
      await writeAudit(tx, { actorUserId: s.user_id, action: "auth.refresh_reuse_detected", entity: "session", entityId: s.family_id, ip: meta.ip, requestId: meta.requestId });
      return { error: Errors.sessionExpired() };
    }
    if (new Date(s.expires_at) <= new Date()) return { error: Errors.sessionExpired() };
    if (s.status !== "active") return { error: Errors.accountSuspended() };
    await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'rotated' where id = $1`, [s.id]);
    return { tokens: await issueSession(cfg, tx, s.user_id, { id: s.family_id, expiresAt: new Date(s.family_expires_at) }, meta) };
  });
  // Errors are thrown after commit so the reuse revocation is saved.
  if ("error" in outcome) throw outcome.error;
  return outcome.tokens;
}

export async function logout(db: Db, refreshToken: string | undefined, sid: string | null, all: boolean, userId: string | null): Promise<void> {
  if (all && userId) {
    await db.query(`update sessions set revoked_at = now(), revoked_reason = 'logout_all' where user_id = $1 and revoked_at is null`, [userId]);
    return;
  }
  if (sid) {
    await db.query(`update sessions set revoked_at = now(), revoked_reason = 'logout' where family_id = $1 and revoked_at is null`, [sid]);
  }
  if (refreshToken) {
    await db.query(
      `update sessions set revoked_at = now(), revoked_reason = 'logout'
        where family_id = (select family_id from sessions where refresh_token_hash = $1) and revoked_at is null`,
      [hashToken(refreshToken)],
    );
  }
}

// Always succeeds from the caller's view, so it cannot be used to discover accounts.
// MOCK / TEMPORARY: no email provider yet. The token is returned to the caller only when
// DEV_EXPOSE_RESET_TOKEN=true (refused in production). Replace with the notification module.
export async function requestPasswordReset(cfg: Config, db: Db, email: string, meta: RequestMeta): Promise<string | null> {
  const r = await db.query(`select id from users where email = $1 and status = 'active' and deleted_at is null`, [email]);
  const u = r.rows[0];
  if (!u) return null;
  const token = newOpaqueToken();
  await withTx(db, async (tx) => {
    await tx.query(`update password_resets set used_at = now() where user_id = $1 and used_at is null`, [u.id]);
    await tx.query(
      `insert into password_resets (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
      [u.id, hashToken(token), cfg.PASSWORD_RESET_TTL_MINUTES],
    );
    await writeAudit(tx, { actorUserId: u.id, action: "auth.password_reset_requested", entity: "user", entityId: u.id, ip: meta.ip, requestId: meta.requestId });
  });
  return token;
}

export async function resetPassword(db: Db, token: string, newPassword: string, meta: RequestMeta): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await withTx(db, async (tx) => {
    const r = await tx.query(
      `update password_resets set used_at = now()
        where token_hash = $1 and used_at is null and expires_at > now()
        returning user_id`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (!row) throw Errors.badToken();
    await tx.query(`update users set password_hash = $1 where id = $2`, [passwordHash, row.user_id]);
    await tx.query(
      `update sessions set revoked_at = now(), revoked_reason = 'password_reset' where user_id = $1 and revoked_at is null`,
      [row.user_id],
    );
    await writeAudit(tx, { actorUserId: row.user_id, action: "auth.password_reset", entity: "user", entityId: row.user_id, ip: meta.ip, requestId: meta.requestId });
  });
}

export async function changePassword(db: Db, userId: string, current: string, next: string, keepSid: string, meta: RequestMeta): Promise<void> {
  const r = await db.query(`select password_hash from users where id = $1`, [userId]);
  if (!r.rows[0] || !(await verifyPassword(r.rows[0].password_hash, current))) throw Errors.invalidCredentials();
  const passwordHash = await hashPassword(next);
  await withTx(db, async (tx) => {
    await tx.query(`update users set password_hash = $1 where id = $2`, [passwordHash, userId]);
    await tx.query(`update password_resets set used_at = now() where user_id = $1 and used_at is null`, [userId]);
    // Sign out every other device; keep the one that made the change.
    await tx.query(
      `update sessions set revoked_at = now(), revoked_reason = 'password_reset'
        where user_id = $1 and family_id <> $2 and revoked_at is null`,
      [userId, keepSid],
    );
    await writeAudit(tx, { actorUserId: userId, action: "auth.password_changed", entity: "user", entityId: userId, ip: meta.ip, requestId: meta.requestId });
  });
}

export { loadPublicUser };
