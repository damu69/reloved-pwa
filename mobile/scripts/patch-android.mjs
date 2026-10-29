// Adjusts the generated Android project: version numbers from the environment and release signing.
// Run after `cap add android`. Safe to run more than once.
import fs from "node:fs";
const f = "android/app/build.gradle";
let s = fs.readFileSync(f, "utf8");
const code = parseInt(process.env.VERSION_CODE || "1", 10), name = process.env.VERSION_NAME || "1.0.0";
s = s.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${name}"`);
if (!s.includes("signingConfigs")) {
  s = s.replace("    buildTypes {", `    signingConfigs {
        release {
            def ks = System.getenv("KEYSTORE_PATH")
            if (ks) {
                storeFile file(ks)
                storePassword System.getenv("KEYSTORE_PASSWORD")
                keyAlias System.getenv("KEY_ALIAS")
                keyPassword System.getenv("KEY_PASSWORD")
            }
        }
    }
    buildTypes {`).replace("        release {\n            minifyEnabled false", "        release {\n            signingConfig signingConfigs.release\n            minifyEnabled false");
}
fs.writeFileSync(f, s);

// The Facebook sign-in library adds the advertising-ID permission. Reloved shows no ads and does not use the advertising ID,
// so it is removed: otherwise Play Console asks for an advertising-ID declaration and the Data safety form would be wrong.
const mf = "android/app/src/main/AndroidManifest.xml";
let m = fs.readFileSync(mf, "utf8");
if (!m.includes("permission.AD_ID")) {
  if (!m.includes('xmlns:tools=')) m = m.replace("<manifest ", '<manifest xmlns:tools="http://schemas.android.com/tools" ');
  m = m.replace("</manifest>", '    <uses-permission android:name="com.google.android.gms.permission.AD_ID" tools:node="remove" />\n</manifest>');
  fs.writeFileSync(mf, m);
}
console.log(`android/app/build.gradle: versionCode ${code}, versionName ${name}, release signing from environment`);
