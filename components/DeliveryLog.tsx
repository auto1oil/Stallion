'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type LogEntry = {
  id: string;
  order_id: string | null;
  invoice_number: string | null;
  customer: string;
  driver_name: string | null;
  signer_name: string | null;
  delivered_by_name: string | null;
  delivered_at: string;
  // Joined from orders (admins only) — for quick PDF viewing in the log.
  invoice_pdf_path?: string | null;
  signed_pdf_path?: string | null;
};

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function monthLabelShort(key: string) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function monthRange(key: string) {
  const [y, m] = key.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export default function DeliveryLog() {
  const supabase = createClient();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [monthOptions, setMonthOptions] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>(monthKey(new Date()));
  const [loading, setLoading] = useState(true);
  const [isMasterAdmin, setIsMasterAdmin] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false); // admin OR master_admin
  const [pdf, setPdf] = useState<{ url: string; title: string } | null>(null);

  async function loadCurrentUser() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    setIsMasterAdmin(profile?.role === 'master_admin');
    setIsAdmin(profile?.role === 'admin' || profile?.role === 'master_admin');
  }

  // Open a stored invoice/signed PDF (admins only). Paths live in the
  // `invoices` bucket; sign a short-lived URL and show it in a modal.
  async function viewPdf(path: string, title: string) {
    const { data } = await supabase.storage.from('invoices').createSignedUrl(path, 600);
    if (data?.signedUrl) setPdf({ url: data.signedUrl, title });
    else alert('Could not load the PDF.');
  }

  async function loadMonths() {
    const { data } = await supabase
      .from('delivery_log')
      .select('delivered_at')
      .order('delivered_at', { ascending: false });
    const keys = new Set<string>();
    keys.add(monthKey(new Date()));
    (data || []).forEach((r: any) => {
      if (r.delivered_at) keys.add(monthKey(new Date(r.delivered_at)));
    });
    setMonthOptions(Array.from(keys).sort().reverse());
  }

  async function loadEntries(key: string, withPdfs: boolean) {
    setLoading(true);
    const { start, end } = monthRange(key);
    // Plain log query — never use an embedded join (delivery_log has no FK to
    // orders, so a join blanks the whole list). Admins fetch the linked orders'
    // PDF paths in a separate query and merge them in.
    const { data } = await supabase
      .from('delivery_log')
      .select('id, order_id, invoice_number, customer, driver_name, signer_name, delivered_by_name, delivered_at')
      .gte('delivered_at', start)
      .lt('delivered_at', end)
      .order('delivered_at', { ascending: false });
    let rows = (data as LogEntry[]) || [];

    if (withPdfs && rows.length > 0) {
      const orderIds = Array.from(new Set(rows.map((r) => r.order_id).filter(Boolean))) as string[];
      if (orderIds.length > 0) {
        const { data: ords } = await supabase
          .from('orders')
          .select('id, invoice_pdf_path, signed_pdf_path')
          .in('id', orderIds);
        const byId = new Map<string, { invoice_pdf_path: string | null; signed_pdf_path: string | null }>();
        ((ords as { id: string; invoice_pdf_path: string | null; signed_pdf_path: string | null }[]) || [])
          .forEach((o) => byId.set(o.id, { invoice_pdf_path: o.invoice_pdf_path, signed_pdf_path: o.signed_pdf_path }));
        rows = rows.map((r) => ({
          ...r,
          invoice_pdf_path: r.order_id ? byId.get(r.order_id)?.invoice_pdf_path ?? null : null,
          signed_pdf_path: r.order_id ? byId.get(r.order_id)?.signed_pdf_path ?? null : null,
        }));
      }
    }
    setEntries(rows);
    setLoading(false);
  }

  useEffect(() => {
    loadCurrentUser();
    loadMonths();
  }, []);

  useEffect(() => {
    loadEntries(selectedMonth, isAdmin);
  }, [selectedMonth, isAdmin]);

  async function deleteEntry(entry: LogEntry) {
    const invDisplay = entry.invoice_number ? `Invoice #${entry.invoice_number}` : entry.customer;
    if (!confirm(`Delete "${invDisplay}" from the delivery log?\n\nThis cannot be undone. Use only for correcting mistakes.`)) {
      return;
    }
    const { error } = await supabase
      .from('delivery_log')
      .delete()
      .eq('id', entry.id);
    if (error) {
      alert('Could not delete: ' + error.message);
      return;
    }
    loadEntries(selectedMonth, isAdmin);
    loadMonths();
  }

  function exportCSV() {
    const headers = ['Date', 'Time', 'Invoice #', 'Customer', 'Signed By', 'Delivered By', 'Assigned Driver'];
    const rows = entries.map((e) => {
      const d = new Date(e.delivered_at);
      return [
        d.toLocaleDateString('en-US'),
        d.toLocaleTimeString('en-US'),
        e.invoice_number || '',
        e.customer,
        e.signer_name || '',
        e.delivered_by_name || '',
        e.driver_name || '',
      ];
    });
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${(c || '').toString().replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `delivery-log-${selectedMonth}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="overflow-x-auto mb-3 -mx-4 px-4">
        <div className="flex items-center gap-2 min-w-max">
          <h1 className="text-lg font-semibold whitespace-nowrap mr-2">Delivery Log</h1>
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
          >
            {monthOptions.map((k) => (
              <option key={k} value={k}>
                {monthLabelShort(k)}
              </option>
            ))}
          </select>
          {entries.length > 0 && (
            <button
              onClick={exportCSV}
              className="px-2 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50 whitespace-nowrap"
            >
              Export CSV
            </button>
          )}
        </div>
      </div>

      <div className="mb-3 text-xs text-gray-500">
        {loading
          ? 'Loading…'
          : `${entries.length} ${entries.length === 1 ? 'delivery' : 'deliveries'} in ${monthLabel(selectedMonth)}`}
      </div>

      {!loading && entries.length === 0 && (
        <p className="text-xs text-gray-500 text-center py-12">
          No deliveries logged for {monthLabel(selectedMonth)}.
        </p>
      )}

      {!loading && entries.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-2 py-2 font-medium text-gray-600 whitespace-nowrap">Delivered</th>
                <th className="text-left px-2 py-2 font-medium text-gray-600 whitespace-nowrap">Inv #</th>
                <th className="text-left px-2 py-2 font-medium text-gray-600">Customer</th>
                <th className="text-left px-2 py-2 font-medium text-gray-600">Signed By</th>
                <th className="text-left px-2 py-2 font-medium text-gray-600">Delivered By</th>
                {isAdmin && <th className="text-left px-2 py-2 font-medium text-gray-600 whitespace-nowrap">Invoice</th>}
                {isMasterAdmin && <th className="px-2 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const d = new Date(e.delivered_at);
                const dateStr = d.toLocaleDateString('en-US', {
                  month: 'numeric',
                  day: 'numeric',
                });
                const timeStr = d.toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                });
                const initiator = e.delivered_by_name || e.driver_name || '—';
                return (
                  <tr key={e.id} className="border-b border-gray-100 align-top">
                    <td className="px-2 py-2 text-gray-600 whitespace-nowrap">
                      {dateStr}
                      <br />
                      <span className="text-[10px] text-gray-400">{timeStr}</span>
                    </td>
                    <td className="px-2 py-2 font-medium tabular-nums">
                      {e.invoice_number || <span className="italic text-gray-400">—</span>}
                    </td>
                    <td className="px-2 py-2 break-words">{e.customer}</td>
                    <td className="px-2 py-2 text-gray-700 break-words">
                      {e.signer_name || <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-2 py-2 text-gray-700 break-words">{initiator}</td>
                    {isAdmin && (
                      <td className="px-2 py-2 whitespace-nowrap">
                        {e.invoice_pdf_path ? (
                          <button
                            onClick={() => viewPdf(e.invoice_pdf_path!, e.invoice_number ? `Invoice #${e.invoice_number}` : e.customer)}
                            className="text-brand-700 hover:underline"
                          >
                            View
                          </button>
                        ) : e.signed_pdf_path ? (
                          <button
                            onClick={() => viewPdf(e.signed_pdf_path!, `Signed — ${e.customer}`)}
                            className="text-brand-700 hover:underline"
                          >
                            Signed
                          </button>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    )}
                    {isMasterAdmin && (
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => deleteEntry(e)}
                          className="text-red-600 hover:text-red-800 text-xs px-1"
                          title="Delete log entry"
                        >
                          🗑
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Admin PDF viewer */}
      {pdf && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setPdf(null)}>
          <div className="bg-white rounded-lg w-full max-w-3xl h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
              <span className="font-semibold text-sm truncate">{pdf.title}</span>
              <div className="flex items-center gap-3 shrink-0">
                <a href={pdf.url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-700 hover:underline">Open</a>
                <button onClick={() => setPdf(null)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
              </div>
            </div>
            <iframe src={pdf.url} title={pdf.title} className="flex-1 w-full rounded-b-lg" />
          </div>
        </div>
      )}
    </div>
  );
}
