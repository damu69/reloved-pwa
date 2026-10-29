// Small client for the Reloved API. The access token lives in memory only. On the website the refresh token
// is an httpOnly cookie the browser sends by itself; inside the Android app (which is not on the site's origin)
// it is kept in the phone's private app storage and sent in the request body instead.
(function () {
  var BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || "/api/v1";
  var C = window.Capacitor, IS_APP = !!(C && C.isNativePlatform && C.isNativePlatform());
  var Prefs = IS_APP && C.registerPlugin ? C.registerPlugin("Preferences") : null, RT_KEY = "rl_refresh";
  var memRt = null; // fallback if native storage is unavailable
  function getRt() { return Prefs ? Prefs.get({ key: RT_KEY }).then(function (r) { return (r && r.value) || memRt; }, function () { return memRt; }) : Promise.resolve(null); }
  function setRt(v) { memRt = v || null; if (!Prefs) return Promise.resolve(); return (v ? Prefs.set({ key: RT_KEY, value: v }) : Prefs.remove({ key: RT_KEY })).catch(function () {}); }
  var appHeaders = IS_APP ? { "X-Client": "app" } : {};
  var cred = IS_APP ? "omit" : "include";
  var token = null, expiresAt = 0, refreshing = null, onLogout = function () {};
  // The website's refresh cookie is httpOnly, so the page cannot see whether one exists. This flag remembers whether the
  // last session check found one: "1" yes, "0" no, missing = never checked. Logged-out visitors then skip the refresh
  // call (it can only answer 401) instead of making the catalogue wait for it.
  var HINT_KEY = "rl_session";
  function hint(v) { if (IS_APP) return; try { localStorage.setItem(HINT_KEY, v); } catch (e) { } }
  function mayHaveSession() { if (IS_APP) return true; try { return localStorage.getItem(HINT_KEY) !== "0"; } catch (e) { return true; } }

  function ApiError(status, body) {
    var e = (body && body.error) || {};
    var x = new Error(e.message || (status === 0 ? "No connection. Check your internet and try again." : "Something went wrong."));
    x.status = status; x.code = e.code || (status === 0 ? "NETWORK" : "ERROR"); x.details = e.details || null; x.body = body || null;
    return x;
  }
  function setSession(r) {
    token = r.accessToken; expiresAt = Date.now() + (r.expiresIn || 900) * 1000; hint("1");
    if (IS_APP && r.refreshToken) return setRt(r.refreshToken).then(function () { return r; });
    return r;
  }
  function refresh() {
    if (!refreshing) {
      refreshing = (IS_APP ? getRt() : Promise.resolve(null)).then(function (rt) {
        if (IS_APP && !rt) throw ApiError(401, null);
        var h = Object.assign({ "X-Requested-With": "reloved" }, appHeaders);
        if (IS_APP) h["Content-Type"] = "application/json";
        return fetch(BASE + "/auth/refresh", { method: "POST", credentials: cred, headers: h, body: IS_APP ? JSON.stringify({ refreshToken: rt }) : undefined })
          .catch(function () { throw ApiError(0, null); });
      }).then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { if (!r.ok) { if (r.status === 401) { hint("0"); if (IS_APP) setRt(null); } throw ApiError(r.status, b); } return setSession(b); }); })
        .finally(function () { refreshing = null; });
    }
    return refreshing;
  }
  async function raw(method, path, body, opts) {
    var h = Object.assign({}, appHeaders), isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (token) h.Authorization = "Bearer " + token;
    if (body != null && !isForm) h["Content-Type"] = "application/json";
    if (opts && opts.headers) Object.assign(h, opts.headers);
    var res;
    try {
      res = await fetch(BASE + path, { method: method, headers: h, credentials: cred, body: body == null ? undefined : (isForm ? body : JSON.stringify(body)) });
    } catch (e) { throw ApiError(0, null); }
    if (res.status === 204) return null;
    var ct = res.headers.get("content-type") || "", data = null;
    if (ct.indexOf("json") > -1) data = await res.json().catch(function () { return null; });
    if (!res.ok) throw ApiError(res.status, data);
    return data;
  }
  async function call(method, path, body, opts) {
    var authed = !(opts && opts.anon);
    if (authed && token && Date.now() > expiresAt - 30000) { try { await refresh(); } catch (e) { token = null; } }
    try { return await raw(method, path, body, opts); }
    catch (e) {
      if (e.status === 401 && authed && path.indexOf("/auth/") !== 0) {
        try { await refresh(); } catch (r) { token = null; onLogout(); throw e; }
        return raw(method, path, body, opts);
      }
      throw e;
    }
  }
  window.api = {
    get: function (p, o) { return call("GET", p, null, o); },
    post: function (p, b, o) { return call("POST", p, b === undefined ? {} : b, o); },
    put: function (p, b, o) { return call("PUT", p, b === undefined ? {} : b, o); },
    patch: function (p, b, o) { return call("PATCH", p, b, o); },
    del: function (p, o) { return call("DELETE", p, null, o); },
    upload: function (p, form) { return call("POST", p, form); },
    login: function (email, password) { return raw("POST", "/auth/login", { email: email, password: password }).then(setSession); },
    social: function (provider, body) { return raw("POST", "/auth/social/" + provider + "/token", body).then(setSession); },
    register: function (b) { return raw("POST", "/auth/register", b).then(setSession); },
    logout: function () { return (IS_APP ? getRt() : Promise.resolve(null)).then(function (rt) { return raw("POST", "/auth/logout", IS_APP ? { refreshToken: rt || undefined } : {}, { headers: { "X-Requested-With": "reloved" } }); }).catch(function () {}).then(function () { token = null; hint("0"); return setRt(null); }); },
    restore: function () { return refresh().then(function () { return true; }, function () { return false; }); },
    mayHaveSession: mayHaveSession,
    hasToken: function () { return !!token; },
    onLogout: function (f) { onLogout = f; },
    blob: async function (path) {
      if (token && Date.now() > expiresAt - 30000) { try { await refresh(); } catch (e) { } }
      var res; try { res = await fetch(BASE + path, { headers: token ? { Authorization: "Bearer " + token } : {}, credentials: cred }); } catch (e) { throw ApiError(0, null); }
      if (!res.ok) throw ApiError(res.status, null);
      return res.blob();
    },
    media: function (productId, imageId, size) { return BASE + "/catalogue/media/products/" + productId + "/" + imageId + "/" + size; },
    base: BASE, isApp: IS_APP
  };
})();
