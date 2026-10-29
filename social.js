// Sign in with Google / Facebook. On the website the buttons are plain links: the browser goes to Google/Facebook and comes
// back to the site (the server does the OAuth work, so no third-party script runs on our pages). Inside the Android app the
// phone's own Google/Facebook sign-in is used and the resulting token is sent to the server.
(function () {
"use strict";
var R = window.RL, V = R.V, A = R.A, S = R.S, UI = R.UI, esc = R.esc, toast = R.toast, errText = R.errText;
var IS_APP = !!(window.api && api.isApp);
var CFG = null, loading = false, nativeReady = null, busy = false;
var NAMES = { google: "Google", facebook: "Facebook" };

var ICON = {
  google: '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.9z"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#1877F2" d="M24 12a12 12 0 1 0-13.9 11.9v-8.4H7.1V12h3V9.4c0-3 1.8-4.7 4.5-4.7 1.3 0 2.7.2 2.7.2v3h-1.5c-1.5 0-2 .9-2 1.9V12h3.4l-.5 3.5h-2.9v8.4A12 12 0 0 0 24 12z"/></svg>'
};
var MSG = {
  cancelled: "Sign-in was cancelled.",
  state: "That sign-in took too long or was interrupted. Please try again.",
  SOCIAL_FAILED: "We could not verify your sign-in. Please try again.",
  SOCIAL_EMAIL_REQUIRED: "Facebook did not share an email address. Allow email access and try again, or sign up with your email.",
  ACCOUNT_EXISTS_USE_PASSWORD: "An account with this email already exists. Sign in with your email and password, then connect Facebook in Settings.",
  ACCOUNT_SUSPENDED: "This account is suspended. Contact support.",
  SOCIAL_ALREADY_LINKED: "That account is already connected to a Reloved account.",
  SOCIAL_RETRY: "Please try signing in again.",
  SOCIAL_NOT_ENABLED: "This sign-in method is not available."
};

function load() {
  if (CFG || loading) return;
  loading = true;
  api.get("/auth/social/providers", { anon: true }).then(function (c) {
    // The app can only use a provider it has everything for.
    c.providers = (c.providers || []).filter(function (p) { return !IS_APP || (p === "google" ? !!c.googleClientId : !!(c.facebookAppId && c.facebookClientToken)); });
    CFG = c; loading = false; R.render();
  }, function () { CFG = { providers: [] }; loading = false; });
}
function enabled() { load(); return (CFG && CFG.providers) || []; }

R.socialButtons = function () {
  var list = enabled();
  if (!list.length) return "";
  return '<div class="social"><div class="or"><span>or continue with</span></div>' + list.map(function (p) {
    var label = "Continue with " + NAMES[p];
    return IS_APP
      ? '<button type="button" class="btn ghost block" data-a="socialnative" data-i="' + p + '">' + ICON[p] + label + "</button>"
      : '<a class="btn ghost block" href="/api/v1/auth/social/' + p + '/start" rel="nofollow">' + ICON[p] + label + "</a>";
  }).join("") + "</div>";
};

/* ---------- Android app: native sign-in ---------- */
function plugin() { var C = window.Capacitor; return C && C.registerPlugin ? C.registerPlugin("SocialLogin") : null; }
function initNative() {
  if (nativeReady) return nativeReady;
  var o = {};
  if (CFG.googleClientId) o.google = { webClientId: CFG.googleClientId };
  if (CFG.facebookAppId && CFG.facebookClientToken) o.facebook = { appId: CFG.facebookAppId, clientToken: CFG.facebookClientToken };
  nativeReady = plugin().initialize(o).catch(function (e) { nativeReady = null; throw e; });
  return nativeReady;
}
async function nativeToken(p) {
  await initNative();
  var SL = plugin();
  if (p === "google") {
    var g = await SL.login({ provider: "google", options: { scopes: ["email", "profile"] } });
    var idt = g && g.result && g.result.idToken;
    if (!idt) throw Object.assign(new Error("Google did not return a sign-in token."), { code: "SOCIAL_FAILED" });
    return { idToken: idt };
  }
  var f = await SL.login({ provider: "facebook", options: { permissions: ["email", "public_profile"] } });
  var at = f && f.result && f.result.accessToken && f.result.accessToken.token;
  if (!at) throw Object.assign(new Error("Facebook did not return a sign-in token."), { code: "SOCIAL_FAILED" });
  return { accessToken: at };
}
function cancelled(e) { return /cancel|dismiss|closed|12501|-5/i.test(String((e && (e.message || e.code)) || "")); }

A.socialnative = async function (p) {
  if (busy) return; busy = true;
  try {
    var body = await nativeToken(p);
    await api.social(p, body);
    await R.loadMe(); UI.auth.err = ""; R.afterAuth(); toast("Signed in");
  } catch (e) {
    if (!cancelled(e)) { UI.auth.err = MSG[e.code] || errText(e); R.render(); }
  } finally { busy = false; }
};

/* ---------- Settings: connected accounts ---------- */
R.socialSettings = function () {
  var list = enabled(), u = S.user || {}, mine = u.providers || [];
  if (!list.length) return "";
  var rows = list.map(function (p) {
    var on = mine.indexOf(p) > -1;
    return '<div class="row" style="display:flex;align-items:center;gap:10px">' + ICON[p] + '<span style="flex:1">' + NAMES[p] + '</span>' +
      (on ? '<span class="muted small">Connected</span>' : '<button class="btn ghost" data-a="sociallink" data-i="' + p + '">Connect</button>') + "</div>";
  }).join("");
  var note = u.hasPassword === false
    ? '<p class="muted small" style="margin:8px 0">You have no password yet; you sign in with ' + mine.map(function (p) { return NAMES[p]; }).join(" or ") + '.</p><button class="btn ghost block" data-a="setpwlink">Email me a link to set a password</button>' : "";
  return '<h3 style="margin:18px 0 6px">Connected accounts</h3><div class="list">' + rows + "</div>" + note;
};
A.sociallink = async function (p) {
  if (busy) return; busy = true;
  try {
    if (IS_APP) {
      var r = await api.post("/auth/social/" + p + "/token", await nativeToken(p));
      S.user = r.user; toast(NAMES[p] + " connected"); R.render();
    } else {
      var s = await api.post("/auth/social/" + p + "/link-start", {});
      location.href = s.url;
    }
  } catch (e) { if (!cancelled(e)) toast(MSG[e.code] || errText(e)); }
  finally { busy = false; }
};
A.setpwlink = async function () {
  try { await api.post("/auth/password/forgot", { email: S.user.email }, { anon: true }); toast("We emailed you a link to set a password."); }
  catch (e) { toast(errText(e)); }
};

/* ---------- Website: coming back from Google/Facebook ---------- */
// The server redirects to  /#social=ok  /#social_linked=google  /#social_error=CODE
function handleReturn() {
  var m = /^#(social|social_linked|social_error)=([A-Za-z0-9_%\-]{1,60})$/.exec(location.hash || "");
  if (!m) return;
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { }
  var kind = m[1], val = decodeURIComponent(m[2]), tries = 0;
  var t = setInterval(async function () {
    if (!S.ready && ++tries <= 100) return;
    clearInterval(t); if (!S.ready) return;
    if (kind === "social") {
      if (await api.restore()) { await R.loadMe(); R.afterAuth(); toast("Signed in"); }
      else { R.go("auth"); UI.auth.err = "Sign-in did not finish. Please try again."; R.render(); }
    } else if (kind === "social_linked") {
      try { await R.loadMe(); } catch (e) { }
      toast(NAMES[val] ? NAMES[val] + " connected" : "Account connected"); R.render();
    } else {
      UI.auth.mode = "login"; R.go("auth"); UI.auth.err = MSG[val] || "Sign-in did not work. Please try again."; R.render(); // go() clears the message, so it is set afterwards
    }
  }, 100);
}
handleReturn();
window.addEventListener("hashchange", handleReturn);
})();
