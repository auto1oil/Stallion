'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Admin controls for the public "Chat with us" widget: required contact info,
// plus a schedule (days + hours) to auto-close the chat outside business hours.
const DAYS = [['0', 'Sun'], ['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat']] as const;

export default function SupportChatSettings() {
  const supabase = createClient();
  const [loaded, setLoaded] = useState(false);
  const [phone, setPhone] = useState(false);
  const [email, setEmail] = useState(false);
  const [schedOn, setSchedOn] = useState(false);
  const [days, setDays] = useState<string[]>(['1', '2', '3', '4', '5']);
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('17:00');
  const [offlineMsg, setOfflineMsg] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('app_settings').select('key, value')
        .in('key', ['support_require_phone', 'support_require_email', 'support_hours_enabled',
          'support_hours_days', 'support_hours_start', 'support_hours_end', 'support_offline_msg']);
      const m = Object.fromEntries(((data as { key: string; value: string }[]) || []).map((r) => [r.key, r.value]));
      setPhone(m.support_require_phone === 'true');
      setEmail(m.support_require_email === 'true');
      setSchedOn(m.support_hours_enabled === 'true');
      if (m.support_hours_days) setDays(m.support_hours_days.split(',').filter(Boolean));
      if (m.support_hours_start) setStart(m.support_hours_start);
      if (m.support_hours_end) setEnd(m.support_hours_end);
      setOfflineMsg(m.support_offline_msg || '');
      setLoaded(true);
    })();
  }, [supabase]);

  async function set(key: string, value: string) {
    await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
  }
  function flash() { setSaved(true); setTimeout(() => setSaved(false), 1200); }

  function toggleDay(d: string) {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    setDays(next);
    set('support_hours_days', next.join(',')).then(flash);
  }

  if (!loaded) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mt-5">
      <h2 className="font-semibold mb-1">Public chat widget</h2>
      <p className="text-xs text-gray-500 mb-3">
        Controls for the &quot;Chat with us&quot; button visitors see on public pages.
      </p>

      <label className="flex items-center gap-2 text-sm mb-2">
        <input type="checkbox" checked={phone} onChange={(e) => { setPhone(e.target.checked); set('support_require_phone', e.target.checked ? 'true' : 'false').then(flash); }} className="w-4 h-4" />
        Require phone number
      </label>
      <label className="flex items-center gap-2 text-sm mb-4">
        <input type="checkbox" checked={email} onChange={(e) => { setEmail(e.target.checked); set('support_require_email', e.target.checked ? 'true' : 'false').then(flash); }} className="w-4 h-4" />
        Require email
      </label>

      <div className="border-t border-gray-100 pt-3">
        <label className="flex items-center gap-2 text-sm font-medium mb-2">
          <input type="checkbox" checked={schedOn} onChange={(e) => { setSchedOn(e.target.checked); set('support_hours_enabled', e.target.checked ? 'true' : 'false').then(flash); }} className="w-4 h-4" />
          Only allow chats during set hours
        </label>

        {schedOn && (
          <div className="pl-6 space-y-3">
            <div>
              <div className="text-xs text-gray-500 mb-1">Open days</div>
              <div className="flex flex-wrap gap-1">
                {DAYS.map(([val, label]) => (
                  <button key={val} onClick={() => toggleDay(val)}
                    className={`px-2 py-1 text-xs rounded border ${days.includes(val) ? 'bg-brand-700 text-white border-brand-700' : 'bg-white border-gray-300 text-gray-600'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <label className="text-xs text-gray-500">From
                <input type="time" value={start} onChange={(e) => { setStart(e.target.value); set('support_hours_start', e.target.value).then(flash); }}
                  className="ml-1 px-2 py-1 border border-gray-300 rounded text-sm" />
              </label>
              <label className="text-xs text-gray-500">to
                <input type="time" value={end} onChange={(e) => { setEnd(e.target.value); set('support_hours_end', e.target.value).then(flash); }}
                  className="ml-1 px-2 py-1 border border-gray-300 rounded text-sm" />
              </label>
            </div>
            <p className="text-[11px] text-gray-400">Times are Mountain Time.</p>
            <div>
              <div className="text-xs text-gray-500 mb-1">Offline message</div>
              <textarea value={offlineMsg} rows={2}
                onChange={(e) => setOfflineMsg(e.target.value)}
                onBlur={() => set('support_offline_msg', offlineMsg).then(flash)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
            </div>
          </div>
        )}
      </div>
      {saved && <p className="text-xs text-emerald-700 mt-2">Saved ✓</p>}
    </div>
  );
}
