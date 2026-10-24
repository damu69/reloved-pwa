// Test web server: serves the PWA files from the repo root exactly as Vercel would (same rewrites, same security
// headers from vercel.json) and forwards /api/* to the API. Only for tests; nothing here is deployed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WEB_PORT ?? 5173);
const API = new URL(process.env.API_URL ?? "http://127.0.0.1:4000");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml" };
// Folders that are not part of the website (Vercel does not serve them either).
const BLOCKED = /^\/(server|e2e|ci|load|mobile|\.git|\.github|node_modules|Claude%20outputs)(\/|$)/i;
const SPA = /^\/(item|c|search|seller|home|discover|sell|inbox|cart|profile)(\/|$|\?)/;

// The same headers production sends, so a change that breaks the Content-Security-Policy fails a test.
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const siteHeaders = Object.fromEntries(((vercel.headers ?? []).find((h) => h.source.startsWith("/((?!api/)")) ?.headers ?? []).map((h) => [h.key, h.value]));

function proxy(req, res) {
  const headers = { ...req.headers, host: API.host };
  // Tests give each browser a fake client address so the API's per-IP limits do not mix tests up.
  headers["x-forwarded-for"] = String(req.headers["x-test-ip"] ?? req.socket.remoteAddress);
  delete headers["x-test-ip"];
  const up = http.request({ host: API.hostname, port: API.port, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end("API unreachable"); });
  req.pipe(up);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) return proxy(req, res);
  if (BLOCKED.test(url.pathname)) { res.writeHead(404); return res.end("Not found"); }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  const inside = file.startsWith(ROOT);
  if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (url.pathname === "/" || SPA.test(url.pathname)) file = path.join(ROOT, "index.html");
    else { res.writeHead(404, siteHeaders); return res.end("Not found"); }
  }
  res.writeHead(200, { ...siteHeaders, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`web on http://localhost:${PORT} -> api ${API.href}`));
