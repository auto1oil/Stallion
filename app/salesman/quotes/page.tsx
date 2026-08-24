'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import QuoteBuilder from '@/components/QuoteBuilder';
import { fillQuotePdf, shareOrDownloadPdf, repLine } from '@/lib/quote-pdf';

type QuoteLine = { desc?: string; cat?: string; pack?: string; unit?: string; price?: string; requested_price?: string | null; special?: boolean };

// Price to print: approved special lines use the requested price; otherwise standard.
const effPrice = (status: string, l: QuoteLine) =>
  status === 'approved' && l.special && l.requested_price ? l.requested_price : l.price;

const STATUS: Record<string, { label: string; cls: string }> = {
  sent: { label: 'Sent', cls: 'text-gray-400' },
  pending_approval: { label: 'Awaiting approval', cls: 'text-amber-700' },
  approved: { label: 'Special pricing approved', cls: 'text-emerald-700' },
  denied: { label: 'Special denied — standard price', cls: 'text-red-600' },
};
type Quote = {
  id: string; quote_number: string;
  customer_company: string | null; customer_contact: string | null;
  customer_address: string | null; customer_phone_email: string | null;
  sales_rep_name: string | null; sales_rep_phone: string | null; sales_rep_email: string | null;
  quote_date: string; valid_thru: string | null;
  status: string; has_special_pricing: boolean;
  line_items: QuoteLine[]; created_at: string;
};

const fmtDate = (d: string | null) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : '');

export default function SalesmanQuotesPage() {
  const supabase = createClient();
  const [me, setMe] = useState<{ id: string; name: string; phone?: string | null; email?: string | null } | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [building, setBuilding] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: p } = await supabase.from('profiles').select('full_name, email, phone, contact_email').eq('id', user.id).single();
      setMe({ id: user.id, name: (p?.full_name || p?.email || 'Sales rep') as string, phone: p?.phone ?? null, email: (p?.contact_email || p?.email) ?? null });
    }
    // RLS limits this to the rep's own quotes.
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

  return (
    <div>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <h1 className="text-2xl font-semibold">Quotes</h1>
        <button onClick={() => setBuilding(true)} className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700">
          + New quote
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">Build a quote from inventory (prices match QuickBooks), then text or email it. Your sent quotes are saved here.</p>

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
                  {fmtDate(q.quote_date)} · {(q.line_items || []).length} item{(q.line_items || []).length === 1 ? '' : 's'}
                  {(STATUS[q.status] && q.status !== 'sent') && <span className={`ml-2 font-medium ${STATUS[q.status].cls}`}>· {STATUS[q.status].label}</span>}
                </div>
              </div>
              {q.status === 'pending_approval' ? (
                <span className="px-3 py-1.5 text-xs rounded-md bg-amber-50 text-amber-700 border border-amber-200 font-medium whitespace-nowrap">Awaiting approval</span>
              ) : (
                <button onClick={() => openPdf(q)} className="px-3 py-1.5 text-xs rounded-md border border-brand-700 text-brand-700 hover:bg-gray-50 font-medium whitespace-nowrap">
                  {q.status === 'approved' ? 'Send approved price' : 'Open / Share'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {building && me && <QuoteBuilder me={me} onClose={() => setBuilding(false)} onSaved={() => { setBuilding(false); load(); }} />}
    </div>
  );
}
