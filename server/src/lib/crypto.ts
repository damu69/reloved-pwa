import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";

// Opaque random tokens (refresh, password reset). Only their SHA-256 hash is stored.
export const newOpaqueToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (t: string): string => createHash("sha256").update(t).digest("hex");

// argon2id with OWASP-recommended minimums.
const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
export const hashPassword = (p: string): Promise<string> => argon2.hash(p, ARGON);
export const verifyPassword = async (hash: string, p: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, p);
  } catch {
    return false;
  }
};
// Used when the email does not exist, so response time does not reveal whether an account exists.
let dummyHash: Promise<string> | undefined;
export const burnPasswordCheck = async (p: string): Promise<void> => {
  dummyHash ??= hashPassword("not-a-real-password-" + randomBytes(8).toString("hex"));
  await verifyPassword(await dummyHash, p);
};
