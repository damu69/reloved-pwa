// Serves /item/<id>/<slug> and /c/<category path>: the normal app page (index.html), with the title, description,
// canonical address, link-preview tags, Product structured data and a plain-HTML copy of the content filled in, so
// search engines and WhatsApp/Twitter previews see the item without running scripts. The app then boots as usual and
// replaces the plain copy. If the API is slow or down, the plain app page is served and the scripts take over.
const fs = require("fs");
const path = require("path");
const { SITE, UUID_RE, CAT_RE, COND, esc, itemPath, inr, clip, mediaUrl, getJson } = require("./_seo");

let TEMPLATE = null;
function template() {
  // vercel.json includes index.html with this function (functions["api/page.js"].includeFiles).
  if (!TEMPLATE) TEMPLATE = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  return TEMPLATE;
}

const NEW_CONDITIONS = ["new_with_tags", "new"];

async function itemPage(id) {
  if (!UUID_RE.test(id || "")) return false;
  const p = await getJson("/catalogue/products/" + id);
  if (!p) return false;
  const vs = p.variants || [];
  const v = vs.filter((x) => x.inStock).sort((a, b) => a.pricePaise - b.pricePaise)[0] || vs[0];
  const price = v ? v.pricePaise : null;
  const cond = COND[p.condition] || p.condition || "";
  const url = SITE + itemPath(p.id, p.title);
  const img = (p.images || [])[0];
  const image = img ? mediaUrl(p.id, img.id, 1200) : SITE + "/icon-512.png";
  const facts = [cond, p.brandName, p.attributes && p.attributes.colour].filter(Boolean).join(" · ");
  const sizes = vs.map((x) => x.options && x.options.size).filter(Boolean);
  const description = clip([facts, sizes.length ? "Size " + sizes.join(", ") : "", p.description].filter(Boolean).join(". "), 158);
  const alt = [p.title, p.brandName || "", cond].filter(Boolean).join(", ");
  const ld = {
    "@context": "https://schema.org", "@type": "Product", name: p.title, description: clip(p.description || facts, 500), image: [image], url,
    category: p.categoryName || undefined,
    brand: p.brandName ? { "@type": "Brand", name: p.brandName } : undefined,
    itemCondition: "https://schema.org/" + (NEW_CONDITIONS.includes(p.condition) ? "NewCondition" : "UsedCondition"),
    offers: price == null ? undefined : {
      "@type": "Offer", price: (price / 100).toFixed(2), priceCurrency: "INR", url,
      availability: "https://schema.org/" + (vs.some((x) => x.inStock) ? "InStock" : "OutOfStock"),
      seller: p.seller ? { "@type": "Organization", name: p.seller.displayName } : undefined,
    },
  };
  const body =
    '<article class="ssr">' +
    '<p class="small muted"><a href="/">Reloved</a>' + (p.categoryPath ? ' › <a href="/c/' + esc(p.categoryPath) + '">' + esc(p.categoryName || p.categoryPath) + "</a>" : "") + "</p>" +
    "<h1>" + esc(p.title) + "</h1>" +
    (img ? '<img src="' + esc(mediaUrl(p.id, img.id, 600)) + '" alt="' + esc(alt) + '" width="600" height="600">' : "") +
    (price != null ? '<p class="price">' + esc(inr(price)) + "</p>" : "") +
    "<p>" + esc(facts) + (sizes.length ? " · Size " + esc(sizes.join(", ")) : "") + "</p>" +
    (p.description ? "<p>" + esc(p.description).replace(/\n/g, "<br>") + "</p>" : "") +
    (p.seller ? "<p>Sold by " + esc(p.seller.displayName) + ", a verified Reloved seller. Buyer Protection on every order.</p>" : "") +
    "</article>";
  return {
    title: p.title + (p.brandName ? " · " + p.brandName : "") + (price != null ? " · " + inr(price) : "") + " | Reloved",
    description, url, image, type: "product", ld, body,
  };
}

