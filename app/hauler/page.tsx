'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import {
  LOAD_STATUS_LABEL, LOAD_STATUS_TONE,
  type HaulerLoad, type HaulerEquipment, type LoadStatus,
} from '@/lib/haulers';

// The hauler's loads. Anything still 'offered' is waiting on them, so it sits
// at the top with the accept/decline buttons; everything else is history.
//
// Accept and decline post to the API route rather than writing the row — a
// hauler can read its loads but never write them, so the rate it accepted at
// is always the rate dispatch sent.

export default function HaulerLoadsPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loads, setLoads] = useState<HaulerLoad[]>([]);
  const [fleet, setFleet] = useState<HaulerEquipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [unitFor, setUnitFor] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const [{ data: l }, { data: e }] = await Promise.all([
      supabase.from('hauler_loads').select('*')
        .order('job_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false }),
      supabase.from('hauler_equipment').select('*').eq('active', true).order('unit_number'),
    ]);
    setLoads((l as HaulerLoad[]) || []);
    setFleet((e as HaulerEquipment[]) || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { refresh(); }, [refresh]);

  async function respond(id: string, answer: 'accept' | 'decline') {
    setBusy(id); setError(''); setMsg('');
    try {
      const res = await fetch(`/api/haulers/loads/${id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer,
          reason: answer === 'decline' ? reason : undefined,
          equipment_id: answer === 'accept' ? (unitFor[id] || null) : undefined,
        }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error || 'Could not send your answer.'); return; }
      setMsg(answer === 'accept' ? 'Accepted — the office has been told.' : 'Declined.');
      setDeclining(null); setReason('');
      // Accepting starts the haul ticket; go straight to it rather than making
      // them find it — the load lines are the next thing they touch.
      if (answer === 'accept' && json.work_order_id) {
        router.push(`/tickets/${json.work_order_id}`);
        return;
      }
      refresh();
    } catch {
      setError('Network error — check your signal and try again.');
    } finally {
      setBusy('');
    }
  }

  const input = 'w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';
  const offered = loads.filter((l) => l.status === 'offered');
  const working = loads.filter((l) => ['accepted', 'assigned'].includes(l.status));
  const past = loads.filter((l) => ['completed', 'declined', 'cancelled'].includes(l.status));

  function details(l: HaulerLoad) {
    const unit = fleet.find((u) => u.id === l.equipment_id);
    return [
      l.job_number && l.job_name ? l.job_name : null,
      l.job_date,
      l.start_time,
      unit ? `Unit ${unit.unit_number || ''}`.trim() : l.equipment_type,
      l.pickup && l.dropoff ? `${l.pickup} → ${l.dropoff}` : (l.pickup || l.dropoff),
      l.rate != null ? `$${Number(l.rate).toFixed(2)}/${l.rate_unit || 'hr'}` : null,
    ].filter(Boolean).join(' · ');
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">Loads</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/hauler/equipment" className="text-brand-700 hover:underline">Trucks &amp; equipment</Link>
          <Link href="/hauler/availability" className="text-brand-700 hover:underline">Availability</Link>
        </div>
      </div>

      {msg && <p className="text-sm text-emerald-700">{msg}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : loads.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing yet. When Stallion sends you a load it shows up here and you
          get a notification.
        </p>
      ) : (
        <>
          {offered.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">
                Waiting on you
              </h2>
              <div className="space-y-2">
                {offered.map((l) => (
                  <div key={l.id} className="bg-white border-2 border-accent-400 rounded-lg px-4 py-3">
                    <div className="font-medium text-sm">
                      {l.job_number ? `Job ${l.job_number}` : l.job_name || 'Load'}
                    </div>
                    <div className="text-xs text-gray-600 mt-0.5">{details(l)}</div>
                    {l.notes && <div className="text-xs text-gray-600 mt-1">{l.notes}</div>}

                    {declining === l.id ? (
                      <div className="mt-2">
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Why can't you take it? (optional)"
                          className={input}
                        />
                        <div className="flex gap-2 mt-2">
                          <button onClick={() => respond(l.id, 'decline')} disabled={busy === l.id}
                            className="px-3 py-1.5 text-xs rounded-md bg-red-700 text-white font-medium hover:bg-red-800 disabled:opacity-50">
                            {busy === l.id ? 'Sending…' : 'Confirm decline'}
                          </button>
                          <button onClick={() => { setDeclining(null); setReason(''); }}
                            className="px-3 py-1.5 text-xs rounded-md border border-gray-300 hover:bg-gray-50">
                            Back
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2 mt-2 flex-wrap items-center">
                        {fleet.length > 0 && (
                          <select
                            value={unitFor[l.id] || ''}
                            onChange={(e) => setUnitFor({ ...unitFor, [l.id]: e.target.value })}
                            className="px-2 py-1 border border-gray-300 rounded-md text-xs"
                          >
                            <option value="">Which unit?</option>
                            {fleet.map((u) => (
                              <option key={u.id} value={u.id}>{u.unit_number || u.equipment_type || 'Unit'}</option>
                            ))}
                          </select>
                        )}
                        <button onClick={() => respond(l.id, 'accept')} disabled={busy === l.id}
                          className="px-3 py-1.5 text-xs rounded-md bg-brand-700 text-white font-medium hover:bg-brand-900 disabled:opacity-50">
                          {busy === l.id ? 'Sending…' : 'Accept'}
                        </button>
                        <button onClick={() => setDeclining(l.id)}
                          className="px-3 py-1.5 text-xs rounded-md border border-gray-300 hover:bg-gray-50">
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {[['On the books', working], ['History', past]].map(([title, list]) => {
            const rows = list as HaulerLoad[];
            if (rows.length === 0) return null;
            return (
              <section key={title as string}>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">{title as string}</h2>
                <div className="space-y-2">
                  {rows.map((l) => (
                    <div key={l.id} className="bg-white border border-gray-200 rounded-lg px-4 py-3">
                      <div className="flex justify-between items-start gap-3 flex-wrap">
                        <div className="min-w-0">
                          <span className="font-medium text-sm">
                            {l.job_number ? `Job ${l.job_number}` : l.job_name || 'Load'}
                          </span>
                          <div className="text-xs text-gray-500 mt-0.5">{details(l)}</div>
                          {l.decline_reason && (
                            <div className="text-xs text-gray-500 mt-0.5">You declined: {l.decline_reason}</div>
                          )}
                          {l.work_order_id && (
                            <Link href={`/tickets/${l.work_order_id}`} className="inline-block text-xs text-brand-700 hover:underline mt-1">
                              Open the haul ticket →
                            </Link>
                          )}
                        </div>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${LOAD_STATUS_TONE[l.status as LoadStatus]}`}>
                          {LOAD_STATUS_LABEL[l.status as LoadStatus]}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
