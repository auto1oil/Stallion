'use client';

// Commission report — used by the admin payout page (every salesman) and the
// salesman earnings page (just themselves; the API enforces that). Pick a
// month; see each salesman's gross profit and commission owed, with a
// per-customer breakdown.

import { useCallback, useEffect, useState } from 'react';

type Customer = { businessId: string; name: string; sale: number; profit: number; gallons: number; commission: number; uncostedSale?: number; uncostedItems?: string[] };
type Salesman = { repId: string; repName: string; totalSale: number; totalProfit: number; totalCommission: number; customers: Customer[] };

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
function thisMonth() { return new Date().toISOString().slice(0, 7); }
// Returns the first/last day of a YYYY-MM month, or null if the month string
// isn't complete/valid (e.g. mid-typing "2026-0") so we never query QuickBooks
// with a bad date. Uses Date.UTC to avoid timezone roll-over on the last day.
function rangeFor(month: string): { from: string; to: string } | null {
  const mm = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!mm) return null;
  const y = Number(mm[1]); const m = Number(mm[2]);
  if (m < 1 || m > 12) return null;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${mm[1]}-${mm[2]}-01`, to: `${mm[1]}-${mm[2]}-${String(lastDay).padStart(2, '0')}` };
}

export default function CommissionsView({ salesmanView = false }: { salesmanView?: boolean }) {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<Salesman[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const range = rangeFor(month);
    if (!range) return; // incomplete month — wait for a full YYYY-MM
    setLoading(true); setErr('');
    try {
      const res = await fetch(`/api/commissions?from=${range.from}&to=${range.to}`);
      const j = await res.json();
      if (!res.ok || !j.ok) { setErr(j.error || 'Could not load commissions.'); setData(null); return; }
      setData(j.salesmen as Salesman[]);
    } catch {
      setErr('Could not load commissions.');
    } finally {
      setLoading(false);
    }
  }, [month]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-sm text-gray-600 flex items-center gap-2">
          Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="px-2 py-1.5 border border-gray-300 rounded-md text-sm" />
        </label>
        <button onClick={load} disabled={loading}
          className="px-3 py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <p className="text-xs text-gray-400 mb-3">
        Commission = % of gross profit (sale − item cost) on non-fuel; fuel is that % or a flat $/gallon, per customer.
        Pulled live from QuickBooks for the month.
      </p>

      {err && <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Crunching invoices… this can take a few seconds.</p>
      ) : !data ? null : data.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No commissions for this month (no invoiced sales on assigned customers).</p>
      ) : (
        <div className="space-y-2">
          {data.map((s) => {
            const isOpen = salesmanView || open.has(s.repId);
            return (
              <div key={s.repId} className="rounded-lg border border-gray-200 bg-white">
                <button
                  onClick={() => !salesmanView && setOpen((o) => { const n = new Set(o); n.has(s.repId) ? n.delete(s.repId) : n.add(s.repId); return n; })}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div className="min-w-0">
                    {!salesmanView && <div className="font-medium text-sm">{s.repName}</div>}
                    <div className="text-xs text-gray-500">
                      Profit {money(s.totalProfit)} · {s.customers.length} customer{s.customers.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-base font-bold text-green-700 tabular-nums">{money(s.totalCommission)}</div>
                    <div className="text-[10px] uppercase tracking-wide text-gray-400">{salesmanView ? 'you earned' : 'commission'}</div>
                  </div>
                </button>
                {isOpen && (
                  <div className="border-t border-gray-100 divide-y divide-gray-100">
                    {s.customers.map((c) => (
                      <div key={c.businessId} className="px-4 py-2 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate">{c.name}</span>
                          <span className="shrink-0 text-right">
                            <span className="text-gray-500 text-xs mr-3">profit {money(c.profit)}{c.gallons ? ` · ${c.gallons} gal` : ''}</span>
                            <span className="font-semibold text-green-700 tabular-nums">{money(c.commission)}</span>
                          </span>
                        </div>
                        {!!c.uncostedSale && c.uncostedSale > 0 && (
                          <div className="mt-1 text-[11px] text-amber-700">
                            ⚠ {money(c.uncostedSale)} of sales had no item cost (counted as full profit)
                            {c.uncostedItems && c.uncostedItems.length > 0 && <>: {c.uncostedItems.join(', ')}</>}
                          </div>
                        )}
                      </div>
                    ))}
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
