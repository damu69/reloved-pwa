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
function ph(title, pid, imgId, size, extra) {
  var h = hueOf(title), bg = "background:linear-gradient(150deg,hsl(" + h + ",38%,38%),hsl(" + ((h + 30) % 360) + ",42%,20%))";
  return '<div class="ph" style="' + bg + '">' + esc(String(title || "?").slice(0, 2).toUpperCase()) +
    (imgId ? '<img loading="lazy" alt="" src="' + esc(api.media(pid, imgId, size || 600)) + '" onerror="this.remove()">' : "") + (extra || "") + "</div>";
}
var HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5 6.5 5c2 0 3.6 1.1 5.5 3 1.9-1.9 3.5-3 5.5-3C21 5 22.8 8.6 21.5 11.8 19.5 16.4 12 21 12 21z"/></svg>';
var toastT;
function toast(m) { Array.prototype.forEach.call(document.querySelectorAll(".toast"), function (x) { x.remove(); }); var d = document.createElement("div"); d.className = "toast"; d.textContent = m; $("app").appendChild(d); clearTimeout(toastT); toastT = setTimeout(function () { d.remove(); }, 3200); }
function errText(e) {
  if (!e) return "Something went wrong.";
  if (e.code === "RATE_LIMITED") return "Too many tries. Please wait a few minutes and try again.";
  if (e.code === "VALIDATION_FAILED" && e.details && e.details.length) return e.details.map(function (d) { return d.message; }).join(" ");
  return e.message || "Something went wrong.";
}
function row(ic, l, v, attr, tog) { return '<button class="row" ' + attr + '><span class="ic">' + ic + '</span><span class="l">' + l + "</span>" + (v !== "" && v != null ? '<span class="v">' + v + "</span>" : "") + (tog || '<span class="chev"></span>') + "</button>"; }
function head(title, back, right) { return '<div class="bar">' + (back ? '<button class="back" data-a="back" aria-label="Back"><span class="chev" style="transform:rotate(-135deg);margin-left:4px"></span></button>' : "") + "<h1>" + title + "</h1>" + (right || "") + "</div>"; }
function sw(on) { return '<span class="toggle" role="switch" aria-checked="' + !!on + '"></span>'; }
function sum(l, v, cls) { return '<div class="sum ' + (cls || "") + '"><span>' + l + "</span><span>" + v + "</span></div>"; }
function loadingBox() { return '<div class="empty">Loading…</div>'; }
function failBox(msg, retry) { return '<div class="empty"><h2>Could not load</h2>' + esc(msg || "") + '<div style="margin-top:12px"><button class="btn sm" data-a="' + (retry || "reload") + '">Try again</button></div></div>'; }

/* ============ state ============ */
var S = { user: null, perms: [], cats: [], cart: null, wish: {}, ready: false };
var stack = [], tab = "home";
var UI = { q: "", cat: "", cond: "", sort: "", minp: "", maxp: "", sellerId: "", sellerName: "", fil: false, feed: { items: [], next: null, loading: false, error: null, key: "", loaded: false },
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
  await Promise.all([loadCart(), loadWish()]);
}
async function loadCart() { try { S.cart = await api.get("/cart"); } catch (e) { if (e.status === 401) S.cart = null; } }
async function loadWish() { try { var r = await api.get("/me/wishlist"); S.wish = {}; (r.items || []).forEach(function (i) { S.wish[i.productId] = i; }); } catch (e) { S.wish = {}; } }
function clearSession() { S.user = null; S.perms = []; S.cart = null; S.wish = {}; C = {}; UI.ck = { addressId: "", idem: null, busy: false, adding: false, err: "" }; }

function feedKey() { return [UI.q, UI.cat, UI.cond, UI.sort, UI.minp, UI.maxp, UI.sellerId].join("|"); }
function feedUrl(cursor) {
  var p = ["limit=24"];
  if (UI.q.trim()) p.push("q=" + encodeURIComponent(UI.q.trim()));
  if (UI.cat) p.push("category=" + encodeURIComponent(UI.cat));
  if (UI.cond) p.push("condition=" + encodeURIComponent(UI.cond));
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
    F.items = more ? F.items.concat(r.items) : r.items; F.next = r.nextCursor || null; F.loaded = true;
  } catch (e) { if (my !== feedSeq) return; F.error = errText(e); }
  F.loading = false; partialFeed();
}
function need(key, fn) {
  var c = C[key];
  if (c) return c;
  c = C[key] = { st: "loading", data: null, err: null };
  fn().then(function (d) { c.st = "ok"; c.data = d; refresh(); }, function (e) { c.st = "err"; c.err = errText(e); c.code = e.code; refresh(); });
  return c;
}
function drop(prefix) { Object.keys(C).forEach(function (k) { if (k.indexOf(prefix) === 0) delete C[k]; }); }

