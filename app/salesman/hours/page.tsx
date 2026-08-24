'use client';

// Salesman's own hours — auto-calculated from their logged visits per day
// ((last visit − first visit) + 0.5 hr wrap-up), shown by week. Mirrors the
// admin Hours calculation; read-only.

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import SalesSubNav from '@/components/SalesSubNav';
import TimeAdjustmentRequest from '@/components/TimeAdjustmentRequest';
import SelfClock from '@/components/SelfClock';

type Visit = { visit_date: string; visit_at: string };

function weekStart(date: Date): Date {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}
function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dayHours(visits: Visit[]): number {
  if (visits.length === 0) return 0;
  const t = visits.map((v) => new Date(v.visit_at).getTime());
  return (Math.max(...t) - Math.min(...t)) / 3_600_000 + 0.5;
}

export default function SalesmanHoursPage() {
  const supabase = createClient();
  const [weekStartDate, setWeekStartDate] = useState<Date>(weekStart(new Date()));
  const [visits, setVisits] = useState<Visit[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const start = ymd(weekStartDate);
    const end = ymd(addDays(weekStartDate, 7));
    const { data } = await supabase
      .from('salesman_visits')
      .select('visit_date, visit_at')
      .eq('salesman_id', user.id)
      .gte('visit_date', start)
      .lt('visit_date', end)
      .order('visit_at');
    setVisits((data as Visit[]) || []);
    setLoading(false);
  }, [supabase, weekStartDate]);
  useEffect(() => { void load(); }, [load]);

  // Group visits by day, compute hours.
  const byDay = new Map<string, Visit[]>();
  for (const v of visits) { const k = v.visit_date; byDay.set(k, [...(byDay.get(k) || []), v]); }
  const days = Array.from({ length: 7 }, (_, i) => ymd(addDays(weekStartDate, i)));
  const total = days.reduce((sum, d) => sum + dayHours(byDay.get(d) || []), 0);

  const weekLabel = `${weekStartDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${addDays(weekStartDate, 6).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <div className="max-w-2xl">
      <SalesSubNav />
      <h1 className="text-2xl font-semibold mb-1">My hours</h1>
      <p className="text-sm text-gray-500 mb-4">Auto-calculated from your visits: (last − first) + 0.5 hr each day.</p>

      <SelfClock />
      <TimeAdjustmentRequest />

      <div className="flex items-center justify-between mb-3">
        <button onClick={() => setWeekStartDate((d) => addDays(d, -7))} className="px-3 py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50">← Prev</button>
        <span className="text-sm font-medium">{weekLabel}</span>
        <button onClick={() => setWeekStartDate((d) => addDays(d, 7))} className="px-3 py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50">Next →</button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {days.map((d) => {
            const dv = byDay.get(d) || [];
            const h = dayHours(dv);
            const label = new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
            return (
              <div key={d} className="px-4 py-2.5 flex items-center justify-between text-sm">
                <span className="text-gray-700">{label}</span>
                <span className="text-gray-500">{dv.length} visit{dv.length === 1 ? '' : 's'}</span>
                <span className="font-semibold tabular-nums w-16 text-right">{h ? `${h.toFixed(1)} h` : '—'}</span>
              </div>
            );
          })}
          <div className="px-4 py-3 flex items-center justify-between text-sm font-semibold bg-gray-50">
            <span>Week total</span>
            <span className="tabular-nums">{total.toFixed(1)} h</span>
          </div>
        </div>
      )}
    </div>
  );
}
