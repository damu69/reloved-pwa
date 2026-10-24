// Re-encrypts PAN and bank account numbers with a new DATA_ENCRYPTION_KEY.
//
//   1. Generate a new key:   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//   2. Store it in your password manager FIRST.
//   3. Dry run (changes nothing):
//        OLD_DATA_ENCRYPTION_KEY=<old> DATA_ENCRYPTION_KEY=<new> npm run rotate-key
//   4. Real run (one transaction; every value is decrypted with the old key, encrypted with the new key and
//      read back before commit):
//        OLD_DATA_ENCRYPTION_KEY=<old> DATA_ENCRYPTION_KEY=<new> npm run rotate-key -- --apply
//   5. Put the new key in Vercel (DATA_ENCRYPTION_KEY) and redeploy the API. Until then the API still holds the
//      old key and cannot read the re-encrypted values, so do steps 4 and 5 back to back.
//
// Needs DATABASE_URL (use the owner/migrate connection) and the usual required settings in the environment.
import { loadConfig } from "../lib/config.js";
import { createPool, withTx } from "../lib/db.js";
import { createFieldCipher } from "../lib/encryption.js";
import { writeAudit } from "../lib/audit.js";

const apply = process.argv.includes("--apply");
const oldKey = process.env.OLD_DATA_ENCRYPTION_KEY;
if (!oldKey || Buffer.from(oldKey, "base64").length !== 32) {
  console.error("OLD_DATA_ENCRYPTION_KEY (32 bytes, base64) is required.");
  process.exit(1);
}
const cfgNew = loadConfig();
if (oldKey === cfgNew.DATA_ENCRYPTION_KEY) {
  console.error("The old and new keys are the same. Generate a new key first.");
  process.exit(1);
}
const oldCipher = createFieldCipher({ ...cfgNew, DATA_ENCRYPTION_KEY: oldKey });
const newCipher = createFieldCipher(cfgNew);

const targets = [
  { label: "seller PAN", table: "sellers", column: "pan_encrypted", aad: (id: string) => `seller:${id}:pan` },
  { label: "bank account", table: "seller_bank_accounts", column: "account_number_encrypted", aad: (id: string) => `bank:${id}` },
];

const pool = createPool(cfgNew);
try {
  await withTx(pool, async (tx) => {
    for (const t of targets) {
      const rows = (await tx.query(`select id, ${t.column} as token from ${t.table} for update`)).rows as Array<{ id: string; token: string }>;
      let done = 0;
      for (const r of rows) {
        const aad = t.aad(r.id);
        const plain = oldCipher.decrypt(r.token, aad); // throws if the old key is wrong: nothing is written
        const next = newCipher.encrypt(plain, aad);
        if (newCipher.decrypt(next, aad) !== plain) throw new Error(`Verification failed for ${t.table} ${r.id}`);
        if (apply) await tx.query(`update ${t.table} set ${t.column} = $1 where id = $2`, [next, r.id]);
        done += 1;
      }
      console.log(`${apply ? "re-encrypted" : "would re-encrypt"} ${done} ${t.label} value(s)`);
    }
    if (apply) await writeAudit(tx, { actorUserId: null, action: "encryption.key.rotate", entity: "system", entityId: null, newValue: { tables: targets.map((t) => t.table) } });
    if (!apply) console.log("Dry run only. Add --apply to write the changes.");
  });
} catch (e) {
  console.error("Rotation failed, nothing was changed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
