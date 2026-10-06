import type { FastifyReply, FastifyRequest } from "fastify";
import { Errors } from "../../lib/errors.js";
import { verifyAccessToken } from "./tokens.js";

export interface AuthContext {
  userId: string;
  sid: string;
  roles: string[];
  permissions: Set<string>;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

// Verifies the bearer token, then checks in ONE query that the user is active, the session
// is not revoked, and loads current roles and permissions.
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) throw Errors.unauthenticated();
  const claims = await verifyAccessToken(req.server.cfg, h.slice(7));
  const r = await req.server.db.query(
    `select u.status,
            exists (select 1 from sessions s where s.family_id = $2 and s.user_id = u.id
                     and s.revoked_at is null and s.expires_at > now()) as session_ok,
            coalesce(array_agg(distinct ur.role_key) filter (where ur.role_key is not null), '{}') as roles,
            coalesce(array_agg(distinct rp.permission_key) filter (where rp.permission_key is not null), '{}') as perms
       from users u
       left join user_roles ur on ur.user_id = u.id
       left join role_permissions rp on rp.role_key = ur.role_key
      where u.id = $1 and u.deleted_at is null
      group by u.id`,
    [claims.sub, claims.sid],
  );
  const row = r.rows[0];
  if (!row || !row.session_ok) throw Errors.sessionExpired();
  if (row.status !== "active") throw Errors.accountSuspended();
  req.auth = { userId: claims.sub, sid: claims.sid, roles: row.roles, permissions: new Set(row.perms) };
}

// Route-level permission check. Always used together with authenticate.
export function requirePermission(...perms: string[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.auth) throw Errors.unauthenticated();
    for (const p of perms) if (!req.auth.permissions.has(p)) throw Errors.forbidden();
  };
}
