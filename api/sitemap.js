// /sitemap.xml: the home page, every active category and every listed item, so search engines find them all.
const { SITE, esc, itemPath, getJson } = require("./_seo");

const MAX_PAGES = 30; // 30 x 60 = 1,800 items; raise (or split into a sitemap index) when the catalogue grows past that

module.exports = async function handler(req, res) {
  const urls = [SITE + "/"];
  try {
    const cats = await getJson("/catalogue/categories");
    for (const c of (cats && cats.items) || []) urls.push(SITE + "/c/" + c.path);
    let cursor = null;
    for (let n = 0; n < MAX_PAGES; n++) {
      const r = await getJson("/catalogue/products?limit=60&sort=newest" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      for (const i of (r && r.items) || []) urls.push(SITE + itemPath(i.id, i.title));
      cursor = r && r.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    console.error("[sitemap]", e && e.message);
    res.statusCode = 503; res.setHeader("retry-after", "600"); return res.end("Sitemap temporarily unavailable");
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/xml; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
  res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => "  <url><loc>" + esc(u) + "</loc></url>").join("\n") + "\n</urlset>\n");
};
