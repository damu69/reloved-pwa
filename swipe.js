// Discover (swipe cards) and Inbox / chat screens.
// Swipe right = message the seller, left = skip, up = save to favourites. Buttons and arrow keys do the same.
(function () {
"use strict";
var R = window.RL, V = R.V, A = R.A, S = R.S, esc = R.esc, inr = R.inr, $ = R.$, toast = R.toast, errText = R.errText, head = R.head, go = R.go, ph = R.ph, COND = R.COND;

/* ---------- swipes remembered on this device, so skipped items do not come back ---------- */
var seen = {};
try { seen = JSON.parse(localStorage.getItem("rl_seen") || "{}") || {}; } catch (e) { seen = {}; }
function remember(id, how) {
  seen[id] = how;
  var k = Object.keys(seen); if (k.length > 600) delete seen[k[0]];
  try { localStorage.setItem("rl_seen", JSON.stringify(seen)); } catch (e) { }
}
function unremember(id) { delete seen[id]; try { localStorage.setItem("rl_seen", JSON.stringify(seen)); } catch (e) { } }
function forgetAll() { seen = {}; try { localStorage.removeItem("rl_seen"); } catch (e) { } }

/* ---------- deck ---------- */
var D = { items: [], next: null, loading: false, loaded: false, error: "", cat: "", hist: [], drag: null, busy: false, sheet: null };
function deckUrl(cursor) {
  var p = ["limit=30"];
  if (D.cat) p.push("category=" + encodeURIComponent(D.cat));
  if (cursor) p.push("cursor=" + encodeURIComponent(cursor));
  return "/catalogue/products?" + p.join("&");
}
var deckSeq = 0;
async function loadDeck(more) {
  if (D.loading) return;
  var my = ++deckSeq;
  D.loading = true; D.error = "";
  if (!more) { D.items = []; D.next = null; D.hist = []; }
  paint();
  try {
    // Keep fetching pages until there are enough unseen cards (a page can be all items already swiped).
    for (var guard = 0; guard < 6; guard++) {
      var r = await api.get(deckUrl(D.next), { anon: !R.signedIn() });
      if (my !== deckSeq) return;
      r.items.forEach(function (i) { R.PCAT[i.id] = i.categoryPath; });
      var have = {}; D.items.forEach(function (i) { have[i.id] = 1; });
      D.items = D.items.concat(r.items.filter(function (i) { return !seen[i.id] && !have[i.id] && i.inStock !== false; }));
      D.next = r.nextCursor || null; D.loaded = true;
      if (D.items.length >= 8 || !D.next) break;
    }
  } catch (e) { if (my === deckSeq) D.error = errText(e); }
  if (my === deckSeq) { D.loading = false; paint(); }
}
// force = re-render even if a text box has focus (used when the message sheet opens or closes)
function paint(force) { if (D.drag) return; if (R.current().v === "discover") { if (force) R.render(); else R.refresh(); } }

function topCats() { return S.cats.filter(function (c) { return c.depth === 0; }); }
function cardHTML(i, depth) {
  var meta = [i.brandName, COND[i.condition] || i.condition].filter(Boolean).join(" · ");
  var top = depth === 0;
  return '<div class="sw-card' + (top ? "" : " behind" + depth) + '"' + (top ? ' data-top="1"' : "") + ' data-id="' + esc(i.id) + '" style="z-index:' + (10 - depth) + '">' +
    ph(i.title, i.id, i.coverImageId, 1200) +
    '<div class="sw-info"><div class="sw-price">' + inr(i.minPricePaise) + '</div><div class="sw-title">' + esc(i.title) + '</div><div class="sw-meta">' + esc(meta) + '</div><div class="sw-seller">Sold by ' + esc(i.sellerName) + "</div></div>" +
    (top ? '<span class="stamp st-chat">Chat</span><span class="stamp st-skip">Skip</span><span class="stamp st-save">Save</span>' : "") + "</div>";
}
function sheetHTML(s) {
  var it = s.item, quick = ["Is this still available?", "Could you share more photos?", "Would you take " + inr(Math.round(it.minPricePaise * 0.85 / 100) * 100) + "?"];
  return '<div class="scrim" data-a="dkcancel"></div><div class="sheet" role="dialog" aria-label="Message the seller"><h3>Message ' + esc(it.sellerName) + "</h3>" +
    '<div class="muted small" style="margin:2px 0 10px">About: ' + esc(it.title) + " · " + inr(it.minPricePaise) + "</div>" +
    '<div class="chips">' + quick.map(function (q) { return '<button class="chip" data-a="dkquick" data-i="' + esc(q) + '">' + esc(q) + "</button>"; }).join("") + "</div>" +
    '<textarea class="inp" id="dk_msg" rows="3" maxlength="1000" placeholder="Write a message">' + esc(s.text) + '</textarea><p class="bad small" id="dk_err" style="min-height:1.2em;margin:4px 0"></p>' +
    '<div class="two"><button class="btn ghost" data-a="dkcancel">Not now</button><button class="btn" data-a="dksend"' + (s.busy ? " disabled" : "") + ">" + (s.busy ? "Sending…" : "Send message") + "</button></div></div>";
}
var BTN = {
  undo: '<svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5 6.5 5c2 0 3.6 1.1 5.5 3 1.9-1.9 3.5-3 5.5-3C21 5 22.8 8.6 21.5 11.8 19.5 16.4 12 21 12 21z"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H10l-5 4v-4H4z"/></svg>'
};
V.discover = function () {
  var chips = '<button class="chip' + (!D.cat ? " on" : "") + '" data-a="dkcat" data-i="">All</button>' +
    topCats().map(function (c) { return '<button class="chip' + (D.cat === c.path ? " on" : "") + '" data-a="dkcat" data-i="' + esc(c.path) + '">' + esc(c.name) + "</button>"; }).join("");
  var stage;
  if (D.items.length) {
    stage = D.items.slice(0, 3).map(function (it, k) { return cardHTML(it, k); }).reverse().join("");
  } else if (D.error) {
    stage = '<div class="empty"><h2>Could not load items</h2>' + esc(D.error) + '<div style="margin-top:12px"><button class="btn sm" data-a="dkreload">Try again</button></div></div>';
  } else if (D.loading || !D.loaded) {
    stage = '<div class="sw-card sw-skel"><div class="ph"></div></div>';
  } else {
    stage = '<div class="empty"><h2>You have seen everything</h2>New listings show up here as sellers add them.<div style="margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="btn" data-a="dkreset">Start over</button><button class="btn ghost" data-a="tab" data-i="home">Browse the grid</button></div></div>';
  }
  var has = D.items.length > 0, canUndo = D.hist.length > 0;
  return '<div class="dk"><div class="dk-head"><h1>Discover</h1></div><div class="chips">' + chips + "</div>" +
    '<div class="dk-stage" id="dkstage">' + stage + "</div>" +
    '<div class="dk-actions"><button class="rb sm" data-a="dkundo" aria-label="Undo"' + (canUndo ? "" : " disabled") + ">" + BTN.undo + '</button><button class="rb skip" data-a="dkskip" aria-label="Skip"' + (has ? "" : " disabled") + ">" + BTN.skip +
    '</button><button class="rb save" data-a="dksave" aria-label="Save to favourites"' + (has ? "" : " disabled") + ">" + BTN.save + '</button><button class="rb chat" data-a="dkchat" aria-label="Message seller"' + (has ? "" : " disabled") + ">" + BTN.chat + "</button></div>" +
    '<p class="dk-hint">Swipe right to message the seller · left to skip · up to save</p></div>' + (D.sheet ? sheetHTML(D.sheet) : "");
};
R.E.discover = function () { if (!D.loaded && !D.loading) loadDeck(false); else if (D.items.length < 6 && D.next && !D.loading) loadDeck(true); };

/* ---------- gestures ---------- */
function topEl() { return document.querySelector("#dkstage [data-top]"); }
function setPose(el, dx, dy, instant) {
  el.style.transition = instant ? "none" : "";
  el.style.transform = "translate(" + dx + "px," + dy + "px) rotate(" + dx / 18 + "deg)";
  var cl = function (v) { return Math.max(0, Math.min(1, v / 110)); }, up = -dy > Math.abs(dx);
  var q = function (s) { return el.querySelector(s); };
  q(".st-chat").style.opacity = up ? 0 : cl(dx); q(".st-skip").style.opacity = up ? 0 : cl(-dx); q(".st-save").style.opacity = up ? cl(-dy) : 0;
  var nx = el.parentNode.querySelector(".behind1");
  if (nx) { var pr = Math.min(1, Math.max(Math.abs(dx), Math.abs(dy)) / 140); nx.style.transition = "none"; nx.style.transform = "scale(" + (0.95 + 0.05 * pr) + ") translateY(" + (10 - 10 * pr) + "px)"; }
}
function reset(el) {
  el.style.transition = "transform .22s ease"; el.style.transform = "";
  ["st-chat", "st-skip", "st-save"].forEach(function (c) { var s = el.querySelector("." + c); if (s) s.style.opacity = 0; });
  var nx = el.parentNode.querySelector(".behind1"); if (nx) { nx.style.transition = "transform .22s ease"; nx.style.transform = ""; }
}
document.addEventListener("pointerdown", function (e) {
  var c = e.target.closest && e.target.closest("#dkstage [data-top]");
  if (!c || D.busy || D.sheet || (e.pointerType === "mouse" && e.button !== 0)) return;
  D.drag = { el: c, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, t0: Date.now(), moved: false, id: e.pointerId };
  try { c.setPointerCapture(e.pointerId); } catch (_) { }
});
document.addEventListener("pointermove", function (e) {
  var d = D.drag; if (!d || e.pointerId !== d.id) return;
  d.dx = e.clientX - d.x0; d.dy = e.clientY - d.y0;
  if (!d.moved && Math.abs(d.dx) + Math.abs(d.dy) > 8) d.moved = true;
  if (d.moved) setPose(d.el, d.dx, d.dy, true);
});
function endDrag(e, cancelled) {
  var d = D.drag; if (!d || (e && e.pointerId !== d.id)) return;
  D.drag = null;
  if (cancelled || !d.moved) {
    if (!cancelled && d.el.isConnected) { var id = d.el.dataset.id; reset(d.el); R.go("item", id); }
    else if (d.el.isConnected) reset(d.el);
    return;
  }
  var thr = Math.min(110, d.el.offsetWidth * 0.28), vx = d.dx / Math.max(1, Date.now() - d.t0);
  if (d.dy < -100 && Math.abs(d.dx) < 90) decide("save", d.el);
  else if (d.dx > thr || (vx > 0.6 && d.dx > 40)) decide("chat", d.el);
  else if (d.dx < -thr || (vx < -0.6 && d.dx < -40)) decide("skip", d.el);
  else reset(d.el);
}
document.addEventListener("pointerup", function (e) { endDrag(e, false); });
document.addEventListener("pointercancel", function (e) { endDrag(e, true); });
document.addEventListener("keydown", function (e) {
  if (R.current().v !== "discover" || D.sheet || D.busy) return;
  var a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  var el = topEl(); if (!el) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); decide("skip", el, true); }
  else if (e.key === "ArrowRight") { e.preventDefault(); decide("chat", el, true); }
  else if (e.key === "ArrowUp") { e.preventDefault(); decide("save", el, true); }
});
// Card leaves the screen, then the next one takes its place.
function fling(el, how, then) {
  D.busy = true;
  el.style.transition = "transform .28s ease-in, opacity .28s";
  el.style.transform = how === "skip" ? "translate(-140%,40px) rotate(-18deg)" : how === "chat" ? "translate(140%,40px) rotate(18deg)" : "translate(0,-130%) rotate(0deg)";
  el.style.opacity = "0.2";
  setTimeout(function () { D.busy = false; then(); }, 270);
}
function advance(how) {
  var it = D.items.shift(); if (!it) return;
  remember(it.id, how); D.hist.push({ item: it, how: how });
  if (D.hist.length > 20) D.hist.shift();
  if (D.items.length < 6 && D.next && !D.loading) loadDeck(true); else paint();
}
function needSignIn(msg) { toast(msg); go("auth"); }
function decide(how, el, viaKey) {
  var id = el.dataset.id, it = D.items.filter(function (x) { return x.id === id; })[0]; if (!it) return;
  if (how === "skip") return fling(el, "skip", function () { advance("skip"); });
  if (!R.signedIn()) { reset(el); return needSignIn(how === "chat" ? "Sign in to message sellers" : "Sign in to save favourites"); }
  if (how === "save") {
    return api.put("/me/wishlist/" + id).then(function () {
      S.wish[id] = { productId: id }; toast("Saved to favourites");
      fling(el, "save", function () { advance("save"); });
    }, function (e) { reset(el); toast(errText(e)); });
  }
  // chat: keep the card in place and ask what to send
  reset(el);
  D.sheet = { item: it, text: "Hi! Is this still available?", busy: false }; paint(true);
  setTimeout(function () { var t = $("dk_msg"); if (t && !viaKey) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }, 60);
}

