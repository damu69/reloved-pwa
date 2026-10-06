// Seller application rules in one place: who may move an application from which status to which.

export type SellerStatus = "draft" | "submitted" | "changes_requested" | "approved" | "rejected" | "suspended";
export type DocType = "pan_card" | "gst_certificate" | "address_proof" | "bank_proof" | "other";

// The seller may edit details, documents and bank account only in these states.
export const EDITABLE: readonly SellerStatus[] = ["draft", "changes_requested"];

export const ADMIN_ACTIONS = {
  approve: { from: ["submitted"], to: "approved", reasonRequired: false },
  request_changes: { from: ["submitted"], to: "changes_requested", reasonRequired: true },
  reject: { from: ["submitted"], to: "rejected", reasonRequired: true },
  suspend: { from: ["approved"], to: "suspended", reasonRequired: true },
  reinstate: { from: ["suspended"], to: "approved", reasonRequired: true },
} as const satisfies Record<string, { from: readonly SellerStatus[]; to: SellerStatus; reasonRequired: boolean }>;
export type AdminAction = keyof typeof ADMIN_ACTIONS;

// DEFAULT (see design pack, section 1): PAN card, address proof and bank proof are required;
// a GST certificate is required only when a GSTIN is given. Change here if the business decides otherwise.
export function requiredDocTypes(hasGstin: boolean): DocType[] {
  return hasGstin ? ["pan_card", "address_proof", "bank_proof", "gst_certificate"] : ["pan_card", "address_proof", "bank_proof"];
}

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

// Characters 3 to 12 of a GSTIN are the holder's PAN.
export const gstinMatchesPan = (gstin: string, pan: string): boolean => gstin.slice(2, 12) === pan;
