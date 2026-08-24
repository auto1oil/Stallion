'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

// Slimmed-down home dashboard for /salesman. Now that My Customers,
// Customers Visited, Forms, and Notifications each have their own
// nav-driven page, the home screen only shows fuel prices for the
// day + a short Updates feed.

type Tier = {
  min_gallons: number;
  max_gallons: number | null;
  markup: number;
  sort_order: number;
};
type Notif = {
  id: string;
  title: string;
  body: string | null;
  created_at: string;
  read_at: string | null;
  link: string | null;
};

export default function RepHomeCards() {
  const supabase = createClient();
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [updates, setUpdates] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      const [{ data: tierRows }, { data: notifs }] = await Promise.all([
        supabase
          .from('fuel_pricing_tiers')
          .select('min_gallons, max_gallons, markup, sort_order'),
        user
          ? supabase
              .from('notifications')
              .select('id, title, body, created_at, read_at, link')
              .eq('recipient_id', user.id)
              .order('created_at', { ascending: false })
              .limit(5)
          : Promise.resolve({ data: [] }),
      ]);
      const sorted = ((tierRows as Tier[]) || []).sort(
        (a, b) => (a.sort_order - b.sort_order) || (a.min_gallons - b.min_gallons),
      );
      setTiers(sorted);
      setUpdates((notifs as Notif[]) || []);
      setLoading(false);
    })();
  }, []);

  function tierLabel(t: Tier): string {
    const min = t.min_gallons.toLocaleString();
    if (t.max_gallons == null) return `${min}+ gal`;
    return `${min}–${t.max_gallons.toLocaleString()} gal`;
  }

  return (
    <div className="space-y-4">
      {/* Default fuel pricing by volume — markup over rack, top of the home
          screen by request. Special-pricing customers are handled at order time. */}
      <section className="bg-white border border-amber-200 rounded-lg p-4">
        <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-800">
            Fuel pricing by volume
          </h2>
          <span className="text-[10px] text-gray-500">$ over rack</span>
        </div>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : tiers.length === 0 ? (
          <p className="text-sm text-gray-500">No pricing set yet. Ask an admin to set it on the Fuel tab.</p>
        ) : (
          <ul className="divide-y divide-amber-100">
            {tiers.map((t, i) => (
              <li key={i} className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-gray-700">{tierLabel(t)}</span>
                <span className="font-semibold tabular-nums text-amber-900">
                  ${Number(t.markup).toFixed(2)} <span className="font-normal text-gray-500 text-xs">over rack</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Updates — recent notifications so the rep doesn't have to open
          the bell. Links into the bell if they want to act on one. */}
      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-2">Updates</h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : updates.length === 0 ? (
          <p className="text-sm text-gray-500">No recent updates.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {updates.map((n) => (
              <li key={n.id} className="py-2 text-sm">
                <div className="flex justify-between gap-2">
                  <span className={n.read_at ? 'text-gray-600' : 'font-medium'}>{n.title}</span>
                  <span className="text-[10px] text-gray-400 whitespace-nowrap shrink-0">
                    {new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
                {n.body && <div className="text-xs text-gray-500 mt-0.5">{n.body}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
