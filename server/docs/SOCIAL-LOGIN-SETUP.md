# Sign in with Google and Facebook: setup

Google and Meta rename menu items now and then; if a label below is not exactly there, look for the closest one.

The code is finished. Each provider turns on by itself when its settings exist in the API project on Vercel
(`reloved-pwa-xumb`); until then the buttons stay hidden. You can enable Google first and Facebook later.

Your site address below is `https://reloved-pwa.vercel.app`. Everything goes through that address, because
`vercel.json` forwards `/api/*` to the API.

## 1. Google

1. https://console.cloud.google.com -> create or pick a project (name it Reloved) -> **APIs & Services -> OAuth consent screen**.
   User type **External**. App name Reloved, support email, logo optional. Links: privacy `https://reloved-pwa.vercel.app/privacy.html`, terms `/terms.html`. Under Authorized domains add `reloved-pwa.vercel.app` (Google's Branding page requires it; no Search Console verification is needed for the basic scopes). Scopes: `openid`, `email`, `profile` only (these need no Google review). Press **Publish app**
   (Testing mode only lets 100 listed test users in).
2. **Credentials -> Create credentials -> OAuth client ID -> Web application**, name `Reloved web`.
   - Authorized redirect URI: `https://reloved-pwa.vercel.app/api/v1/auth/social/google/callback` (exactly this).
   - Authorized JavaScript origins: not needed.
   - Copy the **Client ID** and **Client secret**.
3. For the Android app, create a second client: **OAuth client ID -> Android**, name `Reloved Android`,
   package `com.reloved.app`, and the **SHA-1** of the key that signs the app. Make one Android client per key you test with:
   - your upload key (`keytool -list -v -keystore <your keystore>`),
   - the **Play app signing** key (Play Console -> Setup -> App signing -> SHA-1 of "App signing key certificate"),
     which is what people who install from Google Play actually run,
   - the debug key of the APK from GitHub Actions if you test that file.
   The Android client has no secret and its ID is **not** used anywhere in Reloved; Google only checks that package + SHA-1 match.
   The app signs in with the **Web** client ID above.

Vercel (API project) -> Settings -> Environment Variables, then redeploy:

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | the Web client ID |
| `GOOGLE_CLIENT_SECRET` | the Web client secret (mark Sensitive) |

## 2. Facebook

1. https://developers.facebook.com -> **Create app** -> use case **Authenticate and request data from users with Facebook Login**
   -> app type Consumer (or whatever it offers for Login). Name Reloved.
2. **App settings -> Basic**: Privacy Policy URL `https://reloved-pwa.vercel.app/privacy.html`; User data deletion:
   choose "Data deletion instructions URL" = `https://reloved-pwa.vercel.app/delete-account.html`; category Shopping;
   copy **App ID** and **App secret**. **Settings -> Advanced -> Client token**: copy it (it is not secret; the app embeds it).
3. **Facebook Login -> Settings**: Valid OAuth Redirect URIs: `https://reloved-pwa.vercel.app/api/v1/auth/social/facebook/callback`.
   Keep "Client OAuth login" and "Web OAuth login" on.
4. **Add platform -> Android** (for the app): package `com.reloved.app`, class name `com.reloved.app.MainActivity`,
   and **Key hashes**: the base64 SHA-1 of each signing key (for Play app signing: Play Console SHA-1 -> base64, e.g.
   `echo <hex without colons> | xxd -r -p | base64`). Single sign-on on.
5. **App roles / Roles -> Testers** while the app is in Development mode: only people you add can sign in. To let everyone in,
   switch the app to **Live**. `public_profile` and `email` work without App Review, but Meta usually asks for
   **Business verification** or a data-use checklist before going Live; do that in the app dashboard.

Vercel (API project):

| Name | Value |
| --- | --- |
| `FACEBOOK_APP_ID` | App ID |
| `FACEBOOK_APP_SECRET` | App secret (Sensitive) |
| `FACEBOOK_CLIENT_TOKEN` | Client token (needed for the Android app; the website works without it) |

## 3. Other settings to check

- `APP_URL` on the API project must be `https://reloved-pwa.vercel.app` (it is used to build the redirect addresses above).
- The migration `0014_social_login.sql` runs automatically on the next deploy of the API (`MIGRATE_DATABASE_URL` is already set).
- The Android app needs **one new Play upload** (higher version code) because the plugin is native and the screens are bundled.
  `https://localhost` is already in `CORS_ORIGINS` for the app.
- Google Play -> Data safety: the sentence about sign-in is added in `mobile/store/listing.md`; the privacy page already mentions Google/Facebook.
- Apple App Store (later): an iOS app offering Google/Facebook sign-in must also offer **Sign in with Apple**.

## 4. How it behaves

- Website: the button opens Google/Facebook in the same tab; the server checks the answer (state, nonce, PKCE for Google) and sends the person
  back to the site signed in. No Google/Facebook script runs on Reloved pages, so the Content-Security-Policy and the ZAP gate are unchanged.
- Android app: the phone's own Google/Facebook sign-in returns a token; the app sends it to `POST /api/v1/auth/social/:provider/token`
  and the server verifies it (Google signature, audience and expiry; Facebook `debug_token` must say it was issued to our app).
- A person who signs in with the same **Google** email as an existing Reloved account is attached to it. Google vouches for the email.
  Reloved never verified emails at registration, so if the existing account's email was never verified, its **old password and old sessions are removed**
  (someone else could have registered that email). The owner uses Google, or "Forgot your password?", afterwards.
  To change this to "always keep the password", edit the `if (!existing.email_verified_at)` block in `server/src/modules/auth/social.ts`.
- **Facebook** never attaches by email. If the email already has an account, the person is told to sign in with the password and press
  **Connect** next to Facebook in Settings.
- Facebook sometimes returns no email; the person is asked to allow it or use email sign-up.
- People without a password delete their account by typing DELETE; they can add a password from Settings (email link).
