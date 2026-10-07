// Small client for the Reloved API. The access token lives in memory only; the refresh token is an
// httpOnly cookie that the browser sends by itself.
(function () {
  var BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || "/api/v1";
  var token = null, expiresAt = 0, refreshing = null, onLogout = function () {};

  function ApiError(status, body) {
    var e = (body && body.error) || {};
    var x = new Error(e.message || (status === 0 ? "No connection. Check your internet and try again." : "Something went wrong."));
    x.status = status; x.code = e.code || (status === 0 ? "NETWORK" : "ERROR"); x.details = e.details || null; x.body = body || null;
    return x;
  }
  function setSession(r) {
    token = r.accessToken; expiresAt = Date.now() + (r.expiresIn || 900) * 1000;
    return r;
  }
  function refresh() {
    if (!refreshing) {
      refreshing = fetch(BASE + "/auth/refresh", { method: "POST", credentials: "include", headers: { "X-Requested-With": "reloved" } })
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { if (!r.ok) throw ApiError(r.status, b); return setSession(b); }); })
        .finally(function () { refreshing = null; });
    }
    return refreshing;
  }
  async function raw(method, path, body, opts) {
    var h = {}, isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (token) h.Authorization = "Bearer " + token;
    if (body != null && !isForm) h["Content-Type"] = "application/json";
    if (opts && opts.headers) Object.assign(h, opts.headers);
    var res;
    try {
      res = await fetch(BASE + path, { method: method, headers: h, credentials: "include", body: body == null ? undefined : (isForm ? body : JSON.stringify(body)) });
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
    register: function (b) { return raw("POST", "/auth/register", b).then(setSession); },
    logout: function () { return raw("POST", "/auth/logout", {}, { headers: { "X-Requested-With": "reloved" } }).catch(function () {}).then(function () { token = null; }); },
    restore: function () { return refresh().then(function () { return true; }, function () { return false; }); },
    hasToken: function () { return !!token; },
    onLogout: function (f) { onLogout = f; },
    blob: async function (path) {
      if (token && Date.now() > expiresAt - 30000) { try { await refresh(); } catch (e) { } }
      var res; try { res = await fetch(BASE + path, { headers: token ? { Authorization: "Bearer " + token } : {}, credentials: "include" }); } catch (e) { throw ApiError(0, null); }
      if (!res.ok) throw ApiError(res.status, null);
      return res.blob();
    },
    media: function (productId, imageId, size) { return BASE + "/catalogue/media/products/" + productId + "/" + imageId + "/" + size; },
    base: BASE
  };
})();
