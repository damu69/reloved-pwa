// Double-entry ledger. Every money event is one transaction whose debits equal its credits; lines
// are only ever added, never changed. The database re-checks the balance at commit.
import type { Queryable, Tx } from "../../lib/db.js";

export const PLATFORM = {
  receivable: "platform:payments_receivable",
  commission: "platform:commission_revenue",
  buyerFee: "platform:buyer_fee_revenue",
  coupons: "platform:coupon_expense",
} as const;

export type SellerPurpose = "pending" | "available";
export const sellerAccount = (sellerId: string, purpose: SellerPurpose) => `seller:${sellerId}:${purpose}`;

export interface PostingLine { account: string; direction: "debit" | "credit"; amountPaise: number }
export interface Posting { kind: "order_payment" | "hold_release"; referenceType: string; referenceId: string; memo: string; lines: PostingLine[] }

async function ensureSellerAccounts(tx: Tx, sellerIds: string[]) {
  if (!sellerIds.length) return;
  await tx.query(
    `insert into ledger_accounts (code, kind, seller_id, purpose, name)
     select 'seller:' || s || ':' || p, 'liability', s, p,
            case p when 'pending' then 'Owed to seller, on hold' else 'Owed to seller, available for payout' end
       from unnest($1::uuid[]) s cross join unnest(array['pending', 'available']) p
     on conflict do nothing`, [sellerIds]); // no target: covers both unique keys (code; seller + purpose)
}

// Returns the transaction id, or null if this event was already posted (safe to call twice).
export async function post(tx: Tx, p: Posting): Promise<string | null> {
  const lines = p.lines.filter((l) => l.amountPaise !== 0);
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amountPaise) || l.amountPaise < 0) throw new Error(`Ledger amount must be a non-negative integer: ${l.amountPaise}`);
  }
  const debit = lines.filter((l) => l.direction === "debit").reduce((a, l) => a + l.amountPaise, 0);
  const credit = lines.filter((l) => l.direction === "credit").reduce((a, l) => a + l.amountPaise, 0);
  if (debit !== credit || lines.length < 2) throw new Error(`Unbalanced ledger posting ${p.kind}/${p.referenceId}: ${debit} vs ${credit}`);

  // Sorted, so two first-time postings for the same sellers create their accounts in the same order.
  const sellers = [...new Set(lines.map((l) => /^seller:([0-9a-f-]{36}):/.exec(l.account)?.[1]).filter((x): x is string => !!x))].sort();
  await ensureSellerAccounts(tx, sellers);
  const t = await tx.query(
    `insert into ledger_transactions (kind, reference_type, reference_id, memo) values ($1, $2, $3, $4)
     on conflict (kind, reference_id) do nothing returning id`, [p.kind, p.referenceType, p.referenceId, p.memo]);
  if (!t.rowCount) return null;
  const id = t.rows[0].id as string;
  const codes = lines.map((l) => l.account);
  const accounts = await tx.query(`select id, code from ledger_accounts where code = any($1)`, [codes]);
  const idOf = new Map(accounts.rows.map((a) => [a.code as string, a.id as string]));
  for (const c of codes) if (!idOf.has(c)) throw new Error(`Unknown ledger account ${c}`);
  await tx.query(
    `insert into ledger_entries (transaction_id, account_id, direction, amount_paise)
     select $1, a, d, x from unnest($2::uuid[], $3::text[], $4::bigint[]) as t(a, d, x)`,
    [id, lines.map((l) => idOf.get(l.account)), lines.map((l) => l.direction), lines.map((l) => l.amountPaise)]);
  return id;
}

// Balance in the account's normal direction (credit for what is owed to sellers and revenue).
export async function sellerBalances(db: Queryable, sellerId: string): Promise<{ pendingPaise: number; availablePaise: number; paidOutPaise: number }> {
  const r = await db.query(
    `select a.purpose,
            coalesce(sum(e.amount_paise) filter (where e.direction = 'credit'), 0) - coalesce(sum(e.amount_paise) filter (where e.direction = 'debit'), 0) as bal
       from ledger_accounts a left join ledger_entries e on e.account_id = a.id
      where a.seller_id = $1 group by a.purpose`, [sellerId]);
  const by = new Map(r.rows.map((x) => [x.purpose as string, Number(x.bal)]));
  // MOCK / TEMPORARY: payouts to bank accounts are not built yet, so nothing has been paid out.
  return { pendingPaise: by.get("pending") ?? 0, availablePaise: by.get("available") ?? 0, paidOutPaise: 0 };
}