/* ============ views ============ */
var V = {};
function card(i) {
  var f = !!S.wish[i.id], tag = i.inStock === false ? '<span class="tag">Sold out</span>' : "";
  return '<div><button class="card" data-a="item" data-i="' + esc(i.id) + '" aria-label="' + esc(i.title) + '">' +
    ph(i.title, i.id, i.coverImageId, 600, tag + '<span class="heart' + (f ? " on" : "") + '" data-a="fav" data-i="' + esc(i.id) + '" role="button" aria-label="Favourite" aria-pressed="' + f + '">' + HEART + "</span>") +
    '<div class="t">' + esc(i.title) + '</div><div class="m">' + esc(COND[i.condition] || i.condition || "") + " · " + esc(i.brandName || "No brand") + '</div><div class="price">' + inr(i.minPricePaise) + "</div></button></div>";
}
function gridHTML() {
  var F = UI.feed;
  if (F.error && !F.items.length) return '<div class="empty" style="grid-column:1/-1"><h2>Could not load items</h2>' + esc(F.error) + '<div style="margin-top:12px"><button class="btn sm" data-a="feedretry">Try again</button></div></div>';
  if (!F.items.length) return F.loading || !F.loaded ? '<div class="empty" style="grid-column:1/-1">Loading…</div>' :
    '<div class="empty" style="grid-column:1/-1"><h2>No items found</h2>Try a different search, category or filter.</div>';
  return F.items.map(card).join("");
}
function moreHTML() { var F = UI.feed; return F.next ? '<button class="btn ghost block" data-a="more" ' + (F.loading ? "disabled" : "") + ">" + (F.loading ? "Loading…" : "Load more") + "</button>" : ""; }
function partialFeed() { var g = $("grid"), m = $("more"); if (g) g.innerHTML = gridHTML(); if (m) m.innerHTML = moreHTML(); }

