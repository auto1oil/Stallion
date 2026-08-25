// Hauler paperwork — insurance, authority, W-9.
//
// A company can't run loads for Stallion without current documents, and those
// documents expire. Everything here exists to make a lapse visible before a
// truck is already on a job rather than after.

export const HAULER_DOC_BUCKET = 'hauler-docs';

// The papers Stallion actually asks for. Free text would give five spellings
// of "Certificate of Insurance" and no way to tell what's missing.
export const HAULER_DOC_KINDS = [
  'Certificate of Insurance',
  'Auto Liability',
  'Cargo Insurance',
  'Workers Comp',
  'Operating Authority (MC)',
  'W-9',
  'Signed Agreement',
  'Other',
];

// Without these on file a company should not be hauling. Anything else is
// useful to have but not a blocker, and calling everything required would make
// the warning meaningless.
export const REQUIRED_DOC_KINDS = [
  'Certificate of Insurance',
  'W-9',
];

export type HaulerDocument = {
  id: string;
  hauler_id: string;
  kind: string;
  file_name: string | null;
  file_path: string;
  expires_on: string | null;
  notes: string | null;
  uploaded_by: string | null;
  created_at: string;
};

const today = () => new Date().toISOString().slice(0, 10);

export function isExpired(d: Pick<HaulerDocument, 'expires_on'>): boolean {
  return !!d.expires_on && d.expires_on < today();
}

// "Expiring" means inside 30 days — long enough to chase a renewal, short
// enough that it isn't permanently amber.
export function isExpiringSoon(d: Pick<HaulerDocument, 'expires_on'>, days = 30): boolean {
  if (!d.expires_on || isExpired(d)) return false;
  const limit = new Date();
  limit.setDate(limit.getDate() + days);
  return d.expires_on <= limit.toISOString().slice(0, 10);
}

export type DocStatus = {
  expired: HaulerDocument[];
  expiringSoon: HaulerDocument[];
  missingKinds: string[];
  ok: boolean;
};

// The one-line answer to "can this company haul right now". A kind counts as
// held only if at least one document of that kind is on file and not expired —
// an expired certificate is not paperwork, it's a gap.
export function docStatus(docs: HaulerDocument[]): DocStatus {
  const expired = docs.filter(isExpired);
  const expiringSoon = docs.filter((d) => isExpiringSoon(d));
  const missingKinds = REQUIRED_DOC_KINDS.filter(
    (kind) => !docs.some((d) => d.kind === kind && !isExpired(d)),
  );
  return {
    expired,
    expiringSoon,
    missingKinds,
    ok: expired.length === 0 && missingKinds.length === 0,
  };
}

// A short phrase for a list row. Null when there is nothing to say.
export function docWarning(docs: HaulerDocument[]): string | null {
  const s = docStatus(docs);
  const parts: string[] = [];
  if (s.missingKinds.length) parts.push(`no current ${s.missingKinds.join(' or ')}`);
  const expiredOthers = s.expired.filter((d) => !s.missingKinds.includes(d.kind));
  if (expiredOthers.length) {
    parts.push(`${expiredOthers.length} expired ${expiredOthers.length === 1 ? 'document' : 'documents'}`);
  }
  if (!parts.length && s.expiringSoon.length) {
    parts.push(`${s.expiringSoon.length} expiring within 30 days`);
  }
  return parts.length ? parts.join('; ') : null;
}
