// Shared helpers for the page and sitemap functions. Files starting with "_" are not deployed as endpoints.
const SITE = (process.env.SITE_URL || "https://reloved-pwa.vercel.app").replace(/\/+$/, "");
// The catalogue API itself (the same one the site reaches through the /api rewrite in vercel.json).
const API = (process.env.API_ORIGIN || "https://reloved-pwa-xumb.vercel.app").replace(/\/+$/, "") + "/api/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAT_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;
const COND = { new_with_tags: "New with tags", new: "New", very_good: "Very good", good: "Good", satisfactory: "Satisfactory" };

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function slug(s) { return String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60); }
function itemPath(id, title) { const s = slug(title); return "/item/" + id + (s ? "/" + s : ""); }
function inr(paise) {
  const n = Math.round(Number(paise || 0)) / 100;
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
function clip(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; }
function mediaUrl(pid, imgId, size) { return SITE + "/api/v1/catalogue/media/products/" + pid + "/" + imgId + "/" + size; }

// GET from the catalogue API. Resolves to null on 404, throws on anything else (the caller then serves the plain app).
async function getJson(path) {
  const r = await fetch(API + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("API " + r.status + " for " + path);
  return r.json();
}

module.exports = { SITE, API, UUID_RE, CAT_RE, COND, esc, slug, itemPath, inr, clip, mediaUrl, getJson };
