import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Config } from "./config.js";

// AES-256-GCM field encryption for sensitive identifiers (PAN, bank account numbers).
// Format: "v1:" + base64(iv[12] | tag[16] | ciphertext). The version prefix allows key rotation later.
// `aad` binds a ciphertext to its record, so a value copied into another row will not decrypt.
export interface FieldCipher {
  encrypt(plain: string, aad: string): string;
  decrypt(token: string, aad: string): string;
}

export function createFieldCipher(cfg: Config): FieldCipher {
  const key = Buffer.from(cfg.DATA_ENCRYPTION_KEY, "base64");
  return {
    encrypt(plain, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    },
    decrypt(token, aad) {
      if (!token.startsWith("v1:")) throw new Error("Unknown ciphertext version");
      const raw = Buffer.from(token.slice(3), "base64");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    },
  };
}
