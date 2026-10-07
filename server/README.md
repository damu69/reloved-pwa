# Reloved API (server)

Backend for the Reloved marketplace. Node.js 22, TypeScript, Fastify 5, PostgreSQL 16.
The design is in the "Reloved Marketplace: Production Design Pack" doc; this folder implements
it module by module.

## Status

| Step | Module | State |
| --- | --- | --- |
| 1 | Scaffold: config, logging, error format, migrations, health checks, CI | Done |
| 2 | Auth, roles, permissions, sessions, audit log, admin user management | Done |
| 3 | Seller applications, KYC documents, bank accounts, admin review | Done |
| 4 | Catalogue: categories, brands, GST rates, products, variants, photos, review of new products and of edits to live ones | Done |
| 5 | Search and filters | Next |
| 4+ | Catalogue, search, inventory, cart, checkout, ledger, payments (MOCK), refunds, notifications, dashboards | Planned |

The existing PWA at the repo root still talks to Supabase directly. It moves to this API
module by module; nothing in the live app changes yet.

### MOCK / TEMPORARY items in this folder

| Item | Where | Replace before production with |
| --- | --- | --- |
| Password-reset token returned in the API response | `DEV_EXPOSE_RESET_TOKEN`, `auth/service.ts` | Email via the notification module. The server refuses to start in production with this on. |
| In-memory rate limits | `app.ts`, `lib/limiter.ts` | Redis store, once more than one API instance runs |
| Supabase Storage driver not yet run against a live project | `lib/storage.ts` | Verify on staging with a private bucket before go-live |
| Photos are processed during the upload request | `lib/images.ts` | Background job queue (Redis + BullMQ) when upload volume grows |
| Photos are served by the API with a 1-hour cache | `catalogue/routes.ts` | A CDN in front of storage |
| Files of removed photos and documents stay in storage | `catalogue/products.ts`, `sellers/service.ts` | A cleanup job |
| GST rates seeded as 0, 3, 5, 18, 40% | `migrations/0003_catalogue.sql` | Confirm with the accountant; admins can add or disable rates |
| Required KYC documents are a default (PAN card, address proof, bank proof, GST certificate if GSTIN given) | `sellers/rules.ts` | Confirm with the business / accountant |

## Run locally

1. Install Node 22 and PostgreSQL 16 (or use Docker: `docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`).
2. `cd server && npm install`
3. Create a database: `createdb reloved` (or `psql -c "create database reloved"`).
4. `cp .env.example .env`, then set `JWT_SECRET` and `DATA_ENCRYPTION_KEY` (the file shows how to generate them).
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
append-only audit log, error formats, production config refusals, and the seller flow: application
validation, encrypted PAN and bank numbers, upload type and size checks, document access control,
submission locking, document review, approval races, re-review after edits, role sync on suspend,
bank account changes after approval, and self-review protection; and the catalogue: leaf categories,
GST rates, SKU and option rules, photo type, size, metadata stripping and caps, cross-seller access,
submission and review, edits to live products waiting as versioned pending changes, stale approvals,
instant audited price changes, archive, block, seller suspension and public visibility.
CI runs them on every push that touches `server/`. To turn CI on, move `server/ci/server-ci.yml` to
`.github/workflows/server-ci.yml` (in File Explorer or on github.com) and commit it.

## Deploy (when ready)

- Host the API as a Node service (Render, Railway, Fly.io) with `npm ci && npm run build`, start `npm start`.
- Run `npm run migrate` as a release step before the new version starts; migrations are forward-only.
- Use the Supabase Postgres connection string with `DATABASE_SSL=require` (or `verify-full` plus `DATABASE_CA_CERT`).
- Then run `db/app-role.sql` once and point `DATABASE_URL` at the limited `reloved_app` role.
- Create a PRIVATE Supabase Storage bucket `seller-kyc`; set `STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Set a fresh `DATA_ENCRYPTION_KEY` and store a backup copy outside the hosting platform.
- Set `NODE_ENV=production`, a fresh `JWT_SECRET`, `COOKIE_SECURE=true`, `CORS_ORIGINS=https://reloved-pwa.vercel.app`, `TRUST_PROXY_HOPS=1`.
- Rollback: redeploy the previous build. Migrations only add things, so the previous build still works with the newer schema.

The server refuses to start in production if the mock reset token is on, cookies are insecure,
the database connection is unencrypted, CORS allows localhost or http, or the JWT secret looks like a placeholder.

API reference: `docs/API.md`.
