// Draws the Reloved app icon, splash and store graphics with a headless browser.
// Run once on a computer that has Playwright; the PNGs it writes are committed, so CI does not need this.
// Usage: node scripts/make-icons.mjs   (writes ./resources, ./store and ../web/icon-*.png)
import { chromium } from "playwright";
import fs from "node:fs";
const BG = "#151311", SAND = "#e0b469", LINE = "#38332d", FG = "#f2ece3";
const mark = (size, pad) => {            // the "R" monogram, scaled to fit inside `pad` of the square
  const s = size * pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100">
    <text x="50" y="82" text-anchor="middle" font-family="'Liberation Serif','DejaVu Serif',Georgia,serif" font-size="96" font-style="italic" fill="${SAND}">R</text>
  </svg>`;
};
const page = (w, h, inner, bg) => `<html><body style="margin:0;width:${w}px;height:${h}px;background:${bg};display:grid;place-items:center;overflow:hidden">${inner}</body></html>`;
const b = await chromium.launch(); const ctx = await b.newContext({ deviceScaleFactor: 1 });
async function shot(file, w, h, html, transparent = false) {
  const p = await ctx.newPage(); await p.setViewportSize({ width: w, height: h }); await p.setContent(html);
  await p.screenshot({ path: file, omitBackground: transparent }); await p.close();
}
fs.mkdirSync("resources", { recursive: true }); fs.mkdirSync("store", { recursive: true });
const ring = (s) => `<div style="position:absolute;width:${s * .86}px;height:${s * .86}px;border:${Math.max(2, s * .006)}px solid ${LINE};border-radius:50%"></div>`;
await shot("resources/icon-only.png", 1024, 1024, page(1024, 1024, ring(1024) + mark(1024, .66), BG));
await shot("resources/icon-foreground.png", 1024, 1024, page(1024, 1024, mark(1024, .5), "transparent"), true);
await shot("resources/icon-background.png", 1024, 1024, page(1024, 1024, "", BG));
const splash = (w, h) => page(w, h, `<div style="text-align:center">${mark(w, .26)}<div style="font:400 ${w * .07}px 'Liberation Serif',Georgia,serif;color:${FG};letter-spacing:.02em;margin-top:-${w * .02}px">Reloved</div></div>`, BG);
await shot("resources/splash.png", 2732, 2732, splash(2732, 2732));
await shot("resources/splash-dark.png", 2732, 2732, splash(2732, 2732));
await shot("store/icon-512.png", 512, 512, page(512, 512, ring(512) + mark(512, .66), BG));
await shot("../web/icon-512.png", 512, 512, page(512, 512, mark(512, .6), BG));
await shot("../web/icon-192.png", 192, 192, page(192, 192, mark(192, .6), BG));
await shot("store/feature-graphic-1024x500.png", 1024, 500, page(1024, 500,
  `<div style="display:flex;align-items:center;gap:36px">${mark(300, 1)}<div><div style="font:400 92px 'Liberation Serif',Georgia,serif;color:${FG}">Reloved</div><div style="font:400 34px system-ui,sans-serif;color:#a69d91;margin-top:6px">Pre-owned fashion, found and swiped.</div></div></div>`, BG));
await b.close();
console.log("icons written");
