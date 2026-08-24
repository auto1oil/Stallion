'use client';

// Missing Receipts — the same card_charges data as the Card Charges tab and the
// driver banner, but rolled up BY EMPLOYEE: who owes receipts and for what.
// Reads receipt_status='missing' only, so the moment a charge is matched to a
// OneGloveBox receipt or a driver submits a photo/explanation (status leaves
// 'missing'), it drops off here automatically. Send a reminder per employee.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type Charge = {
  id: string;
  merchant: string | null;
  amount: number | null;
  charge_date: string | null;
  card_last4: string | null;
  driver_id: string | null;
};
type Person = { id: string; full_name: string | null; email: string };

const money = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function MissingReceiptsPage() {
  const supabase = createClient();
  const [charges, setCharges] = useState<Charge[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [expand, setExpand] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [c, p] = await Promise.all([
      supabase.from('card_charges')
        .select('id, merchant, amount, charge_date, card_last4, driver_id')
        .eq('receipt_status', 'missing')
        .order('charge_date', { ascending: false }),
      supabase.from('profiles').select('id, full_name, email').neq('role', 'customer'),
    ]);
    if (c.error) setErr(c.error.message);
    setCharges((c.data as Charge[]) || []);
    setPeople((p.data as Person[]) || []);
    setLoading(false);
  }, [supabase]);
  useEffect(() => { void load(); }, [load]);

  const nameOf = useCallback((id: string | null) => {
    if (!id) return 'Unassigned';
    const p = people.find((x) => x.id === id);
    return p ? (p.full_name || p.email) : 'Unknown';
  }, [people]);

  // Group by driver (unassigned last), each with count + total.
  const groups = useMemo(() => {
    const m = new Map<string, Charge[]>();
    for (const c of charges) {
      const k = c.driver_id || '__unassigned__';
      (m.get(k) || m.set(k, []).get(k)!).push(c);
    }
    return Array.from(m.entries())
      .map(([key, list]) => ({
        key,
        driverId: key === '__unassigned__' ? null : key,
        name: key === '__unassigned__' ? 'Unassigned' : nameOf(key),
        list,
        total: list.reduce((s, c) => s + (c.amount || 0), 0),
      }))
      .sort((a, b) => {
        if (a.driverId === null) return 1;   // unassigned last
        if (b.driverId === null) return -1;
        return b.list.length - a.list.length; // most owed first
      });
  }, [charges, nameOf]);

  const grandTotal = charges.reduce((s, c) => s + (c.amount || 0), 0);

  async function remind(driverId: string, count: number) {
    setBusy(driverId); setErr(null); setMsg(null);
    const { error } = await supabase.rpc('notify_recipients', {
      recipient_ids: [driverId],
      p_kind: 'card_receipt',
      p_title: 'Upload your receipts',
      p_body: `You have ${count} card charge${count === 1 ? '' : 's'} missing a receipt. Please upload ${count === 1 ? 'it' : 'them'} to OneGloveBox.`,
      p_link: '/driver',
    });
    setBusy(null);
    if (error) { setErr(error.message); return; }
    setMsg(`Reminder sent to ${nameOf(driverId)}.`);
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Missing receipts</h1>
      <p className="text-sm text-gray-500 mb-4">
        Every card charge still without a receipt, grouped by employee. When a receipt is uploaded to
        OneGloveBox or the driver submits a photo, the charge drops off here automatically.
      </p>

      <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3 flex items-baseline justify-between">
        <span className="text-sm text-gray-500">Total outstanding</span>
        <span className="text-2xl font-semibold">
          {money(grandTotal)}
          <span className="text-sm font-normal text-gray-400 ml-2">
            {charges.length} charge{charges.length === 1 ? '' : 's'}
          </span>
        </span>
      </div>

      {msg && <div className="mb-3 rounded-md bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">{msg}</div>}
      {err && <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-10">🎉 No missing receipts — everyone&apos;s caught up.</p>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => {
            const open = expand === g.key;
            return (
              <div key={g.key} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <button onClick={() => setExpand(open ? null : g.key)} className="min-w-0 text-left flex-1">
                    <div className="font-medium flex items-center gap-2">
                      <span className={g.driverId ? '' : 'text-amber-700'}>{g.name}</span>
                      <span className="text-xs font-semibold inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 bg-red-500 text-white rounded-full">{g.list.length}</span>
                    </div>
                    <div className="text-xs text-gray-500">{money(g.total)} · tap to {open ? 'hide' : 'view'}</div>
                  </button>
                  {g.driverId && (
                    <button onClick={() => remind(g.driverId!, g.list.length)} disabled={busy === g.driverId}
                      className="shrink-0 text-xs px-2.5 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 whitespace-nowrap font-medium">
                      {busy === g.driverId ? 'Sending…' : '🔔 Remind'}
                    </button>
                  )}
                </div>
                {open && (
                  <div className="border-t border-gray-100 divide-y divide-gray-50">
                    {g.list.map((c) => (
                      <div key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <div className="truncate">{c.merchant || '(no merchant)'}</div>
                          <div className="text-xs text-gray-500">
                            {c.charge_date || 'no date'}{c.card_last4 ? ` · ••${c.card_last4}` : ''}
                          </div>
                        </div>
                        <span className="font-medium shrink-0 tabular-nums">{money(c.amount)}</span>
                      </div>
                    ))}
                    {g.driverId === null && (
                      <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50">
                        Assign these to a driver on the <a href="/admin/card-charges" className="underline">Card Charges</a> tab so they land in someone&apos;s queue.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
