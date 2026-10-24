(function () {
"use strict";
/* ============ helpers ============ */
var INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
function inr(paise) { var n = Math.round(Number(paise || 0)) / 100; return n % 1 ? INR.format(n).replace(/(\.\d)$/, "$10") : INR.format(n); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function when(iso) { try { return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return ""; } }
function $(id) { return document.getElementById(id); }
function val(id) { var e = $(id); return e ? e.value.trim() : ""; }
function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
var COND = { new_with_tags: "New with tags", "new": "New", very_good: "Very good", good: "Good", satisfactory: "Satisfactory" };
var ORDER_ST = { pending_payment: "Awaiting payment", confirmed: "Confirmed", processing: "Being packed", partially_shipped: "Partly shipped", shipped: "Shipped", out_for_delivery: "Out for delivery", partially_delivered: "Partly delivered", delivered: "Delivered", cancelled: "Cancelled" };
function stLabel(s) { return ORDER_ST[s] || String(s || "").replace(/_/g, " "); }
function stClass(s) { return s === "delivered" ? "ok" : s === "cancelled" ? "bad" : "prog"; }
function variantLabel(o) { var v = o && Object.keys(o).map(function (k) { return o[k]; }); return v && v.length ? v.join(" / ") : "Standard"; }
function hueOf(s) { var h = 0; s = String(s || ""); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
var TONES = ["#3a342e", "#32382f", "#2f353b", "#3b3135", "#3b3829", "#2d3a37", "#3a2f2b", "#33313f"];
var ICONS = {
  tee: "M21 10l-13 8 6 9 7-4v27h20V23l7 4 6-9-13-8c-2 4-6 6-10 6s-8-2-10-6z",
  dress: "M26 7h12l1 14-5 4 14 31H16l14-31-5-4zM26 7l1 7M38 7l-1 7M28 25h8",
  trousers: "M19 8h26l4 49H36l-4-27-4 27H15z M19 8l1 8h24l1-8",
  jacket: "M21 10l-13 8 6 9 7-4v27h20V23l7 4 6-9-13-8c-2 4-6 6-10 6s-8-2-10-6zM32 16v38M24 38h4M36 38h4",
  shoe: "M7 46V33c0-2 1.5-3.5 3.5-3.5h6.5l6-10 5 6 10 4.5c6 2 11 5 13 10v6M7 46h50v6H7zM25 24l3 4M30 27l3 4",
  bag: "M13 24h38l4 32H9zM22 24v-6a10 10 0 0 1 20 0v6M13 24l-4 32",
  backpack: "M19 24a13 12 0 0 1 26 0v33H19zM24 42h16v9H24zM26 24v-7M38 24v-7M27 11a5 5 0 0 1 10 0",
  watch: "M24 6h16l2 12H22zM24 58h16l2-12H22zM32 18a14 14 0 1 1 0 28 14 14 0 0 1 0-28zM32 26v7l5 3",
  glasses: "M5 28h54M9 28v8c0 6 6 9 12 9s11-4 11-10v-7M55 28v8c0 6-6 9-12 9s-11-4-11-10",
  earring: "M32 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM32 16v9M21 25h22l-4 21a7 7 0 0 1-14 0z",
  vase: "M26 7h12v9c8 6 11 14 9 24-1 9-6 15-15 15s-14-6-15-15c-2-10 1-18 9-24zM26 7h12M24 30h16",
  hanger: "M32 18a5 5 0 1 0-5-5M32 18v5L7 45h50L32 23"
};
function iconFor(cat) {
  cat = String(cat || "");
  if (/jeans|trousers/.test(cat)) return "trousers";
  if (/jackets/.test(cat)) return "jacket";
  if (/dresses|sarees/.test(cat)) return "dress";
  if (/tops|tshirts|shirts|kurtas|kids/.test(cat)) return "tee";
  if (/^footwear/.test(cat)) return "shoe";
  if (/backpacks/.test(cat)) return "backpack";
  if (/^bags/.test(cat)) return "bag";
  if (/watches/.test(cat)) return "watch";
  if (/sunglasses/.test(cat)) return "glasses";
  if (/jewellery/.test(cat)) return "earring";
  if (/^home/.test(cat)) return "vase";
  return "hanger";
}
var PCAT = {}; // product id -> category path, learned from the feed and item pages, so tiles without a photo can show a fitting drawing
// The server keeps every photo at 200, 600 and 1200px (WebP). srcset lets a phone grid take the 200 or 600 file and only
// a large or sharp screen fetch 1200. `sizes` says how wide each kind of slot is drawn.
var IMG_SIZES = { 600: "(min-width:900px) 230px, (min-width:768px) 25vw, (min-width:600px) 33vw, 50vw", 1200: "(min-width:768px) 55vw, 100vw" };
function ph(title, pid, imgId, size, extra, cat, alt) {
  var bg = "background:" + TONES[hueOf(title) % TONES.length];
  var art = '<svg class="phi" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + ICONS[iconFor(cat || PCAT[pid])] + '"/></svg>';
  size = size || 600;
  var srcset = IMG_SIZES[size] ? ' srcset="' + [200, 600, 1200].filter(function (s) { return s <= size; }).map(function (s) { return esc(api.media(pid, imgId, s)) + " " + s + "w"; }).join(", ") + '" sizes="' + IMG_SIZES[size] + '"' : "";
  return '<div class="ph" style="' + bg + '">' + art +
    (imgId ? '<img loading="lazy" decoding="async" alt="' + esc(alt || "") + '" src="' + esc(api.media(pid, imgId, size)) + '"' + srcset + ' data-rm="1">' : "") + (extra || "") + "</div>";
}
// Alt text for a product photo: "Maroon silk saree, Biba, Good".
function photoAlt(title, brand, cond) { return [title, brand, COND[cond] || cond].filter(Boolean).join(", "); }
var HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5 6.5 5c2 0 3.6 1.1 5.5 3 1.9-1.9 3.5-3 5.5-3C21 5 22.8 8.6 21.5 11.8 19.5 16.4 12 21 12 21z"/></svg>';
var toastT;
function toast(m) { Array.prototype.forEach.call(document.querySelectorAll(".toast"), function (x) { x.remove(); }); var d = document.createElement("div"); d.className = "toast"; d.textContent = m; $("app").appendChild(d); clearTimeout(toastT); toastT = setTimeout(function () { d.remove(); }, 3200); }
function errText(e) {
  if (!e) return "Something went wrong.";
  if (e.code === "RATE_LIMITED") return "Too many tries. Please wait a few minutes and try again.";
  if (e.code === "VALIDATION_FAILED" && e.details && e.details.length) return e.details.map(function (d) { var l = humanPath(d.path); return (l ? l + ": " : "") + niceMsg(l || "This field", d.message); }).join(" ");
  return e.message || "Something went wrong.";
}
/* ---- Form validation helpers: plain-language messages shown under each field ---- */
function humanPath(p) { var s = String(p || "").split(".").pop().replace(/([a-z])([A-Z0-9])/g, "$1 $2").toLowerCase(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
// Turns technical validator text ("Too small: expected string to have >=3 characters") into plain words.
function niceMsg(label, m) {
  m = String(m || ""); var x;
  if ((x = /expected string to have >=(\d+) characters/.exec(m))) return Number(x[1]) <= 1 ? label + " is required." : "Enter at least " + x[1] + " characters.";
  if ((x = /expected string to have <=(\d+) characters/.exec(m))) return "Too long. Use at most " + x[1] + " characters.";
  if (/received (undefined|null)/i.test(m)) return label + " is required.";
  if (/^Invalid (input|option)/i.test(m) || /^Too (small|big)/i.test(m)) return "Please check " + label.toLowerCase() + ".";
  return m;
}
// rules: [{ id: inputId, path: serverFieldName, label, req (default true), min, re, up (uppercase before regex test), msg }]
function checkRules(rules) {
  var errs = {};
  rules.forEach(function (r) {
    var v = val(r.id);
    if (!v) { if (r.req !== false) errs[r.id] = r.label + " is required."; return; }
    if (r.min && v.length < r.min) errs[r.id] = "Enter at least " + r.min + " characters.";
    else if (r.re && !r.re.test(r.up ? v.toUpperCase() : v)) errs[r.id] = r.msg;
  });
  return errs;
}
// Maps a server VALIDATION_FAILED response back to the inputs; anything unmapped goes to `other`.
function serverFieldErrors(e, rules) {
  var out = { fields: {}, other: "" };
  if (e && e.code === "VALIDATION_FAILED" && e.details && e.details.length) {
    var rest = [];
    e.details.forEach(function (d) {
      var r = rules.filter(function (q) { return q.path === d.path; })[0];
      if (r) out.fields[r.id] = niceMsg(r.label, d.message); else rest.push(niceMsg(humanPath(d.path) || "This field", d.message));
    });
    out.other = rest.join(" ");
  } else out.other = errText(e);
  return out;
}
function clearFieldErrors() {
  Array.prototype.forEach.call(document.querySelectorAll(".ferr"), function (x) { x.remove(); });
  Array.prototype.forEach.call(document.querySelectorAll(".inp.invalid"), function (x) { x.classList.remove("invalid"); x.removeAttribute("aria-invalid"); });
}
// Shows a message under each bad input, one summary line above the button, and jumps to the first problem.
function showFieldErrors(errs, summaryId, other) {
  clearFieldErrors();
  var ids = Object.keys(errs), first = null;
  ids.forEach(function (id) {
    var el = $(id); if (!el) return;
    el.classList.add("invalid"); el.setAttribute("aria-invalid", "true");
    var p = document.createElement("small"); p.className = "ferr"; p.setAttribute("role", "alert"); p.textContent = errs[id];
    el.parentNode.appendChild(p); if (!first) first = el;
  });
  var s = $(summaryId);
  if (s) s.textContent = other || (ids.length === 1 ? "Please fix the field marked in red." : ids.length ? "Please fix the " + ids.length + " fields marked in red." : "");
  if (first) { try { first.scrollIntoView({ block: "center", behavior: "smooth" }); first.focus({ preventScroll: true }); } catch (_) { } }
  return ids.length === 0;
}
document.addEventListener("input", function (ev) {
  var t = ev.target;
  if (t && t.classList && t.classList.contains("invalid")) { t.classList.remove("invalid"); t.removeAttribute("aria-invalid"); var n = t.parentNode.querySelector(".ferr"); if (n) n.remove(); }
});
var PH_RE = /^\+?[0-9]{10,15}$/, PIN_RE = /^[1-9][0-9]{5}$/;
var ADDR_RULES = [
  { id: "adn", path: "name", label: "Full name", min: 2 },
  { id: "adp", path: "phone", label: "Phone number", re: PH_RE, msg: "Enter a 10-digit mobile number, for example 9876543210." },
  { id: "ad1", path: "line1", label: "Address line 1", min: 3 },
  { id: "adc", path: "city", label: "City", min: 2 },
  { id: "ads", path: "state", label: "State", min: 2 },
  { id: "adz", path: "pincode", label: "PIN code", re: PIN_RE, msg: "Enter a 6-digit PIN code, for example 682001." }
];
function row(ic, l, v, attr, tog) { return '<button class="row" ' + attr + '><span class="ic">' + ic + '</span><span class="l">' + l + "</span>" + (v !== "" && v != null ? '<span class="v">' + v + "</span>" : "") + (tog || '<span class="chev"></span>') + "</button>"; }
function head(title, back, right) { return '<div class="bar">' + (back ? '<button class="back" data-a="back" aria-label="Back"><span class="chev" style="transform:rotate(-135deg);margin-left:4px"></span></button>' : "") + "<h1>" + title + "</h1>" + (right || "") + "</div>"; }
function sw(on) { return '<span class="toggle" role="switch" aria-checked="' + !!on + '"></span>'; }
function sum(l, v, cls) { return '<div class="sum ' + (cls || "") + '"><span>' + l + "</span><span>" + v + "</span></div>"; }
function skCards(n) { var o = ""; for (var k = 0; k < n; k++) o += '<div><div class="sk sk-img"></div><div class="sk sk-line"></div><div class="sk sk-line s"></div></div>'; return o; }
function loadingBox() { return '<div class="sk-box" role="status" aria-label="Loading"><div class="sk sk-img sk-wide"></div><div class="sk sk-line"></div><div class="sk sk-line s"></div><div class="sk sk-line"></div></div>'; }
function failBox(msg, retry) { return '<div class="empty"><h2>Could not load</h2>' + esc(msg || "") + '<div style="margin-top:12px"><button class="btn sm" data-a="' + (retry || "reload") + '">Try again</button></div></div>'; }

/* ============ state ============ */
var S = { user: null, perms: [], cats: [], cart: null, wish: {}, ready: false };
var stack = [], tab = "home";
var UI = { rate: {}, q: "", cat: "", cond: "", brand: "", size: "", colour: "", sort: "", minp: "", maxp: "", sellerId: "", sellerName: "", fil: false, feed: { items: [], next: null, loading: false, error: null, key: "", loaded: false },
  auth: { mode: "login", busy: false, err: "" }, ck: { addressId: "", idem: null, busy: false, adding: false, err: "" }, coupon: "", pdv: {}, confirm: null, busy: false };
var C = {}; // per-view fetched data: key -> {st:"loading"|"ok"|"err", data, err}

function signedIn() { return !!S.user; }
function cartCount() { return S.cart ? S.cart.items.reduce(function (a, i) { return a + i.quantity; }, 0) : 0; }
function topCats() { return S.cats.filter(function (c) { return c.depth === 0; }); }
function childCats(path) { return S.cats.filter(function (c) { return c.depth > 0 && c.path.indexOf(path + "/") === 0 && c.path.split("/").length === path.split("/").length + 1; }); }
function catByPath(p) { for (var i = 0; i < S.cats.length; i++) if (S.cats[i].path === p) return S.cats[i]; return null; }

/* ============ data ============ */
async function loadCats() { try { S.cats = (await api.get("/catalogue/categories", { anon: true })).items || []; } catch (e) { S.cats = S.cats || []; } }
async function loadMe() {
  var r = await api.get("/me"); S.user = r.user; S.perms = r.permissions || [];
  // Sellers and admins will want their screens soon, so fetch them now in the background.
  if (S.perms.length) loadMod("admin"); else if ((S.user.roles || []).indexOf("seller") > -1) loadMod("seller");
  await Promise.all([loadCart(), loadWish()]);
}
async function loadCart() { try { S.cart = await api.get("/cart"); } catch (e) { if (e.status === 401) S.cart = null; } }
async function loadWish() { try { var r = await api.get("/me/wishlist"); S.wish = {}; (r.items || []).forEach(function (i) { S.wish[i.productId] = i; }); } catch (e) { S.wish = {}; } }
function clearSession() { S.user = null; S.perms = []; S.cart = null; S.wish = {}; C = {}; UI.ck = { addressId: "", idem: null, busy: false, adding: false, err: "" }; }

function feedKey() { return [UI.q, UI.cat, UI.cond, UI.brand, UI.size, UI.colour, UI.sort, UI.minp, UI.maxp, UI.sellerId].join("|"); }
function feedUrl(cursor) {
  var p = ["limit=24"];
  if (UI.q.trim()) p.push("q=" + encodeURIComponent(UI.q.trim()));
  if (UI.cat) p.push("category=" + encodeURIComponent(UI.cat));
  if (UI.cond) p.push("condition=" + encodeURIComponent(UI.cond));
  if (UI.brand) p.push("brand=" + encodeURIComponent(UI.brand));
  if (UI.size.trim()) p.push("size=" + encodeURIComponent(UI.size.trim()));
  if (UI.colour) p.push("colour=" + encodeURIComponent(UI.colour));
  if (UI.sort) p.push("sort=" + encodeURIComponent(UI.sort));
  if (UI.minp > 0) p.push("minPrice=" + encodeURIComponent(UI.minp));
  if (UI.maxp > 0) p.push("maxPrice=" + encodeURIComponent(UI.maxp));
  if (UI.sellerId) p.push("sellerId=" + encodeURIComponent(UI.sellerId));
  if (cursor) p.push("cursor=" + encodeURIComponent(cursor));
  return "/catalogue/products?" + p.join("&");
}
var feedSeq = 0;
async function loadFeed(more) {
  var F = UI.feed;
  if (more && (F.loading || !F.next)) return;
  var my = ++feedSeq;
  if (!more) { F.items = []; F.next = null; }
  F.loading = true; F.error = null; partialFeed();
  try {
    var r = await api.get(feedUrl(more ? F.next : null), { anon: !signedIn() });
    if (my !== feedSeq) return; // a newer search replaced this one
    (r.items || []).forEach(function (i) { PCAT[i.id] = i.categoryPath; PTITLE[i.id] = i.title; }); F.items = more ? F.items.concat(r.items) : r.items; F.next = r.nextCursor || null; F.loaded = true;
  } catch (e) { if (my !== feedSeq) return; F.error = errText(e); }
  F.loading = false; partialFeed();
  if (restoreAfterFeed != null) { window.scrollTo(0, restoreAfterFeed); restoreAfterFeed = null; } // Back to a list that had to reload
}
function need(key, fn) {
  var c = C[key];
  if (c) return c;
  c = C[key] = { st: "loading", data: null, err: null };
  fn().then(function (d) { c.st = "ok"; c.data = d; refresh(); }, function (e) { c.st = "err"; c.err = errText(e); c.code = e.code; refresh(); });
  return c;
}
function drop(prefix) { Object.keys(C).forEach(function (k) { if (k.indexOf(prefix) === 0) delete C[k]; }); }

/* ============ addresses ============ */
// Every screen has its own address, so an item, a category or a search can be shared, bookmarked and found by search engines:
//   /item/<id>/<slug>   /c/<category path>   /search?q=…&c=…   /seller/<id>   /<tab>   /<tab>/<screen>/<param>
// The router keeps the in-memory stack as the source of truth; render() writes it to the address bar, popstate reads it back.
var PTITLE = {}; // product id -> title, learned from the feed and item pages, for readable item addresses
var TAB_NAMES = ["home", "discover", "sell", "inbox", "cart", "profile"];
var NO_URL = { reset: 1 }; // the password reset screen's parameter is a secret token: never put it in the address or history
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function slug(s) { return String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60); }
function itemUrl(id, title) {
  var s = slug(title || PTITLE[id]), base = "/item/" + id;
  if (!s && location.pathname.indexOf(base + "/") === 0) return location.pathname; // opened from a link: keep its slug until the title is known
  return base + (s ? "/" + s : "");
}
function catUrl(path) { return path ? "/c/" + path : "/"; }
function urlFor() {
  var st = stack.filter(function (s) { return !NO_URL[s.v]; }), c = st[st.length - 1];
  if (c && c.v === "item") return itemUrl(c.p);
  if (c) return "/" + tab + "/" + c.v + (c.p ? "/" + encodeURIComponent(c.p) : "");
  if (tab !== "home") return "/" + tab;
  if (UI.q.trim()) return "/search?q=" + encodeURIComponent(UI.q.trim()) + (UI.cat ? "&c=" + encodeURIComponent(UI.cat) : "");
  if (UI.sellerId) return "/seller/" + UI.sellerId;
  return catUrl(UI.cat);
}
function parseUrl() {
  var parts = location.pathname.split("/").filter(Boolean).map(function (x) { try { return decodeURIComponent(x); } catch (e) { return ""; } });
  var qs = new URLSearchParams(location.search), st = { tab: "home", stack: [], q: "", cat: "", sellerId: "", sellerName: "" };
  if (parts[0] === "item" && UUID_RE.test(parts[1] || "")) st.stack = [{ v: "item", p: parts[1] }];
  else if (parts[0] === "c") st.cat = parts.slice(1).filter(function (x) { return /^[a-z0-9-]+$/.test(x); }).join("/");
  else if (parts[0] === "search") { st.q = (qs.get("q") || "").slice(0, 200); st.cat = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(qs.get("c") || "") ? qs.get("c") : ""; }
  else if (parts[0] === "seller" && UUID_RE.test(parts[1] || "")) st.sellerId = parts[1];
  else if (TAB_NAMES.indexOf(parts[0]) > -1) { st.tab = parts[0]; if (/^[a-z]+$/.test(parts[1] || "") && !NO_URL[parts[1]]) st.stack = [{ v: parts[1], p: parts[2] }]; }
  return st;
}
var depth = 0, pushNext = false; // depth: entries this visit pushed, so the in-app back button can use history.back()
function snap() { return { tab: tab, stack: stack.map(function (s) { return { v: s.v, p: s.p }; }), q: UI.q, cat: UI.cat, sellerId: UI.sellerId, sellerName: UI.sellerName, d: depth }; }
function restore(st) {
  var fk = feedKey();
  tab = st.tab; stack = st.stack.slice(); UI.q = st.q || ""; UI.cat = st.cat || ""; UI.sellerId = st.sellerId || ""; UI.sellerName = st.sellerName || ""; depth = st.d || 0; UI.confirm = null;
  return fk !== feedKey();
}
// Called at the end of every render: a navigation marked with navPush() adds a history entry, anything else (typing a
// search, a filter, an item's title arriving) just updates the current one.
function syncUrl() {
  var u = urlFor(), here = location.pathname + location.search;
  try {
    if (pushNext && u !== here) { depth++; history.pushState(snap(), "", u); }
    else history.replaceState(snap(), "", u);
  } catch (e) { }
  pushNext = false;
}
// Scroll position per address: remembered as you leave a screen, put back when Back/Forward returns to it.
var scrollPos = {}, restoreAfterFeed = null;
function here() { return location.pathname + location.search; }
function navPush() { pushNext = true; restoreAfterFeed = null; scrollPos[here()] = window.pageYOffset; }
window.addEventListener("popstate", function (e) {
  if (!S.ready) return;
  var feedChanged = restore(e.state || parseUrl()), c = cur(), y = scrollPos[here()] || 0;
  enter(c.v, c.p); if (feedChanged) { restoreAfterFeed = y; loadFeed(false); } render(); window.scrollTo(0, y);
});
// The tab bar's height (0 while it is hidden) drives where the toast, chat box and sticky photo sit; see styles.css.
function setNavHeight() { var n = $("nav"); document.documentElement.style.setProperty("--navh", n && !n.hidden ? n.offsetHeight + "px" : "0px"); }
window.addEventListener("resize", setNavHeight);
try { history.scrollRestoration = "manual"; } catch (e) { }

/* ============ scripts loaded on demand ============ */
var scripts = {};
function loadScript(src, attrs) {
  if (!scripts[src]) scripts[src] = new Promise(function (ok, fail) {
    var s = document.createElement("script"); s.src = src;
    Object.keys(attrs || {}).forEach(function (k) { s.setAttribute(k, attrs[k]); });
    s.onload = ok; s.onerror = function () { delete scripts[src]; s.remove(); fail(new Error("Could not load " + src)); };
    document.body.appendChild(s);
  });
  return scripts[src];
}
// Seller and admin screens are fetched only when someone opens one, so shoppers never download them.
// admin.js uses helpers from seller.js (RL.H), so seller.js always runs first.
var MODS = { seller: ["/seller.js"], admin: ["/seller.js", "/admin.js"] }, MOD_OF = {}, modState = {}; // modState: name -> "loading" | "ok" | "err"
"sell slbank slearn slform slorder slorders slprod slprods".split(" ").forEach(function (v) { MOD_OF[v] = "seller"; });
"admin adcat adcomm adcoupons adfees adorder adorders adprod adprods adrules adratings adseller adsellers adusers".split(" ").forEach(function (v) { MOD_OF[v] = "admin"; });
function loadMod(name) {
  if (modState[name]) return; // already loaded, loading, or failed (the "Try again" button clears a failure)
  modState[name] = "loading";
  MODS[name].reduce(function (p, src) { return p.then(function () { return loadScript(src); }); }, Promise.resolve())
    .then(function () { modState[name] = "ok"; refresh(); }, function () { modState[name] = "err"; refresh(); });
}
// Nova help chat. Its closed launcher is a fixed 320x96 frame in the bottom-right corner, which on a phone sits over the
// Cart and Profile tabs, so it is loaded only when asked for and lifted above the bottom tab bar while closed.
function openHelpChat() {
  var cfg = window.APP_CONFIG || {};
  if (window.__novaWidgetLoaded) { toast("The chat button is in the bottom corner."); return; }
  toast("Opening chat…");
  watchNova(new URL(cfg.NOVA_SRC).origin);
  loadScript(cfg.NOVA_SRC, { "data-client-id": cfg.NOVA_CLIENT }).catch(function () { toast("Chat is not available right now. Please try again later."); });
}
function watchNova(origin) {
  function place(f, open) { var nav = $("nav"), atBottom = nav && !nav.hidden && nav.getBoundingClientRect().top > innerHeight / 2; f.style.bottom = !open && atBottom ? nav.offsetHeight + "px" : "0"; }
  function found() {
    var f = document.querySelector('iframe[title="Nova AI chat"]'); if (!f) return false;
    place(f, false);
    window.addEventListener("message", function (e) { if (e.origin === origin && e.source === f.contentWindow && e.data && e.data.type === "nova:open") place(f, e.data.open === true); });
    return true;
  }
  var mo = new MutationObserver(function () { if (found()) mo.disconnect(); });
  mo.observe(document.body, { childList: true });
}

/* ============ views ============ */
var V = {};
function card(i) {
  var f = !!S.wish[i.id], tag = i.inStock === false ? '<span class="tag">Sold out</span>' : "";
  // A real link, so search engines and the site crawler can follow it and people can open it in a new tab.
  return '<div><a class="card" href="' + esc(itemUrl(i.id, i.title)) + '" data-a="item" data-i="' + esc(i.id) + '" aria-label="' + esc(i.title) + '">' +
    ph(i.title, i.id, i.coverImageId, 600, tag + '<span class="heart' + (f ? " on" : "") + '" data-a="fav" data-i="' + esc(i.id) + '" role="button" aria-label="Favourite" aria-pressed="' + f + '">' + HEART + "</span>", null, photoAlt(i.title, i.brandName, i.condition)) +
    '<div class="t">' + esc(i.title) + '</div><div class="m">' + esc([COND[i.condition] || i.condition, i.brandName].filter(Boolean).join(" · ")) + '</div><div class="price">' + inr(i.minPricePaise) + "</div></a></div>";
}
function gridHTML() {
  var F = UI.feed;
  if (F.error && !F.items.length) return '<div class="empty" style="grid-column:1/-1"><h2>Could not load items</h2>' + esc(F.error) + '<div style="margin-top:12px"><button class="btn sm" data-a="feedretry">Try again</button></div></div>';
  if (!F.items.length) return F.loading || !F.loaded ? skCards(8) :
    '<div class="empty" style="grid-column:1/-1"><h2>No items found</h2>Try a different search, category or filter.</div>';
  return F.items.map(card).join("");
}
function moreHTML() { var F = UI.feed; return F.next ? '<button class="btn ghost block" data-a="more" ' + (F.loading ? "disabled" : "") + ">" + (F.loading ? "Loading…" : "Load more") + "</button>" : ""; }
// "24 items", or "24+ items" while more can be loaded (the API pages by cursor and does not report a total).
function countText() {
  var F = UI.feed; if (!F.loaded || !F.items.length) return "";
  var n = F.items.length; return n + (F.next ? "+" : "") + (n === 1 && !F.next ? " item" : " items");
}
function partialFeed() {
  var g = $("grid"), m = $("more"), c = $("count"), a = $("actives"), b = $("fbtn");
  var dr = $("drops"); if (dr) dr.innerHTML = dropsHTML();
  if (g) g.innerHTML = gridHTML(); if (m) m.innerHTML = moreHTML(); if (c) c.textContent = countText(); if (a) a.innerHTML = activesHTML();
  if (b) { var nf = filterCount(); b.textContent = "Filters" + (nf ? " (" + nf + ")" : ""); b.classList.toggle("on", UI.fil || !!nf); }
}
// Breadcrumbs (Home / Women / Sarees), as on Vinted and Foot Locker listing and product pages. `current` marks the last
// category as the page itself instead of a link.
function crumbsHTML(path, current) {
  var out = ['<a href="/" data-a="browse" data-i="" data-j="reset">Home</a>'];
  if (path) {
    var segs = path.split("/"), acc = "";
    segs.forEach(function (s, n) {
      acc += (n ? "/" : "") + s; var c = catByPath(acc), nm = c ? c.name : s;
      out.push(current && n === segs.length - 1 ? '<span aria-current="page">' + esc(nm) + "</span>" : '<a href="' + esc(catUrl(acc)) + '" data-a="browse" data-i="' + esc(acc) + '" data-j="reset">' + esc(nm) + "</a>");
    });
  }
  return '<nav class="crumbs" aria-label="Breadcrumb">' + out.join('<i aria-hidden="true">/</i>') + "</nav>";
}
function listTitle() {
  if (UI.q.trim()) return "Results for “" + UI.q.trim() + "”";
  if (UI.sellerId) return "Items from " + (UI.sellerName || "this seller");
  var c = catByPath(UI.cat); return c ? c.name : "Just listed";
}
// Page title, result count and a visible Sort control above the grid: all three big stores have these, and Reloved
// used to hide sorting inside the Filters panel and show no count.
function toolbarHTML() {
  return (UI.cat ? crumbsHTML(UI.cat, true) : "") +
    '<div class="toolbar"><div class="tb-l"><h2 class="listtitle">' + esc(listTitle()) + '</h2><span class="count" id="count" aria-live="polite">' + countText() + "</span>" +
    (UI.sellerId ? '<button class="chip" data-a="clearseller">Show all</button>' : "") + "</div>" +
    '<span class="tb-r"><button class="linkbtn hidefil" data-a="hidefil">' + (UI.hidefil ? "Show filters" : "Hide filters") + '</button>' + '<label class="sortsel"><span>Sort</span><select class="inp" id="fs" data-f="1">' + opt("", UI.q.trim() ? "Best match" : "Newest", UI.sort) + opt("price_asc", "Price: low to high", UI.sort) + opt("price_desc", "Price: high to low", UI.sort) + "</select></label></span></div>" +
    '<div class="actives" id="actives">' + activesHTML() + "</div>" + sellerReviewsHTML();
}
// The filters in use, each removable with one tap, plus "Clear all" (Vinted shows these under its filter row).
function brandName(slug) { var b = (S.brands || []).filter(function (x) { return x.slug === slug; })[0]; return b ? b.name : slug; }
function activesHTML() {
  var out = [];
  function ch(label, key, val) { out.push('<button class="chip on active" data-a="rmfil" data-i="' + key + '"' + (val ? ' data-j="' + esc(val) + '"' : "") + ' aria-label="Remove filter: ' + esc(label) + '">' + esc(label) + ' <span aria-hidden="true">×</span></button>'); }
  if (UI.brand) ch(brandName(UI.brand), "brand");
  condSet().forEach(function (k) { ch(COND[k] || k, "cond", k); });
  if (UI.size.trim()) ch("Size " + UI.size.trim(), "size");
  if (UI.colour) ch(UI.colour, "colour");
  if (UI.minp || UI.maxp) ch(UI.minp && UI.maxp ? "₹" + UI.minp + " – ₹" + UI.maxp : UI.minp ? "From ₹" + UI.minp : "Up to ₹" + UI.maxp, "price");
  return out.length ? out.join("") + '<button class="linkbtn" data-a="filclear">Clear all</button>' : "";
}

// Why buy here: one short block above the grid on the plain home screen (Vinted opens with a pitch, the big stores with a campaign).
function introHTML() {
  return '<section class="intro"><h2>Preloved, checked, protected.</h2><ul>' +
    "<li><b>Verified sellers.</b> Every seller is checked before they can sell, and every listing is reviewed.</li>" +
    "<li><b>Buyer Protection</b> on every order. Damaged or fake? Return it within 7 days.</li>" +
    "<li><b>Indian closets.</b> Kurtas, sarees, sneakers and more, priced in rupees.</li></ul>" +
    '<div class="intro-cta"><a class="btn ghost sm" href="/home/doc/how" data-a="go" data-i="doc" data-j="how">How it works</a><a class="btn sm" href="/sell" data-a="tab" data-i="sell">Sell your clothes</a></div></section>';
}

// ---- Home showcase: layout taken from the Nike and Foot Locker home pages (hero carousel, category tiles, a "fresh drops"
// rail, a brand grid, an app banner and a footer), with Reloved's own words and colour panels instead of photos. ----
var HERO = [
  { k: "a", h: "Preloved, checked, protected.", p: "Verified sellers and Buyer Protection on every order.", b: "Shop now", a: 'data-a="scrolllist"' },
  { k: "b", h: "Clear out your closet.", p: "List what you no longer wear and reach buyers across India.", b: "Start selling", a: 'data-a="tab" data-i="sell"' },
  { k: "c", h: "Swipe to find your next favourite.", p: "Right to message the seller, left to skip.", b: "Open Discover", a: 'data-a="tab" data-i="discover"' }
];
var ICON_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>', ICON_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
function heroHTML() {
  return '<section class="hero" aria-roledescription="carousel" aria-label="Highlights"><div class="hero-track" id="herotrack" tabindex="0">' +
    HERO.map(function (s, n) {
      return '<div class="hero-slide hs-' + s.k + '" role="group" aria-roledescription="slide" aria-label="' + (n + 1) + " of " + HERO.length + '"><div class="hero-copy"><h2>' + esc(s.h) + "</h2><p>" + esc(s.p) + '</p><button class="btn pill-btn" ' + s.a + ">" + esc(s.b) + "</button></div></div>";
    }).join("") + '</div><div class="hero-ctl"><span class="hero-dots" id="herodots">' + HERO.map(function (s, n) { return "<i" + (n ? "" : ' class="on"') + "></i>"; }).join("") + "</span>" +
    '<button class="rnd" data-hero="pause" id="heropause" aria-label="Pause slides"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg></button>' +
    '<button class="rnd" data-hero="prev" aria-label="Previous slide">' + ICON_PREV + '</button><button class="rnd" data-hero="next" aria-label="Next slide">' + ICON_NEXT + "</button></div></section>";
}
function railWrap(title, id, inner) {
  return '<section class="sec"><div class="sec-h"><h2>' + esc(title) + '</h2><span class="rail-ctl"><button class="rnd" data-rail="prev" aria-label="Scroll left">' + ICON_PREV + '</button><button class="rnd" data-rail="next" aria-label="Scroll right">' + ICON_NEXT + '</button></span></div><div class="rail-track" ' + (id ? 'id="' + id + '"' : "") + ">" + inner + "</div></section>";
}
function starsText(avg, n) { return '<span class="stars" aria-label="Rated ' + avg + ' out of 5 from ' + n + (n === 1 ? " rating" : " ratings") + '"><i aria-hidden="true">★</i> <b>' + Number(avg).toFixed(1) + '</b> <span class="muted">(' + n + ")</span></span>"; }
function loadTopSellers() { if (S.topSellers !== undefined) return; S.topSellers = null; api.get("/catalogue/sellers/top", { anon: true }).then(function (r) { S.topSellers = r.items || []; refresh(); }, function () { S.topSellers = []; }); }
function sellersRailHTML() {
  loadTopSellers();
  var L = S.topSellers; if (L === null) return railWrap("Top rated sellers", "", '<div class="sk sk-seller"></div><div class="sk sk-seller"></div><div class="sk sk-seller"></div><div class="sk sk-seller"></div>');
  if (!L.length) return "";
  return railWrap("Top rated sellers", "", L.map(function (x) {
    return '<button class="seller-tile" data-a="seller" data-i="' + esc(x.id) + '" data-j="' + esc(x.displayName) + '"><span class="av" style="background:hsl(' + hueOf(x.displayName) + ',40%,32%)">' + esc(String(x.displayName).slice(0, 1).toUpperCase()) + '</span><b>' + esc(x.displayName) + "</b>" + starsText(x.ratingAvg, x.ratingCount) + '<span class="muted small">' + x.itemCount + (x.itemCount === 1 ? " item" : " items") + "</span></button>";
  }).join(""));
}
function sellerReviewsHTML() {
  if (!UI.sellerId) return "";
  var id = UI.sellerId, c = need("sr:" + id, function () { return api.get("/catalogue/sellers/" + id + "/ratings", { anon: true }); });
  if (c.st === "loading") return '<section class="reviews"><div class="sk" style="height:84px"></div></section>';
  if (c.st === "err" || !c.data.ratingCount) return "";
  var d = c.data, max = Math.max.apply(null, d.distribution.map(function (x) { return x.count; })) || 1;
  return '<section class="reviews"><div class="rv-top"><div class="rv-score"><b>' + Number(d.ratingAvg).toFixed(1) + '</b><span class="stars-row" aria-hidden="true">' + "★".repeat(Math.round(d.ratingAvg)) + '<span class="off">' + "★".repeat(5 - Math.round(d.ratingAvg)) + '</span></span><span class="muted small">' + d.ratingCount + (d.ratingCount === 1 ? " rating" : " ratings") + '</span></div><div class="rv-bars">' +
    d.distribution.map(function (x) { return '<div class="rv-bar"><span>' + x.stars + '★</span><i><u style="width:' + Math.round(x.count / max * 100) + '%"></u></i><span class="muted">' + x.count + "</span></div>"; }).join("") + "</div></div>" +
    (d.recent.some(function (x) { return x.comment; }) ? '<details class="rv-list"' + (d.recent.length <= 3 ? " open" : "") + "><summary>Buyer comments</summary>" + d.recent.filter(function (x) { return x.comment; }).map(function (x) { return '<div class="rv-item"><span class="stars"><i aria-hidden="true">' + "★".repeat(x.stars) + '</i></span> <b>' + esc(x.buyerName) + '</b> <span class="muted small">· ' + when(x.createdAt) + '</span><p>' + esc(x.comment) + "</p></div>"; }).join("") + "</details>" : "") + "</section>";
}
function dropsHTML() {
  var F = UI.feed; if (!F.loaded || F.loading && !F.items.length) return skCards(6); if (!F.items.length) return '<div class="muted small" style="padding:8px 0">New listings will appear here.</div>';
  return F.items.slice(0, 12).map(card).join("");
}
function catRailHTML() {
  var tops = topCats(); if (!tops.length) return "";
  return '<section class="sec"><div class="sec-h"><h2>Shop by category</h2><span class="rail-ctl"><button class="rnd" data-rail="prev" aria-label="Scroll left">' + ICON_PREV + '</button><button class="rnd" data-rail="next" aria-label="Scroll right">' + ICON_NEXT + '</button></span></div><div class="rail-track cat-rail">' +
    tops.map(function (c) { var h = hueOf(c.name); return '<a class="cat-tile" href="' + esc(catUrl(c.path)) + '" data-a="browse" data-i="' + esc(c.path) + '" data-j="reset" style="background:' + TONES[h % TONES.length] + '"><span>' + esc(c.name) + "</span></a>"; }).join("") + "</div></section>";
}
function featuredHTML() {
  return '<section class="sec"><div class="sec-h"><h2>Featured</h2></div><div class="feat">' +
    '<a class="feat-tile ft-a" href="/sell" data-a="tab" data-i="sell"><span class="ft-k">For sellers</span><b>Sell what you no longer wear</b><span class="pill-btn btn sm">List an item</span></a>' +
    '<a class="feat-tile ft-b" href="/discover" data-a="tab" data-i="discover"><span class="ft-k">For buyers</span><b>Swipe through new listings</b><span class="pill-btn btn sm">Discover</span></a></div></section>';
}
function trustTilesHTML() {
  return '<section class="sec"><div class="sec-h"><h2>Why Reloved</h2></div><div class="trio">' +
    '<a class="trio-tile tt-a" href="/home/doc/how" data-a="go" data-i="doc" data-j="how"><b>Verified sellers</b><span>Every seller is checked and every listing reviewed.</span></a>' +
    '<a class="trio-tile tt-b" href="/home/doc/how" data-a="go" data-i="doc" data-j="how"><b>Buyer Protection</b><span>Damaged or fake? Return it within 7 days.</span></a>' +
    '<a class="trio-tile tt-c" href="/home/doc/how" data-a="go" data-i="doc" data-j="how"><b>Priced in rupees</b><span>Indian closets, with delivery fees shown before you order.</span></a></div></section>';
}
function appBannerHTML() {
  return '<section class="appban"><span class="appban-logo" aria-hidden="true">Re<em>loved</em></span><b>It&rsquo;s better on the app</b><button class="btn sm pill-btn" data-a="install">Install Reloved</button></section>';
}
function footerHTML() {
  var tops = topCats().slice(0, 6);
  return '<footer class="foot"><div class="foot-cols">' +
    "<div><h3>Shop</h3>" + (tops.length ? tops.map(function (c) { return '<a href="' + esc(catUrl(c.path)) + '" data-a="browse" data-i="' + esc(c.path) + '" data-j="reset">' + esc(c.name) + "</a>"; }).join("") : '<a href="/" data-a="browse" data-i="" data-j="reset">Just listed</a>') + "</div>" +
    '<div><h3>Sell</h3><a href="/sell" data-a="tab" data-i="sell">Sell your clothes</a><a href="/discover" data-a="tab" data-i="discover">Discover</a></div>' +
    '<div><h3>Help</h3><a href="/home/doc/how" data-a="go" data-i="doc" data-j="how">How it works</a><a href="/home/help" data-a="go" data-i="help">Help Centre</a><a href="/home/about" data-a="go" data-i="about">About us</a></div>' +
    '<div><h3>Legal</h3><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><a href="/delete-account.html">Delete account</a></div></div>' +
    '<p class="foot-note">&copy; ' + new Date().getFullYear() + " Reloved. Preloved fashion from verified Indian sellers.</p></footer>";
}
function showcaseHTML() {
  return heroHTML() + catRailHTML() + railWrap("Fresh drops", "drops", dropsHTML()) + sellersRailHTML() + featuredHTML() + trustTilesHTML() + appBannerHTML();
}
// Cart as a header icon on phones (the bottom bar has five tabs); on desktop it stays in the top bar.
function cartLink() {
  var n = cartCount();
  return '<a class="hdr-cart" href="/cart" data-a="tab" data-i="cart" aria-label="Cart' + (n ? ", " + n + " items" : "") + '"><svg viewBox="0 0 24 24"><path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/></svg>' + (n ? '<i class="dot">' + (n > 9 ? "9+" : n) + "</i>" : "") + "</a>";
}
/* ---- filters: sort, brand, condition (several), size, colour, price ---- */
var SIZES = ["XS", "S", "M", "L", "XL", "XXL", "Free size", "UK 5", "UK 6", "UK 7", "UK 8", "UK 9", "UK 10", "EU 36", "EU 37", "EU 38", "EU 39", "EU 40", "EU 41", "EU 42"];
var COLOURS = ["Black", "White", "Grey", "Blue", "Navy", "Red", "Maroon", "Pink", "Green", "Yellow", "Mustard", "Orange", "Brown", "Beige", "Gold", "Silver"];
function condSet() { return UI.cond ? UI.cond.split(",") : []; }
function filterCount() { return [UI.brand, UI.cond, UI.size, UI.colour, UI.minp, UI.maxp].filter(Boolean).length; }
function loadBrands() { if (S.brands) return; S.brands = []; api.get("/catalogue/brands", { anon: true }).then(function (r) { S.brands = r.items || []; refresh(); }, function () { S.brands = null; }); }
function opt(v, label, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? " selected" : "") + ">" + esc(label) + "</option>"; }
function filtersHTML() {
  var cs = condSet();
  function grp(title, body, open) { return '<details class="fgrp"' + (open === false ? "" : " open") + "><summary>" + title + "</summary>" + body + "</details>"; }
  return '<div class="banner filters"><h3 class="filtitle">Filters</h3>' +
    grp("Brand", '<label class="field"><select class="inp" id="fb" data-f="1" aria-label="Brand">' + opt("", "Any brand", UI.brand) + (S.brands || []).map(function (b) { return opt(b.slug, b.name, UI.brand); }).join("") + "</select></label>") +
    grp("Condition", '<div class="field"><div class="chips wrap">' + Object.keys(COND).map(function (k) { var on = cs.indexOf(k) > -1; return '<button class="chip' + (on ? " on" : "") + '" data-a="condtog" data-i="' + k + '" aria-pressed="' + on + '">' + COND[k] + "</button>"; }).join("") + "</div></div>") +
    grp("Size and colour", '<div class="two"><label class="field"><span>Size</span><input class="inp" id="fz" data-f="1" list="fzl" value="' + esc(UI.size) + '" placeholder="Any, e.g. M or UK 7" autocomplete="off"><datalist id="fzl">' + SIZES.map(function (s) { return '<option value="' + s + '">'; }).join("") + "</datalist></label>" +
      '<label class="field"><span>Colour</span><select class="inp" id="fcl" data-f="1">' + opt("", "Any colour", UI.colour) + COLOURS.map(function (c) { return opt(c, c, UI.colour); }).join("") + "</select></label></div>") +
    grp("Price", '<div class="two"><label class="field"><span>Min (₹)</span><input class="inp" id="fmin" data-f="1" inputmode="numeric" value="' + esc(UI.minp) + '" placeholder="0"></label><label class="field"><span>Max (₹)</span><input class="inp" id="fmax" data-f="1" inputmode="numeric" value="' + esc(UI.maxp) + '" placeholder="No limit"></label></div>') +
    (filterCount() ? '<button class="btn ghost sm" data-a="filclear">Clear filters</button>' : "") + "</div>";
}
V.home = function () {
  var tops = topCats(), top = UI.cat ? UI.cat.split("/")[0] : "", subs = top ? childCats(top) : [];
  function chip(path, label, on) { return '<a class="chip' + (on ? " on" : "") + '" href="' + esc(catUrl(path)) + '" data-a="cat" data-i="' + esc(path) + '">' + esc(label) + "</a>"; }
  var chips = chip("", "All", !UI.cat) + tops.map(function (c) { return chip(c.path, c.name, top === c.path); }).join("");
  // On a laptop the category links live in the header (every page), the filters in a sidebar: fetch the brand list up front.
  if (UI.fil || (window.matchMedia && matchMedia("(min-width:900px)").matches)) loadBrands();
  var subchips = subs.length ? '<div class="chips">' + chip(top, "All " + ((catByPath(top) || {}).name || ""), UI.cat === top) +
    subs.map(function (c) { return chip(c.path, c.name, UI.cat === c.path); }).join("") + "</div>" : "";
  var nf = filterCount(), plain = !UI.q.trim() && !UI.cat && !UI.sellerId && !nf;
  return '<div class="homehead"><h1 class="brand">Re<em>loved</em></h1>' + cartLink() + "</div>" +
    '<div class="searchrow"><div class="search" style="flex:1"><span class="muted">&#9906;</span><input id="q" type="search" placeholder="Search for items" value="' + esc(UI.q) + '" aria-label="Search"></div><button class="chip' + (UI.fil || nf ? " on" : "") + '" id="fbtn" data-a="fil" aria-expanded="' + UI.fil + '">Filters' + (nf ? " (" + nf + ")" : "") + "</button></div>" +
    '<div class="chips catchips">' + chips + "</div>" + subchips +
    (plain && !UI.fil ? showcaseHTML() : "") +
    // Filters: a panel under the chips on phones (opened by the Filters button), a sidebar beside the grid on laptops.
    '<div class="listing' + (UI.hidefil ? " nofil" : "") + '" id="listing-top"><aside class="side' + (UI.fil ? " open" : "") + '" aria-label="Filters">' + filtersHTML() + "</aside>" +
    '<div class="listing-main">' + toolbarHTML() + '<div class="grid" id="grid">' + gridHTML() + '</div><div id="more" style="margin-top:14px">' + moreHTML() + "</div></div></div>" + (plain ? footerHTML() : "");
};
V.browse = function () {
  var tops = topCats();
  return head("Browse") + '<form class="search" id="bf"><span class="muted">&#9906;</span><input id="q2" type="search" placeholder="Search for items" aria-label="Search"></form>' +
    (tops.length ? '<div class="tiles">' + tops.map(function (c) { var h = hueOf(c.name); return '<button class="tile" data-a="browse" data-i="' + esc(c.path) + '" style="background:' + TONES[h % TONES.length] + '"><span>' + esc(c.name) + "</span></button>"; }).join("") + "</div>" : '<div class="empty"><h2>No categories yet</h2>Categories appear here once the catalogue is set up.</div>');
};
V.item = function (pid) {
  var c = need("item:" + pid, function () { return api.get("/catalogue/products/" + pid, { anon: !signedIn() }); });
  if (c.st === "loading") return head("", true) + loadingBox();
  if (c.st === "err") return head("Item", true) + (c.code === "NOT_FOUND" ? '<div class="empty"><h2>Item not found</h2>It may have been removed or is no longer for sale.</div>' : failBox(c.err));
  var p = c.data, vs = p.variants || [], sel = UI.pdv[pid]; PCAT[pid] = p.categoryPath; PTITLE[pid] = p.title;
  var v = vs.filter(function (x) { return x.id === sel; })[0] || vs.filter(function (x) { return x.inStock; })[0] || vs[0];
  var inCart = v && S.cart && S.cart.items.filter(function (i) { return i.variantId === v.id; })[0];
  var f = !!S.wish[pid], imgs = p.images && p.images.length ? p.images : [null];
  var off = v && v.mrpPaise > v.pricePaise ? Math.round((1 - v.pricePaise / v.mrpPaise) * 100) : 0;
  return head("", true, '<button class="back" data-a="fav" data-i="' + esc(pid) + '" aria-label="Favourite" aria-pressed="' + f + '"><span class="heart' + (f ? " on" : "") + '" style="position:static;background:none">' + HEART + "</span></button>") +
    crumbsHTML(p.categoryPath, false) +
    '<div class="itemgrid"><div class="gallery">' + imgs.map(function (im, n) { return ph(p.title, pid, im && im.id, 1200, "", null, photoAlt(p.title, p.brandName, p.condition) + (imgs.length > 1 ? ", photo " + (n + 1) + " of " + imgs.length : "")); }).join("") + '</div><div class="iteminfo">' +
    "<h2>" + esc(p.title) + '</h2><div class="price price-lg">' + (v ? inr(v.pricePaise) : "") + (off ? ' <s class="muted small" style="font-weight:400">' + inr(v.mrpPaise) + '</s> <small>' + off + "% off</small>" : "") + '</div><div class="muted small">Price includes GST</div>' +
    (vs.length > 1 || (vs[0] && Object.keys(vs[0].options || {}).length) ? '<h3 style="margin:14px 0 6px">' + (vs.length > 1 ? "Choose an option" : "Option") + '</h3><div class="chips" style="flex-wrap:wrap">' + vs.map(function (x) { return '<button class="chip' + (v && x.id === v.id ? " on" : "") + '" data-a="vsel" data-i="' + esc(pid) + '" data-j="' + esc(x.id) + '"' + (x.inStock ? "" : ' style="opacity:.45;text-decoration:line-through"') + ">" + esc(variantLabel(x.options)) + "</button>"; }).join("") + "</div>" : "") +
    (v && v.onlyLeft ? '<div class="pill prog" style="display:inline-block">Only ' + v.onlyLeft + " left</div>" : "") +
    '<dl class="kv"><dt>Condition</dt><dd>' + esc(COND[p.condition] || p.condition) + "</dd><dt>Brand</dt><dd>" + esc(p.brandName || "Not stated") + "</dd><dt>Category</dt><dd>" + esc(p.categoryName || "") + "</dd>" +
    Object.keys(p.attributes || {}).map(function (k) { return "<dt>" + esc(k.charAt(0).toUpperCase() + k.slice(1)) + "</dt><dd>" + esc(p.attributes[k]) + "</dd>"; }).join("") + "</dl>" +
    (p.description ? "<p>" + esc(p.description).replace(/\n/g, "<br>") + "</p>" : "") +
    (p.seller ? '<button class="itemcard" data-a="seller" data-i="' + esc(p.seller.id) + '" data-j="' + esc(p.seller.displayName) + '" style="margin:12px 0"><span class="av" style="background:hsl(' + hueOf(p.seller.displayName) + ',40%,32%)">' + esc(String(p.seller.displayName).slice(0, 1).toUpperCase()) + '</span><span style="flex:1"><b>' + esc(p.seller.displayName) + '</b> <span class="pill ok">Verified seller</span><br>' + (p.seller.ratingCount ? starsText(p.seller.ratingAvg, p.seller.ratingCount) + ' <span class="muted small">· See more</span>' : '<span class="muted small">See more from this seller</span>') + '</span><span class="chev"></span></button>' : "") +
    // The buying action comes first, then the secondary one (Vinted: Buy now, Make an offer, Message seller).
    (v && v.inStock ? (inCart ? '<div class="two"><button class="btn ghost" data-a="tab" data-i="cart">View cart (' + inCart.quantity + ')</button><button class="btn" data-a="addcart" data-i="' + esc(v.id) + '">Add one more</button></div>' : '<button class="btn block" data-a="addcart" data-i="' + esc(v.id) + '"' + (UI.busy ? " disabled" : "") + ">Add to cart</button>") : '<div class="banner">This option is sold out.</div>') +
    '<button class="btn ghost block" data-a="msgseller" data-i="' + esc(pid) + '" style="margin-top:10px">Message seller</button>' +
    // Only approved sellers' listings are public (the API's VISIBLE rule), so every seller shown here has been verified.
    '<div class="banner trust" style="margin-top:12px"><b>Buyer Protection</b><span class="small muted">If it arrives damaged or fake, ask for a return within 7 days of delivery. Pay inside Reloved to stay covered. Buyer Protection and delivery fees are shown before you order.</span> <a class="small" href="/home/doc/how" data-a="go" data-i="doc" data-j="how">How it works</a></div>' +
    '<p style="margin-top:6px"><button class="small muted" style="text-decoration:underline" data-a="share" data-i="' + esc(pid) + '">Share this item</button> · <button class="small muted" style="text-decoration:underline" data-a="reportitem" data-i="' + esc(pid) + '">Report this listing</button></p></div></div>';
};
function probText(p) {
  var code = p && (p.code || p), n = p && (p.available != null ? p.available : p.left);
  return ({ NOT_AVAILABLE: "No longer available", OWN_PRODUCT: "This is your own item", OUT_OF_STOCK: "Out of stock", ONLY_N_LEFT: n != null ? "Only " + n + " left" : "Fewer left than in your cart", QUANTITY_LIMIT: "Over the quantity limit", CART_TOO_LARGE: "Cart is too large", PRICE_CHANGED: "Price changed" })[code] || String(code);
}
V.cart = function () {
  if (!signedIn()) return V.gate("Your cart", "Sign in to add items to your cart and check out.");
  var k = S.cart;
  if (!k) return head("Your cart") + loadingBox();
  if (!k.items.length) return head("Your cart") + '<div class="empty"><h2>Your cart is empty</h2>Find something you like and add it here.<div style="margin-top:12px"><button class="btn sm" data-a="tab" data-i="home">Start browsing</button></div></div>';
  var byPkg = {}; k.items.forEach(function (i) { (byPkg[i.sellerId] = byPkg[i.sellerId] || []).push(i); });
  var out = head("Your cart");
  k.packages.forEach(function (pk) {
    out += '<h3 style="margin:6px 0">From ' + esc(pk.sellerName) + '</h3><div class="list" style="padding:4px 0">' + (byPkg[pk.sellerId] || []).map(function (i) {
      return '<div class="row" style="align-items:flex-start;display:block"><div style="display:flex;gap:12px"><div style="width:64px;flex:none">' + ph(i.title, i.productId, i.coverImageId, 200) + '</div><div style="flex:1;min-width:0"><b>' + esc(i.title) + '</b><br><span class="muted small">' + esc(variantLabel(i.options)) + "</span><br>" +
        '<span class="price">' + inr(i.unitPricePaise) + "</span>" + (i.problems && i.problems.length ? '<div class="bad small">' + i.problems.filter(function (p) { return (p.code || p) !== "PRICE_CHANGED"; }).map(probText).map(esc).join(", ") + "</div>" : "") + "</div></div>" +
        '<div style="display:flex;align-items:center;gap:10px;margin-top:8px"><div class="qty"><button data-a="cartqty" data-i="' + esc(i.variantId) + '" data-j="-1" aria-label="Fewer">−</button><span>' + i.quantity + '</span><button data-a="cartqty" data-i="' + esc(i.variantId) + '" data-j="1" aria-label="More">+</button></div><span style="flex:1"></span><button class="small bad" data-a="cartrm" data-i="' + esc(i.variantId) + '">Remove</button></div></div>';
    }).join("") + "</div>" +
      '<label class="field"><span>Delivery from ' + esc(pk.sellerName) + '</span><select class="inp" data-delv="' + esc(pk.sellerId) + '">' + pk.deliveryChoices.map(function (d) { return '<option value="' + esc(d.code) + '"' + (pk.delivery.code === d.code ? " selected" : "") + ">" + esc(d.label) + " · " + (d.feePaise ? inr(d.feePaise) : "Free") + "</option>"; }).join("") + "</select></label>";
  });
  out += '<h3 style="margin:8px 0 6px">Coupon</h3>' + (k.coupon ? '<div class="banner" style="display:flex;gap:10px;align-items:center"><span style="flex:1"><b>' + esc(k.coupon.code || "") + '</b><br><span class="small muted">' + esc(k.coupon.description || "Coupon applied") + '</span></span><button class="chip" data-a="couponrm">Remove</button></div>' :
    '<div class="composer" style="position:static;padding:0 0 8px"><input class="inp" id="cpn" placeholder="Enter a coupon code" value="' + esc(UI.coupon) + '" autocapitalize="characters"><button class="btn" data-a="coupon">Apply</button></div>') + (UI.couponErr ? '<p class="bad small">' + esc(UI.couponErr) + "</p>" : "");
  var t = k.totals;
  out += '<div style="margin-top:12px">' + sum("Items", inr(t.itemsSubtotalPaise)) + (t.discountPaise ? sum("Coupon discount", "−" + inr(t.discountPaise)) : "") + sum("Delivery", t.deliveryPaise ? inr(t.deliveryPaise) : "Free") + sum("Buyer Protection", inr(t.buyerProtectionPaise)) + sum("Total", inr(t.totalPaise), "total") + "</div>" +
    '<p class="muted small">Prices include GST (' + inr(t.gstIncludedInItemsPaise) + " in items).</p>" +
    '<button class="btn block" data-a="checkout"' + (k.canCheckout ? "" : " disabled") + ">Go to checkout</button>" + (k.canCheckout ? "" : '<p class="bad small">Fix the items marked above to continue.</p>');
  return out;
};
V.gate = function (title, msg) { return head(title) + '<div class="empty"><h2>Sign in to continue</h2>' + esc(msg || "") + '<div style="margin-top:12px"><button class="btn" data-a="go" data-i="auth">Sign in or create account</button></div></div>'; };
V.auth = function () {
  var A = UI.auth, reg = A.mode === "register";
  return '<div class="auth"><button class="back" data-a="back" aria-label="Back" style="margin-bottom:12px"><span class="chev" style="transform:rotate(-135deg);margin-left:4px"></span></button><h1>Reloved</h1><p class="muted">' + (reg ? "Create your account to buy and sell pre-owned items." : "Sign in to your account.") + "</p>" +
    '<form id="af" novalidate>' + (reg ? '<label class="field"><span>Full name</span><input class="inp" id="an" autocomplete="name" maxlength="80"></label>' : "") +
    '<label class="field"><span>Email</span><input class="inp" id="ae" type="email" autocomplete="email" inputmode="email"></label>' +
    '<label class="field"><span>Password' + (reg ? " (at least 10 characters)" : "") + '</span><input class="inp" id="ap" type="password" autocomplete="' + (reg ? "new-password" : "current-password") + '"></label>' +
    (reg ? '<label class="field"><span>Phone (optional)</span><input class="inp" id="aph" inputmode="tel" autocomplete="tel"></label>' : "") +
    '<p class="bad small" id="aerr">' + esc(A.err) + '</p><button class="btn block" type="submit"' + (A.busy ? " disabled" : "") + ">" + (A.busy ? "Please wait…" : reg ? "Create account" : "Sign in") + "</button></form>" +
    '<div class="two"><button class="btn ghost" data-a="authmode" data-i="' + (reg ? "login" : "register") + '">' + (reg ? "I have an account" : "Create account") + "</button></div>" +
    (reg ? "" : '<p style="margin-top:12px"><button class="small" style="color:var(--accent);text-decoration:underline" data-a="go" data-i="forgot">Forgot your password?</button></p>') + "</div>";
};
V.checkout = function () {
  if (!signedIn()) return V.gate("Checkout", "Sign in to check out.");
  var k = S.cart;
  if (!k || !k.items.length) return head("Checkout", true) + '<div class="empty"><h2>Your cart is empty</h2></div>';
  var c = need("addresses", function () { return api.get("/me/addresses").then(function (r) { return r.items || r; }); });
  var t = k.totals, K = UI.ck;
  var out = head("Checkout", true) + '<h3 style="margin:0 0 6px">Delivery address</h3>';
  if (c.st === "loading") out += loadingBox();
  else if (c.st === "err") out += failBox(c.err);
  else {
    var list = c.data || [];
    if (!K.addressId || !list.some(function (a) { return a.id === K.addressId; })) { var d = list.filter(function (a) { return a.isDefault; })[0] || list[0]; K.addressId = d ? d.id : ""; }
    if (!list.length) K.adding = true;
    out += (list.length ? '<div class="list">' + list.map(function (a) { return '<button class="row" data-a="addr" data-i="' + esc(a.id) + '"><span class="ic">' + (K.addressId === a.id ? "✓" : "") + '</span><span class="l"><b>' + esc(a.name) + "</b><br>" + esc(a.line1) + (a.line2 ? ", " + esc(a.line2) : "") + "<br>" + esc(a.city) + ", " + esc(a.state) + " " + esc(a.pincode) + '<br><span class="muted small">' + esc(a.phone) + "</span></span></button>"; }).join("") + "</div>" : "") +
      (K.adding ? addressForm() : '<button class="btn ghost block" data-a="addrnew" style="margin-bottom:12px">Add a new address</button>');
  }
  out += '<h3 style="margin:8px 0 6px">Order summary</h3>' + k.packages.map(function (pk) { return sum(esc(pk.sellerName) + " · " + esc(pk.delivery.label), pk.delivery.feePaise ? inr(pk.delivery.feePaise) : "Free"); }).join("") +
    sum("Items (" + cartCount() + ")", inr(t.itemsSubtotalPaise)) + (t.discountPaise ? sum("Coupon discount", "−" + inr(t.discountPaise)) : "") + sum("Delivery", t.deliveryPaise ? inr(t.deliveryPaise) : "Free") + sum("Buyer Protection", inr(t.buyerProtectionPaise)) + sum("Total", inr(t.totalPaise), "total") +
    '<div class="banner warn" style="margin-top:12px"><b>Online payment is not switched on yet</b><span class="small">You can place the order, but it cannot be paid for now. Unpaid orders are released automatically after 15 minutes.</span></div>' +
    (K.err ? '<p class="bad small">' + esc(K.err) + "</p>" : "") +
    '<button class="btn block" data-a="place"' + (K.busy || !K.addressId || !k.canCheckout ? " disabled" : "") + ">" + (K.busy ? "Placing order…" : "Place order · " + inr(t.totalPaise)) + "</button>";
  return out;
};
function addressForm() {
  return '<div class="banner"><b>New address</b><label class="field"><span>Full name</span><input class="inp" id="adn" autocomplete="name"></label><label class="field"><span>Phone</span><input class="inp" id="adp" inputmode="tel" autocomplete="tel"></label>' +
    '<label class="field"><span>Address line 1</span><input class="inp" id="ad1" autocomplete="address-line1"></label><label class="field"><span>Address line 2 (optional)</span><input class="inp" id="ad2" autocomplete="address-line2"></label>' +
    '<label class="field"><span>Landmark (optional)</span><input class="inp" id="adl"></label><div class="two"><label class="field"><span>City</span><input class="inp" id="adc" autocomplete="address-level2"></label><label class="field"><span>State</span><input class="inp" id="ads" autocomplete="address-level1"></label></div>' +
    '<label class="field"><span>PIN code</span><input class="inp" id="adz" inputmode="numeric" maxlength="6" autocomplete="postal-code"></label><p class="bad small" id="aderr"></p><div class="two"><button class="btn" data-a="addrsave">Save address</button><button class="btn ghost" data-a="addrcancel">Cancel</button></div></div>';
}
V.addresses = function () {
  if (!signedIn()) return V.gate("Addresses", "Sign in to manage your addresses.");
  var c = need("addresses", function () { return api.get("/me/addresses").then(function (r) { return r.items || r; }); });
  var out = head("My addresses", true);
  if (c.st === "loading") return out + loadingBox();
  if (c.st === "err") return out + failBox(c.err);
  var list = c.data || [];
  out += list.length ? '<div class="list">' + list.map(function (a) { return '<div class="row" style="display:block"><b>' + esc(a.name) + (a.isDefault ? ' <span class="pill ok">Default</span>' : "") + "</b><br>" + esc(a.line1) + (a.line2 ? ", " + esc(a.line2) : "") + "<br>" + esc(a.city) + ", " + esc(a.state) + " " + esc(a.pincode) + '<br><span class="muted small">' + esc(a.phone) + '</span><div style="margin-top:8px;display:flex;gap:8px">' + (a.isDefault ? "" : '<button class="btn ghost sm" data-a="addrdef" data-i="' + esc(a.id) + '">Make default</button>') + '<button class="btn danger sm" data-a="addrdel" data-i="' + esc(a.id) + '">Delete</button></div></div>'; }).join("") + "</div>" : '<div class="empty">No saved addresses yet.</div>';
  return out + (UI.ck.adding ? addressForm() : '<button class="btn ghost block" data-a="addrnew">Add a new address</button>');
};
V.orders = function () {
  if (!signedIn()) return V.gate("My orders", "Sign in to see your orders.");
  var c = need("orders", function () { return api.get("/orders?limit=50"); });
  var out = head("My orders", true);
  if (c.st === "loading") return out + loadingBox();
  if (c.st === "err") return out + failBox(c.err);
  var o = c.data.items || [];
  return out + (o.length ? '<div class="list">' + o.map(function (x) { return '<button class="row" data-a="order" data-i="' + esc(x.id) + '"><span class="l"><b>Order ' + esc(x.number) + '</b><br><span class="muted small">' + when(x.placedAt) + " · " + x.itemCount + (x.itemCount === 1 ? " item" : " items") + '</span><br><span class="price">' + inr(x.totalPaise) + '</span></span><span class="pill ' + stClass(x.status) + '">' + esc(stLabel(x.status)) + "</span></button>"; }).join("") + "</div>" : '<div class="empty"><h2>No orders yet</h2>When you place an order it shows up here.</div>');
};
function rateBoxHTML(pk, rc) {
  if (!rc || rc.st === "loading") return '<div class="ratebox"><div class="sk" style="height:18px;width:50%"></div></div>';
  if (rc.st === "err") return "";
  var ex = (rc.data.items || []).filter(function (r) { return r.packageId === pk.id; })[0], f = UI.rate[pk.id];
  if (ex && !f) {
    return '<div class="ratebox"><b>Your rating for ' + esc(pk.sellerName) + '</b><div class="stars-row" aria-label="You gave ' + ex.stars + ' out of 5">' + "★".repeat(ex.stars) + '<span class="off">' + "★".repeat(5 - ex.stars) + "</span></div>" + (ex.comment ? '<p class="small" style="margin:4px 0">' + esc(ex.comment) + "</p>" : "") +
      (ex.canEdit ? '<button class="btn ghost sm" data-a="redit" data-i="' + esc(pk.id) + '">Change rating</button>' : '<span class="muted small">Ratings can be changed for 7 days.</span>') + "</div>";
  }
  f = f || { stars: 0, comment: "" };
  var st = "";
  for (var n = 1; n <= 5; n++) st += '<button class="star' + (n <= f.stars ? " on" : "") + '" data-a="rstar" data-i="' + esc(pk.id) + '" data-j="' + n + '" aria-label="' + n + (n === 1 ? " star" : " stars") + '" aria-pressed="' + (n === f.stars) + '">★</button>';
  return '<div class="ratebox"><b>' + (ex ? "Change your rating" : "Rate " + esc(pk.sellerName)) + '</b><div class="stars-row">' + st + '</div><textarea class="inp" id="rc-' + esc(pk.id) + '" maxlength="300" rows="2" placeholder="Add a comment (optional)">' + esc(f.comment) + '</textarea><div class="ratebtns"><button class="btn sm" data-a="rsave" data-i="' + esc(pk.id) + '"' + (f.stars ? "" : " disabled") + '>Submit rating</button>' + (ex ? '<button class="btn ghost sm" data-a="rcancel" data-i="' + esc(pk.id) + '">Cancel</button>' : "") + "</div></div>";
}
V.order = function (id) {
  if (!signedIn()) return V.gate("Order", "Sign in to see this order.");
  var c = need("order:" + id, function () { return api.get("/orders/" + id); });
  if (c.st === "loading") return head("Order", true) + loadingBox();
  if (c.st === "err") return head("Order", true) + (c.code === "NOT_FOUND" ? '<div class="empty"><h2>Order not found</h2></div>' : failBox(c.err));
  var o = c.data, t = o.totals, a = o.shippingAddress || {}, unpaid = o.status === "pending_payment";
  var out = head("Order " + esc(o.number), true) + '<p><span class="pill ' + stClass(o.status) + '">' + esc(stLabel(o.status)) + '</span> <span class="muted small">Placed ' + when(o.placedAt) + "</span></p>";
  if (unpaid) out += '<div class="banner warn"><b>Waiting for payment</b><span class="small">Online payment is not switched on yet, so this order cannot be paid for now. It is released automatically at ' + when(o.expiresAt) + ".</span></div>";
  if (o.cancelledAt) out += '<div class="banner"><b>Cancelled</b><span class="small muted">' + esc(o.cancelReason || "") + "</span></div>";
  var rc = o.packages.some(function (pk) { return pk.status === "delivered"; }) ? need("ratings:mine", function () { return api.get("/ratings/mine"); }) : null;
  o.packages.forEach(function (pk) {
    out += '<h3 style="margin:14px 0 6px">From ' + esc(pk.sellerName) + ' <span class="pill ' + stClass(pk.status) + '">' + esc(stLabel(pk.status)) + '</span></h3><div class="list">' + pk.items.map(function (i) { return '<button class="row" data-a="item" data-i="' + esc(i.productId) + '"><span class="l"><b>' + esc(i.title) + '</b><br><span class="muted small">' + esc(variantLabel(i.options)) + " × " + i.quantity + '</span></span><span class="v">' + inr(i.netPaise) + "</span></button>"; }).join("") + "</div>" +
      '<p class="muted small">' + esc(pk.delivery.label) + " · " + (pk.delivery.feePaise ? inr(pk.delivery.feePaise) : "Free") + (pk.carrier ? " · " + esc(pk.carrier) + " " + esc(pk.trackingNumber || "") : "") + "</p>" + (pk.status === "delivered" ? rateBoxHTML(pk, rc) : "") +
      (o.paymentStatus !== "unpaid" && o.status !== "cancelled" && (pk.status === "confirmed" || pk.status === "processing") ? '<button class="btn danger sm" data-a="pcancel" data-i="' + esc(o.id) + '" data-j="' + esc(pk.id) + '">' + (UI.confirm === pk.id ? "Tap again to cancel this package" : "Cancel this package") + "</button>" : "");
  });
  out += '<div style="margin-top:14px">' + sum("Items", inr(t.itemsSubtotalPaise)) + (t.discountPaise ? sum("Coupon discount", "−" + inr(t.discountPaise)) : "") + sum("Delivery", t.deliveryPaise ? inr(t.deliveryPaise) : "Free") + sum("Buyer Protection", inr(t.buyerProtectionPaise)) + sum("Total", inr(t.totalPaise), "total") + "</div>" +
    '<p class="muted small">Deliver to: ' + esc(a.name) + ", " + esc(a.line1) + (a.line2 ? ", " + esc(a.line2) : "") + ", " + esc(a.city) + ", " + esc(a.state) + " " + esc(a.pincode) + "</p>";
  if (unpaid) out += '<button class="btn danger block" data-a="ocancel" data-i="' + esc(o.id) + '">' + (UI.confirm === o.id ? "Tap again to cancel the order" : "Cancel order") + "</button>";
  else if (o.paymentStatus !== "unpaid" && o.status !== "cancelled" && o.status !== "shipped" && o.status !== "delivered") out += '<button class="btn danger block" data-a="ocancel" data-i="' + esc(o.id) + '">' + (UI.confirm === o.id ? "Tap again to cancel the order" : "Cancel order") + "</button>";
  var hist = o.packages.reduce(function (a2, pk) { return a2.concat((pk.history || []).map(function (h) { return { h: h, pk: pk.number }; })); }, []).sort(function (x, y) { return new Date(y.h.at) - new Date(x.h.at); });
  if (hist.length) out += '<h3 style="margin:18px 0 6px">History</h3><div class="list">' + hist.map(function (x) { return '<div class="row"><span class="l">' + esc(stLabel(x.h.to)) + '<br><span class="muted small">' + esc(x.pk) + " · " + when(x.h.at) + (x.h.reason ? " · " + esc(x.h.reason) : "") + "</span></span></div>"; }).join("") + "</div>";
  return out;
};
V.wish = function () {
  if (!signedIn()) return V.gate("Favourite items", "Sign in to save items you like.");
  var v = Object.keys(S.wish).map(function (k) { var w = S.wish[k]; return { id: w.productId, title: w.title, minPricePaise: w.minPricePaise, coverImageId: w.coverImageId, inStock: w.inStock, condition: "", brandName: "" }; });
  return head("Favourite items", true) + (v.length ? '<div class="grid">' + v.map(function (i) { var f = card(i); return f.replace(/<div class="m">.*?<\/div>/, ""); }).join("") + "</div>" : '<div class="empty"><h2>No favourites yet</h2>Tap the heart on an item to save it.</div>');
};
V.profile = function () {
  if (!signedIn()) return head("Profile") + '<div class="empty"><h2>Welcome to Reloved</h2>Sign in to see your orders, favourites and addresses.<div style="margin-top:12px"><button class="btn" data-a="go" data-i="auth">Sign in or create account</button></div></div>' + docRows();
  var u = S.user, roles = (u.roles || []).filter(function (r) { return r !== "customer"; });
  return '<div class="bar"><span class="av" style="background:var(--accent);color:var(--accent-ink)">' + esc(String(u.fullName || u.email).slice(0, 1).toUpperCase()) + '</span><div style="flex:1;min-width:0"><h2>' + esc(u.fullName || "Your account") + '</h2><span class="muted small">' + esc(u.email) + "</span>" + roles.map(function (r) { return ' <span class="pill ok">' + esc(r) + "</span>"; }).join("") + "</div></div>" +
    '<div class="list">' + row("O", "My orders", "", 'data-a="go" data-i="orders"') + ((u.roles || []).indexOf("seller") > -1 ? row("$", "Seller dashboard", "", 'data-a="tab" data-i="sell"') : "") + (S.perms.length ? row("★", "Admin", "", 'data-a="go" data-i="admin"') : "") + row("♥", "Favourite items", Object.keys(S.wish).length || "", 'data-a="go" data-i="wish"') + row("A", "My addresses", "", 'data-a="go" data-i="addresses"') + row("S", "Settings", "", 'data-a="go" data-i="settings"') + "</div>" + docRows();
};
function docRows() {
  return '<div class="list">' + row("?", "How it works", "", 'data-a="go" data-i="doc" data-j="how"') + row("i", "Help Centre", "", 'data-a="go" data-i="help"') + row("§", "Terms &amp; legal", "", 'data-a="go" data-i="legal"') + row("A", "About us", "", 'data-a="go" data-i="about"') + "</div>";
}
V.settings = function () {
  if (!signedIn()) return V.gate("Settings", "Sign in to change your settings.");
  var u = S.user;
  return head("Settings", true) + '<label class="field"><span>Full name</span><input class="inp" id="setn" maxlength="80" value="' + esc(u.fullName || "") + '"></label><button class="btn block" data-a="savename">Save name</button>' +
    '<h3 style="margin:18px 0 6px">Change password</h3><label class="field"><span>Current password</span><input class="inp" id="pw0" type="password" autocomplete="current-password"></label><label class="field"><span>New password (at least 10 characters)</span><input class="inp" id="pw1" type="password" autocomplete="new-password"></label><button class="btn ghost block" data-a="savepw">Change password</button>' +
    '<div class="list" style="margin-top:18px">' + row("T", "Light / dark theme", "", 'data-a="theme"') + row("+", "Install app", "", 'data-a="install"') + row("O", "Sign out", "", 'data-a="signout"') + row("X", "Sign out everywhere", "", 'data-a="signoutall"') + "</div>" +
    '<div class="list" style="margin-top:14px">' + row("B", "Blocked users", "", 'data-a="go" data-i="blocked"') + row("!", "Delete my account", "", 'data-a="go" data-i="delacct"') + "</div>";
};
var DOCS = {
  how: ["How it works", "Browse or search for items and add what you like to your cart. At checkout choose a delivery address and place the order. Buyer Protection is added to every order. Sellers pack and ship their own items, and you can follow each package on the order page. If something arrives damaged or fake you can ask for a return within 7 days of delivery."],
  trust: ["Trust and Safety", "Keep all payments inside the app. Never share your password. Buyer Protection covers orders placed and paid through the app only."],
  platform: ["Our platform", "Reloved is a marketplace for pre-owned items. Each seller is verified before they can sell, and every listing is reviewed before it goes live. This is a trial version: online payments and email are not switched on yet."],
  privacy: ["Privacy Centre", "We store your name, email, addresses, orders and favourites so the app can work. Passwords are stored only as secure hashes. Sellers' identity documents are encrypted and visible only to the review team. Nothing is sold to third parties."]
};
V.doc = function (k) { var d = DOCS[k] || ["Information", "No content."]; return head(esc(d[0]), true) + "<p>" + esc(d[1]) + "</p>"; };
V.help = function () {
  var q = [["How do I pay?", "Online payment is not switched on yet in this trial. You can place an order, but it cannot be paid for now, and unpaid orders are released after 15 minutes."], ["What does delivery cost?", "Each seller's package has its own delivery fee: home delivery, pickup point or meet and collect. You choose in the cart and see the total before you order."], ["Can I cancel an order?", "Yes. Unpaid orders can be cancelled any time. A paid package can be cancelled until the seller ships it, and you get your money back."], ["Can I return an item?", "Within 7 days of delivery if it arrived damaged or is fake. Add photos to your request. Size returns are not accepted because items are pre-owned."], ["I forgot my password", "Password reset by email is not available yet."]];
  // The chat checks the page's domain, so it is offered on the website only, not inside the Android app.
  return head("Help Centre", true) + (api.isApp ? "" : '<button class="btn block" data-a="nova" style="margin-bottom:12px">Chat with us</button>') + '<div class="list">' + q.map(function (x) { return '<div class="row" style="display:block"><b>' + x[0] + '</b><br><span class="muted">' + x[1] + "</span></div>"; }).join("") + "</div>";
};
V.about = function () { return head("About", true) + '<div class="list">' + [["Our platform", "platform"], ["How it works", "how"], ["Trust and Safety", "trust"]].map(function (t) { return row("i", t[0], "", 'data-a="go" data-i="doc" data-j="' + t[1] + '"'); }).join("") + "</div>"; };
V.legal = function () { return head("Terms &amp; legal", true) + '<div class="list">' + row("§", "User Terms and Conditions", "", 'data-a="go" data-i="tc"') + row("§", "Privacy Centre", "", 'data-a="go" data-i="doc" data-j="privacy"') + '<a class="row" href="'+(window.APP_CONFIG.SITE||"")+'/privacy.html" target="_blank" rel="noopener"><span class="ic">§</span><span class="l">Full Privacy Policy</span><span class="chev"></span></a><a class="row" href="'+(window.APP_CONFIG.SITE||"")+'/terms.html" target="_blank" rel="noopener"><span class="ic">§</span><span class="l">Terms of Use</span><span class="chev"></span></a>' + "</div>"; };
V.tc = function () {
  return head("User Terms and Conditions", true) + '<div class="doc"><h3>1. About you and us</h3><p>Who runs the service and what the defined terms mean.</p><h3>2. Your account</h3><p>Keep your account secure and report unauthorised use. Members must be 18 or over.</p><h3>3. Buying</h3><p>Prices include GST. Delivery and Buyer Protection fees are shown before you order. Pay only through the app to keep Buyer Protection.</p><h3>4. Selling</h3><p>Sellers are verified before they can sell. List only items you own and describe them honestly. Counterfeit, illegal or unsafe items are not allowed.</p><h3>5. Cancellations and returns</h3><p>A paid package can be cancelled until it ships. Returns are accepted within 7 days of delivery for damaged or fake items only.</p><p class="small">Summary for the trial. Not legal advice.</p></div>';
};

/* ============ render / navigation ============ */
var GATED = { cart: 1, checkout: 1, orders: 1, order: 1, wish: 1, addresses: 1, settings: 1 };
function cur() { return stack.length ? stack[stack.length - 1] : { v: tab }; }
function typing() { var a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"); }
var dirty = false;
function render() {
  dirty = false;
  var main = $("main"), nav = $("nav");
  if (!S.ready) return;
  var c = cur(), v = c.v, keep = window.pageYOffset, same = main.dataset.v === v + ":" + (c.p || ""), mod = MOD_OF[v];
  if (mod && modState[mod] !== "ok") {
    loadMod(mod);
    main.innerHTML = head("", stack.length > 0) + (modState[mod] === "err" ? failBox("Check your connection and try again.", "modretry") : loadingBox()); main.dataset.v = "";
    nav.hidden = false; renderNav(); syncUrl(); return;
  }
  // Opened from a link: keep the server's copy of the item on screen until the app has the item, instead of "Loading…".
  var pending = v === "item" && C["item:" + c.p] && C["item:" + c.p].st === "loading";
  if (pending && main.querySelector(".ssr")) { nav.hidden = false; renderNav(); return; }
  main.innerHTML = (V[v] || V.home)(c.p); main.dataset.v = v + ":" + (c.p || "");
  nav.hidden = v === "auth";
  renderNav(); syncUrl(); docHead();
  setNavHeight();
  if (same) window.scrollTo(0, keep);
  if (window.RL) RL.hooks.forEach(function (f) { try { f(); } catch (e) { } });
}
function renderNav() {
  var nav = $("nav"), n = cartCount(), u = S.unread || 0;
  var I = function (d) { return '<svg viewBox="0 0 24 24">' + d + "</svg>"; };
  var tabs = [
    ["home", "Home", I('<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>')],
    ["discover", "Discover", I('<rect x="4" y="4" width="12" height="16" rx="2"/><path d="M19 7l2 11-4 1"/>')],
    ["sell", "Sell", I('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>')],
    ["inbox", "Inbox", I('<path d="M4 5h16v11H10l-5 4v-4H4z"/>')],
    ["cart", "Cart", I('<path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>')],
    ["profile", "Profile", I('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>')]
  ];
  var badge = { cart: n, inbox: u };
  // Laptop header, as on Vinted, Nike and Foot Locker: logo, a search box that is on every page, the account links and a
  // Sell button, with category links in a second row. Phones and tablets hide these (CSS) and keep the bottom tab bar.
  var topc = UI.cat ? UI.cat.split("/")[0] : "", onHome = !stack.length && tab === "home";
  var brandAndSearch = '<a class="navbrand" href="/" data-a="browse" data-i="" data-j="reset">Re<em>loved</em></a>' +
    '<form class="navsearch" id="nf" role="search"><span class="muted" aria-hidden="true">&#9906;</span><input id="nq" type="search" placeholder="Search for items" aria-label="Search for items" value="' + esc(UI.q) + '"></form>';
  var catRow = '<div class="navcats" role="navigation" aria-label="Categories"><a href="/" data-a="browse" data-i="" data-j="reset" class="' + (onHome && !UI.cat && !UI.q.trim() ? "on" : "") + '">Just listed</a>' +
    topCats().map(function (c) { return '<a href="' + esc(catUrl(c.path)) + '" data-a="browse" data-i="' + esc(c.path) + '" data-j="reset" class="' + (onHome && topc === c.path ? "on" : "") + '">' + esc(c.name) + "</a>"; }).join("") + "</div>";
  var util = '<div class="utilbar"><span class="util-msg">Buyer Protection on every order &middot; Meet-up delivery is free</span><span class="util-links"><a href="/home/help" data-a="go" data-i="help">Help</a><a href="/sell" data-a="tab" data-i="sell">Sell</a>' +
    (signedIn() ? '<a href="/profile" data-a="tab" data-i="profile">Hi, ' + esc(String((S.user && S.user.fullName) || "there").split(" ")[0]) + "</a>" : '<a href="/profile" data-a="tab" data-i="profile">Sign up</a><a href="/profile" data-a="tab" data-i="profile">Log in</a>') +
    '<button data-a="theme" class="util-theme" aria-label="Switch light or dark theme"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg></button></span></div>';
  nav.innerHTML = util + brandAndSearch + tabs.map(function (t) {
    var on = (!stack.length && tab === t[0]) || (stack.length && t[0] === "inbox" && cur().v === "chat");
    // Cart is hidden from the phone tab bar by CSS (it sits in the home header there) and shown in the desktop top bar.
    return '<button data-a="tab" data-i="' + t[0] + '" class="t-' + t[0] + (on ? " on" : "") + '" aria-label="' + t[1] + '">' + t[2] + "<span>" + t[1] + "</span>" + (badge[t[0]] ? '<i class="dot">' + (badge[t[0]] > 9 ? "9+" : badge[t[0]]) + "</i>" : "") + "</button>";
  }).join("") + catRow;
}
// The tab title and canonical address follow the screen. Item and category pages also get these in the first HTML
// from the server (api/page.js), for search engines and link previews that do not run scripts.
var SITE_TITLE = "Reloved: preloved fashion and more from verified Indian sellers";
function docHead() {
  var c = cur(), t = SITE_TITLE, cat = catByPath(UI.cat);
  if (c.v === "item" && !PTITLE[c.p]) return; // still loading: keep the title the server sent
  if (c.v === "item") t = PTITLE[c.p] + " | Reloved";
  else if (!stack.length && tab === "home") t = UI.q.trim() ? "“" + UI.q.trim() + "” | Reloved" : UI.sellerId ? (UI.sellerName || "Seller") + " | Reloved" : cat ? "Preloved " + cat.name + " | Reloved" : SITE_TITLE;
  document.title = t;
  var canon = document.querySelector('link[rel="canonical"]');
  if (canon) canon.href = (window.APP_CONFIG.CANONICAL || location.origin) + urlFor();
}
function refresh() { if (typing()) { dirty = true; return; } render(); }
document.addEventListener("focusout", function () { setTimeout(function () { if (dirty && !typing()) render(); }, 50); });
function enter(v, p) {
  if (v === "cart" && signedIn()) loadCart().then(refresh);
  if (v === "orders") drop("orders");
  if (v === "order") drop("order:" + p);
  if (v === "addresses" || v === "checkout") { UI.ck.adding = false; if (v === "addresses") drop("addresses"); if (v === "checkout" && signedIn()) loadCart().then(refresh); }
  if (v === "wish" && signedIn()) loadWish().then(refresh);
  if (v === "item") { drop("item:" + p); if (signedIn() && !S.cart) loadCart().then(refresh); }
  if (v === "auth") UI.auth.err = "";
  if (v === "home" && !UI.feed.loaded) loadFeed(false);
  if (window.RL && RL.E && RL.E[v]) RL.E[v](p);
}
// The page scrolls, so a new screen starts at the top and going back puts the old position back (see popstate).
function toTop() { window.scrollTo(0, 0); }
function go(v, p) { UI.confirm = null; navPush(); stack.push({ v: v, p: p }); enter(v, p); render(); toTop(); }
function setTab(t) { stack = []; tab = t; UI.confirm = null; navPush(); enter(t); render(); toTop(); }
// If this visit pushed the current entry, step back through the browser history so its Back button stays in step;
// popstate then restores the previous screen. Otherwise (opened from a link) just drop the top screen.
function back() {
  UI.confirm = null;
  if (depth > 0 && history.state && history.state.d === depth) { history.back(); return; }
  stack.pop(); render();
}
function replace(v, p) { UI.confirm = null; stack.pop(); stack.push({ v: v, p: p }); enter(v, p); render(); toTop(); }
function afterAuth() { if (cur().v === "auth") stack.pop(); drop(""); S.ready = true; render(); if (tab === "home" || !UI.feed.loaded) loadFeed(false); }

/* ============ actions ============ */
async function act(a, i, j, el) {
  switch (a) {
    case "tab": setTab(i); return;
    case "back": back(); return;
    case "go": go(i, j || undefined); return;
    case "reload": location.reload(); return;
    case "modretry": Object.keys(modState).forEach(function (k) { if (modState[k] === "err") delete modState[k]; }); render(); return;
    case "nova": openHelpChat(); return;
    case "share": {
      var link = (window.APP_CONFIG.CANONICAL || location.origin) + itemUrl(i);
      if (navigator.share) { try { await navigator.share({ title: PTITLE[i] || "Reloved", url: link }); } catch (e) { } return; }
      try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch (e) { toast(link); }
      return;
    }
    case "item": go("item", i); return;
    case "cat": UI.cat = i; navPush(); loadFeed(false); render(); return;
    case "browse": UI.cat = i; if (j === "reset") { UI.q = ""; UI.sellerId = ""; UI.sellerName = ""; } stack = []; tab = "home"; navPush(); loadFeed(false); render(); return;
    case "rmfil": {
      if (i === "cond") { var cs2 = condSet(), at2 = cs2.indexOf(j); if (at2 > -1) cs2.splice(at2, 1); UI.cond = cs2.join(","); }
      else if (i === "price") UI.minp = UI.maxp = "";
      else UI[i] = "";
      loadFeed(false); render(); return;
    }
    case "scrolllist": { var lt = $("listing-top"); if (lt) lt.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    case "hidefil": UI.hidefil = !UI.hidefil; render(); return;
    case "fil": UI.fil = !UI.fil; if (UI.fil) loadBrands(); render(); return;
    case "condtog": { var cs = condSet(), at = cs.indexOf(i); if (at > -1) cs.splice(at, 1); else cs.push(i); UI.cond = cs.join(","); loadFeed(false); render(); return; }
    case "filclear": UI.cond = UI.brand = UI.size = UI.colour = UI.minp = UI.maxp = ""; UI.sort = ""; loadFeed(false); render(); return;
    case "more": loadFeed(true); return;
    case "feedretry": loadFeed(UI.feed.items.length > 0); return;
    case "seller": UI.sellerId = i; UI.sellerName = j; UI.cat = ""; UI.q = ""; stack = []; tab = "home"; navPush(); loadFeed(false); render(); return;
    case "clearseller": UI.sellerId = ""; UI.sellerName = ""; navPush(); loadFeed(false); render(); return;
    case "vsel": UI.pdv[i] = j; render(); return;
    case "fav": {
      if (!signedIn()) { toast("Sign in to save favourites"); go("auth"); return; }
      var had = !!S.wish[i];
      try { if (had) await api.del("/me/wishlist/" + i); else await api.put("/me/wishlist/" + i); } catch (e) { toast(errText(e)); return; }
      if (had) delete S.wish[i]; else { S.wish[i] = { productId: i }; loadWish().then(function () { refresh(); partialFeed(); }); }
      refresh(); partialFeed(); return;
    }
    case "addcart": {
      if (!signedIn()) { toast("Sign in to add items to your cart"); go("auth"); return; }
      if (UI.busy) return; UI.busy = true;
      var q = (S.cart && S.cart.items.filter(function (x) { return x.variantId === i; })[0] || { quantity: 0 }).quantity + 1;
      try { S.cart = await api.put("/cart/items/" + i, { quantity: q }); toast("Added to cart"); }
      catch (e) { toast(e.code === "OWN_PRODUCT" ? "This is your own listing." : errText(e)); }
      UI.busy = false; render(); return;
    }
    case "cartqty": {
      var line = S.cart.items.filter(function (x) { return x.variantId === i; })[0], nq = line.quantity + Number(j);
      try { S.cart = nq <= 0 ? await api.del("/cart/items/" + i) : await api.put("/cart/items/" + i, { quantity: nq }); }
      catch (e) { toast(errText(e)); await loadCart(); }
      UI.couponErr = ""; render(); return;
    }
    case "cartrm": try { S.cart = await api.del("/cart/items/" + i); } catch (e) { toast(errText(e)); await loadCart(); } render(); return;
    case "coupon": {
      var code = val("cpn"); UI.coupon = code; if (!code) { UI.couponErr = "Enter a code."; render(); return; }
      try { S.cart = await api.post("/cart/coupon", { code: code }); UI.couponErr = ""; UI.coupon = ""; toast("Coupon applied"); }
      catch (e) { UI.couponErr = e.code === "COUPON_NOT_APPLICABLE" && e.details && e.details.shortfallPaise ? "Add " + inr(e.details.shortfallPaise) + " more to use this coupon." : errText(e); }
      render(); return;
    }
    case "couponrm": try { S.cart = await api.del("/cart/coupon"); } catch (e) { toast(errText(e)); } render(); return;
    case "checkout": if (!S.cart || !S.cart.canCheckout) { toast("Fix the items marked in your cart first"); return; } UI.ck.err = ""; go("checkout"); return;
    case "addr": UI.ck.addressId = i; UI.ck.idem = null; render(); return;
    case "addrnew": UI.ck.adding = true; render(); return;
    case "addrcancel": UI.ck.adding = false; render(); return;
    case "addrsave": {
      var b = { name: val("adn"), phone: val("adp"), line1: val("ad1"), line2: val("ad2") || undefined, landmark: val("adl") || undefined, city: val("adc"), state: val("ads"), pincode: val("adz") };
      var bad = checkRules(ADDR_RULES);
      if (!showFieldErrors(bad, "aderr")) return;
      try {
        var r = await api.post("/me/addresses", b); UI.ck.addressId = r.id; UI.ck.adding = false; UI.ck.idem = null; drop("addresses"); toast("Address saved");
      } catch (e) { var se = serverFieldErrors(e, ADDR_RULES); showFieldErrors(se.fields, "aderr", se.other); return; }
      render(); return;
    }
    case "addrdel": try { await api.del("/me/addresses/" + i); drop("addresses"); if (UI.ck.addressId === i) UI.ck.addressId = ""; } catch (e) { toast(errText(e)); } render(); return;
    case "addrdef": try { await api.patch("/me/addresses/" + i, { isDefault: true }); drop("addresses"); } catch (e) { toast(errText(e)); } render(); return;
    case "place": {
      var K = UI.ck; if (K.busy) return;
      if (!K.addressId) { K.err = "Choose or add a delivery address."; render(); return; }
      K.busy = true; K.err = ""; render();
      var key = K.idem || (K.idem = uuid());
      try {
        var o = await api.post("/checkout", { addressId: K.addressId, expectedTotalPaise: S.cart.totals.totalPaise }, { headers: { "Idempotency-Key": key } });
        K.idem = null; K.busy = false; drop("order"); loadCart().then(refresh);
        stack.pop(); go("order", o.id); toast("Order placed"); return;
      } catch (e) {
        K.busy = false;
        if (e.code === "PENDING_ORDER_EXISTS" && e.details && e.details.orderId) { K.idem = null; stack.pop(); go("order", e.details.orderId); toast("You already have an unpaid order. Cancel it to place a new one."); return; }
        if (e.code === "TOTAL_CHANGED") { K.idem = null; await loadCart(); K.err = "The total changed. Please review it and place the order again."; }
        else if (e.status === 0 || e.status >= 500) K.err = errText(e) + " It is safe to try again; you will not be charged twice.";
        else { K.idem = null; K.err = errText(e); await loadCart(); }
        render(); return;
      }
    }
    case "order": go("order", i); return;
    case "ocancel": {
      if (UI.confirm !== i) { UI.confirm = i; render(); return; }
      UI.confirm = null;
      try { await api.post("/orders/" + i + "/cancel", { reason: "Cancelled by buyer" }); toast("Order cancelled"); drop("order"); drop("orders"); await loadCart(); }
      catch (e) { toast(errText(e)); }
      render(); return;
    }
    case "rstar": case "redit": case "rcancel": case "rsave": {
      var ta = document.getElementById("rc-" + i), cur = UI.rate[i], ex0 = ((C["ratings:mine"] || {}).data || { items: [] }).items.filter(function (r) { return r.packageId === i; })[0];
      if (a === "rcancel") { delete UI.rate[i]; render(); return; }
      if (a === "redit") { UI.rate[i] = { stars: ex0 ? ex0.stars : 0, comment: ex0 && ex0.comment || "" }; render(); return; }
      cur = cur || { stars: ex0 ? ex0.stars : 0, comment: "" };
      if (ta) cur.comment = ta.value;
      if (a === "rstar") { cur.stars = Number(j); UI.rate[i] = cur; render(); return; }
      if (!cur.stars) { toast("Choose 1 to 5 stars"); return; }
      try { await api.put("/ratings/packages/" + i, { stars: cur.stars, comment: cur.comment.trim() || undefined }); toast("Thanks for rating this seller."); delete UI.rate[i]; drop("ratings:"); drop("order:"); S.topSellers = undefined; }
      catch (e) { toast(errText(e)); }
      render(); return;
    }
    case "pcancel": {
      if (UI.confirm !== j) { UI.confirm = j; render(); return; }
      UI.confirm = null;
      try { await api.post("/orders/" + i + "/packages/" + j + "/cancel", { reason: "Cancelled by buyer" }); toast("Package cancelled. Your refund is on its way."); drop("order"); drop("orders"); }
      catch (e) { toast(errText(e)); }
      render(); return;
    }
    case "authmode": UI.auth.mode = i; UI.auth.err = ""; render(); return;
    case "signout": await api.logout(); clearSession(); stack = []; tab = "home"; toast("Signed out"); render(); loadFeed(false); return;
    case "signoutall": try { await api.post("/auth/logout-all"); } catch (e) { } await api.logout(); clearSession(); stack = []; tab = "home"; toast("Signed out everywhere"); render(); return;
    case "savename": try { var r2 = await api.patch("/me", { fullName: val("setn") }); S.user = r2.user; toast("Name saved"); } catch (e) { toast(errText(e)); } render(); return;
    case "savepw": try { await api.post("/auth/password/change", { currentPassword: $("pw0").value, newPassword: $("pw1").value }); toast("Password changed"); $("pw0").value = ""; $("pw1").value = ""; } catch (e) { toast(errText(e)); } return;
    case "theme": { var rt = document.documentElement, dark = getComputedStyle(rt).colorScheme === "dark"; rt.setAttribute("data-theme", dark ? "light" : "dark"); try { localStorage.setItem("rl-theme", dark ? "light" : "dark"); } catch (e) { } return; }
    case "install": if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } else toast("On iPhone: Share, then Add to Home Screen. On Android: browser menu, then Install app."); return;
    default: if (window.RL && RL.A[a]) { await RL.A[a](i, j, el); return; }
  }
}
var deferredInstall = null;
window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferredInstall = e; });

async function submitAuth() {
  var A = UI.auth; if (A.busy) return;
  // Read every field before render(): rendering rebuilds the form and would empty the name and phone boxes.
  var email = val("ae"), pw = $("ap").value, reg = A.mode === "register", name = val("an"), phone = val("aph");
  if (!email || !pw) { A.err = "Enter your email and password."; render(); return; }
  A.busy = true; A.err = ""; render();
  try {
    if (reg) await api.register({ email: email, password: pw, fullName: name || email.split("@")[0], phone: phone || undefined });
    else await api.login(email, pw);
    await loadMe(); A.busy = false; afterAuth(); toast(reg ? "Welcome to Reloved" : "Signed in");
  } catch (e) {
    A.busy = false; A.err = e.code === "ACCOUNT_EXISTS" ? "An account with this email already exists. Try signing in." : errText(e);
    render(); var em = $("ae"); if (em) em.value = email; var en = $("an"); if (en) en.value = name; var ep = $("aph"); if (ep) ep.value = phone;
  }
}

document.addEventListener("click", function (ev) {
  var el = ev.target.closest && ev.target.closest("[data-a]");
  if (!el) return;
  // Ctrl/Cmd/Shift-click on a real link opens it in a new tab or window, as people expect.
  if (el.tagName === "A" && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey)) return;
  ev.preventDefault();
  act(el.dataset.a, el.dataset.i, el.dataset.j, el).catch(function (e) { toast(errText(e)); });
});
document.addEventListener("submit", function (ev) {
  if (ev.target.id === "af") { ev.preventDefault(); submitAuth(); }
  else if (ev.target.id === "bf" || ev.target.id === "nf") { ev.preventDefault(); UI.q = val(ev.target.id === "nf" ? "nq" : "q2"); UI.cat = ""; UI.sellerId = ""; UI.sellerName = ""; stack = []; tab = "home"; navPush(); loadFeed(false); render(); }
});
var searchT;
document.addEventListener("input", function (ev) {
  if (ev.target.id === "q") { clearTimeout(searchT); searchT = setTimeout(function () { UI.q = ev.target.value; loadFeed(false); syncUrl(); docHead(); }, 350); }
});
document.addEventListener("change", function (ev) {
  var t = ev.target, FIELD = { fs: "sort", fb: "brand", fz: "size", fcl: "colour", fmin: "minp", fmax: "maxp" };
  if (t.dataset && t.dataset.f) {
    if (FIELD[t.id]) UI[FIELD[t.id]] = t.value.trim(); // only the control that changed, so closed or hidden filters are never wiped
    clearTimeout(searchT); searchT = setTimeout(function () { loadFeed(false); }, 200);
  } else if (t.dataset && t.dataset.delv) {
    api.put("/cart/delivery/" + t.dataset.delv, { code: t.value }).then(function (r) { S.cart = r; render(); }, function (e) { toast(errText(e)); loadCart().then(render); });
  }
});

/* ============ boot ============ */
api.onLogout(function () { clearSession(); toast("Please sign in again"); stack = []; render(); });
async function boot() {
  if ("serviceWorker" in navigator && !(window.api && window.api.isApp)) navigator.serviceWorker.register("/sw.js").catch(function () {});
  restore(parseUrl()); // open the screen the address names (a shared item, a category, a search…)
  var first = cur();
  // A shared item link: start fetching the item now, alongside the categories, rather than after them.
  if (first.v === "item") need("item:" + first.p, function () { return api.get("/catalogue/products/" + first.p, { anon: true }); });
  var cats = loadCats();
  // No session to restore: fetch the products right away, next to the categories, instead of after a refresh that would fail.
  if (!api.mayHaveSession()) { loadFeed(false); await cats; S.ready = true; start(); return; }
  var ok = await api.restore();
  if (ok) { try { await loadMe(); } catch (e) { clearSession(); } }
  await cats;
  S.ready = true; start(); loadFeed(false);
}
function start() {
  var c = cur();
  if (c.v === "item") { if (signedIn() && !S.cart) loadCart().then(refresh); } // the item itself is already loading (boot)
  else if (c.v !== "home") enter(c.v, c.p);
  render();
}
// A photo that fails to load is removed so the colour placeholder shows. Done here, not with an inline onerror attribute, because the site's Content-Security-Policy forbids inline handlers.
document.addEventListener("error", function (ev) { var t = ev.target; if (t && t.tagName === "IMG" && t.hasAttribute("data-rm")) t.remove(); }, true);
window.RL = { V: V, A: {}, E: {}, PCAT: PCAT, paintNav: renderNav, S: S, UI: UI, C: C, hooks: [], esc: esc, inr: inr, when: when, $: $, val: val, uuid: uuid, COND: COND, stLabel: stLabel, stClass: stClass, variantLabel: variantLabel, hueOf: hueOf, ph: ph, toast: toast, errText: errText, checkRules: checkRules, serverFieldErrors: serverFieldErrors, showFieldErrors: showFieldErrors, clearFieldErrors: clearFieldErrors, PH_RE: PH_RE, PIN_RE: PIN_RE, row: row, head: head, sum: sum, sw: sw, go: go, back: back, render: render, refresh: refresh, need: need, drop: drop, signedIn: signedIn, loadMe: loadMe, loadCats: loadCats, loadFeed: loadFeed, loadingBox: loadingBox, failBox: failBox, probText: probText, setTab: setTab,
  current: function () { return cur(); }, canBack: function () { return stack.length > 0; }, replace: replace, itemUrl: itemUrl };
boot();
window.__reloved = { S: S, UI: UI };
})();
