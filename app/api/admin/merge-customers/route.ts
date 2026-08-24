// POST /api/admin/merge-customers — combine two duplicate customer records.
//
// Body: { keep_id, remove_id }
// Merges remove_id INTO keep_id, but ALWAYS keeps the side that has a real
// login (so a QuickBooks placeholder never wins over a signup). The survivor
// inherits the QuickBooks link + QB-linked business from the other side, all of
// the other's orders/documents are repointed onto the survivor, and the
// duplicate profile (+ its login, + its now-orphaned business) is removed.
// Runs with the service-role client — no SQL/DB function needed.

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
    let keepId = body.keep_id as string | undefined;
    let removeId = body.remove_id as string | undefined;
    if (!keepId || !removeId || keepId === removeId) {
      return NextResponse.json({ ok: false, error: 'two different customers required' }, { status: 400 });
    }

    const db = createAdminClient();
    const hasLogin = async (id: string) => {
      try { const { data } = await db.auth.admin.getUserById(id); return !!data?.user; } catch { return false; }
    };
    // Never delete the side that can actually sign in — swap if needed.
    if (await hasLogin(removeId) && !(await hasLogin(keepId))) {
      [keepId, removeId] = [removeId, keepId];
    }

    type P = { id: string; business_id: string | null; imported_from_qb_customer_id: string | null; business_name: string | null; full_name: string | null; phone: string | null; address: string | null };
    const { data: profs } = await db
      .from('profiles')
      .select('id, business_id, imported_from_qb_customer_id, business_name, full_name, phone, address')
      .in('id', [keepId, removeId]);
    const keep = (profs as P[] | null)?.find((p) => p.id === keepId);
    const remove = (profs as P[] | null)?.find((p) => p.id === removeId);
    if (!keep || !remove) return NextResponse.json({ ok: false, error: 'customer not found' }, { status: 404 });

    // Which business carries the QuickBooks link? Keep that one on the survivor.
    const bizIds = [keep.business_id, remove.business_id].filter(Boolean) as string[];
    const { data: bizRows } = bizIds.length
      ? await db.from('businesses').select('id, qb_customer_id, name').in('id', bizIds)
      : { data: [] as { id: string; qb_customer_id: string | null; name: string }[] };
    const bizById = new Map((bizRows || []).map((b) => [b.id, b]));
    const qbBiz = (bizRows || []).find((b) => b.qb_customer_id);
    const survivingBizId = qbBiz?.id || keep.business_id || remove.business_id || null;

    // Patch the survivor: adopt the QB-linked business + import id, fill blanks.
    const patch: Record<string, unknown> = {};
    if (survivingBizId && survivingBizId !== keep.business_id) patch.business_id = survivingBizId;
    if (!keep.imported_from_qb_customer_id && remove.imported_from_qb_customer_id) patch.imported_from_qb_customer_id = remove.imported_from_qb_customer_id;

    // The survivor keeps ONE QuickBooks customer id. If the removed side carried
    // a DIFFERENT one, this pair is the same company entered twice in
    // QuickBooks — record the loser's id on the surviving business so the
    // customer sync permanently skips it and never re-creates this duplicate.
    // (When both sides share the id — or the removed side had none — there's
    // nothing to suppress.)
    const survivorQbId = keep.imported_from_qb_customer_id || remove.imported_from_qb_customer_id || null;
    const loserQbId =
      remove.imported_from_qb_customer_id && remove.imported_from_qb_customer_id !== survivorQbId
        ? remove.imported_from_qb_customer_id
        : null;
    if (!keep.business_name && remove.business_name) patch.business_name = remove.business_name;
    if (!keep.full_name && remove.full_name) patch.full_name = remove.full_name;
    if (!keep.phone && remove.phone) patch.phone = remove.phone;
    if (!keep.address && remove.address) patch.address = remove.address;
    if (Object.keys(patch).length) await db.from('profiles').update(patch).eq('id', keepId);

    // Repoint the duplicate's orders + documents onto the survivor.
    await db.from('customer_orders').update({ customer_id: keepId }).eq('customer_id', removeId);
    await db.from('customer_documents').update({ customer_id: keepId }).eq('customer_id', removeId);

    // Remove the duplicate profile (cascades its link requests) + its login.
    const { error: delErr } = await db.from('profiles').delete().eq('id', removeId);
    if (delErr) return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });
    try { await db.auth.admin.deleteUser(removeId); } catch { /* no login — fine */ }

    // Permanently suppress the loser's QB customer id so the nightly / manual
    // customer sync never re-imports this duplicate. Stored as a JSON array in
    // app_settings (key 'qb_suppressed_customers') — a table that already
    // exists, so NO migration/SQL is needed for this to work.
    if (loserQbId) {
      const { data: row } = await db.from('app_settings').select('value').eq('key', 'qb_suppressed_customers').maybeSingle();
      let arr: string[] = [];
      try { arr = row?.value ? JSON.parse(row.value) : []; } catch { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      if (!arr.includes(loserQbId)) arr.push(loserQbId);
      await db.from('app_settings').upsert({ key: 'qb_suppressed_customers', value: JSON.stringify(arr) }, { onConflict: 'key' });
    }

    // Drop the duplicate's leftover business if it's not the surviving one and
    // no longer has any customers (never delete a QuickBooks-linked business).
    const orphanBizId = remove.business_id;
    if (orphanBizId && orphanBizId !== survivingBizId && !bizById.get(orphanBizId)?.qb_customer_id) {
      const { count } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('business_id', orphanBizId);
      if ((count || 0) === 0) await db.from('businesses').delete().eq('id', orphanBizId);
    }

    return NextResponse.json({ ok: true, kept: keepId });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'server error' }, { status: 500 });
  }
}
