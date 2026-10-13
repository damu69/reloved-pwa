# Publishing Reloved on Google Play: step by step

Written for a Windows computer and GitHub Desktop. Fees and Google's rules change, so check the amounts and
requirements on the Play Console pages as you go.

## 0. What is already done for you
Android shell, icons, store graphics and listing text, account deletion (in the app and at /delete-account.html),
report and block, forgot-password email, Privacy Policy and Terms pages, and a GitHub workflow that builds the app.

## 1. Switch on forgot-password email (10 minutes)
Without this, the "Forgot password?" link will not send anything.
1. Create an account at resend.com and add your sending domain (it shows DNS records to add).
2. Create an API key.
3. In Vercel, open the **API project** (reloved-pwa-xumb), Settings, Environment Variables, and add:
   - `RESEND_API_KEY` = the key
   - `EMAIL_FROM` = for example `Reloved <no-reply@yourdomain.com>` (must be on the verified domain)
   - `APP_URL` = `https://reloved-pwa.vercel.app`
4. Redeploy the API project. Test: use Forgot password with your own email.

## 2. Create your Google Play developer account (MIA Solutions)
1. Go to play.google.com/console and sign up as an **Organization**.
2. You will pay a one-time registration fee and must verify the organisation (a D-U-N-S number is usually
   required) and your identity. Verification can take days, so start this now.
3. Keep the contact email and phone current; Google uses them for review messages.

## 3. Make your upload key (once, and keep it safe)
On your computer, in a terminal where Java is installed (or run it later from Android Studio's terminal):

```
keytool -genkeypair -v -storetype PKCS12 -keystore reloved-upload.keystore -alias reloved -keyalg RSA -keysize 2048 -validity 10000
```

Choose a strong password and remember the alias (`reloved`). **Back up the .keystore file and the passwords
in a password manager.** Do not commit the file to GitHub. If you lose it you can ask Google to reset the upload
key, but it is a hassle.

Turn the file into text so GitHub can store it (PowerShell):

```
[Convert]::ToBase64String([IO.File]::ReadAllBytes("reloved-upload.keystore")) | Set-Clipboard
```

## 4. Add four secrets in GitHub
Repository on github.com, Settings, Secrets and variables, Actions, New repository secret:

| Name | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the text you just copied |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `reloved` |
| `ANDROID_KEY_PASSWORD` | the key password (same as the keystore password if you were only asked once) |

## 5. Build the app
1. Push everything in GitHub Desktop (Commit to main, Push origin).
1b. **Add the build workflow (one time).** Claude cannot write into the `.github` folder, so do this by hand: on github.com
   open your repository, Add file, Create new file, and type `.github/workflows/android-release.yml` as the name
   (typing the slashes creates the folders). Open `mobile/android-release.yml` from your computer, copy all of it, paste it
   into the new file, and click Commit changes. Then Pull in GitHub Desktop to bring it down.
2. On github.com open the repository, Actions, **Android app**, Run workflow. Version name `1.0.0`, version code `1`.
   Every later upload to Google Play needs a higher version code (2, 3, ...).
3. Wait about 10 minutes. Open the finished run and download the artifacts:
   - `reloved-debug-apk`: install this on your Android phone to try the app first.
   - `reloved-release-aab`: the signed file you upload to Google Play.
4. If the run fails, copy the red error text from the failing step and send it to me.

## 6. Create the app in Play Console
1. Create app: name "Reloved: Pre-owned Fashion", English (India), App, Free.
2. Set up your app, App content. Fill every section using `store/listing.md`:
   privacy policy URL, app access (give a reviewer login), ads (No), content rating, target audience (18+),
   data safety, financial features, and the account deletion URL.
3. Main store listing: paste the descriptions and upload `store/icon-512.png`, `store/feature-graphic-1024x500.png`
   and the screenshots.
4. Opt in to **Play App Signing** when asked. Google keeps the final signing key; your keystore becomes the upload key.

## 7. Test, then release
1. Testing, Internal testing: create a release, upload `app-release.aab`, add your own email as a tester, and install
   from the link. Try sign-up, browsing, swiping, chat, reporting, deleting a test account.
2. If your developer account is a **new personal account**, Google may require a closed test with a minimum number of
   testers for about 14 days before production. A verified organisation account is often exempt. Play Console shows
   what applies to you.
3. Production: Create release, upload the same `.aab`, add release notes, submit for review.
   Review usually takes a few days; the first one can take longer.

## 8. Before you ask for production access
Google reviewers test the app like a customer. Make sure:
- **Payments work** (Razorpay is not built yet). An app where checkout cannot complete is likely to be rejected or
  to get poor reviews. Tell me when you have Razorpay test keys and I will build it.
- The reviewer login works and there are real-looking listings with photos.
- The demo seller data has been replaced or is clearly labelled (run `server/db/demo-remove.sql` when ready).
- The contact email in the Privacy Policy is one you actually read.

## 9. Updating later
- Website changes (screens, fixes): push to GitHub. Vercel updates the site and the app picks it up at once.
- Native changes (icon, version, plugins): bump the version code and run the workflow again, then upload the new `.aab`.

## What I could not do for you
Create your Play Console and GitHub secrets, run Google's verification, test on a physical Android phone, or
check that the GitHub workflow builds. I tested the Android project setup and icon generation, but the actual Gradle
build only runs on GitHub, so expect that the first run may need one small fix.
