# Reloved: security hardening and store compliance

Written 2026-10-24. No app is "100% secure"; the goal is to close known gaps, make the rest visible, and keep a checklist. Kubernetes was considered and not adopted: the app runs on Vercel (serverless) with Supabase (managed Postgres), which already provides managed TLS, DDoS absorption and patched infrastructure. Kubernetes would add operations work and new attack surface without fixing any application-level risk. Revisit it only if you outgrow serverless.

## 1. Already in place (verified in the code)

- API: Helmet with deny-all CSP, HSTS in production, strict CORS allow-list, httpOnly refresh cookie, short-lived access token, Argon2 password hashing, Zod input validation, request ids, secret redaction in logs, `no-store` on API responses, body limit 1 MB, upload limit 8 MB.
- Config refuses unsafe production settings (placeholder JWT secret, no DB TLS, mock payments, insecure cookies, local storage).
- Money: idempotent checkout, append-only ledger, signed webhooks, payment confirmation only through the verified path.
- PAN and bank numbers encrypted at rest (`DATA_ENCRYPTION_KEY`); KYC documents in a private bucket.
- PWA: CSP (`script-src 'self'`), `X-Frame-Options`, `nosniff`, Referrer and Permissions policies; service worker never caches `/api/`.
- Account deletion (in app and `/delete-account.html`), report and block, privacy and terms pages, Android shell (Capacitor, `cleartext: false`).

## 2. Changed in this pass

- `server/src/app.ts`, `server/src/lib/config.ts`, `server/.env.example`: the temporary diagnostics (`/debug/client-ip`, `/api/v1/debug/client-ip`, and the `x-debug-error` header that echoed internal error messages) are now OFF unless `DEBUG_DIAGNOSTICS=true`, and the API refuses to start in production with it on. Before this they were reachable by anyone.
- `vercel.json`: added `Strict-Transport-Security` and `Cross-Origin-Opener-Policy: same-origin` to the PWA.

## 3. Still open, in priority order (needs your decision or an account)

1. **Rate limits are per serverless instance.** An attacker can spread requests over instances, so login and register limits are weaker than they look. Fix: Upstash Redis (free tier) behind `@fastify/rate-limit` and `windowLimiter`. Needs an Upstash account and `REDIS_URL`.
2. **Rotate `DATA_ENCRYPTION_KEY`.** It was shared in chat. Re-encrypting stored PAN/bank values needs a small migration script; do it before real sellers upload KYC.
3. **Confirm the Supabase `reloved` schema is not exposed** through the Supabase Data API (Settings, API, Exposed schemas), and that RLS is on for any table in `public` (old `docs` table).
4. **Private bucket `seller-kyc`** and `SUPABASE_SERVICE_ROLE_KEY` check are still marked untested in the build status.
5. **Dependency and secret scanning**: turn on GitHub Dependabot, secret scanning and push protection (repository Settings, Code security). Free. Add CodeQL if you want static analysis.
6. **Email** (Resend) so password reset works without exposing reset tokens; keep `DEV_EXPOSE_RESET_TOKEN=false` in production.
7. **Backups**: confirm Supabase point-in-time recovery (paid plan) or schedule `pg_dump`; test one restore.
8. **Monitoring**: alerts on 5xx rate and login failures (Vercel log drain or Sentry).
9. `style-src 'unsafe-inline'` remains in the PWA CSP because the app uses inline styles; removing it needs a refactor.
10. Before going live with payments: Razorpay webhook secret in env, penetration test, and accountant confirmation of GST/TCS/TDS.

## 4. Google Play checklist (package `com.reloved.app`, MIA Solutions organisation account)

| Item | Status |
| --- | --- |
| Privacy policy URL on a public page | Done (`/privacy.html`) |
| Account deletion in app and on the web, URL entered in Data safety | Done (`/delete-account.html`); enter the URL in Play Console |
| User-generated content: report, block, moderation | Done; keep a moderation SLA and mention it in the listing |
| Data safety form matches real collection (email, name, address, photos, messages, purchase history; encrypted in transit; deletion supported) | Fill from `mobile/store/listing.md` |
| Target API level meets Play's current requirement | Check `mobile/package.json` Capacitor version and `targetSdk` before each upload |
| Signed AAB, Play App Signing | Workflow exists (`android-release.yml`) |
| Payments: physical goods may use Razorpay; Play Billing is only for digital goods | Compliant by design; do not sell digital items or boosts through Razorpay inside the app |
| App access: reviewer test login | Provide in App content |
| Content rating, ads declaration, target audience 18+ | Fill in Play Console |
| New personal accounts: closed test requirement | Organisation account is usually exempt |

## 5. Apple App Store checklist

Needs an Apple Developer Program account (organisation, D-U-N-S), a Mac (or cloud build such as Codemagic or GitHub macOS runners) and the Capacitor iOS project (`npx cap add ios`).

- **Guideline 4.2 minimum functionality:** a plain website wrapper is rejected. Add native value: push notifications, camera for listing photos, share sheet, offline shell. Keep the app clearly more than the website.
- **1.2 user-generated content:** report, block, filtering and a published contact, all present; add a clear terms acceptance at sign-up.
- **5.1.1(v) account deletion** in the app: present.
- **Sign in with Apple** is required only if you add Google or Facebook login. Email and password alone does not need it.
- **Privacy labels** and privacy policy URL in App Store Connect; add `PrivacyInfo.xcprivacy` and declare required-reason APIs used by plugins.
- **3.1.1 payments:** physical goods and services between users can use external payment (Razorpay). No digital goods through it.
- **App Transport Security:** HTTPS only (already true). Provide a demo account for review.
- Photo, camera and notification permission strings in `Info.plist` must explain the purpose in plain words.

## 6. Where your input is needed

Pick which open items in section 3 to do next. Items 1, 5 and 7 give the most protection for the least effort.
