// The website reaches the API through the same address (a Vercel rewrite forwards /api/* to it).
// Inside the Android app the screens are bundled on the phone, so the API needs its full address.
var SITE = "https://reloved-pwa.vercel.app";
var native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
window.APP_CONFIG = { API_BASE: native ? SITE + "/api/v1" : "/api/v1", SITE: native ? SITE : "",
  // Nova help chat. Loaded only when someone taps "Chat with us" in the Help Centre.
  NOVA_SRC: "https://ainovabank.vercel.app/widget.js", NOVA_CLIENT: "miaa" };
