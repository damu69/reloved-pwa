import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Config } from "./config.js";

// Private file storage, kept apart from the application code. Files are never public:
// they are read back only through authorised API routes.
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*\.(pdf|jpg|png|webp)$/;
function checkKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error("Invalid storage key");
}

// Development and tests only (the server refuses it in production).
export function localStorage(rootDir: string): Storage {
  const root = resolve(rootDir);
  const pathOf = (key: string) => {
    checkKey(key);
    const p = resolve(root, key);
    if (!p.startsWith(root + sep)) throw new Error("Invalid storage key");
    return p;
  };
  return {
    async put(key, body) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body, { flag: "wx" });
    },
    get: (key) => readFile(pathOf(key)),
    remove: (key) => rm(pathOf(key), { force: true }),
  };
}

// Supabase Storage through its REST API with the service-role key (server side only).
// Create the bucket as PRIVATE in the Supabase dashboard first.
// Not yet exercised against a live project; verify on staging before relying on it.
export function supabaseStorage(url: string, serviceKey: string, bucket: string): Storage {
  const base = `${url.replace(/\/$/, "")}/storage/v1/object/${bucket}`;
  const headers = { authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  const fail = async (r: Response, what: string) => {
    throw new Error(`Storage ${what} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  return {
    async put(key, body, contentType) {
      checkKey(key);
      const r = await fetch(`${base}/${key}`, {
        method: "POST",
        headers: { ...headers, "content-type": contentType, "x-upsert": "false" },
        body: new Uint8Array(body),
      });
      if (!r.ok) await fail(r, "upload");
    },
    async get(key) {
      checkKey(key);
      const r = await fetch(`${base}/${key}`, { headers });
      if (!r.ok) await fail(r, "download");
      return Buffer.from(await r.arrayBuffer());
    },
    async remove(key) {
      checkKey(key);
      const r = await fetch(`${base}/${key}`, { method: "DELETE", headers });
      if (!r.ok && r.status !== 404) await fail(r, "delete");
    },
  };
}

export function createStorage(cfg: Config): Storage {
  return cfg.STORAGE_DRIVER === "supabase"
    ? supabaseStorage(cfg.SUPABASE_URL!, cfg.SUPABASE_SERVICE_ROLE_KEY!, cfg.STORAGE_BUCKET)
    : localStorage(cfg.STORAGE_LOCAL_DIR);
}

// File type from the content itself, never from the name or the client's Content-Type.
export function sniffDocumentType(b: Buffer): { mime: string; ext: string } | null {
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}
