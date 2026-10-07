import { z } from "zod";
import type { Queryable } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { safeText, uuid } from "../../lib/validate.js";

// Product content: the fields that need admin approval before they change on a live product.
export interface Content {
  title: string; description: string; categoryId: string; brandId: string | null;
  condition: string; attributes: Record<string, string>; gstRateBp: number; hsnCode: string | null;
}
export const CONTENT_COLUMNS: Record<keyof Content, string> = {
  title: "title", description: "description", categoryId: "category_id", brandId: "brand_id",
  condition: "condition", attributes: "attributes", gstRateBp: "gst_rate_bp", hsnCode: "hsn_code",
};

const key = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, "Use lowercase letters, digits and _");
export const keyValues = (max: number) =>
  z.record(key, safeText(1, 60)).refine((o) => Object.keys(o).length <= max, `At most ${max} entries`);

// Long text may contain line breaks; other control characters are refused.
const longText = z.string().trim().max(5000).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), "Contains invalid characters");

export const contentFields = {
  title: safeText(3, 150),
  description: longText,
  categoryId: uuid(),
  brandId: uuid().nullable(),
  condition: z.enum(["new_with_tags", "new", "very_good", "good", "satisfactory"]),
  attributes: keyValues(20),
  gstRateBp: z.number().int().min(0).max(10000),
  hsnCode: z.string().trim().regex(/^[0-9]{4,8}$/, "4 to 8 digits").nullable(),
};
export const createSchema = z.object({
  ...contentFields,
  description: contentFields.description.default(""),
  brandId: contentFields.brandId.optional().default(null),
  attributes: contentFields.attributes.optional().default({}),
  hsnCode: contentFields.hsnCode.optional().default(null),
}).strict();
export const patchSchema = z.object(contentFields).partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const contentOf = (p: any): Content => ({
  title: p.title, description: p.description, categoryId: p.category_id, brandId: p.brand_id,
  condition: p.condition, attributes: p.attributes, gstRateBp: p.gst_rate_bp, hsnCode: p.hsn_code,
});

// Category must be active and a leaf; brand (if any) active; GST rate active.
export async function checkRefs(db: Queryable, c: Content): Promise<void> {
  const r = await db.query(
    `select
       (select is_active from categories where id = $1) as cat_active,
       exists (select 1 from categories where parent_id = $1) as cat_has_children,
       (select is_active from brands where id = $2) as brand_active,
       (select is_active from gst_rates where rate_bp = $3) as gst_active`,
    [c.categoryId, c.brandId, c.gstRateBp],
  );
  const x = r.rows[0];
  const bad: { path: string; message: string }[] = [];
  if (x.cat_active !== true) bad.push({ path: "categoryId", message: "Choose an available category." });
  else if (x.cat_has_children) bad.push({ path: "categoryId", message: "Choose a more specific category." });
  if (c.brandId && x.brand_active !== true) bad.push({ path: "brandId", message: "Choose an available brand." });
  if (x.gst_active !== true) bad.push({ path: "gstRateBp", message: "Choose an allowed GST rate." });
  if (bad.length) throw Errors.validation(bad);
}

// A product can be put up for review (or a revision approved) only when it can actually be sold.
export async function sellableProblems(db: Queryable, productId: string, imageStatuses: string[]): Promise<{ path: string; message: string }[]> {
  const r = await db.query(
    `select
       (select count(*)::int from product_images where product_id = $1 and status = any($2)) as images,
       (select count(*)::int from product_variants where product_id = $1 and is_active and deleted_at is null) as variants`,
    [productId, imageStatuses],
  );
  const x = r.rows[0];
  const out = [];
  if (x.images < 1) out.push({ path: "images", message: "Add at least one photo." });
  if (x.variants < 1) out.push({ path: "variants", message: "Add at least one active variant with a price." });
  return out;
}

export const notSellable = (problems: { path: string; message: string }[]) =>
  new AppError(422, "PRODUCT_INCOMPLETE", "The product is not ready yet.", problems);
