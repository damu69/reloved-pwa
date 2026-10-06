import { z } from "zod";
import { Errors } from "./errors.js";

// Parses request input with a zod schema; any failure becomes a 400 VALIDATION_FAILED.
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    // One message per field, the first that failed, so forms can show it next to the input.
    const seen = new Map<string, string>();
    for (const i of r.error.issues) {
      const path = i.path.join(".");
      if (!seen.has(path)) seen.set(path, i.message);
    }
    throw Errors.validation([...seen].map(([path, message]) => ({ path, message })));
  }
  return r.data;
}

// Free text from users: trimmed, no control characters (null bytes break Postgres; others break UIs).
export const safeText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Contains invalid characters");

// UUIDs are compared as strings in code, so normalise case: Postgres would match either.
export const uuid = () => z.uuid().transform((s) => s.toLowerCase());

export const normEmail = (v: unknown): string => String(v ?? "").trim().toLowerCase();
