'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type Visit = {
  id: string;
  salesman_id: string | null;
  salesman_name: string;
  business_name: string;
  city: string | null;
  contact_person: string | null;
  notes: string | null;
  visit_date: string;
  visit_at: string;
};

type Salesman = { id: string; full_name: string };

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function getMonday(offset: number): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const day = now.getDay();
  const daysBackToMonday = (day + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysBackToMonday + offset * 7);
  return monday;
}

function fmtDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDayShort(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function calcDayHours(dayVisits: Visit[]): number {
  if (dayVisits.length === 0) return 0;
  const times = dayVisits.map((v) => new Date(v.visit_at).getTime());
  const first = Math.min(...times);
  const last  = Math.max(...times);
  return (last - first) / (1000 * 60 * 60) + 0.5;
}

export default function SalesLog() {
  const supabase = createClient();
  const [weekOffset, setWeekOffset] = useState(0);
  const [salesmen, setSalesmen] = useState<Salesman[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const { data: people } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('role', 'salesman')
      .order('full_name');
    setSalesmen(((people as any[]) || []).map((p) => ({
      id: p.id,
      full_name: p.full_name || p.email,
    })));

    const monday = getMonday(weekOffset);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);

    const { data } = await supabase
      .from('salesman_visits')
      .select('*')
      .gte('visit_date', fmtDateISO(monday))
      .lte('visit_date', fmtDateISO(friday))
      .order('visit_at', { ascending: true });
    setVisits((data as Visit[]) || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [weekOffset]);

  const monday = getMonday(weekOffset);
  const days: Date[] = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });

  function visitsFor(salesmanId: string, day: Date): Visit[] {
    const dayStr = fmtDateISO(day);
    return visits
      .filter((v) => v.salesman_id === salesmanId && v.visit_date === dayStr)
      .sort((a, b) => a.visit_at.localeCompare(b.visit_at));
  }

  function weekHours(salesmanId: string): number {
    return days.reduce((sum, day) => sum + calcDayHours(visitsFor(salesmanId, day)), 0);
  }

  const weekLabel = `${fmtDayShort(days[0])} – ${fmtDayShort(days[4])}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-2xl font-semibold">Sales Log</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWeekOffset(weekOffset - 1)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
          >
            ← Prev
          </button>
          <span className="text-sm font-medium whitespace-nowrap">
            {weekLabel}
            {weekOffset === 0 && <span className="text-gray-500 font-normal"> · this week</span>}
          </span>
          <button
            onClick={() => setWeekOffset(weekOffset + 1)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Next →
          </button>
          {weekOffset !== 0 && (
            <button
              onClick={() => setWeekOffset(0)}
              className="text-sm text-brand-700 hover:text-brand-900 px-2"
            >
              Today
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-4">
        Daily hours = time of last visit − time of first visit + 0.5 hour wrap-up.
        Days with no visits count as 0 hours.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : salesmen.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-12">No salesmen on file.</p>
      ) : (
        <div className="space-y-4">
          {salesmen.map((s) => {
            const total = weekHours(s.id);
            return (
              <div key={s.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-2">
                  <span className="font-semibold">{s.full_name}</span>
                  <span className="text-xs text-gray-600">
                    Week total: <span className="font-semibold text-brand-900">{total.toFixed(2)} hrs</span>
                  </span>
                </div>

                {/* MOBILE: stacked days */}
                <div className="md:hidden divide-y divide-gray-100">
                  {days.map((d, i) => {
                    const dayVisits = visitsFor(s.id, d);
                    const hours = calcDayHours(dayVisits);
                    return (
                      <div key={i} className="px-4 py-3">
                        <div className="flex justify-between items-baseline mb-1">
                          <div className="text-sm font-semibold text-gray-800">
                            {DAY_NAMES[i]}
                            <span className="text-gray-400 font-normal ml-2 text-xs">{fmtDayShort(d)}</span>
                          </div>
                          <div className="text-xs">
                            {hours > 0 ? (
                              <span className="font-semibold text-gray-800">{hours.toFixed(2)} hrs</span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </div>
                        </div>
                        {dayVisits.length === 0 ? (
                          <p className="text-xs text-gray-400">No visits</p>
                        ) : (
                          <ul className="space-y-1.5 mt-1">
                            {dayVisits.map((v) => (
                              <li key={v.id} className="text-sm">
                                <div className="font-medium">{v.business_name}</div>
                                <div className="text-[11px] text-gray-500">
                                  {fmtTime(v.visit_at)}
                                  {v.city ? ` · ${v.city}` : ''}
                                  {v.contact_person ? ` · ${v.contact_person}` : ''}
                                </div>
                                {v.notes && <div className="text-[11px] text-gray-600 whitespace-pre-wrap mt-0.5">{v.notes}</div>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* DESKTOP: 5-column grid */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50/60 border-b border-gray-200">
                      <tr>
                        {days.map((d, i) => (
                          <th
                            key={i}
                            className="text-left px-3 py-2 font-medium text-gray-700 border-r border-gray-100 last:border-r-0 align-top w-1/5"
                          >
                            <div>{DAY_NAMES[i]}</div>
                            <div className="text-[10px] text-gray-400 font-normal">{fmtDayShort(d)}</div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        {days.map((d, i) => {
                          const dayVisits = visitsFor(s.id, d);
                          return (
                            <td
                              key={i}
                              className="px-3 py-2 align-top border-r border-gray-100 last:border-r-0"
                            >
                              {dayVisits.length === 0 ? (
                                <span className="text-gray-300 text-xs">—</span>
                              ) : (
                                <div className="space-y-1.5">
                                  {dayVisits.map((v) => (
                                    <div key={v.id} className="border-b border-gray-50 last:border-b-0 pb-1 last:pb-0">
                                      <div className="font-medium text-gray-800">{v.business_name}</div>
                                      <div className="text-[10px] text-gray-500">
                                        {fmtTime(v.visit_at)}
                                        {v.city ? ` · ${v.city}` : ''}
                                      </div>
                                      {v.contact_person && (
                                        <div className="text-[10px] text-gray-500">{v.contact_person}</div>
                                      )}
                                      {v.notes && (
                                        <div className="text-[10px] text-gray-600 whitespace-pre-wrap mt-0.5">{v.notes}</div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                      <tr className="bg-gray-50/60 border-t border-gray-200">
                        {days.map((d, i) => {
                          const dayVisits = visitsFor(s.id, d);
                          const hours = calcDayHours(dayVisits);
                          const isFriday = i === 4;
                          return (
                            <td
                              key={i}
                              className="px-3 py-2 align-top border-r border-gray-100 last:border-r-0"
                            >
                              <div className="text-[10px] uppercase tracking-wide text-gray-500">Hours</div>
                              <div className="text-sm font-semibold text-gray-800">
                                {hours > 0 ? `${hours.toFixed(2)}` : '—'}
                              </div>
                              {isFriday && (
                                <div className="mt-2 pt-2 border-t border-gray-200">
                                  <div className="text-[10px] uppercase tracking-wide text-gray-500">Week total</div>
                                  <div className="text-base font-bold text-brand-900">{total.toFixed(2)}</div>
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