/* ---------- actions ---------- */
A.dkcat = function (i) { D.cat = i; D.loaded = false; D.sheet = null; loadDeck(false); };
A.dkreload = function () { loadDeck(D.items.length > 0); };
A.dkreset = function () { forgetAll(); D.loaded = false; loadDeck(false); };
A.dkskip = function () { var el = topEl(); if (el && !D.busy) decide("skip", el); };
A.dksave = function () { var el = topEl(); if (el && !D.busy) decide("save", el); };
A.dkchat = function () { var el = topEl(); if (el && !D.busy) decide("chat", el); };
A.dkundo = function () {
  var h = D.hist.pop(); if (!h || D.busy) return;
  unremember(h.item.id); D.items.unshift(h.item); paint();
  if (h.how === "save") api.del("/me/wishlist/" + h.item.id).then(function () { delete S.wish[h.item.id]; }, function () { });
};
A.dkcancel = function () { D.sheet = null; paint(true); };
A.dkquick = function (i) { var t = $("dk_msg"); if (t) { t.value = i; t.focus(); } };
A.dksend = async function () {
  var s = D.sheet; if (!s || s.busy) return;
  var t = $("dk_msg"), text = t ? t.value.trim() : "", er = $("dk_err");
  if (!text) { if (er) er.textContent = "Write a message first."; return; }
  s.text = text; s.busy = true; var btn = document.querySelector('[data-a="dksend"]'); if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  try {
    await api.post("/chat/conversations", { productId: s.item.id, message: text });
  } catch (e) {
    s.busy = false; if (btn) { btn.disabled = false; btn.textContent = "Send message"; }
    if (e.code === "OWN_PRODUCT" || e.code === "NOT_FOUND") { D.sheet = null; paint(true); toast(e.code === "OWN_PRODUCT" ? "This is your own listing." : "That item is no longer available."); var el0 = topEl(); if (el0) fling(el0, "skip", function () { advance("skip"); }); return; }
    var er2 = $("dk_err"); if (er2) er2.textContent = errText(e); return;
  }
  D.sheet = null; R.drop("chats"); pollUnread();
  toast("Message sent to " + s.item.sellerName);
  paint(true);
  var el = topEl(); if (el) fling(el, "chat", function () { advance("chat"); }); else advance("chat");
};

