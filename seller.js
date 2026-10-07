// Seller screens: application (KYC), listings, stock, orders, earnings.
(function () {
"use strict";
var R = window.RL, V = R.V, A = R.A, S = R.S, esc = R.esc, inr = R.inr, $ = R.$, val = R.val, toast = R.toast, errText = R.errText, head = R.head, need = R.need, drop = R.drop, go = R.go, row = R.row, sum = R.sum;

/* ---------- shared helpers (also used by admin.js) ---------- */
var H = R.H = {};
H.fld = function (label, id, v, attrs) { return '<label class="field"><span>' + label + '</span><input class="inp" id="' + id + '" value="' + esc(v == null ? "" : v) + '" ' + (attrs || "") + "></label>"; };
H.area = function (label, id, v, attrs) { return '<label class="field"><span>' + label + '</span><textarea class="inp" id="' + id + '" ' + (attrs || "") + ">" + esc(v == null ? "" : v) + "</textarea></label>"; };
H.sel = function (label, id, opts, cur, attrs) { return '<label class="field"><span>' + label + '</span><select class="inp" id="' + id + '" ' + (attrs || "") + ">" + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur == null ? "" : cur) ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + "</select></label>"; };
H.pill = function (t, cls) { return '<span class="pill ' + (cls || "") + '">' + esc(t) + "</span>"; };
H.paise = function (id) { var n = parseFloat(String(val(id)).replace(/,/g, "")); return isFinite(n) ? Math.round(n * 100) : NaN; };
H.errs = function (e) { return errText(e); };
H.chips = function (list, curv, act) { return '<div class="chips">' + list.map(function (c) { return '<button class="chip' + (c[0] === curv ? " on" : "") + '" data-a="' + act + '" data-i="' + esc(c[0]) + '">' + esc(c[1]) + "</button>"; }).join("") + "</div>"; };
H.leaves = function () {
  var byId = {}; S.cats.forEach(function (c) { byId[c.id] = c; });
  function label(c) { var parts = [], x = c; while (x) { parts.unshift(x.name); x = x.parentId ? byId[x.parentId] : null; } return parts.join(" › "); }
  return S.cats.filter(function (c) { return !S.cats.some(function (d) { return d.parentId === c.id; }); }).map(function (c) { return [c.id, label(c)]; }).sort(function (a, b) { return a[1] < b[1] ? -1 : 1; });
};
H.allCats = function () {
  var byId = {}; S.cats.forEach(function (c) { byId[c.id] = c; });
  function label(c) { var parts = [], x = c; while (x) { parts.unshift(x.name); x = x.parentId ? byId[x.parentId] : null; } return parts.join(" › "); }
  return S.cats.map(function (c) { return [c.id, label(c)]; }).sort(function (a, b) { return a[1] < b[1] ? -1 : 1; });
};
// Photos from a phone can be 5-10 MB; the host accepts at most 4.5 MB per request, so shrink images first.
H.shrink = function (file, maxDim, quality) {
  return new Promise(function (resolve, reject) {
    if (!/^image\//.test(file.type)) return resolve(file);
    var r = new FileReader();
    r.onerror = function () { reject(new Error("Could not read the file.")); };
    r.onload = function () {
      var im = new Image();
      im.onerror = function () { reject(new Error("This image could not be opened.")); };
      im.onload = function () {
        var s = Math.min(1, maxDim / Math.max(im.width, im.height)), c = document.createElement("canvas");
        c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        c.toBlob(function (b) { if (!b) return reject(new Error("Could not process the image.")); resolve(new File([b], (file.name || "photo").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" })); }, "image/jpeg", quality);
      };
      im.src = r.result;
    };
    r.readAsDataURL(file);
  });
};
H.MAXBYTES = 4 * 1024 * 1024;
// Images that need a sign-in to view are fetched with the token and swapped in after the screen is drawn.
var blobCache = {};
H.authImg = function (path, cls) { return '<img data-auth="' + esc(path) + '" alt="" class="' + (cls || "") + '">'; };
R.hooks.push(function () {
  Array.prototype.forEach.call(document.querySelectorAll("img[data-auth]:not([data-done])"), function (img) {
    var p = img.getAttribute("data-auth"); img.setAttribute("data-done", "1");
    if (blobCache[p]) { img.src = blobCache[p]; return; }
    api.blob(p).then(function (b) { blobCache[p] = URL.createObjectURL(b); img.src = blobCache[p]; }, function () { img.remove(); });
  });
});
H.thumb = function (title, path) { var h = R.hueOf(title); return '<div class="ph" style="background:linear-gradient(150deg,hsl(' + h + ',38%,38%),hsl(' + ((h + 30) % 360) + ',42%,20%))">' + esc(String(title || "?").slice(0, 2).toUpperCase()) + (path ? H.authImg(path) : "") + "</div>"; };

var APP_ST = { draft: "Draft", submitted: "Under review", approved: "Approved", changes_requested: "Changes requested", rejected: "Rejected", suspended: "Suspended" };
var DOC_LABEL = { pan_card: "PAN card", gst_certificate: "GST certificate", address_proof: "Address proof (Aadhaar, utility bill, rent agreement…)", bank_proof: "Bank proof (cancelled cheque or statement)", other: "Other" };
var DOC_ST = { pending: ["Waiting for review", "prog"], accepted: ["Accepted", "ok"], rejected: ["Rejected", "bad"] };
var BTYPES = [["individual", "Individual"], ["proprietorship", "Proprietorship"], ["partnership", "Partnership"], ["llp", "LLP"], ["private_limited", "Private limited"], ["public_limited", "Public limited"], ["other", "Other"]];
var P_ST = { draft: ["Draft", ""], pending: ["In review", "prog"], active: ["Live", "ok"], rejected: ["Rejected", "bad"], archived: ["Archived", ""], blocked: ["Blocked", "bad"] };
function editable(a) { return a.status === "draft" || a.status === "changes_requested"; }

/* ---------- Sell tab ---------- */
V.sell = function () {
  if (!R.signedIn()) return R.V.gate("Sell", "Sign in to start selling on Reloved.");
  var c = need("sl:app", function () { return api.get("/seller/application").catch(function (e) { if (e.status === 404) return { none: true }; throw e; }); });
  if (c.st === "loading") return head("Sell") + R.loadingBox();
  if (c.st === "err") return head("Sell") + R.failBox(c.err);
  var a = c.data;
  if (a.none) return head("Sell on Reloved") + '<div class="banner"><b>Become a seller</b><span class="small muted">Tell us about your business, upload your documents and bank account. We review every application before you can list items.</span></div>' +
    '<div class="list">' + row("1", "Business details", "PAN, address, phone", "", "<span></span>") + row("2", "Documents", "PAN, address and bank proof", "", "<span></span>") + row("3", "Bank account", "Where your earnings go", "", "<span></span>") + "</div><button class=\"btn block\" data-a=\"go\" data-i=\"slform\">Start application</button>";
  var out = head("Sell") + '<p>' + H.pill(APP_ST[a.status] || a.status, a.status === "approved" ? "ok" : a.status === "rejected" || a.status === "suspended" ? "bad" : "prog") + ' <b>' + esc(a.displayName) + "</b></p>";
  if (a.status === "approved" || a.status === "suspended") return out + dashboard(a);
  if (a.status === "submitted") return out + '<div class="banner"><b>Your application is under review</b><span class="small muted">We will check your documents and bank account. You can still see the details below.</span></div>' + appSummary(a, false);
  var last = (a.history || []).slice(-1)[0];
  if (a.status === "rejected") return out + '<div class="banner warn"><b>Application rejected</b><span class="small">' + esc((last && last.reason) || "") + "</span></div>" + appSummary(a, false);
  if (a.status === "changes_requested") out += '<div class="banner warn"><b>Changes requested</b><span class="small">' + esc((last && last.reason) || "Please update the items marked below and submit again.") + "</span></div>";
  return out + appSummary(a, true);
};
function appSummary(a, edit) {
  var need2 = ["pan_card", "address_proof", "bank_proof"].concat(a.gstin ? ["gst_certificate"] : []);
  var out = '<h3 style="margin:14px 0 6px">Business details</h3><div class="list"><div class="row" style="display:block"><b>' + esc(a.businessName) + "</b> · " + esc((BTYPES.filter(function (b) { return b[0] === a.businessType; })[0] || [0, a.businessType])[1]) + "<br>PAN " + esc(a.panMasked) + (a.gstin ? " · GSTIN " + esc(a.gstin) : "") + "<br>" + esc(a.address.line1) + (a.address.line2 ? ", " + esc(a.address.line2) : "") + ", " + esc(a.address.city) + ", " + esc(a.address.state) + " " + esc(a.address.pincode) + '<br><span class="muted small">' + esc(a.contactPhone) + "</span></div></div>" + (edit ? '<button class="btn ghost block" data-a="go" data-i="slform">Edit business details</button>' : "");
  out += '<h3 style="margin:16px 0 6px">Documents</h3>';
  need2.forEach(function (t) {
    var docs = (a.documents || []).filter(function (d) { return d.docType === t; }), d = docs[docs.length - 1], st = d && DOC_ST[d.status];
    out += '<div class="list"><div class="row" style="display:block"><b>' + esc(DOC_LABEL[t]) + "</b> " + (d ? H.pill(st[0], st[1]) : H.pill("Missing", "bad")) + (d && d.reviewNote ? '<br><span class="bad small">' + esc(d.reviewNote) + "</span>" : "") + (d ? '<br><span class="muted small">' + esc(d.originalName) + "</span>" : "") +
      (edit && (!d || d.status !== "accepted") ? '<label class="upl" style="margin:8px 0 0">' + (d ? "Replace file" : "+ Upload file") + '<input type="file" data-up="' + t + '" accept="image/jpeg,image/png,image/webp,application/pdf" hidden></label>' : "") + "</div></div>";
  });
  if (edit && !a.gstin) out += '<p class="muted small">A GST certificate is needed only if you add a GSTIN in your business details.</p>';
  out += '<h3 style="margin:16px 0 6px">Bank account</h3>';
  var b = (a.bankAccounts || []).slice(-1)[0];
  out += '<div class="list"><div class="row" style="display:block">' + (b ? "<b>" + esc(b.accountHolderName) + "</b> · " + esc(b.accountNumberMasked) + "<br>IFSC " + esc(b.ifsc) + " " + H.pill(b.status, b.status === "verified" ? "ok" : "prog") : '<span class="bad">Not added yet</span>') + "</div></div>" + (edit ? '<button class="btn ghost block" data-a="go" data-i="slbank">' + (b ? "Change bank account" : "Add bank account") + "</button>" : "");
  if (edit) out += '<p class="bad small" id="slerr"></p><button class="btn block" style="margin-top:14px" data-a="slsubmit">Submit for review</button>';
  return out;
}
function dashboard(a) {
  var bal = need("sl:bal", function () { return api.get("/seller/finance/balance"); }), b = bal.data;
  var suspended = a.status === "suspended";
  return (suspended ? '<div class="banner warn"><b>Your seller account is suspended</b><span class="small">You can still see your orders and earnings. Contact support to know more.</span></div>' : "") +
    '<div class="banner"><b style="font-size:1.4rem">' + (b ? inr(b.availablePaise) : "…") + '</b><span class="muted small">Available · ' + (b ? inr(b.pendingPaise) : "…") + " on hold" + (b && b.nextReleaseAt ? " · next release " + R.when(b.nextReleaseAt) : "") + "</span></div>" +
    '<div class="list">' + (suspended ? "" : row("P", "My products", "", 'data-a="go" data-i="slprods"')) + row("O", "Orders to ship", "", 'data-a="go" data-i="slorders"') + row("₹", "Earnings", "", 'data-a="go" data-i="slearn"') + (suspended ? "" : row("+", "Add a product", "", 'data-a="go" data-i="slprod" data-j="new"')) + "</div>" +
    '<p class="muted small">Payouts to your bank account are not switched on yet. Earnings are held for ' + (b ? b.holdDaysFromPayment : 14) + " days after payment.</p>";
}
V.slform = function () {
  var c = need("sl:app", function () { return api.get("/seller/application").catch(function (e) { if (e.status === 404) return { none: true }; throw e; }); });
  if (c.st !== "ok") return head("Business details", true) + R.loadingBox();
  var a = c.data.none ? { address: {} } : c.data, u = S.user || {};
  return head(c.data.none ? "Start application" : "Business details", true) + '<form id="slf" novalidate>' + H.fld("Store name (shown to buyers)", "sf_dn", a.displayName, 'maxlength="60"') + H.fld("Business name", "sf_bn", a.businessName || "", 'maxlength="160"') + H.sel("Business type", "sf_bt", BTYPES, a.businessType || "individual") +
    H.fld("PAN", "sf_pan", c.data.none ? "" : "", 'maxlength="10" autocapitalize="characters" placeholder="' + (c.data.none ? "ABCDE1234F" : a.panMasked + " (enter again only to change)") + '"') + H.fld("GSTIN (optional)", "sf_gst", a.gstin || "", 'maxlength="15" autocapitalize="characters"') +
    H.fld("Address line 1", "sf_a1", a.address.line1) + H.fld("Address line 2 (optional)", "sf_a2", a.address.line2) + '<div class="two">' + H.fld("City", "sf_c", a.address.city) + H.fld("State", "sf_s", a.address.state) + "</div>" + H.fld("PIN code", "sf_z", a.address.pincode, 'maxlength="6" inputmode="numeric"') + H.fld("Contact phone", "sf_ph", a.contactPhone, 'inputmode="tel"') +
    '<p class="bad small" id="sferr"></p><button class="btn block" type="submit">Save</button></form>';
};
V.slbank = function () {
  return head("Bank account", true) + '<p class="muted small">Your earnings will be paid to this account. The number is stored encrypted. Names must match your PAN.</p><form id="slb" novalidate>' + H.fld("Account holder name", "sb_n", "") + H.fld("Account number", "sb_a", "", 'inputmode="numeric" autocomplete="off"') + H.fld("Confirm account number", "sb_c", "", 'inputmode="numeric" autocomplete="off"') + H.fld("IFSC", "sb_i", "", 'maxlength="11" autocapitalize="characters"') + '<p class="bad small" id="sberr"></p><button class="btn block" type="submit">Save bank account</button></form>';
};
document.addEventListener("submit", function (ev) {
  if (ev.target.id === "slf") { ev.preventDefault(); saveForm(); }
  if (ev.target.id === "slb") { ev.preventDefault(); saveBank(); }
});
async function saveForm() {
  var c = R.C["sl:app"], isNew = !c || !c.data || c.data.none;
  var b = { displayName: val("sf_dn"), businessName: val("sf_bn"), businessType: val("sf_bt"), addressLine1: val("sf_a1"), city: val("sf_c"), state: val("sf_s"), pincode: val("sf_z"), contactPhone: val("sf_ph") };
  var a2 = val("sf_a2"), pan = val("sf_pan").toUpperCase(), g = val("sf_gst").toUpperCase();
  if (a2) b.addressLine2 = a2; else if (!isNew) b.addressLine2 = null;
  if (g) b.gstin = g; else if (!isNew) b.gstin = null;
  if (pan || isNew) b.pan = pan;
  try { if (isNew) await api.post("/seller/application", b); else await api.patch("/seller/application", b); }
  catch (e) { var er = $("sferr"); if (er) er.textContent = errText(e); return; }
  drop("sl:"); toast("Saved"); R.back();
}
async function saveBank() {
  try { await api.put("/seller/bank-account", { accountHolderName: val("sb_n"), accountNumber: val("sb_a"), accountNumberConfirm: val("sb_c"), ifsc: val("sb_i").toUpperCase() }); }
  catch (e) { var er = $("sberr"); if (er) er.textContent = errText(e); return; }
  drop("sl:"); toast("Bank account saved"); R.back();
}
A.slsubmit = async function () {
  try { await api.post("/seller/application/submit", {}); drop("sl:"); toast("Submitted. We will review your application."); R.render(); }
  catch (e) { var er = $("slerr"); var m = errText(e); if (e.code === "APPLICATION_INCOMPLETE" && e.details && e.details.length) m = "Still missing: " + e.details.map(function (d) { return String(d.path).replace("document:", "").replace(/_/g, " "); }).join(", ") + "."; if (er) er.textContent = m; else toast(m); }
};
document.addEventListener("change", async function (ev) {
  var t = ev.target;
  if (t.dataset && t.dataset.up && t.files && t.files[0]) {
    var f = t.files[0], type = t.dataset.up;
    try {
      toast("Uploading…");
      if (/^image\//.test(f.type)) f = await H.shrink(f, 2200, 0.85);
      if (f.size > H.MAXBYTES) { toast("This file is too large. Use a file under 4 MB."); return; }
      var fd = new FormData(); fd.append("file", f, f.name);
      await api.upload("/seller/documents?docType=" + type, fd); drop("sl:"); toast("Uploaded"); R.render();
    } catch (e) { toast(errText(e)); }
    t.value = "";
  }
  if (t.dataset && t.dataset.img && t.files && t.files.length) {
    var pid = t.dataset.img, files = Array.prototype.slice.call(t.files), okn = 0;
    for (var k = 0; k < files.length; k++) {
      try {
        toast("Uploading photo " + (k + 1) + " of " + files.length + "…");
        var ph = await H.shrink(files[k], 1600, 0.85);
        if (ph.size > H.MAXBYTES) { toast("A photo is too large. Try another."); continue; }
        var fd2 = new FormData(); fd2.append("file", ph, ph.name); await api.upload("/seller/products/" + pid + "/images", fd2); okn++;
      } catch (e) { toast(errText(e)); }
    }
    drop("sl:prod:" + pid); if (okn) toast(okn + " photo" + (okn > 1 ? "s" : "") + " added"); R.render();
    t.value = "";
  }
});

/* ---------- small helpers ---------- */
// First tap arms the button (label changes); the second tap confirms. Typed text is kept across the redraw.
function tapTwice(id) {
  if (R.UI.confirm === id) { R.UI.confirm = null; return true; }
  var keep = {}; Array.prototype.forEach.call(document.querySelectorAll("#main input[id],#main textarea[id],#main select[id]"), function (e) { keep[e.id] = e.type === "checkbox" ? e.checked : e.value; });
  R.UI.confirm = id; R.render();
  Object.keys(keep).forEach(function (k) { var e = $(k); if (e) { if (e.type === "checkbox") e.checked = keep[k]; else e.value = keep[k]; } });
  return false;
}
H.tapTwice = tapTwice;
function more(c, act) { return c && c.data && c.data.nextCursor ? '<button class="btn ghost block" data-a="' + act + '">Load more</button>' : ""; }
var refs = function () {
  return { b: need("sl:brands", function () { return api.get("/catalogue/brands"); }), g: need("sl:gst", function () { return api.get("/catalogue/gst-rates"); }) };
};

/* ---------- products ---------- */
var pFilter = "";
V.slprods = function () {
  var c = need("sl:prods:" + pFilter, function () { return api.get("/seller/products?limit=50" + (pFilter ? "&status=" + pFilter : "")); });
  var out = head("My products", true, '<button class="btn sm" data-a="go" data-i="slprod" data-j="new">+ Add</button>') +
    H.chips([["", "All"], ["draft", "Drafts"], ["pending", "In review"], ["active", "Live"], ["rejected", "Rejected"], ["archived", "Archived"]], pFilter, "slpf");
  if (c.st === "loading") return out + R.loadingBox();
  if (c.st === "err") return out + R.failBox(c.err);
  var items = c.data.items;
  if (!items.length) return out + '<div class="empty"><h2>Nothing here yet</h2>Add your first item to start selling.</div>';
  return out + '<div class="list">' + items.map(function (p) {
    var st = P_ST[p.status] || [p.status, ""];
    return '<button class="row" data-a="go" data-i="slprod" data-j="' + esc(p.id) + '"><span class="l"><b>' + esc(p.title) + '</b><br><span class="muted small">' + (p.minPricePaise != null ? "from " + inr(p.minPricePaise) : "No price yet") + "</span></span>" + H.pill(st[0], st[1]) + (p.hasPendingChange ? H.pill("Edit in review", "prog") : "") + '<span class="chev"></span></button>';
  }).join("") + "</div>";
};
A.slpf = function (i) { pFilter = i; R.render(); };

function loadProd(id) {
  return { p: need("sl:prod:" + id, function () { return api.get("/seller/products/" + id); }), inv: need("sl:inv:" + id, function () { return api.get("/seller/inventory?productId=" + id + "&limit=100"); }) };
}
V.slprod = function (id) {
  var isNew = id === "new", r = refs();
  if (r.b.st === "loading" || r.g.st === "loading") return head(isNew ? "New product" : "Product", true) + R.loadingBox();
  var brands = [["", "No brand"]].concat((r.b.data ? r.b.data.items : []).map(function (b) { return [b.id, b.name]; }));
  var gst = (r.g.data ? r.g.data.items : []).map(function (g) { return [g.rateBp, g.label]; });
  var conds = Object.keys(R.COND).map(function (k) { return [k, R.COND[k]]; });
  var cats = H.leaves();
  if (isNew && !cats.length) return head("New product", true) + '<div class="empty"><h2>No categories yet</h2>The marketplace admin has to add categories first.</div>';
  function form(p) {
    var attrs = p.attributes && p.attributes.colour ? p.attributes.colour : "";
    return H.fld("Title", "pf_t", p.title, 'maxlength="150"') + H.area("Description", "pf_d", p.description, 'maxlength="5000"') + H.sel("Category", "pf_c", cats, p.categoryId) + H.sel("Brand", "pf_b", brands, p.brandId || "") + H.sel("Condition", "pf_n", conds, p.condition || "good") +
      H.sel("GST rate", "pf_g", gst, p.gstRateBp != null ? p.gstRateBp : (gst[0] ? gst[0][0] : 0)) + H.fld("HSN code (optional)", "pf_h", p.hsnCode || "", 'inputmode="numeric" maxlength="8"');
  }
  if (isNew) return head("New product", true) + '<form id="pfn" novalidate>' + form({}) + '<p class="bad small" id="pferr"></p><button class="btn block" type="submit">Save and continue</button></form><p class="muted small">Next you add photos, sizes, prices and stock.</p>';
  var L = loadProd(id), c = L.p;
  if (c.st === "loading") return head("Product", true) + R.loadingBox();
  if (c.st === "err") return head("Product", true) + R.failBox(c.err);
  var p = c.data, st = P_ST[p.status] || [p.status, ""], locked = !(p.status === "draft" || p.status === "rejected" || p.status === "active");
  var out = head(esc(p.title), true) + "<p>" + H.pill(st[0], st[1]) + (p.pendingChange ? " " + H.pill("Edit in review", "prog") : "") + "</p>";
  if (p.status === "rejected" && p.reviewNote) out += '<div class="banner warn"><b>Rejected</b><span class="small">' + esc(p.reviewNote) + "</span></div>";
  if (p.lastChangeReview && p.lastChangeReview.status === "rejected") out += '<div class="banner warn"><b>Your last edit was not approved</b><span class="small">' + esc(p.lastChangeReview.note || "") + "</span></div>";
  if (p.status === "pending") out += '<div class="banner"><b>In review</b><span class="small muted">We are checking this item. You can withdraw it to make changes.</span></div>';
  if (p.status === "blocked") out += '<div class="banner warn"><b>Blocked</b><span class="small">' + esc(p.reviewNote || "This item was blocked by the marketplace.") + "</span></div>";
  if (p.status === "active") out += '<div class="banner"><span class="small muted">Price and stock changes apply at once. Changes to the title, description, photos or category are reviewed first.</span></div>';
  // photos
  out += '<h3 style="margin:14px 0 6px">Photos</h3><div class="thumbs">' + p.images.map(function (im) {
    return '<div style="position:relative">' + H.thumb("", "/seller/products/" + p.id + "/images/" + im.id + "/200") + (locked ? "" : '<button class="heart" style="right:2px;top:2px;bottom:auto" data-a="slimgdel" data-i="' + esc(p.id) + '" data-j="' + esc(im.id) + '" aria-label="Remove photo"><span style="color:#fff;font-weight:700">×</span></button>') + (im.status !== "active" ? '<span class="tag" style="position:absolute;left:2px;bottom:2px;background:rgba(0,0,0,.7);color:#fff;font-size:.6rem;padding:2px 5px;border-radius:6px">' + (im.status === "pending_remove" ? "removing" : "in review") + "</span>" : "") + "</div>";
  }).join("") + "</div>" + (locked ? "" : '<label class="upl">+ Add photos<input type="file" data-img="' + esc(p.id) + '" accept="image/jpeg,image/png,image/webp" multiple hidden></label>');
  // variants
  var inv = L.inv.data ? L.inv.data.items : [], lvl = {}; inv.forEach(function (x) { lvl[x.variantId] = x; });
  out += '<h3 style="margin:14px 0 6px">Sizes, prices and stock</h3>';
  if (!p.variants.length) out += '<p class="muted small">Add at least one option with a price.</p>';
  p.variants.forEach(function (v) {
    var l = lvl[v.id], label = Object.keys(v.options || {}).map(function (k) { return v.options[k]; }).join(" / ") || v.sku;
    out += '<div class="list"><div class="row" style="display:block"><b>' + esc(label) + '</b> <span class="muted small">' + esc(v.sku) + "</span>" + (v.isActive ? "" : " " + H.pill("Hidden", "")) +
      '<div class="two" style="margin-top:8px">' + H.fld("Price (₹)", "vp_" + v.id, (v.pricePaise / 100), 'inputmode="decimal"') + H.fld("MRP (₹)", "vm_" + v.id, (v.mrpPaise / 100), 'inputmode="decimal"') + "</div>" + H.fld("In stock" + (l ? " · " + l.reserved + " reserved, " + l.sold + " sold" : ""), "vs_" + v.id, l ? l.onHand : 0, 'inputmode="numeric"') +
      (locked ? "" : '<div class="two"><button class="btn sm" data-a="slvsave" data-i="' + esc(p.id) + '" data-j="' + esc(v.id) + '">Save</button><button class="btn danger sm" data-a="slvdel" data-i="' + esc(p.id) + '" data-j="' + esc(v.id) + '">' + (R.UI.confirm === v.id ? "Tap again" : "Remove") + "</button></div>") + "</div></div>";
  });
  if (!locked) out += '<details class="list" ' + (p.variants.length ? "" : "open") + '><summary class="row" style="cursor:pointer"><span class="l"><b>+ Add a size or option</b></span></summary><div style="padding:0 14px 14px">' + H.fld("Option name (e.g. M, EU 41, One size)", "nv_o", "") + H.fld("SKU (your own code)", "nv_s", "", 'autocapitalize="characters"') + '<div class="two">' + H.fld("Price (₹)", "nv_p", "", 'inputmode="decimal"') + H.fld("MRP (₹)", "nv_m", "", 'inputmode="decimal"') + "</div>" + H.fld("Stock", "nv_q", "1", 'inputmode="numeric"') + '<button class="btn block" data-a="sladdv" data-i="' + esc(p.id) + '">Add option</button></div></details>';
  // details
  if (locked) out += '<h3 style="margin:14px 0 6px">Details</h3><div class="list"><div class="row" style="display:block">' + esc(p.categoryPath || p.categoryName) + " · " + esc(R.COND[p.condition] || p.condition) + "<br>" + esc(p.description || "") + "</div></div>";
  else out += '<h3 style="margin:14px 0 6px">Details</h3><form id="pfe" data-id="' + esc(p.id) + '" novalidate>' + form(p) + '<p class="bad small" id="pferr"></p><button class="btn ghost block" type="submit">Save details</button></form>';
  // actions
  out += '<div style="margin-top:16px;display:grid;gap:8px"><p class="bad small" id="slaerr"></p>';
  if (p.status === "draft" || p.status === "rejected") out += '<button class="btn block" data-a="slpact" data-i="' + esc(p.id) + '" data-j="submit">Submit for review</button>';
  if (p.status === "pending") out += '<button class="btn ghost block" data-a="slpact" data-i="' + esc(p.id) + '" data-j="withdraw">Withdraw from review</button>';
  if (p.status === "active") out += '<button class="btn ghost block" data-a="slpact" data-i="' + esc(p.id) + '" data-j="archive">Archive (hide from buyers)</button>';
  if (p.status === "archived") out += '<button class="btn block" data-a="slpact" data-i="' + esc(p.id) + '" data-j="unarchive">Bring back</button>';
  if (p.pendingChange) out += '<button class="btn ghost block" data-a="sldiscard" data-i="' + esc(p.id) + '">Discard my edit in review</button>';
  if (p.status === "draft" || p.status === "rejected") out += '<button class="btn danger block" data-a="slpdel" data-i="' + esc(p.id) + '">' + (R.UI.confirm === "del" + p.id ? "Tap again to delete" : "Delete product") + "</button>";
  return out + "</div>";
};
function productBody() {
  var b = { title: val("pf_t"), description: val("pf_d"), categoryId: val("pf_c"), condition: val("pf_n"), gstRateBp: parseInt(val("pf_g"), 10), brandId: val("pf_b") || null, hsnCode: val("pf_h") || null };
  return b;
}
document.addEventListener("submit", async function (ev) {
  var f = ev.target;
  if (f.id !== "pfn" && f.id !== "pfe") return;
  ev.preventDefault();
  var er = $("pferr"), b = productBody();
  try {
    if (f.id === "pfn") { var r = await api.post("/seller/products", b); drop("sl:prods"); toast("Saved. Now add photos and prices."); R.replace("slprod", r.id); }
    else { var id = f.dataset.id, res = await api.patch("/seller/products/" + id, b); drop("sl:prod:" + id); drop("sl:prods"); toast(res.changeMode === "pending_review" ? "Sent for review. The live item stays as it is until approved." : "Saved"); R.render(); }
  } catch (e) { if (er) er.textContent = errText(e); else toast(errText(e)); }
});
A.slimgdel = async function (pid, iid) { await api.del("/seller/products/" + pid + "/images/" + iid); drop("sl:prod:" + pid); R.render(); };
A.slpact = async function (pid, act) {
  try { await api.post("/seller/products/" + pid + "/" + act, {}); drop("sl:prod:" + pid); drop("sl:prods"); toast({ submit: "Sent for review", withdraw: "Withdrawn", archive: "Archived", unarchive: "Back on sale (in review if needed)" }[act]); R.render(); }
  catch (e) { var er = $("slaerr"), m = errText(e); if (e.code === "PRODUCT_INCOMPLETE" && e.details && e.details.length) m = e.details.map(function (d) { return d.message; }).join(" "); if (er) er.textContent = m; else toast(m); }
};
A.sldiscard = async function (pid) { await api.del("/seller/products/" + pid + "/pending-change"); drop("sl:prod:" + pid); drop("sl:prods"); toast("Edit discarded"); R.render(); };
A.slpdel = async function (pid) { if (!tapTwice("del" + pid)) return; await api.del("/seller/products/" + pid); drop("sl:prod"); drop("sl:prods"); toast("Deleted"); R.back(); };
A.slvdel = async function (pid, vid) { if (!tapTwice(vid)) return; await api.del("/seller/products/" + pid + "/variants/" + vid); drop("sl:prod:" + pid); drop("sl:inv:" + pid); R.render(); };
A.slvsave = async function (pid, vid) {
  var price = H.paise("vp_" + vid), mrp = H.paise("vm_" + vid), q = parseInt(val("vs_" + vid), 10);
  if (!(price >= 100)) return toast("Enter a price of at least ₹1.");
  if (!(mrp >= price)) return toast("MRP cannot be lower than the price.");
  if (!(q >= 0)) return toast("Enter the number in stock.");
  var c = R.C["sl:prod:" + pid], inv = R.C["sl:inv:" + pid], v = c && c.data && c.data.variants.filter(function (x) { return x.id === vid; })[0];
  var lv = inv && inv.data && inv.data.items.filter(function (x) { return x.variantId === vid; })[0];
  try {
    if (!v || v.pricePaise !== price || v.mrpPaise !== mrp) await api.patch("/seller/products/" + pid + "/variants/" + vid, { pricePaise: price, mrpPaise: mrp });
    if (!lv || lv.onHand !== q) await api.put("/seller/inventory/" + vid, { onHand: q, expectedOnHand: lv ? lv.onHand : 0 });
    drop("sl:prod:" + pid); drop("sl:inv:" + pid); drop("sl:prods"); toast("Saved"); R.render();
  } catch (e) { toast(errText(e)); if (e.code === "STOCK_CHANGED" || e.status === 409) { drop("sl:inv:" + pid); R.render(); } }
};
A.sladdv = async function (pid) {
  var name = val("nv_o"), sku = val("nv_s"), price = H.paise("nv_p"), mrp = H.paise("nv_m"), q = parseInt(val("nv_q"), 10);
  if (!name) return toast("Give the option a name, for example M or One size.");
  if (!sku) sku = (pid.slice(0, 4) + "-" + name).replace(/[^A-Za-z0-9._-]/g, "").toUpperCase();
  if (!(price >= 100)) return toast("Enter a price of at least ₹1.");
  if (isNaN(mrp)) mrp = price;
  if (mrp < price) return toast("MRP cannot be lower than the price.");
  try {
    var r = await api.post("/seller/products/" + pid + "/variants", { sku: sku, options: { size: name }, pricePaise: price, mrpPaise: mrp });
    if (q > 0) await api.put("/seller/inventory/" + r.id, { onHand: q, expectedOnHand: 0 });
    drop("sl:prod:" + pid); drop("sl:inv:" + pid); drop("sl:prods"); toast("Option added"); R.render();
  } catch (e) { toast(errText(e)); }
};

/* ---------- orders ---------- */
var oFilter = "";
var SO_NEXT = { confirmed: ["processing", "Start packing"], processing: ["shipped", "Mark as shipped"], shipped: ["out_for_delivery", "Out for delivery"], out_for_delivery: ["delivered", "Mark as delivered"] };
V.slorders = function () {
  var c = need("sl:orders:" + oFilter, function () { return api.get("/seller/orders?limit=50" + (oFilter ? "&status=" + oFilter : "")); });
  var out = head("Orders", true) + H.chips([["", "All"], ["confirmed", "To pack"], ["processing", "Packing"], ["shipped", "Shipped"], ["delivered", "Delivered"], ["cancelled", "Cancelled"]], oFilter, "slof");
  if (c.st === "loading") return out + R.loadingBox();
  if (c.st === "err") return out + R.failBox(c.err);
  if (!c.data.items.length) return out + '<div class="empty"><h2>No orders here</h2>Paid orders for your items will show up here.</div>';
  return out + '<div class="list">' + c.data.items.map(function (o) {
    return '<button class="row" data-a="go" data-i="slorder" data-j="' + esc(o.id) + '"><span class="l"><b>' + esc(o.number) + '</b><br><span class="muted small">' + R.when(o.createdAt) + " · " + o.itemCount + (o.itemCount === 1 ? " item" : " items") + '</span><br><span class="price">' + inr(o.itemsNetPaise) + '</span></span><span class="pill ' + R.stClass(o.status) + '">' + esc(R.stLabel(o.status)) + '</span><span class="chev"></span></button>';
  }).join("") + "</div>";
};
A.slof = function (i) { oFilter = i; R.render(); };
V.slorder = function (id) {
  var c = need("sl:order:" + id, function () { return api.get("/seller/orders/" + id); });
  if (c.st === "loading") return head("Order", true) + R.loadingBox();
  if (c.st === "err") return head("Order", true) + R.failBox(c.err);
  var o = c.data, pk = o.packages.filter(function (x) { return x.id === id; })[0] || o.packages[0], a = o.shippingAddress;
  var out = head(esc(pk.number), true) + '<p><span class="pill ' + R.stClass(pk.status) + '">' + esc(R.stLabel(pk.status)) + '</span> <span class="muted small">' + (pk.confirmedAt ? "Paid " + R.when(pk.confirmedAt) : "Placed " + R.when(o.placedAt)) + "</span></p>";
  out += '<div class="list">' + pk.items.map(function (i) { return '<div class="row" style="display:block"><b>' + esc(i.title) + '</b><br><span class="muted small">' + esc(R.variantLabel(i.options)) + " · " + esc(i.sku) + " × " + i.quantity + '</span><br><span class="price">' + inr(i.netPaise) + "</span></div>"; }).join("") + "</div>";
  if (pk.earnings) out += "<div>" + sum("Items", inr(pk.itemsNetPaise)) + (pk.earnings.commissionPaise != null ? sum("Marketplace commission", "−" + inr(pk.earnings.commissionPaise)) : "") + (pk.earnings.deliveryFeePaise ? sum("Delivery fee (to you)", inr(pk.earnings.deliveryFeePaise)) : "") + (pk.earnings.sellerEarningPaise != null ? sum("You earn", inr(pk.earnings.sellerEarningPaise), "total") : "") + "</div>" + (pk.earnings.availableAt ? '<p class="muted small">' + (pk.earnings.releasedAt ? "Released " + R.when(pk.earnings.releasedAt) : "Available from " + R.when(pk.earnings.availableAt)) + "</p>" : "");
  out += '<p class="muted small">Delivery: ' + esc(pk.delivery.label) + (pk.carrier ? " · " + esc(pk.carrier) + " " + esc(pk.trackingNumber || "") : "") + "</p>";
  if (a) out += '<h3 style="margin:14px 0 6px">Ship to</h3><div class="list"><div class="row" style="display:block"><b>' + esc(a.name) + "</b><br>" + esc(a.line1) + (a.line2 ? ", " + esc(a.line2) : "") + "<br>" + esc(a.city) + ", " + esc(a.state) + " " + esc(a.pincode) + (a.phone ? '<br><span class="muted small">' + esc(a.phone) + "</span>" : "") + "</div></div>";
  var nx = SO_NEXT[pk.status];
  out += '<p class="bad small" id="soerr"></p>';
  if (nx && pk.status === "processing" && pk.delivery.code !== "meet") out += H.fld("Courier name", "so_car", "", 'maxlength="60"') + H.fld("Tracking number", "so_trk", "", 'maxlength="60"');
  if (nx) out += '<button class="btn block" data-a="sostep" data-i="' + esc(pk.id) + '" data-j="' + nx[0] + '">' + nx[1] + "</button>";
  if (pk.delivery.code === "meet" && (pk.status === "confirmed" || pk.status === "processing")) out += '<button class="btn ghost block" style="margin-top:8px" data-a="sostep" data-i="' + esc(pk.id) + '" data-j="delivered">Handed over in person</button>';
  if (pk.status === "confirmed" || pk.status === "processing") out += '<div style="margin-top:14px"><h3>Cannot fulfil this order?</h3><p class="muted small">The buyer gets a full refund.</p>' + H.fld("Reason", "so_r", "", 'maxlength="300"') + '<label class="row" style="padding:6px 0"><input type="checkbox" id="so_rs" checked> <span class="l">Put the items back in stock</span></label><button class="btn danger block" data-a="socancel" data-i="' + esc(pk.id) + '">' + (R.UI.confirm === "c" + pk.id ? "Tap again to cancel and refund" : "Cancel and refund buyer") + "</button></div>";
  var hist = (pk.history || []).slice().reverse();
  if (hist.length) out += '<h3 style="margin:18px 0 6px">History</h3><div class="list">' + hist.map(function (h) { return '<div class="row"><span class="l">' + esc(R.stLabel(h.to)) + '<br><span class="muted small">' + R.when(h.at) + (h.reason ? " · " + esc(h.reason) : "") + "</span></span></div>"; }).join("") + "</div>";
  return out;
};
A.sostep = async function (id, to) {
  var b = { to: to };
  if (to === "shipped") { b.carrier = val("so_car"); b.trackingNumber = val("so_trk"); if (!b.carrier || !b.trackingNumber) { var e0 = $("soerr"); if (e0) e0.textContent = "Enter the courier name and tracking number."; return; } }
  try { await api.post("/seller/orders/" + id + "/status", b); drop("sl:order"); drop("sl:orders"); drop("sl:bal"); toast("Updated"); R.render(); }
  catch (e) { var er = $("soerr"); if (er) er.textContent = errText(e); else toast(errText(e)); }
};
A.socancel = async function (id) {
  var r = val("so_r"), er = $("soerr");
  if (r.length < 5) { if (er) er.textContent = "Give a reason of at least 5 characters."; return; }
  if (!tapTwice("c" + id)) return;
  try { await api.post("/seller/orders/" + id + "/cancel", { reason: r, restock: !!($("so_rs") && $("so_rs").checked) }); drop("sl:"); toast("Cancelled. The buyer will be refunded."); R.render(); }
  catch (e) { if (er) er.textContent = errText(e); else toast(errText(e)); }
};

/* ---------- earnings ---------- */
V.slearn = function () {
  var b = need("sl:bal", function () { return api.get("/seller/finance/balance"); }), c = need("sl:earn", function () { return api.get("/seller/finance/earnings?limit=50"); });
  var out = head("Earnings", true);
  if (b.st === "ok") out += '<div class="banner"><b style="font-size:1.4rem">' + inr(b.data.availablePaise) + '</b><span class="muted small">Available · ' + inr(b.data.pendingPaise) + " on hold" + (b.data.nextReleaseAt ? " · next release " + R.when(b.data.nextReleaseAt) : "") + "</span></div>";
  out += '<p class="muted small">Money is held for ' + (b.data ? b.data.holdDaysFromPayment : 14) + " days after the buyer pays, in case of returns. Payouts to your bank are not switched on yet.</p>";
  if (c.st === "loading") return out + R.loadingBox();
  if (c.st === "err") return out + R.failBox(c.err);
  if (!c.data.items.length) return out + '<div class="empty"><h2>No earnings yet</h2>They appear here once a buyer pays for your items.</div>';
  return out + '<div class="list">' + c.data.items.map(function (e) {
    return '<div class="row" style="display:block"><b>' + esc(e.number) + "</b> " + H.pill(e.status === "cancelled" ? "Cancelled" : e.state === "available" ? "Available" : "On hold", e.state === "available" ? "ok" : "prog") + '<br><span class="muted small">Items ' + inr(e.itemsSubtotalPaise) + " − commission " + inr(e.commissionPaise) + " + delivery " + inr(e.deliveryFeePaise) + '</span><br><span class="price">' + inr(e.sellerEarningPaise) + '</span> <span class="muted small">' + (e.state === "available" ? "released " + R.when(e.releasedAt) : "available " + R.when(e.availableAt)) + "</span></div>";
  }).join("") + "</div>";
};
})();
