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
| 5 | Search: full text with typo tolerance (English and Indian scripts), filters, sorting, cursor pagination | Done |
| 6 | Inventory: warehouses, stock counters, checkout holds that expire, no overselling, stock history, availability in search | Done |
| 7 | Cart, pricing engine, coupons, wishlist, admin fee settings | Done |
| 8 | Addresses, idempotent checkout, multi-seller orders with frozen amounts, payment confirmation path, unpaid-order expiry, fulfilment steps | Done |
| 9 | Commission rules (product > seller > category > default), commission frozen per order line, append-only double-entry ledger, seller balances with a 14-day hold | Done |
| 10 | Payments: provider interface with a MOCK provider, Razorpay later | Next |
| 11+ | Refunds and cancellations, notifications, payouts, dashboards | Planned |

The existing PWA at the repo root still talks to Supabase directly. It moves to this API
module by module; nothing in the live app changes yet.

### MOCK / TEMPORARY items in this folder

| Item | Where | Replace before production with |
| --- | --- | --- |
| Password-reset token returned in the API response | `DEV_EXPOSE_RESET_TOKEN`, `auth/service.ts` | Email via the notification module. The server refuses to start in production with this on. |
| In-memory rate limits | `app.ts`, `lib/limiter.ts` | Redis store, once more than one API instance runs |
| Supabase Storage driver not yet run against a live project | `lib/storage.ts` | Verify on staging with a private bucket before go-live |
| Expiry of unpaid stock holds and leftover search refreshes run on a 60-second timer inside the API process | `server.ts` | Job queue (Redis + BullMQ) |
| A checkout takes each item from one warehouse (no splitting one item across warehouses) | `inventory/service.ts` | Split reservations if sellers need it |
| Photos are processed during the upload request | `lib/images.ts` | Background job queue (Redis + BullMQ) when upload volume grows |
| Photos are served by the API with a 1-hour cache | `catalogue/routes.ts` | A CDN in front of storage |
| Files of removed photos and documents stay in storage | `catalogue/products.ts`, `sellers/service.ts` | A cleanup job |
| GST rates seeded as 0, 3, 5, 18, 40% | `migrations/0003_catalogue.sql` | Confirm with the accountant; admins can add or disable rates |
| No real payment yet: orders wait for the payment window and are then cancelled; `confirmPayment` is called only by tests until step 10 | `orders/service.ts` | Razorpay (step 10) |
| Paid orders and packages cannot be cancelled yet | `orders/service.ts` | Refunds and cancellations (step 11) |
| Outbox events are written but not yet delivered | `outbox_events` | Notifications (step 12) |
| Payouts to sellers' bank accounts are not built; `paidOutPaise` is always 0 | `finance/ledger.ts` | Payouts module |
| No GST on commission or on the Buyer Protection fee; no GST TCS (section 52) or income-tax TDS (194-O) withheld from sellers | `finance/service.ts` | Confirm with the accountant before launch |
| Earnings are released 14 days after payment even if the package has not shipped or has an open complaint | `finance/service.ts` | Hold on open returns and disputes (step 11) |
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
instant audited price changes, archive, block, seller suspension and public visibility; and search:
matching across fields, Hindi text, typos, unsafe input, filters, every sort order paged with ties,
microsecond timestamps, concurrent edits and suspensions, and 10,000-product timings; and inventory:
50 buyers for the last unit, 30 buyers for 10 units, crossed-order checkouts without deadlocks,
expiry sweeps running in parallel, late payments after expiry, stale exact counts, returns and
restocking, warehouse switches, append-only stock history, and admin adjustments; and the cart:
the pricing engine (2,000 random orders always add up), per-seller delivery, Buyer Protection once
per order, coupon scope, caps, minimums, expiry and limits, live price and stock re-checks, guessing
limits, admin fee changes, and concurrency on cart size and delivery options; and orders:
idempotent checkout (replays, reused keys, five parallel checkouts), the total the buyer saw,
one unpaid order at a time, last-unit and single-use-coupon races, frozen and database-guarded
amounts, payment confirmation and its repeat, unpaid expiry and late payment, per-customer coupon
limits, strict fulfilment steps, two sellers shipping at once, and seller/customer/admin access; and
finance: rule precedence and rounding, rules frozen on orders, overlapping and self-serving rules
refused, gap-free default changes, balanced and append-only ledger postings, coupon cost on the
platform, the 14-day hold and its release (once, even when run twice at once), and checkout
stopping when no commission rule is in force.

All money in the API is integer paise in Indian rupees (INR); prices include GST.
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