/* ---------- inbox ---------- */
function ago(iso) {
  var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "now"; if (m < 60) return m + "m"; if (m < 1440) return Math.floor(m / 60) + "h";
  if (m < 10080) return Math.floor(m / 1440) + "d";
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); } catch (e) { return ""; }
}
function avatar(name) { return '<span class="av" style="background:' + ["#4a4036", "#3c4a3d", "#3b4552", "#52403f", "#4c4a36", "#3a4c4a"][R.hueOf(name) % 6] + '">' + esc(String(name || "?").slice(0, 1).toUpperCase()) + "</span>"; }
V.inbox = function () {
  if (!R.signedIn()) return V.gate("Inbox", "Sign in to message sellers and see your chats.");
  var c = R.need("chats", function () { return api.get("/chat/conversations"); });
  if (c.st === "loading") return head("Inbox") + R.loadingBox();
  if (c.st === "err") return head("Inbox") + R.failBox(c.err);
  var list = c.data.items || [];
  if (!list.length) return head("Inbox") + '<div class="empty"><h2>No chats yet</h2>Swipe right on something you like in Discover, or tap Message seller on an item.<div style="margin-top:14px"><button class="btn" data-a="tab" data-i="discover">Go to Discover</button></div></div>';
  return head("Inbox") + '<div class="list">' + list.map(function (x) {
    return '<button class="row chatrow' + (x.unread ? " unread" : "") + '" data-a="chat" data-i="' + esc(x.id) + '">' + avatar(x.otherName) +
      '<span class="l"><span class="chat-top"><b>' + esc(x.otherName) + '</b><span class="muted small">' + ago(x.lastMessageAt) + '</span></span><span class="muted small chat-item">' + esc(x.productTitle) + '</span><span class="chat-prev">' + esc(x.lastMessagePreview || "No messages yet") + "</span></span>" +
      (x.unread ? '<i class="dot">' + (x.unread > 9 ? "9+" : x.unread) + "</i>" : "") + "</button>";
  }).join("") + "</div>";
};
R.E.inbox = function () { R.drop("chats"); if (R.signedIn()) pollUnread(); };
A.chat = function (i) { go("chat", i); };

