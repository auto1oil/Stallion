'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Sales rep's per-event notification preferences. Saves directly to the
// profile columns the notify_* Postgres triggers read on every order /
// status change.

export default function SalesmanNotificationsPage() {
  const supabase = createClient();
  const [prefs, setPrefs] = useState<{ new_order: boolean; out_for_delivery: boolean; delivered: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from('profiles')
        .select('notify_on_new_order, notify_on_out_for_delivery, notify_on_delivered')
        .eq('id', user.id)
        .single();
      const p = data as {
        notify_on_new_order: boolean;
        notify_on_out_for_delivery: boolean;
        notify_on_delivered: boolean;
      } | null;
      setPrefs({
        new_order:        p?.notify_on_new_order ?? true,
        out_for_delivery: p?.notify_on_out_for_delivery ?? false,
        delivered:        p?.notify_on_delivered ?? false,
      });
    })();
  }, []);

  async function update(key: 'new_order' | 'out_for_delivery' | 'delivered', value: boolean) {
    if (!prefs) return;
    setPrefs({ ...prefs, [key]: value });
    setSaving(true);
    setSaved(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }
    const col =
      key === 'new_order' ? 'notify_on_new_order' :
      key === 'out_for_delivery' ? 'notify_on_out_for_delivery' :
      'notify_on_delivered';
    await supabase.from('profiles').update({ [col]: value }).eq('id', user.id);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-2">Notifications</h1>
      <p className="text-sm text-gray-500 mb-4">
        Pick which order events show up in your bell. New order is on by default so
        you don't accidentally visit a customer who just ordered through the app.
      </p>

      {!prefs ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={prefs.new_order}
              onChange={(e) => update('new_order', e.target.checked)}
              className="w-4 h-4 mt-0.5"
            />
            <div>
              <div className="font-medium">New order placed</div>
              <div className="text-xs text-gray-500">Ping me when a customer places an order with me assigned.</div>
            </div>
          </label>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={prefs.out_for_delivery}
              onChange={(e) => update('out_for_delivery', e.target.checked)}
              className="w-4 h-4 mt-0.5"
            />
            <div>
              <div className="font-medium">Out for delivery</div>
              <div className="text-xs text-gray-500">Ping me when one of my customers' orders is loaded on the truck.</div>
            </div>
          </label>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={prefs.delivered}
              onChange={(e) => update('delivered', e.target.checked)}
              className="w-4 h-4 mt-0.5"
            />
            <div>
              <div className="font-medium">Delivered</div>
              <div className="text-xs text-gray-500">Ping me when one of my customers' orders is marked delivered.</div>
            </div>
          </label>

          <div className="text-xs text-gray-400 pt-1">
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Changes save automatically.'}
          </div>
        </div>
      )}
    </div>
  );
}
