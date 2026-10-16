/* Home showcase behaviour: hero carousel (auto-advance, pause, arrows, dots), scroll rails and the remembered theme.
   The page content is drawn by app.js; this file only listens, so it keeps working after every re-render. */
(function () {
  "use strict";
  try { var t = localStorage.getItem("rl-theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) { }
  var paused = false, reduce = window.matchMedia && matchMedia("(prefers-reduced-motion:reduce)").matches;
  if (reduce) paused = true;
  function track() { return document.getElementById("herotrack"); }
  function go(dir) {
    var tr = track(); if (!tr) return;
    var w = tr.clientWidth, n = tr.children.length, i = Math.round(tr.scrollLeft / w) + dir;
    if (i >= n) i = 0; if (i < 0) i = n - 1;
    tr.scrollTo({ left: i * w, behavior: reduce ? "auto" : "smooth" });
  }
  function dots() {
    var tr = track(), d = document.getElementById("herodots"); if (!tr || !d) return;
    var i = Math.round(tr.scrollLeft / tr.clientWidth);
    Array.prototype.forEach.call(d.children, function (el, n) { el.classList.toggle("on", n === i); });
  }
  document.addEventListener("scroll", function (e) { if (e.target && e.target.id === "herotrack") dots(); }, true);
  document.addEventListener("click", function (e) {
    var h = e.target.closest && e.target.closest("[data-hero]"), r = e.target.closest && e.target.closest("[data-rail]");
    if (h) {
      var k = h.getAttribute("data-hero");
      if (k === "pause") {
        paused = !paused; h.setAttribute("aria-label", paused ? "Play slides" : "Pause slides");
        h.firstElementChild.innerHTML = paused ? '<path d="M8 5l11 7-11 7z"/>' : '<path d="M9 6v12M15 6v12"/>';
      } else go(k === "next" ? 1 : -1);
      return;
    }
    if (r) {
      var rt = r.closest(".sec").querySelector(".rail-track");
      if (rt) rt.scrollBy({ left: (r.getAttribute("data-rail") === "next" ? 1 : -1) * rt.clientWidth * 0.8, behavior: reduce ? "auto" : "smooth" });
    }
  });
  setInterval(function () {
    var tr = track(); if (!tr || paused || document.hidden) return;
    if (tr.matches(":hover") || tr.contains(document.activeElement)) return;
    go(1);
  }, 6000);
})();
