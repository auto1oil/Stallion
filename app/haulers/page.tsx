'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import type { Hauler } from '@/lib/haulers';
import { docWarning, type HaulerDocument } from '@/lib/hauler-docs';

// The hauler directory: every company set up to haul for Stallion, with the
// count of trucks on file and whatever is still waiting on each of them.

type Row = Hauler & { units: number; open: number; docWarning: string | null };

export default function HaulersPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', contact_name: '', phone: '', email: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function load() {
    setLoading(true);
    const [{ data: haulers }, { data: equip }, { data: loads }, { data: papers }] = await Promise.all([
      supabase.from('haulers').select('*').order('name'),
      supabase.from('hauler_equipment').select('hauler_id').eq('active', true),
      supabase.from('hauler_loads').select('hauler_id, status').in('status', ['offered', 'accepted', 'assigned']),
      supabase.from('hauler_documents').select('*'),
    ]);

    const units = new Map<string, number>();
    for (const e of ((equip as { hauler_id: string }[]) || [])) {
      units.set(e.hauler_id, (units.get(e.hauler_id) || 0) + 1);
    }
    const open = new Map<string, number>();
    for (const l of ((loads as { hauler_id: string }[]) || [])) {
      open.set(l.hauler_id, (open.get(l.hauler_id) || 0) + 1);
    }

    // Paperwork is grouped per company so a lapse shows on the row, before
    // anyone picks that company to send a load to.
    const byHauler = new Map<string, HaulerDocument[]>();
    for (const d of ((papers as HaulerDocument[]) || [])) {
      byHauler.set(d.hauler_id, [...(byHauler.get(d.hauler_id) || []), d]);
    }

    setRows(((haulers as Hauler[]) || []).map((h) => ({
      ...h,
      units: units.get(h.id) || 0,
      open: open.get(h.id) || 0,
      docWarning: docWarning(byHauler.get(h.id) || []),
    })));
    setLoading(false);
  }

  async function addHauler() {
    const name = draft.name.trim();
    if (!name) { setError('Give the company a name.'); return; }
    setBusy(true); setError('');
    const { error: err } = await supabase.from('haulers').insert({
      name,
      contact_name: draft.contact_name.trim() || null,
      phone: draft.phone.trim() || null,
      email: draft.email.trim() || null,
    });
    setBusy(false);
    if (err) {
      // The unique index is on lower(name), so a near-duplicate is caught too.
      setError(err.code === '23505' ? 'A hauler with that name already exists.' : err.message);
      return;
    }
    setDraft({ name: '', contact_name: '', phone: '', email: '' });
    setAdding(false);
    load();
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const label = 'block text-xs font-medium text-gray-600 mb-1';
  const visible = rows.filter((r) => showInactive || r.active);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-4">
        <h1 className="text-2xl font-semibold">Haulers</h1>
        <button
          onClick={() => setAdding((v) => !v)}
          className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900"
        >
          {adding ? 'Cancel' : 'Add hauler'}
        </button>
      </div>

      {adding && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="sm:col-span-2"><span className={label}>Company name</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Contact</span>
              <input value={draft.contact_name} onChange={(e) => setDraft({ ...draft, contact_name: e.target.value })} className={input} />
            </label>
            <label><span className={label}>Phone</span>
              <input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} className={input} />
            </label>
            <label className="sm:col-span-2"><span className={label}>Email</span>
              <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} className={input} />
            </label>
          </div>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          <button
            onClick={addHauler}
            disabled={busy}
            className="mt-3 px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save hauler'}
          </button>
          <p className="text-xs text-gray-500 mt-2">
            Adding the company here is step one. To give them a login, add the
            person under <Link href="/admin/users" className="text-brand-700 hover:underline">Users</Link> with
            the role <strong>Hauler</strong> and point them at this company.
          </p>
        </div>
      )}

      {rows.some((r) => !r.active) && (
        <label className="flex items-center gap-2 text-sm text-gray-600 mb-3">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500">No haulers yet. Add the first one above.</p>
      ) : (
        <div className="space-y-2">
          {visible.map((h) => (
            <Link
              key={h.id}
              href={`/haulers/${h.id}`}
              className="block bg-white border border-gray-200 rounded-lg px-4 py-3 hover:border-brand-300"
            >
              <div className="flex justify-between items-start gap-3 flex-wrap">
                <div className="min-w-0">
                  <span className="font-medium text-sm">{h.name}</span>
                  {!h.active && <span className="ml-2 text-[11px] text-gray-500">(inactive)</span>}
                  <div className="text-xs text-gray-500 mt-0.5">
                    {[h.contact_name, h.phone, h.email].filter(Boolean).join(' · ') || 'No contact on file'}
                  </div>
                  {h.docWarning && (
                    <div className="text-xs text-red-600 font-medium mt-0.5">
                      Paperwork: {h.docWarning}
                    </div>
                  )}
                </div>
                <div className="text-xs text-gray-600 text-right shrink-0">
                  <div>{h.units} {h.units === 1 ? 'unit' : 'units'}</div>
                  {h.open > 0 && (
                    <div className="text-accent-400 font-semibold">{h.open} open {h.open === 1 ? 'load' : 'loads'}</div>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
