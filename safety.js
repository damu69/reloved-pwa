// Forgot / reset password, delete account, report and block, and the admin report queue.
(function () {
"use strict";
var R = window.RL, V = R.V, A = R.A, S = R.S, esc = R.esc, $ = R.$, val = R.val, toast = R.toast, errText = R.errText, head = R.head, go = R.go, need = R.need, drop = R.drop, row = R.row;

function busy(btn, on, label) { if (btn) { btn.disabled = on; if (label) btn.textContent = on ? "Please wait…" : label; } }
function say(id, m) { var e = $(id); if (e) e.textContent = m || ""; }

/* ---------- forgot and reset password ---------- */
var FG = { sent: false, email: "" };
V.forgot = function () {
  var h = head("Forgot password", true);
  if (FG.sent) return h + '<div class="banner"><b>Check your email</b><span class="small muted">If ' + esc(FG.email) + ' has an account, we have sent a link to choose a new password. The link works for a short time. Check your spam folder too.</span></div><button class="btn ghost block" data-a="fgagain">Use a different email</button>';
  return h + '<p class="muted">Enter the email you signed up with. We will send you a link to choose a new password.</p><form id="fgf" novalidate><label class="field"><span>Email</span><input class="inp" id="fg_e" type="email" autocomplete="email" inputmode="email" value="' + esc(FG.email) + '"></label><p class="bad small" id="fg_err"></p><button class="btn block" type="submit">Send reset link</button></form>';
};
A.fgagain = function () { FG.sent = false; R.render(); };
async function sendForgot() {
  var e = val("fg_e").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return say("fg_err", "Enter a valid email address, like name@example.com.");
  var btn = document.querySelector("#fgf button[type=submit]"); busy(btn, true, "Send reset link");
  try { await api.post("/auth/password/forgot", { email: e }); FG.sent = true; FG.email = e; R.render(); }
  catch (x) { busy(btn, false, "Send reset link"); say("fg_err", errText(x)); }
}
var RS = { token: "" };
V.reset = function (token) {
  RS.token = token || RS.token;
  return head("New password", true) + '<p class="muted">Choose a new password for your account.</p><form id="rsf" novalidate><label class="field"><span>New password (at least 10 characters)</span><input class="inp" id="rs_p" type="password" autocomplete="new-password"></label><label class="field"><span>Repeat the password</span><input class="inp" id="rs_p2" type="password" autocomplete="new-password"></label><p class="bad small" id="rs_err"></p><button class="btn block" type="submit">Save new password</button></form>';
};
async function sendReset() {
  var p = $("rs_p").value, p2 = $("rs_p2").value;
  if (p.length < 10) return say("rs_err", "Use at least 10 characters.");
  if (p !== p2) return say("rs_err", "The two passwords are not the same.");
  var btn = document.querySelector("#rsf button[type=submit]"); busy(btn, true, "Save new password");
  try { await api.post("/auth/password/reset", { token: RS.token, password: p }); RS.token = ""; toast("Password changed. Sign in with the new one."); R.UI.auth.mode = "login"; R.UI.auth.err = ""; go("auth"); }
  catch (x) { busy(btn, false, "Save new password"); say("rs_err", x.code === "INVALID_TOKEN" ? "This link has expired or was already used. Ask for a new one." : errText(x)); }
}
// The email link opens the site as  /#reset=TOKEN
function openResetLink() {
  var m = /^#reset=([A-Za-z0-9_\-]{20,200})$/.exec(location.hash || "");
  if (!m) return;
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { }
  var tries = 0, t = setInterval(function () { if (S.ready || ++tries > 100) { clearInterval(t); if (S.ready) go("reset", m[1]); } }, 100);
}
openResetLink();
window.addEventListener("hashchange", openResetLink);

/* ---------- delete account ---------- */
V.delacct = function () {
  if (!R.signedIn()) return V.gate("Delete account", "Sign in first.");
  return head("Delete account", true) + '<div class="banner warn"><b>This cannot be undone</b><span class="small">Your profile, addresses, favourites and cart are removed. If you sell, your listings are taken down. Order and payment records are kept because the law requires it, but they no longer show your name or contact details. You cannot delete the account while an order or return is still in progress.</span></div>' +
    '<form id="daf" novalidate><label class="field"><span>Enter your password to confirm</span><input class="inp" id="da_p" type="password" autocomplete="current-password"></label><p class="bad small" id="da_err"></p><button class="btn danger block" type="submit">Delete my account</button></form>';
};
async function sendDelete() {
  var p = $("da_p").value; if (!p) return say("da_err", "Enter your password.");
  var btn = document.querySelector("#daf button[type=submit]"); busy(btn, true, "Delete my account");
  try { await api.post("/me/delete", { password: p }); toast("Your account has been deleted."); setTimeout(function () { location.href = location.pathname; }, 900); }
  catch (x) { busy(btn, false, "Delete my account"); say("da_err", x.code === "INVALID_CREDENTIALS" ? "That password is not correct." : errText(x)); }
}

/* ---------- report ---------- */
var REASONS = [["counterfeit", "Fake or counterfeit"], ["prohibited", "Not allowed on Reloved"], ["misleading", "Misleading description or photos"], ["abusive", "Rude or abusive"], ["spam", "Spam"], ["scam", "Scam or asks to pay outside the app"], ["other", "Something else"]];
var RP = { type: "", id: "", reason: "", sent: false };
V.report = function (p) {
  if (p) { var k = String(p).split(":"); if (RP.type !== k[0] || RP.id !== k[1]) RP = { type: k[0], id: k[1], reason: "", sent: false }; }
  if (!R.signedIn()) return V.gate("Report", "Sign in to send a report.");
  var what = RP.type === "product" ? "listing" : RP.type === "user" ? "user" : "conversation";
  if (RP.sent) return head("Report", true) + '<div class="banner"><b>Thanks, we got it</b><span class="small muted">Our team will review this ' + what + '. You can also block the person so they cannot message you.</span></div><button class="btn block" data-a="back">Done</button>';
  return head("Report this " + what, true) + '<p class="muted">What is wrong?</p><div class="list">' + REASONS.map(function (r) { return '<button class="row" data-a="rpr" data-i="' + r[0] + '"><span class="l">' + esc(r[1]) + '</span><span class="v">' + (RP.reason === r[0] ? "●" : "○") + "</span></button>"; }).join("") + '</div>' +
    '<label class="field"><span>More detail (optional)</span><textarea class="inp" id="rp_d" maxlength="1000" placeholder="Tell us what happened"></textarea></label><p class="bad small" id="rp_err"></p><button class="btn block" data-a="rpsend">Send report</button>';
};
A.rpr = function (i) { var d = $("rp_d"); var keep = d ? d.value : ""; RP.reason = i; R.render(); var d2 = $("rp_d"); if (d2) d2.value = keep; };
A.rpsend = async function () {
  if (!RP.reason) return say("rp_err", "Pick what is wrong first.");
  try { await api.post("/safety/reports", { targetType: RP.type, targetId: RP.id, reason: RP.reason, details: val("rp_d").trim() || undefined }); RP.sent = true; R.render(); }
  catch (x) { say("rp_err", errText(x)); }
};
A.reportitem = function (pid) { if (!R.signedIn()) { toast("Sign in to report a listing"); return go("auth"); } go("report", "product:" + pid); };

/* ---------- blocked users ---------- */
V.blocked = function () {
  if (!R.signedIn()) return V.gate("Blocked users", "Sign in first.");
  var c = need("blocks", function () { return api.get("/safety/blocks"); });
  var h = head("Blocked users", true);
  if (c.st === "loading") return h + R.loadingBox();
  if (c.st === "err") return h + R.failBox(c.err);
  if (!c.data.items.length) return h + '<div class="empty">You have not blocked anyone. Blocked people cannot message you and you cannot message them.</div>';
  return h + '<div class="list">' + c.data.items.map(function (u) { return '<div class="row"><span class="l"><b>' + esc(u.name) + '</b></span><button class="btn ghost sm" data-a="unblock" data-i="' + esc(u.id) + '">Unblock</button></div>'; }).join("") + "</div>";
};
A.unblock = async function (id) { await api.del("/safety/blocks/" + id); drop("blocks"); toast("Unblocked"); R.render(); };
A.blockuser = async function (id) { await api.post("/safety/blocks", { userId: id }); drop("blocks"); toast("Blocked. They can no longer message you."); };

/* ---------- admin: report queue ---------- */
var RF = "open", armed = "";
function can(p) { return (S.perms || []).indexOf(p) >= 0; }
V.adreports = function () {
  if (!R.signedIn() || !can("admin.reports.manage")) return head("Reports", true) + '<div class="empty"><h2>Not allowed</h2>This area is for marketplace admins.</div>';
  var c = need("ad:reports:" + RF, function () { return api.get("/admin/reports?status=" + RF); });
  var h = head("Reports", true) + '<div class="chips">' + [["open", "Open"], ["actioned", "Actioned"], ["dismissed", "Dismissed"]].map(function (x) { return '<button class="chip' + (RF === x[0] ? " on" : "") + '" data-a="adrf" data-i="' + x[0] + '">' + x[1] + "</button>"; }).join("") + "</div>";
  if (c.st === "loading") return h + R.loadingBox();
  if (c.st === "err") return h + R.failBox(c.err);
  if (!c.data.items.length) return h + '<div class="empty">Nothing here.</div>';
  var why = {}; REASONS.forEach(function (r) { why[r[0]] = r[1]; });
  return h + c.data.items.map(function (r) {
    var open = r.status === "open", t = r.targetType;
    return '<div class="banner"><b>' + esc(why[r.reason] || r.reason) + '</b><span class="small muted">' + esc(t) + ": " + esc(r.targetLabel || "") + " · reported by " + esc(r.reporterName) + "</span>" + (r.details ? '<p class="small" style="margin:6px 0">' + esc(r.details).replace(/\n/g, "<br>") + "</p>" : "") +
      (t === "product" ? '<button class="btn ghost sm" data-a="item" data-i="' + esc(r.targetId) + '">View listing</button> ' : "") +
      (open ? '<div class="two" style="margin-top:8px">' + (t === "product" ? btn(r.id, "remove", "Remove listing") : "") + (t !== "conversation" ? btn(r.id, "suspend", "Suspend user") : "") + btn(r.id, "dismiss", "Dismiss") + "</div>" : (r.adminNote ? '<span class="small muted">Note: ' + esc(r.adminNote) + "</span>" : "")) + "</div>";
  }).join("");
};
function btn(id, act, label) { var k = id + ":" + act; return '<button class="btn ' + (act === "dismiss" ? "ghost" : "danger") + ' sm" data-a="adrs" data-i="' + esc(id) + '" data-j="' + act + '">' + (armed === k ? "Tap again" : label) + "</button>"; }
A.adrf = function (i) { RF = i; armed = ""; R.render(); };
A.adrs = async function (id, act) {
  var k = id + ":" + act;
  if (act !== "dismiss" && armed !== k) { armed = k; return R.render(); }
  armed = "";
  try { await api.post("/admin/reports/" + id + "/resolve", { action: act }); drop("ad:reports:open"); drop("ad:reports:actioned"); drop("ad:reports:dismissed"); toast("Done"); } catch (x) { toast(errText(x)); }
  R.render();
};

/* ---------- Android app: the phone's back button goes back inside the app, and exits only from the top level ---------- */
(function () {
  var C = window.Capacitor, App = C && C.isNativePlatform && C.isNativePlatform() && C.registerPlugin && C.registerPlugin("App");
  if (App && App.addListener) App.addListener("backButton", function () { if (R.canBack()) R.back(); else App.exitApp(); });
})();

/* ---------- offline notice (the app opens even without a connection) ---------- */
(function () {
  var bar;
  function show(off) {
    if (!bar) { bar = document.createElement("div"); bar.setAttribute("role", "status"); bar.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99;padding:calc(env(safe-area-inset-top,0px) + 8px) 12px 8px;background:#3a2f28;color:#f3ece4;text-align:center;font-size:13px;display:none"; bar.textContent = "You're offline. Reconnect to browse and buy."; document.body.appendChild(bar); }
    bar.style.display = off ? "block" : "none";
  }
  window.addEventListener("offline", function () { show(true); });
  window.addEventListener("online", function () { show(false); if (window.RL && RL.refresh) RL.refresh(); });
  if (navigator.onLine === false) show(true);
})();

/* ---------- forms ---------- */
document.addEventListener("submit", function (e) {
  var id = e.target.id;
  if (id === "fgf") { e.preventDefault(); sendForgot(); }
  else if (id === "rsf") { e.preventDefault(); sendReset(); }
  else if (id === "daf") { e.preventDefault(); sendDelete(); }
});
})();
