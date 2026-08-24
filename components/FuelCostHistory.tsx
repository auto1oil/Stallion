'use client';
import { useEffect, useState } from 'react';

// Fuel cost-per-gallon history table. Date down the left, one column per fuel
// product. Each cell is the all-in cost: rack price (that date) + the fuel
// taxes for that product. Newest date on top. The product header row and the
// Date header/column stay put while the body scrolls (sticky).

type Cell = { rack: number; tax: number; total: number } | null;
type Row = { date: string; prices: Record<string, Cell> };
type Resp = {
  ok: boolean;
  products: string[];
  taxByProduct: Record<string, number>;
  taxBreakdown: Record<string, { name: string; rate: number }[]>;
  rows: Row[];
  error?: string;
};

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'numeric', day: 'numeric', year: '2-digit',
  });
}

export default function FuelCostHistory({ onClose }: { onClose?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [data, setData] = useState<Resp | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin/fuel-cost-history');
        const json: Resp = await res.json();
        if (!res.ok || !json.ok) { setErr(json.error || 'Could not load history'); return; }
        setData(json);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not load history');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const products = data?.products || [];

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
      <div className="flex items-start justify-between gap-2 mb-1">
        <h2 className="font-semibold">Fuel cost history (per gallon)</h2>
        {onClose && (
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 whitespace-nowrap">
            Close
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        All-in cost per gallon by date: the rack price that day plus the fuel taxes that ride along
        with each product. Newest date on top. Tax rates use the current QuickBooks rates.
      </p>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {!loading && !err && data && (
        products.length === 0 || data.rows.length === 0 ? (
          <p className="text-sm text-gray-500">
            No history yet — map each fuel product to a rack line and load rack prices first.
          </p>
        ) : (
          <>
            {/* Per-product tax footnote */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-[11px] text-gray-500">
              {products.map((p) => (
                <span key={p}>
                  <span className="font-medium text-gray-600">{p}</span> tax:{' '}
                  ${(data.taxByProduct[p] || 0).toFixed(4)}/gal
                </span>
              ))}
            </div>

            <div className="overflow-auto border border-gray-100 rounded max-h-[70vh]">
              <table className="text-sm border-collapse">
                <thead>
                  <tr>
                    <th className="sticky top-0 left-0 z-20 bg-gray-100 px-3 py-2 text-left font-medium text-gray-600 border-b border-r border-gray-200 whitespace-nowrap">
                      Date
                    </th>
                    {products.map((p) => (
                      <th key={p}
                        className="sticky top-0 z-10 bg-gray-100 px-3 py-2 text-right font-medium text-gray-600 border-b border-gray-200 whitespace-nowrap">
                        {p}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.date} className="border-t border-gray-100">
                      <td className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-gray-700 border-r border-gray-200 whitespace-nowrap tabular-nums">
                        {fmtDate(row.date)}
                      </td>
                      {products.map((p) => {
                        const c = row.prices[p];
                        return (
                          <td key={p} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                            {c ? (
                              <span title={`Rack $${c.rack.toFixed(4)} + tax $${c.tax.toFixed(4)}`}
                                className="font-medium text-gray-800">
                                ${c.total.toFixed(4)}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              Hover a cell to see the rack price and tax split that make up the total.
            </p>
          </>
        )
      )}
    </div>
  );
}
