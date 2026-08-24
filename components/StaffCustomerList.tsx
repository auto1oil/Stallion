'use client';

// Customer list for salesmen + drivers. Mirrors the admin Customers screen
// (missing documents, order cadence + next-order countdown, inactive shading).
// Data comes from /api/staff/customers (assembled server-side). Sales reps +
// admins see each account's balance owed; drivers only see it on inactive
// accounts that still owe. Reps can upload a missing document if they can get
// it. Inactive (9-months-no-order) businesses render grayscale so staff can try
// to win them back; only admins can reactivate.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';

type MissingDoc = { type: 'profile_sheet' | 'tax_exempt' | 'fein'; label: string };
type Invoice = { number: string | null; date: string | null; path: string };
type StaffCustomer = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  assigned_sales_rep_id: string | null;
  inactive: boolean;
  balance: number | null; // reps/admins: real balance per account; drivers: only inactive-owed
  owner_profile_id: string | null;
  missing_docs: MissingDoc[];
  order_days: string[]; // YYYY-MM-DD, newest first, within 12 months
  invoices: Invoice[];
};

// avg gap + days until the next expected order, from the order-day history.
function cadence(days: string[]): { avgDays: number; countdownDays: number } | null {
  if (days.length < 2) return null;
  const newest = new Date(days[0] + 'T00:00:00').getTime();
  const oldest = new Date(days[days.length - 1] + 'T00:00:00').getTime();
  const avgMs = (newest - oldest) / (days.length - 1);
  return {
    avgDays: Math.max(1, Math.round(avgMs / 86_400_000)),
    countdownDays: Math.round((newest + avgMs - Date.now()) / 86_400_000),
  };
}
function cadenceClass(countdownDays: number): string {
  if (countdownDays < 0) return 'bg-red-50 text-red-700 border-red-200';
  if (countdownDays <= 2) return 'bg-amber-50 text-amber-800 border-amber-200';
  return 'bg-green-50 text-green-700 border-green-200';
}

