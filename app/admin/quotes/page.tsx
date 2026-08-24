'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import AdminSubNav from '@/components/AdminSubNav';
import QuoteBuilder, { type EditQuote } from '@/components/QuoteBuilder';
import { fillQuotePdf, shareOrDownloadPdf, repLine } from '@/lib/quote-pdf';

type QuoteLine = { desc?: string; cat?: string; pack?: string; unit?: string; price?: string; requested_price?: string | null; special?: boolean; inventory_item_id?: string; gallons?: number | null; fuel_product?: string | null };
type Quote = {
  id: string; quote_number: string; business_id: string | null;
  customer_company: string | null; customer_contact: string | null;
  customer_address: string | null; customer_phone_email: string | null;
  sales_rep_name: string | null; sales_rep_phone: string | null; sales_rep_email: string | null;
  quote_date: string; valid_thru: string | null;
  status: string; has_special_pricing: boolean;
  line_items: QuoteLine[]; created_at: string;
};

const fmtDate = (d: string | null) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : '');

const effPrice = (status: string, l: QuoteLine) =>
  status === 'approved' && l.special && l.requested_price ? l.requested_price : l.price;

const STATUS: Record<string, { label: string; cls: string }> = {
  sent: { label: 'Sent', cls: 'text-gray-400' },
  pending_approval: { label: 'Awaiting approval', cls: 'text-amber-700' },
  approved: { label: 'Special pricing approved', cls: 'text-emerald-700' },
  denied: { label: 'Special denied — standard price', cls: 'text-red-600' },
};