async function categoryPage(catPath) {
  if (!CAT_RE.test(catPath || "")) return false;
  const cats = await getJson("/catalogue/categories");
  const all = (cats && cats.items) || [];
  const cat = all.find((c) => c.path === catPath);
  if (!cat) return false;
  const res = await getJson("/catalogue/products?limit=48&category=" + encodeURIComponent(catPath));
  const items = (res && res.items) || [];
  const subs = all.filter((c) => c.path.startsWith(catPath + "/") && c.path.split("/").length === catPath.split("/").length + 1);
  const parent = catPath.includes("/") ? all.find((c) => c.path === catPath.slice(0, catPath.lastIndexOf("/"))) : null;
  const name = cat.name, where = parent ? " · " + parent.name : "";
  const url = SITE + "/c/" + catPath;
  const body =
    '<section class="ssr">' +
    '<p class="small muted"><a href="/">Reloved</a>' + (parent ? ' › <a href="/c/' + esc(parent.path) + '">' + esc(parent.name) + "</a>" : "") + "</p>" +
    "<h1>Preloved " + esc(name) + "</h1>" +
    "<p>Pre-owned " + esc(name.toLowerCase()) + " from verified sellers across India, with Buyer Protection on every order.</p>" +
    (subs.length ? "<ul>" + subs.map((s) => '<li><a href="/c/' + esc(s.path) + '">' + esc(s.name) + "</a></li>").join("") + "</ul>" : "") +
    (items.length ? "<ul>" + items.map((i) => '<li><a href="' + esc(itemPath(i.id, i.title)) + '">' + esc(i.title) + "</a> " + esc(inr(i.minPricePaise)) + (i.brandName ? " · " + esc(i.brandName) : "") + "</li>").join("") + "</ul>" : "<p>No items in this category right now.</p>") +
    "</section>";
  const ld = {
    "@context": "https://schema.org", "@type": "CollectionPage", name: "Preloved " + name + where, url,
    mainEntity: { "@type": "ItemList", itemListElement: items.slice(0, 24).map((i, n) => ({ "@type": "ListItem", position: n + 1, url: SITE + itemPath(i.id, i.title), name: i.title })) },
  };
  return {
    title: "Preloved " + name + where + " | Reloved",
    description: clip("Shop preloved " + name.toLowerCase() + " from verified sellers across India. " + (items.length ? items.slice(0, 3).map((i) => i.title).join(", ") + " and more." : "") + " Buyer Protection on every order.", 158),
    url, image: SITE + "/icon-512.png", type: "website", ld, body,
  };
}

function setTag(html, re, tag) { return re.test(html) ? html.replace(re, tag) : html.replace("</head>", tag + "\n</head>"); }
function fill(html, page) {
  if (page === false) {
    return setTag(html, /<title>[^<]*<\/title>/, "<title>Not found | Reloved</title>").replace("</head>", '<meta name="robots" content="noindex">\n</head>');
  }
  if (!page) return html;
  html = setTag(html, /<title>[^<]*<\/title>/, "<title>" + esc(page.title) + "</title>");
  html = setTag(html, /<meta name="description"[^>]*>/, '<meta name="description" content="' + esc(page.description) + '">');
  html = setTag(html, /<link rel="canonical"[^>]*>/, '<link rel="canonical" href="' + esc(page.url) + '">');
  const og = { "og:type": page.type, "og:title": page.title, "og:description": page.description, "og:url": page.url, "og:image": page.image };
  for (const k of Object.keys(og)) html = setTag(html, new RegExp('<meta property="' + k + '"[^>]*>'), '<meta property="' + k + '" content="' + esc(og[k]) + '">');
  // JSON-LD: "<" is escaped so a title can never close the script tag.
  html = html.replace("</head>", '<script type="application/ld+json">' + JSON.stringify(page.ld).replace(/</g, "\\u003c") + "</script>\n</head>");
  return html.replace(/<div class="loading">[^<]*<\/div>/, page.body);
}

module.exports = async function handler(req, res) {
  const u = new URL(req.url, "http://localhost");
  // The rewrite passes kind/id/path as query parameters; the original path is a fallback.
  const parts = u.pathname.split("/").filter(Boolean);
  let kind = u.searchParams.get("kind"), id = u.searchParams.get("id"), catPath = u.searchParams.get("path");
  if (!kind && parts[0] === "item") { kind = "item"; id = parts[1]; }
  if (!kind && parts[0] === "c") { kind = "c"; catPath = parts.slice(1).join("/"); }
  let page = null;
  try {
    if (kind === "item") page = await itemPage(id);
    else if (kind === "c") page = await categoryPage(catPath);
  } catch (e) {
    console.error("[page]", kind, e && e.message);
    page = null; // the API is unreachable: serve the plain app, it shows the content or its own error
  }
  res.statusCode = page === false ? 404 : 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", page ? "public, max-age=0, s-maxage=300, stale-while-revalidate=3600" : "public, max-age=0, s-maxage=60");
  res.end(fill(template(), page));
};
module.exports.fill = fill;
