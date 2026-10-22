// Charges — fuel and misc purchases drivers record in the field, each with
// its scanned receipt. The receipt is not optional: the table refuses a row
// without receipt_path, and the form refuses to save before the upload has
// actually finished — which is the difference between "scanned" and "saved".

export const CHARGE_TYPES = [
  { value: 'fuel', label: 'Fuel' },
  { value: 'misc', label: 'Misc' },
] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number]['value'];

export const RECEIPT_BUCKET = 'receipts';

export type Charge = {
  id: string;
  created_by: string | null;
  spent_by_name: string | null;
  charged_on: string;
  type: ChargeType;
  amount: number;
  vendor: string | null;
  unit_number: string | null;
  job_number: string | null;
  notes: string | null;
  receipt_path: string;
  created_at: string;
  updated_at: string;
};

export const chargeTypeLabel = (t: string) =>
  CHARGE_TYPES.find((c) => c.value === t)?.label ?? t;
