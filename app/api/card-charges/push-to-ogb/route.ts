// POST /api/card-charges/push-to-ogb — forward a driver-submitted receipt to
// OneGloveBox automatically. Called right after a driver submits a receipt in
// the app. On success the charge becomes 'matched' (its OGB receipt is on file);
// if OGB isn't wired or the push fails, the charge stays 'submitted' so an admin
// can still enter it manually — nothing is lost either way.
//
// Body: { chargeId }

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { pushReceiptToOgb, receiptsPushConfigured } from '@/lib/receipts-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const chargeId = String(body?.chargeId || '');
  if (!chargeId) return NextResponse.json({ ok: false, error: 'chargeId required' }, { status: 400 });

  const db = createAdminClient();
  const { data: charge } = await db.from('card_charges')
    .select('id, amount, charge_date, driver_id, receipt_url, receipt_source, receipt_vendor, receipt_note')
    .eq('id', chargeId).maybeSingle();
  if (!charge) return NextResponse.json({ ok: false, error: 'charge not found' }, { status: 404 });

  // Only the assigned driver (their own receipt) or an admin may push it.
  const { data: me } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle();
  const isAdmin = me?.role === 'admin' || me?.role === 'master_admin';
  if ((charge as { driver_id: string | null }).driver_id !== user.id && !isAdmin) {
    return NextResponse.json({ ok: false, error: 'not your charge' }, { status: 403 });
  }

  // OGB ingest not configured yet → leave it in the manual Submitted queue.
  if (!receiptsPushConfigured()) return NextResponse.json({ ok: true, pushed: false });

  const c = charge as {
    id: string; amount: number | null; charge_date: string | null; driver_id: string | null;
    receipt_url: string | null; receipt_source: string | null; receipt_vendor: string | null; receipt_note: string | null;
  };

  const { data: driver } = c.driver_id
    ? await db.from('profiles').select('full_name, email').eq('id', c.driver_id).maybeSingle()
    : { data: null };

  // A URL OGB can fetch the photo from: external receipts are already URLs;
  // uploads get a 1-hour signed URL from the card-receipts bucket.
  let fileUrl: string | null = null;
  if (c.receipt_url) {
    if (/^https?:\/\//.test(c.receipt_url)) fileUrl = c.receipt_url;
    else {
      const { data: signed } = await db.storage.from('card-receipts').createSignedUrl(c.receipt_url, 3600);
      fileUrl = signed?.signedUrl ?? null;
    }
  }

  const push = await pushReceiptToOgb({
    driver: (driver as { full_name?: string | null; email?: string | null } | null)?.full_name
      || (driver as { email?: string | null } | null)?.email || null,
    driverEmail: (driver as { email?: string | null } | null)?.email || null,
    vendor: c.receipt_vendor,
    amount: c.amount,
    date: c.charge_date,
    note: c.receipt_note,
    fileUrl,
    externalRef: c.id,
  });

  if (!push.ok) return NextResponse.json({ ok: true, pushed: false, error: push.error });

  // It's on file in OneGloveBox now → mark matched (your reconciliation signal).
  await db.from('card_charges').update({
    receipt_status: 'matched',
    receipt_source: 'external_app',
    receipt_matched_at: new Date().toISOString(),
    receipt_ref: push.id ?? null,
  }).eq('id', c.id);

  return NextResponse.json({ ok: true, pushed: true });
}
