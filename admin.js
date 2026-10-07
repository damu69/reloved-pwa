// Admin screens: seller review, product review, catalogue set-up, coupons, fees, commission, orders, users.
(function () {
"use strict";
var R = window.RL, V = R.V, A = R.A, S = R.S, esc = R.esc, inr = R.inr, $ = R.$, val = R.val, toast = R.toast, errText = R.errText, head = R.head, need = R.need, drop = R.drop, row = R.row, sum = R.sum, H = R.H;
function can(p) { return (S.perms || []).indexOf(p) >= 0; }
var tapTwice = H.tapTwice;
function forbid() { return head("Admin", true) + '<div class="empty"><h2>Not allowed</h2>This area is for marketplace admins.</div>'; }
function guard(t) { return !R.signedIn() || !(S.perms && S.perms.length) ? forbid() : null; }
function bp(v) { return (v / 100).toFixed(2).replace(/\.?0+$/, "") + "%"; }
function pct(id) { var n = parseFloat(val(id)); return isFinite(n) ? Math.round(n * 100) : NaN; }
function dt(id) { var v = val(id); if (!v) return undefined; var d = new Date(v + "T23:59:59"); return isNaN(d) ? undefined : d.toISOString(); }
function listBox(c, empty, fn) { if (c.st === "loading") return R.loadingBox(); if (c.st === "err") return R.failBox(c.err); if (!c.data.items.length) return '<div class="empty">' + empty + "</div>"; return '<div class="list">' + c.data.items.map(fn).join("") + "</div>"; }
function say(id, m) { var e = $(id); if (e) e.textContent = m; else toast(m); }

V.admin = function () {
  var g = guard(); if (g) return g;
  var sc = need("ad:cnt", function () { return Promise.all([api.get("/admin/sellers?status=submitted&limit=50").catch(function () { return { items: [] }; }), api.get("/admin/catalogue/products?status=pending&limit=50").catch(function () { return { items: [] }; }), api.get("/admin/catalogue/pending-changes?limit=50").catch(function () { return { items: [] }; })]).then(function (r) { return { sellers: r[0].items.length, products: r[1].items.length, changes: r[2].items.length }; }); });
  var n = sc.data || {}, dot = function (x) { return x ? '<span class="dot">' + x + "</span>" : ""; };
  return head("Admin", true) + '<h3 style="margin:6px 0">Needs review</h3><div class="list">' + row("S", "Seller applications", dot(n.sellers), 'data-a="go" data-i="adsellers"') + row("P", "Product reviews", dot(n.products + n.changes), 'data-a="go" data-i="adprods"') + "</div>" +
    '<h3 style="margin:14px 0 6px">Marketplace</h3><div class="list">' + row("O", "Orders", "", 'data-a="go" data-i="adorders"') + row("U", "Users", "", 'data-a="go" data-i="adusers"') + row("C", "Categories, brands, GST", "", 'data-a="go" data-i="adcat"') + row("%", "Coupons", "", 'data-a="go" data-i="adcoupons"') + "</div>" +
    '<h3 style="margin:14px 0 6px">Money</h3><div class="list">' + row("%", "Commission", "", 'data-a="go" data-i="adcomm"') + row("₹", "Fees &amp; delivery", "", 'data-a="go" data-i="adfees"') + row("T", "Hold &amp; return rules", "", 'data-a="go" data-i="adrules"') + "</div>";
};

/* ---------- sellers ---------- */
var sFilter = "submitted";
V.adsellers = function () {
  var g = guard(); if (g) return g;
  var c = need("ad:sellers:" + sFilter, function () { return api.get("/admin/sellers?limit=50&status=" + sFilter); });
  return head("Sellers", true) + H.chips([["submitted", "To review"], ["changes_requested", "Changes asked"], ["approved", "Approved"], ["suspended", "Suspended"], ["rejected", "Rejected"]], sFilter, "adsf") + listBox(c, "No sellers here.", function (s) {
    return '<button class="row" data-a="go" data-i="adseller" data-j="' + esc(s.id) + '"><span class="l"><b>' + esc(s.displayName) + '</b><br><span class="muted small">' + esc(s.email) + " · " + esc(s.city) + "</span></span>" + '<span class="chev"></span></button>';
  });
};
A.adsf = function (i) { sFilter = i; R.render(); };
var docView = {};
V.adseller = function (id) {
  var g = guard(); if (g) return g;
  var c = need("ad:seller:" + id, function () { return api.get("/admin/sellers/" + id); });
  if (c.st === "loading") return head("Seller", true) + R.loadingBox();
  if (c.st === "err") return head("Seller", true) + R.failBox(c.err);
  var s = c.data, DOCL = { pan_card: "PAN card", gst_certificate: "GST certificate", address_proof: "Address proof", bank_proof: "Bank proof", other: "Other" };
  var out = head(esc(s.displayName), true) + "<p>" + H.pill(s.status.replace(/_/g, " "), s.status === "approved" ? "ok" : s.status === "rejected" || s.status === "suspended" ? "bad" : "prog") + "</p>";
  out += '<div class="list"><div class="row" style="display:block"><b>' + esc(s.businessName) + "</b> · " + esc(s.businessType) + "<br>PAN " + esc(s.panMasked) + (s.gstin ? " · GSTIN " + esc(s.gstin) : "") + "<br>" + esc(s.address.line1) + (s.address.line2 ? ", " + esc(s.address.line2) : "") + ", " + esc(s.address.city) + ", " + esc(s.address.state) + " " + esc(s.address.pincode) + '<br><span class="muted small">' + esc(s.contactPhone) + "</span></div></div>";
  if (s.missing && s.missing.length) out += '<p class="muted small">Still missing: ' + s.missing.map(function (m) { return esc(String(m.path || m).replace("document:", "").replace(/_/g, " ")); }).join(", ") + "</p>";
  out += '<h3 style="margin:14px 0 6px">Documents</h3>';
  s.documents.forEach(function (d) {
    var v = docView[d.id];
    out += '<div class="list"><div class="row" style="display:block"><b>' + esc(DOCL[d.docType] || d.docType) + "</b> " + H.pill(d.status, d.status === "accepted" ? "ok" : d.status === "rejected" ? "bad" : "prog") + '<br><span class="muted small">' + esc(d.originalName) + "</span>" +
      (v && v.image ? '<img src="' + v.url + '" alt="" style="width:100%;border-radius:10px;margin-top:8px">' : "") + (d.reviewNote ? '<br><span class="small bad">' + esc(d.reviewNote) + "</span>" : "") +
      '<div class="two" style="margin-top:8px"><button class="btn ghost sm" data-a="addoc" data-i="' + esc(s.id) + '" data-j="' + esc(d.id) + '">' + (v ? (v.image ? "Hide" : "Open again") : "View") + "</button>" +
      (can("admin.sellers.manage") && d.status === "pending" ? '<span style="display:flex;gap:6px"><button class="btn sm" style="flex:1" data-a="addocrev" data-i="' + esc(s.id) + '" data-j="' + esc(d.id) + '" data-k="accepted">Accept</button><button class="btn danger sm" style="flex:1" data-a="addocrev" data-i="' + esc(s.id) + '" data-j="' + esc(d.id) + '" data-k="rejected">Reject</button></span>' : "") + "</div></div></div>";
  });
  if (!s.documents.length) out += '<p class="muted small">No documents uploaded.</p>';
  out += '<h3 style="margin:14px 0 6px">Bank account</h3>';
  s.bankAccounts.forEach(function (b) {
    out += '<div class="list"><div class="row" style="display:block"><b>' + esc(b.accountHolderName) + "</b> · " + esc(b.accountNumberMasked) + " · IFSC " + esc(b.ifsc) + " " + H.pill(b.status, b.status === "verified" ? "ok" : b.status === "rejected" ? "bad" : "prog") +
      (can("admin.sellers.manage") && b.status === "pending" ? '<div class="two" style="margin-top:8px"><button class="btn sm" data-a="adbank" data-i="' + esc(s.id) + '" data-j="' + esc(b.id) + '" data-k="verified">Verify</button><button class="btn danger sm" data-a="adbank" data-i="' + esc(s.id) + '" data-j="' + esc(b.id) + '" data-k="rejected">Reject</button></div>' : "") + "</div></div>";
  });
  if (!s.bankAccounts.length) out += '<p class="muted small">No bank account added.</p>';
  var acts = { submitted: [["approve", "Approve seller", ""], ["request-changes", "Ask for changes", "ghost"], ["reject", "Reject", "danger"]], approved: [["suspend", "Suspend seller", "danger"]], suspended: [["reinstate", "Reinstate seller", ""]] }[s.status] || [];
  if (acts.length && can("admin.sellers.manage")) out += '<h3 style="margin:16px 0 6px">Decision</h3>' + H.area("Reason (needed unless approving)", "ad_r", "", 'maxlength="500"') + '<p class="bad small" id="aderr"></p><div style="display:grid;gap:8px">' + acts.map(function (a) { return '<button class="btn ' + a[2] + ' block" data-a="adsact" data-i="' + esc(s.id) + '" data-j="' + a[0] + '">' + a[1] + "</button>"; }).join("") + "</div>";
  var h = (s.history || []).slice().reverse();
  if (h.length) out += '<h3 style="margin:16px 0 6px">History</h3><div class="list">' + h.map(function (x) { return '<div class="row"><span class="l">' + esc(x.to.replace(/_/g, " ")) + '<br><span class="muted small">' + R.when(x.at) + (x.reason ? " · " + esc(x.reason) : "") + "</span></span></div>"; }).join("") + "</div>";
  return out;
};
A.addoc = async function (sid, did) {
  if (docView[did]) { if (docView[did].image) { delete docView[did]; R.render(); return; } }
  var b = await api.blob("/admin/sellers/" + sid + "/documents/" + did + "/file"), u = URL.createObjectURL(b);
  if (/^image\//.test(b.type)) { docView[did] = { url: u, image: true }; R.render(); }
  else { docView[did] = { url: u }; var a = document.createElement("a"); a.href = u; a.target = "_blank"; a.rel = "noopener"; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); R.render(); }
};
document.addEventListener("click", async function (ev) {
  var el = ev.target.closest && ev.target.closest("[data-k][data-a]");
  if (!el || (el.dataset.a !== "addocrev" && el.dataset.a !== "adbank")) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  var sid = el.dataset.i, oid = el.dataset.j, d = el.dataset.k, note;
  if (d === "rejected") { note = val("ad_r"); if (!note || note.length < 3) { toast("Write the reason in the box under Decision first (at least 3 characters)."); return; } }
  try {
    if (el.dataset.a === "addocrev") await api.post("/admin/sellers/" + sid + "/documents/" + oid + "/review", { decision: d, note: note });
    else await api.post("/admin/sellers/" + sid + "/bank-accounts/" + oid + "/review", { decision: d, note: note });
    drop("ad:seller:" + sid); toast("Saved"); R.render();
  } catch (e) { toast(errText(e)); }
}, true);
A.adsact = async function (sid, act) {
  var r = val("ad_r");
  if (act !== "approve" && r.length < 3) return say("aderr", "Write a reason (at least 3 characters).");
  try { await api.post("/admin/sellers/" + sid + "/" + act, r ? { reason: r } : {}); drop("ad:"); drop("sl:"); toast("Done"); R.render(); }
  catch (e) { say("aderr", errText(e)); }
};

/* ---------- product review ---------- */
var pTab = "pending";
V.adprods = function () {
  var g = guard(); if (g) return g;
  var out = head("Product review", true) + H.chips([["pending", "New items"], ["changes", "Edits"], ["active", "Live"], ["blocked", "Blocked"]], pTab, "adpt");
  if (pTab === "changes") {
    var cc = need("ad:changes", function () { return api.get("/admin/catalogue/pending-changes?limit=50"); });
    return out + listBox(cc, "No edits waiting.", function (x) { return '<button class="row" data-a="go" data-i="adprod" data-j="' + esc(x.productId) + '"><span class="l"><b>' + esc(x.title) + '</b><br><span class="muted small">' + esc(x.sellerName) + " · edit v" + x.version + "</span></span>" + '<span class="chev"></span></button>'; });
  }
  var c = need("ad:prods:" + pTab, function () { return api.get("/admin/catalogue/products?limit=50&status=" + pTab); });
  return out + listBox(c, "Nothing here.", function (x) { return '<button class="row" data-a="go" data-i="adprod" data-j="' + esc(x.id) + '"><span class="l"><b>' + esc(x.title) + '</b><br><span class="muted small">' + esc(x.sellerName) + "</span></span>" + '<span class="chev"></span></button>'; });
};
A.adpt = function (i) { pTab = i; R.render(); };
V.adprod = function (id) {
  var g = guard(); if (g) return g;
  var c = need("ad:prod:" + id, function () { return api.get("/admin/catalogue/products/" + id); });
  if (c.st === "loading") return head("Product", true) + R.loadingBox();
  if (c.st === "err") return head("Product", true) + R.failBox(c.err);
  var p = c.data, out = head(esc(p.title), true) + "<p>" + H.pill(p.status, p.status === "active" ? "ok" : p.status === "pending" ? "prog" : "bad") + ' <span class="muted small">by ' + esc(p.seller.displayName) + " · " + esc(p.categoryPath) + " · " + esc(R.COND[p.condition] || p.condition) + "</span></p>";
  out += '<div class="thumbs">' + p.images.map(function (im) { return '<div style="position:relative;width:110px">' + H.thumb("", "/admin/catalogue/products/" + p.id + "/images/" + im.id + "/600") + (im.status !== "active" ? '<span class="muted small">' + esc(im.status.replace("_", " ")) + "</span>" : "") + "</div>"; }).join("") + "</div>";
  out += '<div class="list"><div class="row" style="display:block">' + esc(p.description || "No description") + '<br><span class="muted small">GST ' + bp(p.gstRateBp) + (p.hsnCode ? " · HSN " + esc(p.hsnCode) : "") + (p.brandName ? " · " + esc(p.brandName) : "") + "</span></div>" + p.variants.map(function (v) { return '<div class="row"><span class="l">' + esc(Object.keys(v.options || {}).map(function (k) { return v.options[k]; }).join(" / ") || v.sku) + ' <span class="muted small">' + esc(v.sku) + '</span></span><span class="price">' + inr(v.pricePaise) + " <small class=\"muted\">MRP " + inr(v.mrpPaise) + "</small></span></div>"; }).join("") + "</div>";
  var pc = p.pendingChange;
  if (pc) {
    var keys = Object.keys(pc.data).filter(function (k) { return JSON.stringify(pc.data[k]) !== JSON.stringify(p[k]); });
    out += '<h3 style="margin:14px 0 6px">Seller edit waiting (v' + pc.version + ")</h3><div class=\"list\">" + (keys.length ? keys.map(function (k) { return '<div class="row" style="display:block"><span class="muted small">' + esc(k) + '</span><br><s class="muted">' + esc(typeof p[k] === "object" ? JSON.stringify(p[k]) : p[k] == null ? "—" : p[k]) + "</s><br><b>" + esc(typeof pc.data[k] === "object" ? JSON.stringify(pc.data[k]) : pc.data[k] == null ? "—" : pc.data[k]) + "</b></div>"; }).join("") : '<div class="row muted">Only photos changed.</div>') + "</div>";
  }
  if (p.reviewNote) out += '<p class="muted small">Last note: ' + esc(p.reviewNote) + "</p>";
  if (can("admin.products.review")) {
    out += H.area("Reason (needed to reject or block)", "ad_r", "", 'maxlength="500"') + '<p class="bad small" id="aderr"></p><div style="display:grid;gap:8px">';
    if (p.status === "pending") out += '<button class="btn block" data-a="adpact" data-i="' + esc(p.id) + '" data-j="approve" data-k="' + p.submission + '">Approve and publish</button><button class="btn danger block" data-a="adpact" data-i="' + esc(p.id) + '" data-j="reject" data-k="' + p.submission + '">Reject</button>';
    if (pc) out += '<button class="btn block" data-a="adprev" data-i="' + esc(p.id) + '" data-j="approve" data-k="' + pc.version + '">Approve the edit</button><button class="btn danger block" data-a="adprev" data-i="' + esc(p.id) + '" data-j="reject" data-k="' + pc.version + '">Reject the edit</button>';
    if (p.status === "active") out += '<button class="btn danger block" data-a="adpact" data-i="' + esc(p.id) + '" data-j="block">Block this item</button>';
    if (p.status === "blocked") out += '<button class="btn block" data-a="adpact" data-i="' + esc(p.id) + '" data-j="unblock">Unblock</button>';
    out += "</div>";
  }
  return out;
};
document.addEventListener("click", async function (ev) {
  var el = ev.target.closest && ev.target.closest("[data-a=adpact],[data-a=adprev]");
  if (!el) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  var id = el.dataset.i, act = el.dataset.j, k = el.dataset.k, reason = val("ad_r"), body = {};
  if ((act === "reject" || act === "block") && reason.length < 3) return say("aderr", "Write a reason (at least 3 characters).");
  if (reason) body.reason = reason;
  try {
    if (el.dataset.a === "adpact") { if (act === "approve" || act === "reject") body.submission = parseInt(k, 10); await api.post("/admin/catalogue/products/" + id + "/" + act, body); }
    else { body.version = parseInt(k, 10); await api.post("/admin/catalogue/products/" + id + "/pending-change/" + act, body); }
    drop("ad:"); toast("Done"); R.back();
  } catch (e) { say("aderr", errText(e)); }
}, true);

/* ---------- catalogue set-up ---------- */
V.adcat = function () {
  var g = guard(); if (g) return g;
  var br = need("ad:brands", function () { return api.get("/catalogue/brands"); }), gs = need("ad:gst", function () { return api.get("/catalogue/gst-rates"); });
  var cats = H.allCats(), byId = {}; S.cats.forEach(function (c) { byId[c.id] = c; });
  var out = head("Categories &amp; brands", true) + '<h3 style="margin:6px 0">Categories</h3><div class="list">' + cats.map(function (c) { return '<div class="row"><span class="l">' + esc(c[1]) + '</span><button class="btn ghost sm" data-a="adcatoff" data-i="' + esc(c[0]) + '">' + (R.UI.confirm === "co" + c[0] ? "Tap again" : "Hide") + "</button></div>"; }).join("") + (cats.length ? "" : '<div class="row muted">No categories yet.</div>') + "</div>";
  out += '<details class="list"><summary class="row" style="cursor:pointer"><span class="l"><b>+ Add a category</b></span></summary><div style="padding:0 14px 14px">' + H.fld("Name", "nc_n", "", 'maxlength="80"') + H.sel("Inside (leave empty for top level)", "nc_p", [["", "Top level"]].concat(cats), "") + '<p class="muted small">Items can only be listed in categories that have no sub-categories.</p><button class="btn block" data-a="adcatadd">Add category</button></div></details>';
  out += '<h3 style="margin:16px 0 6px">Brands</h3><div class="chips" style="flex-wrap:wrap">' + (br.data ? br.data.items.map(function (b) { return '<span class="chip">' + esc(b.name) + "</span>"; }).join("") : "") + '</div><div class="two">' + H.fld("New brand", "nb_n", "", 'maxlength="80"') + '<div style="align-self:end;margin-bottom:12px"><button class="btn block" data-a="adbrandadd">Add</button></div></div>';
  out += '<h3 style="margin:16px 0 6px">GST rates sellers can choose</h3><div class="chips" style="flex-wrap:wrap">' + (gs.data ? gs.data.items.map(function (g2) { return '<span class="chip">' + esc(g2.label) + "</span>"; }).join("") : "") + '</div><div class="two">' + H.fld("Rate % (e.g. 12)", "ng_r", "", 'inputmode="decimal"') + H.fld("Label", "ng_l", "", 'maxlength="20" placeholder="12%"') + '</div><button class="btn ghost block" data-a="adgstadd">Add GST rate</button><p class="muted small">Confirm the correct GST rates for second-hand goods with your accountant before going live.</p>';
  return out;
};
async function reloadCats() { drop("ad:"); drop("sl:"); await R.loadCats(); R.render(); }
A.adcatadd = async function () { var n = val("nc_n"); if (n.length < 1) return toast("Enter a name."); try { await api.post("/admin/catalogue/categories", { name: n, parentId: val("nc_p") || null }); toast("Category added"); await reloadCats(); } catch (e) { toast(errText(e)); } };
A.adcatoff = async function (id) { if (!tapTwice("co" + id)) return; try { await api.patch("/admin/catalogue/categories/" + id, { isActive: false }); toast("Hidden"); await reloadCats(); } catch (e) { toast(errText(e)); } };
A.adbrandadd = async function () { var n = val("nb_n"); if (!n) return toast("Enter a brand name."); try { await api.post("/admin/catalogue/brands", { name: n }); drop("ad:brands"); drop("sl:brands"); toast("Brand added"); R.render(); } catch (e) { toast(errText(e)); } };
A.adgstadd = async function () { var r = pct("ng_r"), l = val("ng_l"); if (!(r >= 0)) return toast("Enter the rate, e.g. 12."); if (!l) l = r / 100 + "%"; try { await api.post("/admin/catalogue/gst-rates", { rateBp: r, label: l }); drop("ad:gst"); drop("sl:gst"); toast("Rate added"); R.render(); } catch (e) { toast(errText(e)); } };

/* ---------- coupons ---------- */
V.adcoupons = function () {
  var g = guard(); if (g) return g;
  var c = need("ad:coupons", function () { return api.get("/admin/coupons?limit=100"); });
  var out = head("Coupons", true);
  out += '<details class="list"><summary class="row" style="cursor:pointer"><span class="l"><b>+ New coupon</b></span></summary><div style="padding:0 14px 14px">' + H.fld("Code (letters and digits, 4–20)", "cp_c", "", 'maxlength="20" autocapitalize="characters"') + H.fld("What buyers see", "cp_d", "", 'maxlength="200"') +
    H.sel("Type", "cp_t", [["percent", "Percentage off"], ["fixed", "Fixed amount off"]], "percent") + '<div class="two">' + H.fld("Percent (e.g. 10)", "cp_p", "", 'inputmode="decimal"') + H.fld("Or amount (₹)", "cp_a", "", 'inputmode="decimal"') + "</div>" +
    '<div class="two">' + H.fld("Max discount ₹ (percent only)", "cp_m", "", 'inputmode="decimal"') + H.fld("Minimum order ₹", "cp_o", "", 'inputmode="decimal"') + "</div>" +
    '<div class="two">' + H.fld("Total uses allowed", "cp_u", "", 'inputmode="numeric"') + H.fld("Uses per buyer", "cp_pu", "1", 'inputmode="numeric"') + '</div><label class="field"><span>Ends on (optional)</span><input class="inp" type="date" id="cp_e"></label><label class="row" style="padding:4px 0"><input type="checkbox" id="cp_f"> <span class="l">First order only</span></label><p class="bad small" id="cperr"></p><button class="btn block" data-a="adcpadd">Create coupon</button></div></details>';
  return out + listBox(c, "No coupons yet.", function (x) {
    return '<div class="row"><span class="l"><b>' + esc(x.code) + "</b> " + H.pill(x.state, x.state === "active" ? "ok" : "") + '<br><span class="muted small">' + (x.discountType === "percent" ? bp(x.percentBp) + " off" + (x.maxDiscountPaise ? " up to " + inr(x.maxDiscountPaise) : "") : inr(x.amountPaise) + " off") + (x.minOrderPaise ? " · min " + inr(x.minOrderPaise) : "") + " · used " + x.usedCount + (x.usageLimit ? "/" + x.usageLimit : "") + (x.endsAt ? " · ends " + R.when(x.endsAt) : "") + '</span></span><button class="btn ghost sm" data-a="adcptog" data-i="' + esc(x.id) + '" data-j="' + (x.isActive ? "0" : "1") + '">' + (x.isActive ? "Turn off" : "Turn on") + "</button></div>";
  });
};
A.adcpadd = async function () {
  var b = { code: val("cp_c").toUpperCase(), description: val("cp_d") || "Discount", discountType: val("cp_t"), perUserLimit: parseInt(val("cp_pu"), 10) || 1, firstOrderOnly: !!$("cp_f").checked };
  if (b.discountType === "percent") { b.percentBp = pct("cp_p"); if (!(b.percentBp >= 1)) return say("cperr", "Enter the percentage."); var m = H.paise("cp_m"); if (m >= 100) b.maxDiscountPaise = m; }
  else { b.amountPaise = H.paise("cp_a"); if (!(b.amountPaise >= 100)) return say("cperr", "Enter the amount in rupees."); }
  var mo = H.paise("cp_o"); if (mo > 0) b.minOrderPaise = mo;
  var u = parseInt(val("cp_u"), 10); if (u >= 1) b.usageLimit = u;
  var e = dt("cp_e"); if (e) b.endsAt = e;
  try { await api.post("/admin/coupons", b); drop("ad:coupons"); toast("Coupon created"); R.render(); } catch (er) { say("cperr", errText(er)); }
};
A.adcptog = async function (id, on) { try { await api.patch("/admin/coupons/" + id, { isActive: on === "1" }); drop("ad:coupons"); R.render(); } catch (e) { toast(errText(e)); } };

/* ---------- commission ---------- */
V.adcomm = function () {
  var g = guard(); if (g) return g;
  var d = need("ad:commdef", function () { return api.get("/admin/commission/rules?scope=default&state=active&limit=5"); }), rl = need("ad:commrules", function () { return api.get("/admin/commission/rules?state=active&limit=100"); });
  var sellers = need("ad:allsellers", function () { return api.get("/admin/sellers?status=approved&limit=100"); });
  var cur = d.data && d.data.items[0], cats = H.allCats(), sOpts = sellers.data ? sellers.data.items.map(function (s) { return [s.id, s.displayName]; }) : [];
  var names = {}; cats.forEach(function (c) { names[c[0]] = c[1]; }); sOpts.forEach(function (s) { names[s[0]] = s[1]; });
  var out = head("Commission", true) + '<div class="banner"><b style="font-size:1.4rem">' + (cur ? bp(cur.rateBp) : "…") + '</b><span class="small muted">Default commission on every sale. Rules below override it: product, then seller, then category, then this default.</span></div>';
  out += H.fld("New default rate (%)", "cm_r", "", 'inputmode="decimal"') + H.fld("Reason", "cm_n", "", 'maxlength="300"') + '<p class="bad small" id="cmerr"></p><button class="btn block" data-a="adcmdef">' + (R.UI.confirm === "cmdef" ? "Tap again to change the default" : "Change default rate") + "</button>";
  out += '<h3 style="margin:18px 0 6px">Special rates</h3>' + listBox(rl, "None yet.", function (x) { if (x.scope === "default") return ""; var t = x.categoryId || x.sellerId || x.productId; return '<div class="row"><span class="l"><b>' + bp(x.rateBp) + "</b> · " + x.scope + ' <span class="muted small">' + esc(names[t] || t.slice(0, 8)) + (x.note ? " · " + esc(x.note) : "") + '</span></span><button class="btn ghost sm" data-a="adcmend" data-i="' + esc(x.id) + '">' + (R.UI.confirm === "ce" + x.id ? "Tap again" : "End") + "</button></div>"; });
  out += '<details class="list"><summary class="row" style="cursor:pointer"><span class="l"><b>+ Add a special rate</b></span></summary><div style="padding:0 14px 14px">' + H.sel("Applies to", "cs_s", [["category", "A category"], ["seller", "A seller"]], "category") + H.sel("Category", "cs_c", cats, "") + H.sel("Seller", "cs_l", sOpts, "") + H.fld("Rate (%)", "cs_r", "", 'inputmode="decimal"') + H.fld("Note", "cs_n", "", 'maxlength="300"') + '<p class="muted small">Uses the category above if you chose "A category", otherwise the seller. Starts now.</p><p class="bad small" id="cserr"></p><button class="btn block" data-a="adcsadd">Add rate</button></div></details>';
  return out;
};
A.adcmdef = async function () {
  var r = pct("cm_r"), n = val("cm_n"); if (!(r >= 0 && r <= 5000)) return say("cmerr", "Enter a rate between 0 and 50."); if (n.length < 3) return say("cmerr", "Write a reason.");
  if (!tapTwice("cmdef")) return;
  try { await api.put("/admin/commission/default", { rateBp: r, reason: n }); drop("ad:comm"); toast("Default changed. It applies to orders paid from now on."); R.render(); } catch (e) { say("cmerr", errText(e)); }
};
A.adcmend = async function (id) { if (!tapTwice("ce" + id)) return; try { await api.post("/admin/commission/rules/" + id + "/end", { reason: "Ended by admin" }); drop("ad:comm"); R.render(); } catch (e) { toast(errText(e)); } };
A.adcsadd = async function () {
  var sc = val("cs_s"), r = pct("cs_r"), t = sc === "category" ? val("cs_c") : val("cs_l");
  if (!t) return say("cserr", "Choose who it applies to."); if (!(r >= 0 && r <= 5000)) return say("cserr", "Enter a rate between 0 and 50.");
  var b = { scope: sc, targetId: t, rateBp: r }; if (val("cs_n").length >= 3) b.note = val("cs_n");
  try { await api.post("/admin/commission/rules", b); drop("ad:comm"); toast("Rate added"); R.render(); } catch (e) { say("cserr", errText(e)); }
};

/* ---------- fees & delivery ---------- */
V.adfees = function () {
  var g = guard(); if (g) return g;
  var c = need("ad:fees", function () { return api.get("/admin/pricing"); });
  var out = head("Fees &amp; delivery", true);
  if (c.st === "loading") return out + R.loadingBox();
  if (c.st === "err") return out + R.failBox(c.err);
  var s = c.data.settings;
  out += '<h3 style="margin:6px 0">Buyer Protection fee</h3><p class="muted small">Added to each order: a fixed amount plus a percentage of items.</p><div class="two">' + H.fld("Fixed (₹)", "fe_f", s.buyerFeeFixedPaise / 100, 'inputmode="decimal"') + H.fld("Percent", "fe_p", s.buyerFeeBp / 100, 'inputmode="decimal"') + '</div><div class="two">' + H.fld("Max items in cart", "fe_l", s.maxCartLines, 'inputmode="numeric"') + H.fld("Max per item", "fe_q", s.maxLineQuantity, 'inputmode="numeric"') + '</div><p class="bad small" id="feerr"></p><button class="btn block" data-a="adfeesave">Save fees</button>';
  out += '<h3 style="margin:18px 0 6px">Delivery options</h3>' + c.data.deliveryOptions.map(function (o) {
    return '<div class="list"><div class="row" style="display:block"><b>' + esc(o.code) + "</b> " + (o.is_active ? "" : H.pill("Off", "")) + '<div class="two" style="margin-top:6px">' + H.fld("Name", "do_l_" + o.code, o.label) + H.fld("Fee (₹)", "do_f_" + o.code, o.fee_paise / 100, 'inputmode="decimal"') + '</div><div class="two"><label class="row" style="padding:0"><input type="checkbox" id="do_a_' + o.code + '"' + (o.is_active ? " checked" : "") + '> <span class="l">Available</span></label><button class="btn sm" data-a="addosave" data-i="' + esc(o.code) + '" data-j="' + o.sort_order + '">Save</button></div></div></div>';
  }).join("");
  return out;
};
A.adfeesave = async function () {
  var f = H.paise("fe_f"), p = pct("fe_p"), l = parseInt(val("fe_l"), 10), q = parseInt(val("fe_q"), 10);
  if (!(f >= 0) || !(p >= 0)) return say("feerr", "Enter the fee amounts.");
  try { await api.patch("/admin/pricing/settings", { buyerFeeFixedPaise: f, buyerFeeBp: p, maxCartLines: l, maxLineQuantity: q }); drop("ad:fees"); toast("Saved. New orders use these fees."); R.render(); } catch (e) { say("feerr", errText(e)); }
};
A.addosave = async function (code, so) {
  var f = H.paise("do_f_" + code); if (!(f >= 0)) return toast("Enter the fee.");
  try { await api.put("/admin/pricing/delivery-options/" + code, { label: val("do_l_" + code), feePaise: f, isActive: !!$("do_a_" + code).checked, sortOrder: parseInt(so, 10) || 0 }); drop("ad:fees"); drop("cart"); toast("Saved"); R.render(); } catch (e) { toast(errText(e)); }
};

/* ---------- hold & return rules ---------- */
V.adrules = function () {
  var g = guard(); if (g) return g;
  var c = need("ad:fin", function () { return api.get("/admin/finance/settings"); });
  var out = head("Hold &amp; return rules", true);
  if (c.st === "loading") return out + R.loadingBox();
  if (c.st === "err") return out + R.failBox(c.err);
  var s = c.data, F = [["payoutHoldDays", "Hold seller money (days after payment)"], ["returnWindowDays", "Return window (days)"], ["sellerDecisionDays", "Seller answers a return within (days)"], ["escalationDays", "Escalate to admin after (days)"], ["returnShipDays", "Buyer ships return within (days)"], ["returnReceiptDays", "Seller confirms receipt within (days)"]];
  out += '<p class="muted small">Changes apply to orders paid and returns requested from now on.</p>' + F.map(function (f) { return H.fld(f[1], "fr_" + f[0], s[f[0]], 'inputmode="numeric"'); }).join("") + H.fld("Return shipping fee (₹)", "fr_returnShippingPaise", (s.returnShippingPaise || 0) / 100, 'inputmode="decimal"') + H.fld("Reason for change", "fr_reason", "", 'maxlength="300"') + '<p class="bad small" id="frerr"></p><button class="btn block" data-a="adrulesave">Save</button>';
  return out;
};
A.adrulesave = async function () {
  var c = R.C["ad:fin"].data, b = {}, keys = ["payoutHoldDays", "returnWindowDays", "sellerDecisionDays", "escalationDays", "returnShipDays", "returnReceiptDays"];
  keys.forEach(function (k) { var n = parseInt(val("fr_" + k), 10); if (n !== c[k] && isFinite(n)) b[k] = n; });
  var rs = H.paise("fr_returnShippingPaise"); if (isFinite(rs) && rs !== c.returnShippingPaise) b.returnShippingPaise = rs;
  if (!Object.keys(b).length) return say("frerr", "Nothing changed.");
  if (val("fr_reason").length < 3) return say("frerr", "Write a reason for the change.");
  b.reason = val("fr_reason");
  try { await api.patch("/admin/finance/settings", b); drop("ad:fin"); drop("sl:bal"); toast("Saved"); R.render(); } catch (e) { say("frerr", errText(e)); }
};

/* ---------- orders ---------- */
var oF = "";
V.adorders = function () {
  var g = guard(); if (g) return g;
  var c = need("ad:orders:" + oF, function () { return api.get("/admin/orders?limit=50" + (oF ? "&status=" + oF : "")); });
  return head("Orders", true) + H.chips([["", "All"], ["pending_payment", "Unpaid"], ["confirmed", "Paid"], ["shipped", "Shipped"], ["delivered", "Delivered"], ["cancelled", "Cancelled"]], oF, "adof") + listBox(c, "No orders.", function (o) {
    return '<button class="row" data-a="go" data-i="adorder" data-j="' + esc(o.id) + '"><span class="l"><b>' + esc(o.number) + '</b><br><span class="muted small">' + R.when(o.placedAt) + " · " + esc(o.paymentStatus) + '</span><br><span class="price">' + inr(o.totalPaise) + '</span></span><span class="pill ' + R.stClass(o.status) + '">' + esc(R.stLabel(o.status)) + '</span><span class="chev"></span></button>';
  });
};
A.adof = function (i) { oF = i; R.render(); };
V.adorder = function (id) {
  var g = guard(); if (g) return g;
  var c = need("ad:order:" + id, function () { return api.get("/admin/orders/" + id); });
  if (c.st === "loading") return head("Order", true) + R.loadingBox();
  if (c.st === "err") return head("Order", true) + R.failBox(c.err);
  var o = c.data, t = o.totals, a = o.shippingAddress || {};
  var out = head("Order " + esc(o.number), true) + '<p><span class="pill ' + R.stClass(o.status) + '">' + esc(R.stLabel(o.status)) + "</span> " + H.pill(o.paymentStatus, o.paymentStatus === "paid" ? "ok" : "prog") + ' <span class="muted small">' + R.when(o.placedAt) + "</span></p>";
  o.packages.forEach(function (pk) {
    out += '<h3 style="margin:12px 0 6px">' + esc(pk.number) + " · " + esc(pk.sellerName) + ' <span class="pill ' + R.stClass(pk.status) + '">' + esc(R.stLabel(pk.status)) + '</span></h3><div class="list">' + pk.items.map(function (i) { return '<div class="row"><span class="l">' + esc(i.title) + '<br><span class="muted small">' + esc(R.variantLabel(i.options)) + " × " + i.quantity + (i.commissionPaise != null ? " · commission " + inr(i.commissionPaise) + " (" + bp(i.commissionRateBp) + ")" : "") + '</span></span><span class="price">' + inr(i.netPaise) + "</span></div>"; }).join("") + "</div>" +
      (pk.earnings && pk.earnings.sellerEarningPaise != null ? '<p class="muted small">Seller earns ' + inr(pk.earnings.sellerEarningPaise) + (pk.earnings.availableAt ? " · available " + R.when(pk.earnings.availableAt) : "") + "</p>" : "") + (pk.carrier ? '<p class="muted small">' + esc(pk.carrier) + " " + esc(pk.trackingNumber || "") + "</p>" : "");
  });
  out += "<div>" + sum("Items", inr(t.itemsSubtotalPaise)) + (t.discountPaise ? sum("Coupon" + (o.coupon ? " " + esc(o.coupon) : ""), "−" + inr(t.discountPaise)) : "") + sum("Delivery", inr(t.deliveryPaise)) + sum("Buyer Protection", inr(t.buyerProtectionPaise)) + sum("Total", inr(t.totalPaise), "total") + "</div>";
  if (a.name) out += '<p class="muted small">Ship to: ' + esc(a.name) + ", " + esc(a.line1) + ", " + esc(a.city) + ", " + esc(a.state) + " " + esc(a.pincode) + "</p>";
  if (o.payments && o.payments.length) out += '<h3 style="margin:14px 0 6px">Payments</h3><div class="list">' + o.payments.map(function (p) { return '<div class="row"><span class="l">' + esc(p.provider) + " · " + esc(p.status) + '<br><span class="muted small">' + R.when(p.createdAt) + (p.failureReason ? " · " + esc(p.failureReason) : "") + '</span></span><span class="price">' + inr(p.amountPaise) + "</span></div>"; }).join("") + "</div>";
  return out + '<p class="muted small">Refunds and cancelling a paid order on a seller\'s behalf will come in the next step.</p>';
};

/* ---------- users ---------- */
var uQ = "";
V.adusers = function () {
  var g = guard(); if (g) return g;
  var c = need("ad:users:" + uQ, function () { return api.get("/admin/users?limit=50" + (uQ ? "&q=" + encodeURIComponent(uQ) : "")); });
  var out = head("Users", true) + '<form class="search" id="adsq" style="margin-bottom:12px"><input id="adq" placeholder="Search name or email" value="' + esc(uQ) + '" autocomplete="off"></form>';
  if (c.st === "loading") return out + R.loadingBox();
  if (c.st === "err") return out + R.failBox(c.err);
  return out + listBox(c, "No users found.", function (u) {
    var me = S.user && S.user.id === u.id, isAdmin = u.roles.indexOf("admin") >= 0;
    return '<div class="row" style="display:block"><b>' + esc(u.fullName) + "</b> " + (u.status !== "active" ? H.pill(u.status, "bad") : "") + (isAdmin ? " " + H.pill("admin", "ok") : "") + (u.roles.indexOf("seller") >= 0 ? " " + H.pill("seller", "") : "") + '<br><span class="muted small">' + esc(u.email) + " · joined " + R.when(u.createdAt) + "</span>" +
      (me ? "" : '<div class="two" style="margin-top:8px">' + (can("admin.roles.manage") ? '<button class="btn ghost sm" data-a="aduadm" data-i="' + esc(u.id) + '" data-j="' + (isAdmin ? "0" : "1") + '">' + (R.UI.confirm === "ua" + u.id ? "Tap again" : isAdmin ? "Remove admin" : "Make admin") + "</button>" : "<span></span>") + (can("admin.users.manage") && u.status !== "deleted" ? '<button class="btn ' + (u.status === "active" ? "danger" : "ghost") + ' sm" data-a="adusus" data-i="' + esc(u.id) + '" data-j="' + (u.status === "active" ? "0" : "1") + '">' + (R.UI.confirm === "us" + u.id ? "Tap again" : u.status === "active" ? "Suspend" : "Reactivate") + "</button>" : "") + "</div>") + "</div>";
  });
};
document.addEventListener("submit", function (ev) { if (ev.target.id === "adsq") { ev.preventDefault(); uQ = val("adq"); R.render(); } });
A.aduadm = async function (id, on) {
  if (!tapTwice("ua" + id)) return;
  try { if (on === "1") await api.post("/admin/users/" + id + "/roles", { role: "admin" }); else await api.del("/admin/users/" + id + "/roles/admin"); drop("ad:users"); toast("Done"); R.render(); } catch (e) { toast(errText(e)); }
};
A.adusus = async function (id, re) {
  if (!tapTwice("us" + id)) return;
  try { await api.post("/admin/users/" + id + (re === "1" ? "/reactivate" : "/suspend"), { reason: re === "1" ? "Reactivated by admin" : "Suspended by admin" }); drop("ad:users"); toast("Done"); R.render(); } catch (e) { toast(errText(e)); }
};
})();
