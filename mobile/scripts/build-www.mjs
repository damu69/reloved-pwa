// Copies the website into mobile/www so the app ships with its own screens (no live site inside the app).
// Run before every `cap sync`. Skips files the app does not need.
import fs from "node:fs";
import path from "node:path";
// In the repository the website sits at the repo root (this folder is ../mobile); locally it may be ../web.
const src = fs.existsSync(path.resolve("..", "index.html")) ? path.resolve("..") : path.resolve("..", "web"), dst = path.resolve("www");
// Only the files the app uses (the repo root also holds server/, mobile/, sql files and so on).
const files = ["index.html", "config.js", "api.js", "app.js", "seller.js", "admin.js", "swipe.js", "safety.js", "showcase.js", "theme.js", "styles.css",
  "privacy.html", "terms.html", "delete-account.html", "icon-192.png", "icon-512.png"];
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of files) { fs.copyFileSync(path.join(src, f), path.join(dst, f)); n++; }
// the service worker and install manifest are for the website only
let html = fs.readFileSync(path.join(dst, "index.html"), "utf8");
html = html.replace(/<link[^>]+rel="manifest"[^>]*>\s*/g, "");
fs.writeFileSync(path.join(dst, "index.html"), html);
console.log(`www: copied ${n} files from ${path.relative(process.cwd(), src) || "."}`);
