# Reloved API (server)

Backend for the Reloved marketplace. Node.js 22, TypeScript, Fastify 5, PostgreSQL 16.
The design is in the "Reloved Marketplace: Production Design Pack" doc; this folder implements
it module by module.

## Status

| Step | Module | State |
| --- | --- | --- |
| 1 | Scaffold: config, logging, error format, migrations, health checks, CI | Done |
| 2 | Auth, roles, permissions, sessions, audit log, admin user management | Done |
| 3 | Sellers and KYC | Next |
| 4+ | Catalogue, search, inventory, cart, checkout, ledger, payments (MOCK), refunds, notifications, dashboards | Planned |

The existing PWA at the repo root still talks to Supabase directly. It moves to this API
module by module; nothing in the live app changes yet.

### MOCK / TEMPORARY items in this folder

| Item | Where | Replace before production with |
| --- | --- | --- |
| Password-reset token returned in the API response | `DEV_EXPOSE_RESET_TOKEN`, `auth/service.ts` | Email via the notification module. The server refuses to start in production with this on. |
| In-memory rate limits | `app.ts`, `lib/limiter.ts` | Redis store, once more than one API instance runs |

## Run locally

1. Install Node 22 and PostgreSQL 16 (or use Docker: `docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`).
2. `cd server && npm install`
3. Create a database: `createdb reloved` (or `psql -c "create database reloved"`).
4. `cp .env.example .env`, then set `JWT_SECRET` (the file shows how to generate one).
5. `npm run migrate`
6. `npm run dev`, then open http://localhost:4000/health
7. Make yourself an admin: register through `POST /api/v1/auth/register`, then `npm run grant-admin -- you@example.com`.

## Tests

Tests run against a real PostgreSQL; each test file creates and drops its own database.

```
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

They cover registration, login, refresh-token rotation and replay detection, logout, password
reset and change, expired tokens, CSRF checks, rate-limit bypass attempts, RBAC and privilege
escalation, admin self-protection, suspension revoking live tokens, cursor pagination, the
append-only audit log, error formats, and production config refusals.
CI runs them on every push that touches `server/` (`.github/workflows/server-ci.yml`).

## Deploy (when ready)

- Host the API as a Node service (Render, Railway, Fly.io) with `npm ci && npm run build`, start `npm start`.
- Run `npm run migrate` as a release step before the new version starts; migrations are forward-only.
- Use the Supabase Postgres connection string with `DATABASE_SSL=require` (or `verify-full` plus `DATABASE_CA_CERT`).
- Then run `db/app-role.sql` once and point `DATABASE_URL` at the limited `reloved_app` role.
- Set `NODE_ENV=production`, a fresh `JWT_SECRET`, `COOKIE_SECURE=true`, `CORS_ORIGINS=https://reloved-pwa.vercel.app`, `TRUST_PROXY_HOPS=1`.
- Rollback: redeploy the previous build. Migrations only add things, so the previous build still works with the newer schema.

The server refuses to start in production if the mock reset token is on, cookies are insecure,
the database connection is unencrypted, CORS allows localhost or http, or the JWT secret looks like a placeholder.

API reference: `docs/API.md`.
