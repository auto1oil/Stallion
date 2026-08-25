'use client';
import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';

// The customer dropdown, with an inline "add one" so a new customer never
// means leaving the form you're in the middle of.
//
// The directory used to be filled only by syncing from QuickBooks, which meant
// nothing could be written until QuickBooks was connected. A customer added
// here is a plain row; connecting QuickBooks later links it up by name rather
// than duplicating it.

type Customer = { id: string; name: string; qb_customer_id: string | null };

export default function CustomerPicker({
  value,
  onChange,
  disabled = false,
  label = 'Customer',
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const supabase = createClient();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', phone: '', address: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('businesses').select('id, name, qb_customer_id').order('name');
    setCustomers((data as Customer[]) || []);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    const name = draft.name.trim();
    if (!name) { setError('Give the customer a name.'); return; }
    setBusy(true); setError('');

    // Adding a name that's already on file would quietly create a second
    // customer that invoices separately, so match first and just select it.
    const existing = customers.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      setBusy(false); setAdding(false);
      setDraft({ name: '', phone: '', address: '' });
      onChange(existing.id);
      return;
    }

    const { data, error: err } = await supabase
      .from('businesses')
      .insert({
        name,
        phone: draft.phone.trim() || null,
        address: draft.address.trim() || null,
      })
      .select('id, name, qb_customer_id')
      .single();
    setBusy(false);
    if (err) { setError(err.message); return; }

    setCustomers((cs) => [...cs, data as Customer].sort((a, b) => a.name.localeCompare(b.name)));
    onChange((data as Customer).id);
    setDraft({ name: '', phone: '', address: '' });
    setAdding(false);
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const lbl = 'block text-xs font-medium text-gray-600 mb-1';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={lbl}>{label}</span>
        {!disabled && (
          <button
            type="button"
            onClick={() => { setAdding((v) => !v); setError(''); }}
            className="text-[11px] text-brand-700 hover:underline mb-1"
          >
            {adding ? 'Cancel' : '+ New customer'}
          </button>
        )}
      </div>

      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={input}>
        <option value="">— Pick a customer —</option>
        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      {customers.length === 0 && !adding && !disabled && (
        <p className="mt-1 text-[11px] text-gray-500">
          Nobody on file yet — add one with <strong>+ New customer</strong>, or sync
          them in from QuickBooks under Customers.
        </p>
      )}

      {adding && (
        <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="sm:col-span-3">
              <span className={lbl}>Name</span>
              <input
                autoFocus
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                className={input}
              />
            </label>
            <label className="sm:col-span-1">
              <span className={lbl}>Phone</span>
              <input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} className={input} />
            </label>
            <label className="sm:col-span-2">
              <span className={lbl}>Address</span>
              <input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} className={input} />
            </label>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <button
            type="button"
            onClick={add}
            disabled={busy}
            className="mt-2 px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add customer'}
          </button>
        </div>
      )}
    </div>
  );
}
