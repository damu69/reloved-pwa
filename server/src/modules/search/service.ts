import { z } from "zod";
import type { Db } from "../../lib/db.js";
import { withTx } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { CURRENCY } from "../../lib/money.js";

export type SearchSort = "relevance" | "newest" | "price_asc" | "price_desc";
export interface SearchParams {
  q?: string | undefined;
  category?: string | undefined;     // path; includes subcategories
  brands?: string[] | undefined;     // brand slugs
  sellerId?: string | undefined;
  conditions?: string[] | undefined;
  minPricePaise?: number | undefined;
  maxPricePaise?: number | undefined;
  sort?: SearchSort | undefined;
  limit: number;
  cursor?: string | undefined;
}
export interface SearchHit {
  id: string; title: string; condition: string; brandName: string | null; sellerName: string;
  categoryPath: string; minPricePaise: number; currency: typeof CURRENCY; coverImageId: string | null;
}
export interface SearchResult { items: SearchHit[]; nextCursor: string | null; sort: SearchSort }

// The API depends on this interface only, so the Postgres implementation can be replaced by a
// dedicated engine (OpenSearch, Meilisearch) fed from the product_search table later.
export interface SearchService {
  search(p: SearchParams): Promise<SearchResult>;
}

// Words are runs of letters, vowel signs/combining marks (needed for Hindi and other Indic scripts)
// and digits; everything else separates words, matching search_norm() in the database. This also
// makes the tsquery we build safe: no operator characters can reach it.
export function tokenize(q: string): string[] {
  return (q.normalize("NFC").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).map((t) => t.slice(0, 40)).slice(0, 8);
}

const cursorSchema = z.object({ s: z.enum(["relevance", "newest", "price_asc", "price_desc"]), k: z.union([z.number(), z.string()]), id: z.uuid() });
function decode(c: string, sort: SearchSort) {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
  } catch {
    throw Errors.validation([{ path: "cursor", message: "Invalid cursor" }]);
  }
  const r = cursorSchema.safeParse(v);
  if (!r.success || r.data.s !== sort) throw Errors.validation([{ path: "cursor", message: "Invalid cursor" }]);
  const ok = sort === "newest" ? typeof r.data.k === "string" && z.iso.datetime({ offset: true }).safeParse(r.data.k).success
    : typeof r.data.k === "number" && Number.isFinite(r.data.k);
  if (!ok) throw Errors.validation([{ path: "cursor", message: "Invalid cursor" }]);
  return r.data;
}
const encode = (s: SearchSort, k: number | string, id: string) => Buffer.from(JSON.stringify({ s, k, id })).toString("base64url");

export class PostgresSearch implements SearchService {
  constructor(private db: Db) {}

  async search(p: SearchParams): Promise<SearchResult> {
    const tokens = p.q ? tokenize(p.q) : [];
    const hasQ = tokens.length > 0;
    const sort: SearchSort = p.sort === "relevance" && !hasQ ? "newest" : (p.sort ?? (hasQ ? "relevance" : "newest"));
    if (p.minPricePaise !== undefined && p.maxPricePaise !== undefined && p.minPricePaise > p.maxPricePaise) {
      throw Errors.validation([{ path: "minPrice", message: "Minimum price is above the maximum." }]);
    }
    const cur = p.cursor ? decode(p.cursor, sort) : null;

    const args: unknown[] = [];
    const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };
    // Visible = listed product AND seller approved AND category active (checked live, see migration 0004).
    const where: string[] = ["ps.is_listed", "s.status = 'approved'", "c.is_active"];
    let rank = "0::numeric";
    if (hasQ) {
      const tsq = arg(tokens.map((t) => `${t}:*`).join(" & "));
      const plain = arg(tokens.join(" "));
      // Full-text match on any field, or a close spelling of the title (typo tolerance).
      where.push(`(ps.document @@ to_tsquery('simple', ${tsq}) or ${plain} <% ps.title_lower)`);
      rank = `round((ts_rank_cd(ps.document, to_tsquery('simple', ${tsq}), 32) + word_similarity(${plain}, ps.title_lower))::numeric, 6)`;
    }
    if (p.category) { const c = arg(p.category); where.push(`(ps.category_path = ${c} or ps.category_path like ${c} || '/%')`); }
    if (p.brands?.length) where.push(`ps.brand_slug = any(${arg(p.brands)})`);
    if (p.sellerId) where.push(`ps.seller_id = ${arg(p.sellerId)}`);
    if (p.conditions?.length) where.push(`ps.condition = any(${arg(p.conditions)})`);
    if (p.minPricePaise !== undefined) where.push(`ps.min_price_paise >= ${arg(p.minPricePaise)}`);
    if (p.maxPricePaise !== undefined) where.push(`ps.min_price_paise <= ${arg(p.maxPricePaise)}`);

    const order = {
      relevance: { by: "rank desc, product_id desc", key: "rank", cmp: (k: string, id: string) => `(rank, product_id) < (${k}::numeric, ${id}::uuid)` },
      newest: { by: "created_at desc, product_id desc", key: "created_at", cmp: (k: string, id: string) => `(created_at, product_id) < (${k}::timestamptz, ${id}::uuid)` },
      price_asc: { by: "min_price_paise asc, product_id asc", key: "min_price_paise", cmp: (k: string, id: string) => `(min_price_paise, product_id) > (${k}::bigint, ${id}::uuid)` },
      price_desc: { by: "min_price_paise desc, product_id desc", key: "min_price_paise", cmp: (k: string, id: string) => `(min_price_paise, product_id) < (${k}::bigint, ${id}::uuid)` },
    }[sort];
    const outer = cur ? `where ${order.cmp(arg(cur.k), arg(cur.id))}` : "";
    const lim = arg(p.limit + 1);

    const sql = `
      select * from (
        select ps.product_id, ps.title, ps.condition, ps.brand_name, ps.seller_name, ps.category_path,
               ps.min_price_paise, ps.cover_image_id, ps.created_at,
               to_char(ps.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_t, ${rank} as rank
          from product_search ps
          join sellers s on s.id = ps.seller_id
          join categories c on c.id = ps.category_id
         where ${where.join(" and ")}
      ) x ${outer}
      order by ${order.by}
      limit ${lim}`;

    const rows = await withTx(this.db, async (tx) => {
      // Typo tolerance: accept titles whose words are at least 40% similar to the query.
      await tx.query(`select set_config('pg_trgm.word_similarity_threshold', '0.4', true)`);
      return (await tx.query(sql, args)).rows;
    });

    const more = rows.length > p.limit;
    const items = more ? rows.slice(0, p.limit) : rows;
    const last = items.at(-1);
    const keyOf = (r: any): number | string =>
      order.key === "created_at" ? r.cursor_t : order.key === "rank" ? Number(r.rank) : Number(r.min_price_paise);
    return {
      sort,
      items: items.map((r: any) => ({
        id: r.product_id, title: r.title, condition: r.condition, brandName: r.brand_name, sellerName: r.seller_name,
        categoryPath: r.category_path, minPricePaise: Number(r.min_price_paise), currency: CURRENCY, coverImageId: r.cover_image_id,
      })),
      nextCursor: more && last ? encode(sort, keyOf(last), last.product_id) : null,
    };
  }
}
