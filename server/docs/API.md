# Reloved API v1

Base path `/api/v1`. JSON only. Every response carries an `x-request-id` header.

## Conventions

**Errors** always look like this:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Some fields are invalid.", "details": [{ "path": "email", "message": "Invalid email address" }], "requestId": "…" } }
```

| Status | Codes |
| --- | --- |
| 400 | `VALIDATION_FAILED`, `BAD_REQUEST`, `INVALID_TOKEN` |
| 401 | `UNAUTHENTICATED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN`, `ACCOUNT_SUSPENDED` |
| 404 | `NOT_FOUND` (also used for records you may not see, so ids cannot be probed) |
| 409 | `ACCOUNT_EXISTS`, `LAST_ADMIN`, `APPLICATION_EXISTS`, `STORE_NAME_TAKEN`, `GSTIN_IN_USE`, `TOO_MANY_DOCUMENTS` |
| 413 / 415 | `FILE_TOO_LARGE` / `UNSUPPORTED_FILE_TYPE` |
| 422 | `INVALID_TRANSITION`, `APPLICATION_INCOMPLETE`, `DOCUMENTS_NOT_ACCEPTED`, `BANK_ACCOUNT_MISSING`, `BANK_PROOF_REQUIRED` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` (no internal details; quote the requestId to support) |

**Authentication.** `Authorization: Bearer <accessToken>` (15 minutes). The refresh token is an
httpOnly cookie `rl_rt` scoped to `/api/v1/auth`. Cookie routes (`/auth/refresh`, `/auth/logout`) also
need the header `X-Requested-With: reloved`, and the browser's Origin must be in `CORS_ORIGINS`.
Call fetch with `credentials: "include"`.

**Pagination.** `?limit=20&cursor=…`; responses are `{ "items": [...], "nextCursor": "…" | null }`.

## Auth

| Method and path | Body | Result | Limits |
| --- | --- | --- | --- |
| `POST /auth/register` | `email`, `password` (10–128), `fullName`, `phone?` | 201 `{ user, accessToken, expiresIn }` + cookie | 5 per 15 min per IP |
| `POST /auth/login` | `email`, `password` | 200 same as above | 10 per 15 min per IP+email; 30 per 15 min per IP |
| `POST /auth/refresh` | none (cookie) | 200 new tokens; old refresh token is now dead | 60 per 15 min per IP |
| `POST /auth/logout` | none (cookie) | 204; this login is revoked | |
| `POST /auth/logout-all` | none, Bearer | 204; every login of this user is revoked | |
| `POST /auth/password/forgot` | `email` | 202 always, same timing either way | 5 per 15 min per IP+email; 15 per IP |
| `POST /auth/password/reset` | `token`, `password` | 204; all sessions revoked | 10 per 15 min per IP |
| `POST /auth/password/change` | `currentPassword`, `newPassword`, Bearer | 204; other sessions and reset links revoked | |

Replaying a refresh token that was already used revokes that whole login and returns 401 `SESSION_EXPIRED`.
A login lasts at most `SESSION_MAX_DAYS` (90) however often it is refreshed.

## Me

| Method and path | Result |
| --- | --- |
| `GET /me` | `{ user: { id, email, fullName, phone, roles }, permissions: [...] }` |
| `PATCH /me` | body `{ fullName }`, returns `{ user }` |

## Admin

All need a Bearer token and the listed permission (held by the `admin` role).

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /admin/users?q&status&role&limit&cursor` | `admin.users.read` | Search by email or name |
| `POST /admin/users/:id/roles` body `{ role }` | `admin.roles.manage` | `customer`, `seller`, `admin`; audited |
| `DELETE /admin/users/:id/roles/:role` | `admin.roles.manage` | Cannot remove your own admin role or the last admin; audited |
| `POST /admin/users/:id/suspend` body `{ reason }` | `admin.users.manage` | Revokes all their sessions at once; audited |
| `POST /admin/users/:id/reactivate` body `{ reason }` | `admin.users.manage` | Audited |
| `GET /admin/audit-logs?entity&entityId&actorUserId&action&from&to&limit&cursor` | `admin.audit.read` | Newest first |

## Seller (signed-in user, own application only)

Status flow: `draft` → `submitted` → `approved`, or back to `changes_requested` (seller edits and resubmits),
or `rejected`. Approved sellers can be `suspended` and `reinstated`. The `seller` role exists only while approved.

| Method and path | Body | Notes |
| --- | --- | --- |
| `POST /seller/application` | `displayName` (store name, unique), `businessName`, `businessType`, `pan`, `gstin?`, `addressLine1`, `addressLine2?`, `city`, `state`, `pincode`, `contactPhone` | 201. GSTIN must contain the PAN. PAN stored encrypted, shown as `XXXXXX1234` |
| `GET /seller/application` | | Status, masked identifiers, documents, bank accounts, history, `missing` requirements |
| `PATCH /seller/application` | any of the fields above | Only in `draft` or `changes_requested`. Changing PAN, GSTIN, business or address sends the matching accepted documents back to pending |
| `PUT /seller/bank-account` | `accountHolderName`, `accountNumber`, `accountNumberConfirm`, `ifsc` | Encrypted, shown as `XXXX1234`. After approval the new account stays pending until an admin verifies it with a fresh bank proof |
| `POST /seller/documents?docType=` | multipart/form-data, one `file` part | `pan_card`, `gst_certificate`, `address_proof`, `bank_proof`, `other`. PDF, JPEG, PNG or WebP by content, max 5 MB, max 20 kept. After approval only `bank_proof` |
| `DELETE /seller/documents/:id` | | Only while editable |
| `GET /seller/documents/:id/file` | | Download your own document |
| `POST /seller/application/submit` | | 422 `APPLICATION_INCOMPLETE` lists what is missing |

## Admin: sellers

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /admin/sellers?status&q&limit&cursor` | `admin.sellers.read` | |
| `GET /admin/sellers/:id` | `admin.sellers.read` | Masked identifiers, documents, bank accounts, history with actors |
| `GET /admin/sellers/:id/sensitive` | `admin.sellers.documents` | Full PAN and account numbers; audited |
| `GET /admin/sellers/:id/documents/:docId/file` | `admin.sellers.documents` | Audited |
| `POST /admin/sellers/:id/documents/:docId/review` | `admin.sellers.manage` | `{ decision: accepted or rejected, note }`; note required to reject |
| `POST /admin/sellers/:id/approve` | `admin.sellers.manage` | Needs every required document accepted; verifies the bank account; grants the seller role |
| `POST /admin/sellers/:id/request-changes`, `/reject`, `/suspend`, `/reinstate` | `admin.sellers.manage` | `{ reason }` required |
| `POST /admin/sellers/:id/bank-accounts/:bankId/review` | `admin.sellers.manage` | After approval only; verifying needs an accepted bank proof uploaded after the account was entered |

Admins can never act on their own seller account (403). Every action is in the audit log and the seller's status history.

## Health

`GET /health` (process alive) and `GET /ready` (database reachable, 503 if not).