V.home = function () {
  var tops = topCats(), top = UI.cat ? UI.cat.split("/")[0] : "", subs = top ? childCats(top) : [];
  var chips = '<button class="chip' + (!UI.cat ? " on" : "") + '" data-a="cat" data-i="">All</button>' +
    tops.map(function (c) { return '<button class="chip' + (top === c.path ? " on" : "") + '" data-a="cat" data-i="' + esc(c.path) + '">' + esc(c.name) + "</button>"; }).join("");
  var subchips = subs.length ? '<div class="chips"><button class="chip' + (UI.cat === top ? " on" : "") + '" data-a="cat" data-i="' + esc(top) + '">All ' + esc((catByPath(top) || {}).name || "") + "</button>" +
    subs.map(function (c) { return '<button class="chip' + (UI.cat === c.path ? " on" : "") + '" data-a="cat" data-i="' + esc(c.path) + '">' + esc(c.name) + "</button>"; }).join("") + "</div>" : "";
  return '<div style="display:flex;gap:8px;margin-bottom:12px"><div class="search" style="flex:1"><span class="muted">&#9906;</span><input id="q" type="search" placeholder="Search for items" value="' + esc(UI.q) + '" aria-label="Search"></div><button class="chip' + (UI.fil ? " on" : "") + '" data-a="fil">Filters</button></div>' +
    (UI.fil ? '<div class="banner"><div class="two"><label class="field"><span>Sort</span><select class="inp" id="fs" data-f="1"><option value="">' + (UI.q.trim() ? "Best match" : "Newest") + '</option><option value="price_asc"' + (UI.sort === "price_asc" ? " selected" : "") + '>Price: low to high</option><option value="price_desc"' + (UI.sort === "price_desc" ? " selected" : "") + '>Price: high to low</option></select></label>' +
      '<label class="field"><span>Condition</span><select class="inp" id="fc" data-f="1"><option value="">Any</option>' + Object.keys(COND).map(function (k) { return '<option value="' + k + '"' + (UI.cond === k ? " selected" : "") + ">" + COND[k] + "</option>"; }).join("") + "</select></label></div>" +
      '<div class="two"><label class="field"><span>Min price (₹)</span><input class="inp" id="fmin" data-f="1" inputmode="numeric" value="' + esc(UI.minp) + '" placeholder="0"></label><label class="field"><span>Max price (₹)</span><input class="inp" id="fmax" data-f="1" inputmode="numeric" value="' + esc(UI.maxp) + '" placeholder="No limit"></label></div></div>' : "") +
    '<div class="chips">' + chips + "</div>" + subchips +
    (UI.sellerId ? '<div class="banner" style="display:flex;gap:10px;align-items:center"><span class="small" style="flex:1">Items from <b>' + esc(UI.sellerName || "this seller") + '</b></span><button class="chip" data-a="clearseller">Show all</button></div>' : "") +
    '<div class="grid" id="grid">' + gridHTML() + '</div><div id="more" style="margin-top:14px">' + moreHTML() + "</div>";
};
V.browse = function () {
  var tops = topCats();
  return head("Browse") + '<form class="search" id="bf"><span class="muted">&#9906;</span><input id="q2" type="search" placeholder="Search for items" aria-label="Search"></form>' +
    (tops.length ? '<div class="tiles">' + tops.map(function (c) { var h = hueOf(c.name); return '<button class="tile" data-a="browse" data-i="' + esc(c.path) + '" style="background:linear-gradient(150deg,hsl(' + h + ',40%,36%),hsl(' + ((h + 30) % 360) + ',45%,20%))"><span>' + esc(c.name) + "</span></button>"; }).join("") + "</div>" : '<div class="empty"><h2>No categories yet</h2>Categories appear here once the catalogue is set up.</div>');
};
V.item = function (pid) {
  var c = need("item:" + pid, function () { return api.get("/catalogue/products/" + pid, { anon: !signedIn() }); });
  if (c.st === "loading") return head("", true) + loadingBox();
  if (c.st === "err") return head("Item", true) + (c.code === "NOT_FOUND" ? '<div class="empty"><h2>Item not found</h2>It may have been removed or is no longer for sale.</div>' : failBox(c.err));
  var p = c.data, vs = p.variants || [], sel = UI.pdv[pid];
  var v = vs.filter(function (x) { return x.id === sel; })[0] || vs.filter(function (x) { return x.inStock; })[0] || vs[0];
  var inCart = v && S.cart && S.cart.items.filter(function (i) { return i.variantId === v.id; })[0];
  var f = !!S.wish[pid], imgs = p.images && p.images.length ? p.images : [null];
  var off = v && v.mrpPaise > v.pricePaise ? Math.round((1 - v.pricePaise / v.mrpPaise) * 100) : 0;
  return head("", true, '<button class="back" data-a="fav" data-i="' + esc(pid) + '" aria-label="Favourite" aria-pressed="' + f + '"><span class="heart' + (f ? " on" : "") + '" style="position:static;background:none">' + HEART + "</span></button>") +
    '<div class="gallery">' + imgs.map(function (im) { return ph(p.title, pid, im && im.id, 1200); }).join("") + "</div>" +
    "<h2>" + esc(p.title) + '</h2><div class="price" style="font-size:1.2rem;margin:4px 0">' + (v ? inr(v.pricePaise) : "") + (off ? ' <s class="muted small" style="font-weight:400">' + inr(v.mrpPaise) + '</s> <small>' + off + "% off</small>" : "") + '</div><div class="muted small">Price includes GST</div>' +
    (vs.length > 1 || (vs[0] && Object.keys(vs[0].options || {}).length) ? '<h3 style="margin:14px 0 6px">' + (vs.length > 1 ? "Choose an option" : "Option") + '</h3><div class="chips" style="flex-wrap:wrap">' + vs.map(function (x) { return '<button class="chip' + (v && x.id === v.id ? " on" : "") + '" data-a="vsel" data-i="' + esc(pid) + '" data-j="' + esc(x.id) + '"' + (x.inStock ? "" : ' style="opacity:.45;text-decoration:line-through"') + ">" + esc(variantLabel(x.options)) + "</button>"; }).join("") + "</div>" : "") +
    (v && v.onlyLeft ? '<div class="pill prog" style="display:inline-block">Only ' + v.onlyLeft + " left</div>" : "") +
    '<dl class="kv"><dt>Condition</dt><dd>' + esc(COND[p.condition] || p.condition) + "</dd><dt>Brand</dt><dd>" + esc(p.brandName || "Not stated") + "</dd><dt>Category</dt><dd>" + esc(p.categoryName || "") + "</dd>" +
    Object.keys(p.attributes || {}).map(function (k) { return "<dt>" + esc(k) + "</dt><dd>" + esc(p.attributes[k]) + "</dd>"; }).join("") + "</dl>" +
    (p.description ? "<p>" + esc(p.description).replace(/\n/g, "<br>") + "</p>" : "") +
    (p.seller ? '<button class="itemcard" data-a="seller" data-i="' + esc(p.seller.id) + '" data-j="' + esc(p.seller.displayName) + '" style="margin:12px 0"><span class="av" style="background:hsl(' + hueOf(p.seller.displayName) + ',40%,32%)">' + esc(String(p.seller.displayName).slice(0, 1).toUpperCase()) + '</span><span style="flex:1"><b>' + esc(p.seller.displayName) + '</b><br><span class="muted small">See more from this seller</span></span><span class="chev"></span></button>' : "") +
    (v && v.inStock ? (inCart ? '<div class="two"><button class="btn ghost" data-a="tab" data-i="cart">View cart (' + inCart.quantity + ')</button><button class="btn" data-a="addcart" data-i="' + esc(v.id) + '">Add one more</button></div>' : '<button class="btn block" data-a="addcart" data-i="' + esc(v.id) + '"' + (UI.busy ? " disabled" : "") + ">Add to cart</button>") : '<div class="banner">This option is sold out.</div>') +
    '<p class="muted small" style="margin-top:10px">Buyer Protection and delivery fees are added at checkout.</p>';
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
    (reg ? "" : '<p class="muted small" style="margin-top:12px">Forgot your password? Password reset by email is not available yet.</p>') + "</div>";
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
V.order = function (id) {
  if (!signedIn()) return V.gate("Order", "Sign in to see this order.");
  var c = need("order:" + id, function () { return api.get("/orders/" + id); });
  if (c.st === "loading") return head("Order", true) + loadingBox();
  if (c.st === "err") return head("Order", true) + (c.code === "NOT_FOUND" ? '<div class="empty"><h2>Order not found</h2></div>' : failBox(c.err));
  var o = c.data, t = o.totals, a = o.shippingAddress || {}, unpaid = o.status === "pending_payment";
  var out = head("Order " + esc(o.number), true) + '<p><span class="pill ' + stClass(o.status) + '">' + esc(stLabel(o.status)) + '</span> <span class="muted small">Placed ' + when(o.placedAt) + "</span></p>";
  if (unpaid) out += '<div class="banner warn"><b>Waiting for payment</b><span class="small">Online payment is not switched on yet, so this order cannot be paid for now. It is released automatically at ' + when(o.expiresAt) + ".</span></div>";
  if (o.cancelledAt) out += '<div class="banner"><b>Cancelled</b><span class="small muted">' + esc(o.cancelReason || "") + "</span></div>";
  o.packages.forEach(function (pk) {
    out += '<h3 style="margin:14px 0 6px">From ' + esc(pk.sellerName) + ' <span class="pill ' + stClass(pk.status) + '">' + esc(stLabel(pk.status)) + '</span></h3><div class="list">' + pk.items.map(function (i) { return '<button class="row" data-a="item" data-i="' + esc(i.productId) + '"><span class="l"><b>' + esc(i.title) + '</b><br><span class="muted small">' + esc(variantLabel(i.options)) + " × " + i.quantity + '</span></span><span class="v">' + inr(i.netPaise) + "</span></button>"; }).join("") + "</div>" +
      '<p class="muted small">' + esc(pk.delivery.label) + " · " + (pk.delivery.feePaise ? inr(pk.delivery.feePaise) : "Free") + (pk.carrier ? " · " + esc(pk.carrier) + " " + esc(pk.trackingNumber || "") : "") + "</p>" +
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
V.sell = function () {
  return head("Sell") + '<div class="banner"><b>Selling on Reloved</b><span class="small muted">Seller sign-up with identity and bank verification, product listing and order handling are being moved to the new system. They will be available in the next update.</span></div>' +
    '<div class="list">' + row("1", "Apply as a seller", "Coming soon", "", "<span></span>") + row("2", "List products with photos and sizes", "Coming soon", "", "<span></span>") + row("3", "Manage stock and orders", "Coming soon", "", "<span></span>") + row("4", "See your earnings", "Coming soon", "", "<span></span>") + "</div>";
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
    '<div class="list" style="margin-top:18px">' + row("T", "Light / dark theme", "", 'data-a="theme"') + row("+", "Install app", "", 'data-a="install"') + row("O", "Sign out", "", 'data-a="signout"') + row("X", "Sign out everywhere", "", 'data-a="signoutall"') + "</div>";
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
  return head("Help Centre", true) + '<div class="list">' + q.map(function (x) { return '<div class="row" style="display:block"><b>' + x[0] + '</b><br><span class="muted">' + x[1] + "</span></div>"; }).join("") + "</div>";
};
V.about = function () { return head("About", true) + '<div class="list">' + [["Our platform", "platform"], ["How it works", "how"], ["Trust and Safety", "trust"]].map(function (t) { return row("i", t[0], "", 'data-a="go" data-i="doc" data-j="' + t[1] + '"'); }).join("") + "</div>"; };
V.legal = function () { return head("Terms &amp; legal", true) + '<div class="list">' + row("§", "User Terms and Conditions", "", 'data-a="go" data-i="tc"') + row("§", "Privacy Centre", "", 'data-a="go" data-i="doc" data-j="privacy"') + "</div>"; };
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
  var c = cur(), v = c.v, keep = main.scrollTop, same = main.dataset.v === v + ":" + (c.p || "");
  main.innerHTML = (V[v] || V.home)(c.p); main.dataset.v = v + ":" + (c.p || "");
  nav.hidden = v === "auth";
  var n = cartCount();
  var tabs = [["home", "Home", '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'], ["browse", "Browse", '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'], ["sell", "Sell", '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'], ["cart", "Cart", '<path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>'], ["profile", "Profile", '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>']];
  nav.innerHTML = tabs.map(function (t) { return '<button data-a="tab" data-i="' + t[0] + '" class="' + (!stack.length && tab === t[0] ? "on" : "") + '" aria-label="' + t[1] + '"><svg viewBox="0 0 24 24">' + t[2] + "</svg>" + t[1] + (t[0] === "cart" && n ? ' <span class="dot">' + n + "</span>" : "") + "</button>"; }).join("");
  if (same) main.scrollTop = keep;
  if (window.RL) RL.hooks.forEach(function (f) { try { f(); } catch (e) { } });
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
}
function go(v, p) { UI.confirm = null; stack.push({ v: v, p: p }); enter(v, p); render(); $("main").scrollTop = 0; }
function setTab(t) { stack = []; tab = t; UI.confirm = null; enter(t); render(); $("main").scrollTop = 0; }
function back() { UI.confirm = null; stack.pop(); render(); }
function afterAuth() { if (cur().v === "auth") stack.pop(); drop(""); S.ready = true; render(); if (tab === "home" || !UI.feed.loaded) loadFeed(false); }

/* ============ actions ============ */
async function act(a, i, j, el) {
  switch (a) {
    case "tab": setTab(i); return;
    case "back": back(); return;
    case "go": go(i, j || undefined); return;
    case "reload": location.reload(); return;
    case "item": go("item", i); return;
    case "cat": UI.cat = i; loadFeed(false); render(); return;
    case "browse": UI.cat = i; stack = []; tab = "home"; loadFeed(false); render(); return;
    case "fil": UI.fil = !UI.fil; render(); return;
    case "more": loadFeed(true); return;
    case "feedretry": loadFeed(UI.feed.items.length > 0); return;
    case "seller": UI.sellerId = i; UI.sellerName = j; UI.cat = ""; UI.q = ""; stack = []; tab = "home"; loadFeed(false); render(); return;
    case "clearseller": UI.sellerId = ""; UI.sellerName = ""; loadFeed(false); render(); return;
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
      try {
        var r = await api.post("/me/addresses", b); UI.ck.addressId = r.id; UI.ck.adding = false; UI.ck.idem = null; drop("addresses"); toast("Address saved");
      } catch (e) { var er = $("aderr"); if (er) er.textContent = errText(e); return; }
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
    case "theme": { var rt = document.documentElement, dark = getComputedStyle(rt).colorScheme === "dark"; rt.setAttribute("data-theme", dark ? "light" : "dark"); return; }
    case "install": if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } else toast("On iPhone: Share, then Add to Home Screen. On Android: browser menu, then Install app."); return;
    default: if (window.RL && RL.A[a]) { await RL.A[a](i, j, el); return; }
  }
}
var deferredInstall = null;
window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferredInstall = e; });

