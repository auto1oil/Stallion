// POST /api/rep/upload-customer-doc
//
// Multipart form: { business_id, doc_type, file }
//
// Office/crew staff upload one of the three customer documents (profile_sheet,
// tax_exempt, fein) on behalf of a business. The
// doc is stored against the business owner's profile so the existing
// CustomerDocuments component picks it up for the customer too.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const ALLOWED_TYPES = new Set(['profile_sheet', 'tax_exempt', 'fein']);

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  // Caller must be staff. Drivers are included (they get the customer list too)
  // but, unlike salesmen, aren't tied to a specific assignment.
  const { data: actor } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (!actor || !['office', 'driver', 'mechanic', 'contractor', 'admin', 'master_admin'].includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'staff only' }, { status: 403 });
  }

  const form = await req.formData();
  const businessId = String(form.get('business_id') || '');
  const docType = String(form.get('doc_type') || '');
  const file = form.get('file');
  if (!businessId || !docType || !(file instanceof File)) {
    return NextResponse.json({ ok: false, error: 'business_id, doc_type, and file are required' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(docType)) {
    return NextResponse.json({ ok: false, error: 'bad doc_type' }, { status: 400 });
  }

  // Data ops run with the service-role client: drivers aren't covered by the
  // is_staff() document policies, and the caller's role is already verified.
  const db = createAdminClient();

  // Writes run with the rep's own session. The "Staff manage customer
  // documents" policies (section 23) permit staff to upload on a customer's
  // behalf, so no service-role key is required.

  // Attach the doc to the business owner so the customer's /shop/account view
  // shows it. Fall back to any customer profile in the business if the owner
  // flag was never set, so the upload still lands somewhere consistent.
  let { data: target } = await db
    .from('profiles')
    .select('id')
    .eq('business_id', businessId)
    .eq('is_business_owner', true)
    .limit(1)
    .maybeSingle();
  if (!target) {
    const { data: anyMember } = await db
      .from('profiles')
      .select('id')
      .eq('business_id', businessId)
      .eq('role', 'customer')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    target = anyMember;
  }
  if (!target) {
    return NextResponse.json({ ok: false, error: 'no customer profile linked to this business' }, { status: 400 });
  }

  const arrayBuf = await file.arrayBuffer();
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const path = `${target.id}/${docType}-${Date.now()}.${ext}`;
  const { error: upErr } = await db.storage
    .from('customer-documents')
    .upload(path, arrayBuf, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });
  }

  // Replace any prior row of the same type so the latest upload wins.
  await db
    .from('customer_documents')
    .delete()
    .eq('customer_id', target.id)
    .eq('doc_type', docType);

  const { error: insErr } = await db
    .from('customer_documents')
    .insert({
      customer_id: target.id,
      doc_type: docType,
      file_path: path,
      file_name: file.name,
      file_size_bytes: file.size,
      mime_type: file.type || null,
    });
  if (insErr) {
    return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, file_path: path });
}
