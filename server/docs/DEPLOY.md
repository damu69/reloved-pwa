# Deploying the Reloved API (trial)

The API runs on **Vercel** as a separate project from the live app, using the **existing Supabase
project** for its database and private file storage. Online payments are **paused**
(`PAYMENT_PROVIDER=none`): orders can be placed but not paid, and unpaid orders cancel themselves
after 15 minutes.

Everything the API stores lives in a private schema, `reloved`, which Supabase's public REST API
does not expose. The live app's existing tables are not touched.

## 1. Supabase: database (about 5 minutes)

1. Make up two long passwords (letters and digits only, 32+ characters), one for `reloved_owner`
   and one for `reloved_app`. In Windows PowerShell this prints a new random one each time:

   ```powershell
   $b = New-Object byte[] 36; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) -replace '[+/=]',''
   ```

2. Open `server/db/supabase-setup.sql`, replace `CHANGE_ME_OWNER_PASSWORD` and
   `CHANGE_ME_APP_PASSWORD` with your passwords, then paste the whole file into
   **Supabase → SQL Editor → New query** and press **Run**. Do not save the edited file in the repo.
3. In **Supabase → Connect** (top of the dashboard), choose **Session pooler**. Copy the host, which
   looks like `aws-0-ap-south-1.pooler.supabase.com`. You need it below.

## 2. Supabase: file storage

1. **Storage → New bucket**, name `seller-kyc`, **Public: off**.
2. **Project Settings → API**: copy the **Project URL** and the **service_role** key. The service role
   key is a secret: it goes only into Vercel, never into the app or the repo.

## 3. Vercel: new project for the API

1. **Vercel → Add New → Project**, import the same GitHub repo (`reloved-pwa`).
2. **Root Directory: `server`**. Framework preset: **Other**. Leave the build settings as they are
   (they come from `server/vercel.json`).
3. Before deploying, open **Environment Variables** and add these for **Production**:

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgres://reloved_app.pcvhiqamniurynfdznwt:APP_PASSWORD@POOLER_HOST:5432/postgres` |
| `MIGRATE_DATABASE_URL` | `postgres://reloved_owner.pcvhiqamniurynfdznwt:OWNER_PASSWORD@POOLER_HOST:5432/postgres` |
| `DATABASE_SSL` | `require` |
| `DATABASE_POOL_MAX` | `3` |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `0` (the timeout is set on the database role instead) |
| `JWT_SECRET` | a new random value from the same PowerShell line |
| `DATA_ENCRYPTION_KEY` | 32 random bytes in base64, see below |
| `CRON_SECRET` | another random value from the same PowerShell line |
| `CORS_ORIGINS` | `https://reloved-pwa.vercel.app` |
| `TRUST_PROXY_HOPS` | `1` |
| `STORAGE_DRIVER` | `supabase` |
| `SUPABASE_URL` | `https://pcvhiqamniurynfdznwt.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key |
| `STORAGE_BUCKET` | `seller-kyc` |
| `PAYMENT_PROVIDER` | `none` |

   `DATA_ENCRYPTION_KEY` (PowerShell):

   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
   ```

   Keep a copy of `DATA_ENCRYPTION_KEY` somewhere safe (a password manager): without it, the stored
   PAN and bank account numbers cannot be read again.

4. Press **Deploy**. The build compiles the code and then applies the database migrations (you will
   see `applied 0001_identity.sql` … `done, 10 applied` in the build log). If a migration fails, the
   build fails and nothing changes.
5. Open `https://YOUR-API.vercel.app/health`; it should show `{"status":"ok"}`.

Preview deployments (pushes to other branches) do not run migrations and have no settings, so they
are expected not to work; only Production is used.

## 4. Background jobs (once, after the first deploy)

Vercel functions do not run timers, so Supabase calls the API every minute. In the SQL Editor, run
the commented block at the end of `server/db/supabase-setup.sql` (remove the `--`), with your API
address and `CRON_SECRET` filled in. To check it runs:
`select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;`

## 5. First admin

Register an account through the API (or, later, the app), then in the SQL Editor:

```sql
insert into reloved.user_roles (user_id, role_key)
  select id, 'admin' from reloved.users where email = 'you@example.com' on conflict do nothing;
```

## Trial limits to know

- No payments (paused). No emails: password reset does not work yet.
- Uploads: Vercel accepts request bodies up to 4.5 MB, so photos and documents must be smaller than
  that (the API itself allows 8 MB).
- The free plan's function instances each keep up to 3 database connections; fine for a trial.
- Rate limits are kept per function instance, so they are looser than on a single server.
- Each push to `main` that changes `server/` redeploys the API and applies any new migrations.
