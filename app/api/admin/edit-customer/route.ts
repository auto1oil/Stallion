// POST /api/admin/edit-customer — admin edits a customer's details.
//
// Body: { customer_id, business_name?, full_name?, email?, phone?, address?, county? }
// Updates the customer profile and, when the customer is linked to a business,
// the business name/phone/address too (so the display stays consistent). If the
// email changes and the customer has a real login, updates their auth email as
// well. Runs with the service-role client to avoid RLS gaps.

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (me?.role !== 'admin' && me?.role !== 'master_admin') {
      return NextResponse.json({ ok: false, error: 'admin only' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const id = body.customer_id as string | undefined;
    if (!id) return NextResponse.json({ ok: false, error: 'customer_id required' }, { status: 400 });

    const db = createAdminClient();
    const { data: prof } = await db
      .from('profiles').select('business_id, email').eq('id', id).maybeSingle();
    if (!prof) return NextResponse.json({ ok: false, error: 'customer not found' }, { status: 404 });

    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
    const businessName = str(body.business_name);
    const fullName = str(body.full_name);
    const email = str(body.email);
    const phone = str(body.phone);
    const address = str(body.address);
    const county = str(body.county);

    // Profile fields (empty string clears the optional ones).
    const profilePatch: Record<string, unknown> = {};
    if (businessName !== undefined) profilePatch.business_name = businessName || null;
    if (fullName !== undefined) profilePatch.full_name = fullName || null;
    if (phone !== undefined) profilePatch.phone = phone || null;
    if (address !== undefined) profilePatch.address = address || null;
    if (county !== undefined) profilePatch.county = county || null;
    if (email !== undefined && email && email !== prof.email) profilePatch.email = email;
    if (Object.keys(profilePatch).length > 0) {
      const { error } = await db.from('profiles').update(profilePatch).eq('id', id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // Linked business — keep its name/phone/address in step with the edit.
    if (prof.business_id) {
      const bizPatch: Record<string, unknown> = {};
      // Lock the name so the QuickBooks customer sync stops reverting an
      // admin-chosen business name (e.g. "PartsCo") back to the QB name.
      if (businessName) { bizPatch.name = businessName; bizPatch.name_locked = true; } // never blank a business name
      if (phone !== undefined) bizPatch.phone = phone || null;
      if (address !== undefined) bizPatch.address = address || null;
      if (Object.keys(bizPatch).length > 0) {
        await db.from('businesses').update(bizPatch).eq('id', prof.business_id);
      }
    }

    // Keep the login email in sync (best-effort — imported customers have no
    // auth user, so this just no-ops for them).
    let emailNote: string | null = null;
    if (email && email !== prof.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      const { error } = await db.auth.admin.updateUserById(id, { email, email_confirm: true });
      if (error) emailNote = 'Profile updated, but their login email could not be changed: ' + error.message;
    }

    return NextResponse.json({ ok: true, email_note: emailNote });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'server error' }, { status: 500 });
  }
}