/* ---------- conversation ---------- */
var CH = { id: null, items: [], conv: null, loaded: false, err: "", draft: "", sending: false };
function bubbles() {
  var out = "", day = "";
  CH.items.forEach(function (m) {
    var d = new Date(m.createdAt), dk = d.toDateString();
    if (dk !== day) { day = dk; out += '<div class="bub sys">' + esc(d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })) + "</div>"; }
    out += '<div class="bub' + (m.mine ? " me" : "") + '">' + esc(m.body).replace(/\n/g, "<br>") + '<span class="bt">' + esc(d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })) + "</span></div>";
  });
  return out || '<div class="bub sys">Say hello. Messages are private between you and the seller.</div>';
}
function paintMsgs(stick) {
  var box = $("msgs"); if (!box) return;
  var doc = document.documentElement, near = doc.scrollHeight - window.pageYOffset - window.innerHeight < 140;
  box.innerHTML = bubbles();
  if (stick || near) window.scrollTo(0, doc.scrollHeight);
}
async function loadChat(id) {
  try {
    var r = await api.get("/chat/conversations/" + id + "/messages");
    if (CH.id !== id) return;
    CH.items = r.items; CH.conv = r.conversation; CH.loaded = true; CH.err = "";
  } catch (e) { if (CH.id === id) CH.err = errText(e); }
  if (R.current().v === "chat") R.refresh();
  R.drop("chats"); pollUnread();
}
async function pollChat() {
  var id = CH.id; if (!id || !CH.loaded) return;
  var last = CH.items.length ? CH.items[CH.items.length - 1].id : 0;
  try {
    var r = await api.get("/chat/conversations/" + id + "/messages?after=" + last);
    if (CH.id !== id || !r.items.length) return;
    CH.items = CH.items.concat(r.items); paintMsgs(false); R.drop("chats"); pollUnread();
  } catch (e) { }
}
V.chat = function (id) {
  if (!R.signedIn()) return V.gate("Chat", "Sign in to see your chats.");
  if (CH.id !== id) { CH = { id: id, items: [], conv: null, loaded: false, err: "", draft: "", sending: false }; loadChat(id); }
  if (CH.err) return head("Chat", true) + R.failBox(CH.err, "chatretry");
  if (!CH.loaded) return head("Chat", true) + R.loadingBox();
  var c = CH.conv;
  return head(esc(c.otherName), true) +
    '<button class="itemcard" data-a="item" data-i="' + esc(c.productId) + '">' + ph(c.productTitle, c.productId, c.coverImageId, 200) + '<span style="flex:1;min-width:0"><b class="clip">' + esc(c.productTitle) + '</b><span class="muted small clip">' + (c.role === "buyer" ? "You are asking about this item" : "Asking about this item") + '</span></span><span class="chev"></span></button>' +
    '<div class="chat-safe"><button data-a="go" data-i="report" data-j="conversation:' + esc(c.id) + '">Report</button><button data-a="chatblock">Block ' + esc(c.otherName) + '</button></div>' +
    '<div class="msgs" id="msgs">' + bubbles() + "</div>" +
    '<form class="composer" id="chatf"><textarea class="inp" id="chat_in" rows="1" maxlength="1000" placeholder="Write a message" aria-label="Message">' + esc(CH.draft) + '</textarea><button class="btn" type="submit"' + (CH.sending ? " disabled" : "") + ">Send</button></form>";
};
A.chatblock = async function () { if (!CH.conv || !CH.conv.otherUserId) return; await A.blockuser(CH.conv.otherUserId); };
A.chatretry = function () { var id = CH.id; CH = { id: null }; R.replace("chat", id); };
R.hooks.push(function () {
  if (R.current().v === "chat" && CH.loaded) { if (!CH.shown) window.scrollTo(0, document.documentElement.scrollHeight); CH.shown = true; }
  else CH.shown = false;
});
document.addEventListener("input", function (e) { if (e.target.id === "chat_in") { CH.draft = e.target.value; e.target.style.height = "auto"; e.target.style.height = Math.min(120, e.target.scrollHeight) + "px"; } });
document.addEventListener("keydown", function (e) {
  if (e.target.id === "chat_in" && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
});
document.addEventListener("submit", function (e) { if (e.target.id === "chatf") { e.preventDefault(); sendChat(); } });
async function sendChat() {
  var t = $("chat_in"), text = t ? t.value.trim() : "";
  if (!text || CH.sending) return;
  CH.sending = true;
  try {
    var m = await api.post("/chat/conversations/" + CH.id + "/messages", { body: text });
    CH.items.push(m); CH.draft = ""; t.value = ""; t.style.height = "auto";
    paintMsgs(true); R.drop("chats");
  } catch (e) { toast(errText(e)); }
  CH.sending = false; if (t) t.focus();
}

/* ---------- message the seller from an item page ---------- */
A.msgseller = async function (pid) {
  if (!R.signedIn()) return needSignIn("Sign in to message sellers");
  try { var r = await api.post("/chat/conversations", { productId: pid }); R.drop("chats"); go("chat", r.id); }
  catch (e) { toast(e.code === "OWN_PRODUCT" ? "This is your own listing." : errText(e)); }
};

/* ---------- unread badge and background refresh ---------- */
async function pollUnread() {
  if (!R.signedIn()) { if (S.unread) { S.unread = 0; R.paintNav(); } return; }
  try {
    var r = await api.get("/chat/unread"), n = r.messages || 0;
    if (n !== (S.unread || 0)) { S.unread = n; R.paintNav(); }
  } catch (e) { }
}
var tickN = 0;
setInterval(function () {
  if (document.hidden || !R.signedIn()) return;
  tickN++;
  var v = R.current().v;
  if (v === "chat") pollChat();
  else if (v === "inbox") {
    var c = R.need("chats", function () { return api.get("/chat/conversations"); });
    if (c.st === "ok") api.get("/chat/conversations").then(function (r) { c.data = r; if (R.current().v === "inbox") R.refresh(); }, function () { });
  }
  if (tickN % 3 === 0) pollUnread();
}, 4000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) pollUnread(); });
R.hooks.push(function () { if (R.signedIn() && S.unread === undefined) { S.unread = 0; pollUnread(); } });
})();