// orderPath: when set, the customer name links to the place-
// order screen pre-selected for that customer, so reps can open a customer and
// put an order in. Omitted (driver side) leaves the name as plain text.
export default function StaffCustomerList({ meId, canToggleMine, orderPath }: { meId: string; canToggleMine: boolean; orderPath?: string }) {
  // Where clicking this customer's name goes: the order screen, pre-selecting
  // the business's owner profile when we have one, else seeding the search.
  function orderHref(c: StaffCustomer): string | null {
    if (!orderPath) return null;
    return c.owner_profile_id
      ? `${orderPath}?customer=${encodeURIComponent(c.owner_profile_id)}`
      : `${orderPath}?q=${encodeURIComponent(c.name)}`;
  }
  const [customers, setCustomers] = useState<StaffCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [mineOnly, setMineOnly] = useState(canToggleMine);
  const [uploading, setUploading] = useState<string | null>(null); // `${bizId}:${docType}`
  const [openInvoices, setOpenInvoices] = useState<Set<string>>(new Set());
  const fileInputs = useRef<Map<string, HTMLInputElement>>(new Map());

  // Open an invoice PDF (signed URL — salesmen can read the invoices bucket).
  async function viewInvoice(path: string) {
    const supabase = createClient();
    const { data, error } = await supabase.storage.from('invoices').createSignedUrl(path, 120);
    if (error || !data) { setErr(error?.message || 'Could not open invoice'); return; }
    window.open(data.signedUrl, '_blank');
  }

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch('/api/staff/customers');
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Could not load customers'); return; }
      setCustomers(json.customers as StaffCustomer[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load customers');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function upload(bizId: string, docType: string, file: File) {
    setUploading(`${bizId}:${docType}`); setErr(null);
    try {
      const fd = new FormData();
      fd.append('business_id', bizId);
      fd.append('doc_type', docType);
      fd.append('file', file);
      const res = await fetch('/api/rep/upload-customer-doc', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Upload failed'); return; }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  }

  const needle = q.trim().toLowerCase();
  const visible = customers.filter((c) => {
    if (mineOnly && c.assigned_sales_rep_id !== meId) return false;
    if (!needle) return true;
    return `${c.name} ${c.address || ''} ${c.phone || ''}`.toLowerCase().includes(needle);
  });

  return (
    <div>
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search business, city, phone…"
          className="flex-1 min-w-[180px] px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
        {canToggleMine && (
          <div className="flex rounded-md border border-gray-300 overflow-hidden text-sm">
            <button onClick={() => setMineOnly(true)}
              className={`px-3 py-2 ${mineOnly ? 'bg-brand-50 text-brand-700 font-medium' : 'bg-white text-gray-600'}`}>
              My customers
            </button>
            <button onClick={() => setMineOnly(false)}
              className={`px-3 py-2 border-l border-gray-300 ${!mineOnly ? 'bg-brand-50 text-brand-700 font-medium' : 'bg-white text-gray-600'}`}>
              All customers
            </button>
          </div>
        )}
      </div>

      {err && <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No customers here.</p>
      ) : (
        <div className="space-y-2">
          {visible.map((c) => {
            const cad = cadence(c.order_days);
            const inactive = c.inactive;
            return (
              <div key={c.id} className={`rounded-lg border p-3 ${inactive ? 'bg-gray-200 border-gray-300' : 'bg-white border-gray-200'}`}>
                {/* Balance owed — kept out of the grayscale so it stands out.
                    Red when they owe, gray at $0. For drivers this only appears
                    on inactive accounts (a "don't reactivate, still owes"
                    warning); for reps/admins it shows on every account. */}
                {c.balance != null && (
                  <div className={`mb-2 inline-block rounded-md text-xs font-semibold px-2 py-1 ${c.balance > 0 ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}`}>
                    {c.balance > 0
                      ? `Balance owed: ${c.balance.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`
                      : 'Balance: $0.00'}
                  </div>
                )}
                <div className={inactive ? 'grayscale opacity-80' : ''}>
                  <div className="flex justify-between items-start gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {inactive && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-gray-200 text-gray-600 border-gray-300">
                            Inactive
                          </span>
                        )}
                        {orderHref(c) ? (
                          <Link href={orderHref(c)!} title={`Open ${c.name} — place an order`}
                            className="font-medium text-sm text-brand-700 hover:underline">
                            {c.name}
                          </Link>
                        ) : (
                          <span className="font-medium text-sm">{c.name}</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {[c.address, c.phone].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                    {cad && (
                      <div className="flex gap-1.5 shrink-0">
                        <div title={`Orders about every ${cad.avgDays} days`}
                          className="px-2 py-1 rounded-md border bg-gray-50 border-gray-200 text-center min-w-[44px]">
                          <div className="text-sm font-bold text-gray-700 leading-none">{cad.avgDays}d</div>
                          <div className="text-[8px] uppercase tracking-wide text-gray-400 mt-0.5 leading-none">every</div>
                        </div>
                        <div title="Next order expected"
                          className={`px-2 py-1 rounded-md border text-center min-w-[44px] ${cadenceClass(cad.countdownDays)}`}>
                          <div className="text-sm font-bold leading-none">
                            {cad.countdownDays < 0 ? `${-cad.countdownDays}d` : `${cad.countdownDays}d`}
                          </div>
                          <div className="text-[8px] uppercase tracking-wide mt-0.5 leading-none opacity-70">
                            {cad.countdownDays < 0 ? 'overdue' : 'next'}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Missing documents — each can be uploaded if the rep has it. */}
                  {c.missing_docs.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {c.missing_docs.map((d) => {
                        const key = `${c.id}:${d.type}`;
                        return (
                          <span key={d.type}
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-200">
                            Missing: {d.label}
                            <button
                              onClick={() => fileInputs.current.get(key)?.click()}
                              disabled={uploading === key}
                              className="underline font-medium disabled:opacity-50">
                              {uploading === key ? 'Uploading…' : 'Upload'}
                            </button>
                            <input
                              ref={(el) => { if (el) fileInputs.current.set(key, el); }}
                              type="file"
                              accept="application/pdf,image/*,.doc,.docx,.heic"
                              className="hidden"
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(c.id, d.type, f); e.target.value = ''; }}
                            />
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Invoices — outside the grayscale so links stay usable. */}
                {c.invoices.length > 0 && (
                  <div className="mt-2 border-t border-gray-100 pt-2">
                    <button onClick={() => setOpenInvoices((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
                      className="text-xs font-medium text-brand-700 hover:underline">
                      {openInvoices.has(c.id) ? '▾' : '▸'} Invoices ({c.invoices.length})
                    </button>
                    {openInvoices.has(c.id) && (
                      <div className="mt-1 divide-y divide-gray-100">
                        {c.invoices.map((inv, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                            <span className="min-w-0">
                              <span className="font-medium">{inv.number ? `#${inv.number}` : 'Invoice'}</span>
                              {inv.date && <span className="text-xs text-gray-500 ml-2">{new Date(inv.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                            </span>
                            <button onClick={() => viewInvoice(inv.path)} className="text-brand-600 underline text-xs whitespace-nowrap shrink-0">
                              View
                            </button>
                          </div>
                        ))}
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
