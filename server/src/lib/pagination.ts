import { z } from "zod";
import { Errors } from "./errors.js";

// Cursor pagination over (created_at desc, id desc). The cursor is opaque to clients.
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

export interface Cursor { t: string; id: string }

export function decodeCursor(c?: string): Cursor | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (typeof v?.id !== "string" || v.id.length > 64 || !z.iso.datetime().safeParse(v?.t).success) throw new Error();
    return { t: v.t, id: v.id };
  } catch {
    throw Errors.validation([{ path: "cursor", message: "Invalid cursor" }]);
  }
}

export const encodeCursor = (t: Date | string, id: string | number): string =>
  Buffer.from(JSON.stringify({ t: new Date(t).toISOString(), id: String(id) })).toString("base64url");

export function page<T>(rows: T[], limit: number, cursorOf: (r: T) => string) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? cursorOf(last) : null };
}