async function submitAuth() {
  var A = UI.auth; if (A.busy) return;
  var email = val("ae"), pw = $("ap").value, reg = A.mode === "register";
  if (!email || !pw) { A.err = "Enter your email and password."; render(); return; }
  A.busy = true; A.err = ""; render();
  try {
    if (reg) await api.register({ email: email, password: pw, fullName: val("an") || email.split("@")[0], phone: val("aph") || undefined });
    else await api.login(email, pw);
    await loadMe(); A.busy = false; afterAuth(); toast(reg ? "Welcome to Reloved" : "Signed in");
  } catch (e) {
    var keepName = val("an"), keepPhone = val("aph");
    A.busy = false; A.err = e.code === "ACCOUNT_EXISTS" ? "An account with this email already exists. Try signing in." : errText(e);
    render(); var em = $("ae"); if (em) em.value = email; var en = $("an"); if (en) en.value = keepName; var ep = $("aph"); if (ep) ep.value = keepPhone;
  }
}

document.addEventListener("click", function (ev) {
  var el = ev.target.closest && ev.target.closest("[data-a]");
  if (!el) return;
  ev.preventDefault();
  act(el.dataset.a, el.dataset.i, el.dataset.j, el).catch(function (e) { toast(errText(e)); });
});
document.addEventListener("submit", function (ev) {
  if (ev.target.id === "af") { ev.preventDefault(); submitAuth(); }
  else if (ev.target.id === "bf") { ev.preventDefault(); UI.q = val("q2"); UI.cat = ""; stack = []; tab = "home"; loadFeed(false); render(); }
});
var searchT;
document.addEventListener("input", function (ev) {
  if (ev.target.id === "q") { clearTimeout(searchT); searchT = setTimeout(function () { UI.q = ev.target.value; loadFeed(false); }, 350); }
});
document.addEventListener("change", function (ev) {
  var t = ev.target;
  if (t.dataset && t.dataset.f) {
    UI.sort = val("fs"); UI.cond = val("fc"); UI.minp = val("fmin"); UI.maxp = val("fmax");
    clearTimeout(searchT); searchT = setTimeout(function () { loadFeed(false); }, 200);
  } else if (t.dataset && t.dataset.delv) {
    api.put("/cart/delivery/" + t.dataset.delv, { code: t.value }).then(function (r) { S.cart = r; render(); }, function (e) { toast(errText(e)); loadCart().then(render); });
  }
});

/* ============ boot ============ */
api.onLogout(function () { clearSession(); toast("Please sign in again"); stack = []; render(); });
async function boot() {
  $("main").innerHTML = '<div class="loading">Loading marketplace…</div>';
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
  await loadCats();
  var ok = await api.restore();
  if (ok) { try { await loadMe(); } catch (e) { clearSession(); } }
  S.ready = true; render(); loadFeed(false);
}
window.RL = { V: V, A: {}, S: S, UI: UI, C: C, hooks: [], esc: esc, inr: inr, when: when, $: $, val: val, uuid: uuid, COND: COND, stLabel: stLabel, stClass: stClass, variantLabel: variantLabel, hueOf: hueOf, ph: ph, toast: toast, errText: errText, row: row, head: head, sum: sum, sw: sw, go: go, back: back, render: render, refresh: refresh, need: need, drop: drop, signedIn: signedIn, loadMe: loadMe, loadCats: loadCats, loadFeed: loadFeed, loadingBox: loadingBox, failBox: failBox, probText: probText, setTab: setTab,
  current: function () { return cur(); }, replace: function (v, p) { stack.pop(); go(v, p); } };
boot();
window.__reloved = { S: S, UI: UI };
})();