export default function AdminQuotesPage() {
  const supabase = createClient();
  const [me, setMe] = useState<{ id: string; name: string; phone?: string | null; email?: string | null } | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [building, setBuilding] = useState(false);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: p } = await supabase.from('profiles').select('full_name, email, phone, contact_email').eq('id', user.id).single();
      setMe({ id: user.id, name: (p?.full_name || p?.email || 'Sales rep') as string, phone: p?.phone ?? null, email: (p?.contact_email || p?.email) ?? null });
    }
    const { data } = await supabase.from('quotes').select('*').order('created_at', { ascending: false });
    setQuotes((data as Quote[]) || []);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function openPdf(q: Quote) {
    const bytes = await fillQuotePdf({
      quote_number: q.quote_number,
      quote_date: fmtDate(q.quote_date),
      valid_thru: fmtDate(q.valid_thru),
      customer_company: q.customer_company || '',
      customer_contact: q.customer_contact || '',
      customer_address: q.customer_address || '',
      customer_phone_email: q.customer_phone_email || '',
      sales_rep: repLine(q.sales_rep_name, q.sales_rep_phone, q.sales_rep_email),
      lines: (q.line_items || []).map((l) => ({ desc: l.desc, cat: l.cat, pack: l.pack, unit: l.unit, price: effPrice(q.status, l) })),
    });
    await shareOrDownloadPdf(bytes, `Quote ${q.quote_number} - ${q.customer_company || ''}.pdf`);
  }

  async function decide(q: Quote, status: 'approved' | 'denied') {
    if (!me) return;
    setActing(q.id);
    const { error } = await supabase.from('quotes').update({
      status,
      approved_by: me.id,
      approved_at: new Date().toISOString(),
      decision_note: notes[q.id]?.trim() || null,
    }).eq('id', q.id);
    setActing(null);
    if (!error) { setNotes((n) => { const c = { ...n }; delete c[q.id]; return c; }); load(); }
  }

  const pending = quotes.filter((q) => q.status === 'pending_approval');

  return (
    <div>
      <AdminSubNav
        tabs={[
          { href: '/admin/customers', label: 'Existing customers' },
          { href: '/salesman/businesses', label: 'Customers visited' },
          { href: '/admin/forms', label: 'Forms' },
          { href: '/admin/quotes', label: 'Quotes' },
        ]}
      />
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <h1 className="text-2xl font-semibold">Quotes</h1>
        <button onClick={() => setBuilding(true)} className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700">
          + New quote
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">All reps&apos; quotes, built from inventory (prices match QuickBooks). Tap a quote to re-open and share the PDF.</p>

      {/* Special-pricing requests awaiting a decision */}
      {pending.length > 0 && (
        <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50/60 p-3">
          <h2 className="text-sm font-semibold text-amber-900 mb-2">Special pricing requests ({pending.length})</h2>
          <div className="space-y-3">
            {pending.map((q) => (
              <div key={q.id} className="bg-white border border-amber-200 rounded-md p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="font-medium text-sm">{q.customer_company || 'Customer'} <span className="text-gray-400">· {q.quote_number}</span></div>
                  <div className="text-xs text-gray-500">{q.sales_rep_name || '—'} · {fmtDate(q.quote_date)}</div>
                </div>
                <div className="mt-2 space-y-1">
                  {(q.line_items || []).map((l, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-gray-700">{l.desc}{l.pack ? <span className="text-gray-400"> · {l.pack}</span> : null}</span>
                      {l.special && l.requested_price ? (
                        <span className="whitespace-nowrap tabular-nums">
                          <span className="line-through text-gray-400">{l.price}</span>{' '}
                          <span className="font-semibold text-amber-800">{l.requested_price}</span>
                        </span>
                      ) : (
                        <span className="whitespace-nowrap tabular-nums text-gray-600">{l.price}</span>
                      )}
                    </div>
                  ))}
                </div>
                <input
                  value={notes[q.id] || ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [q.id]: e.target.value }))}
                  placeholder="Note (optional, shown to the rep)"
                  className="mt-2 w-full px-2 py-1 border border-gray-300 rounded text-xs"
                />
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button onClick={() => decide(q, 'denied')} disabled={acting === q.id}
                    className="px-3 py-1 text-xs rounded-md border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 font-medium">Deny</button>
                  <button onClick={() => decide(q, 'approved')} disabled={acting === q.id}
                    className="px-3 py-1 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 font-medium">{acting === q.id ? '…' : 'Approve'}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : quotes.length === 0 ? (
        <p className="text-sm text-gray-400">No quotes yet. Tap “New quote” to build one.</p>
      ) : (
        <div className="space-y-2">
          {quotes.map((q) => (
            <div key={q.id} className="bg-white border border-gray-200 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="font-medium text-sm">
                  {q.customer_company || 'Customer'} <span className="text-gray-400">· {q.quote_number}</span>
                </div>
                <div className="text-xs text-gray-500">
                  {fmtDate(q.quote_date)} · {q.sales_rep_name || '—'} · {(q.line_items || []).length} item{(q.line_items || []).length === 1 ? '' : 's'}
                  {(STATUS[q.status] && q.status !== 'sent') && <span className={`ml-2 font-medium ${STATUS[q.status].cls}`}>· {STATUS[q.status].label}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setEditing(q)} className="px-3 py-1.5 text-xs rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium whitespace-nowrap">
                  Edit
                </button>
                {q.status === 'pending_approval' ? (
                  <span className="px-3 py-1.5 text-xs rounded-md bg-amber-50 text-amber-700 border border-amber-200 font-medium whitespace-nowrap">Awaiting decision</span>
                ) : (
                  <button onClick={() => openPdf(q)} className="px-3 py-1.5 text-xs rounded-md border border-brand-700 text-brand-700 hover:bg-gray-50 font-medium whitespace-nowrap">
                    Open / Share
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {building && me && <QuoteBuilder me={me} onClose={() => setBuilding(false)} onSaved={() => { setBuilding(false); load(); }} />}
      {editing && me && (
        <QuoteBuilder
          me={me}
          editQuote={{
            id: editing.id,
            business_id: editing.business_id,
            customer_company: editing.customer_company,
            customer_contact: editing.customer_contact,
            customer_address: editing.customer_address,
            customer_phone_email: editing.customer_phone_email,
            sales_rep_name: editing.sales_rep_name,
            sales_rep_phone: editing.sales_rep_phone,
            sales_rep_email: editing.sales_rep_email,
            valid_thru: editing.valid_thru,
            line_items: editing.line_items as EditQuote['line_items'],
          }}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
