'use client';
import { useEffect, useState } from 'react';

// The One Glovebox fleet program — trips, IFTA miles, fuel logging, receipts,
// maintenance, registrations, repairs, documents — framed into this app so
// drivers use one app instead of two. One copy of the fleet code runs at
// oneglovebox.com; this page shows it locked to Stallion's fleet.

const OGB_ORIGIN = 'https://oneglovebox.com';

export default function FleetPage() {
  const [url, setUrl] = useState<string | null>(null);
  const [canConfigure, setCanConfigure] = useState(false);
  const [checked, setChecked] = useState(false);
  const [ready, setReady] = useState(false);
  const [fleetId, setFleetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/fleet-embed')
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && j.configured) setUrl(j.url);
        setCanConfigure(!!j.can_configure);
      })
      .catch(() => setError('Could not load the fleet settings — refresh to try again.'))
      .finally(() => setChecked(true));
  }, []);

  // The panel says hello ({type:'ogb:ready'}) when it has loaded; until then
  // we hold our own cover over it. If the ping never arrives, drop the cover
  // after a few seconds anyway rather than hide a working panel.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin === OGB_ORIGIN && e.data && e.data.type === 'ogb:ready') setReady(true);
    }
    window.addEventListener('message', onMsg);
    const fallback = setTimeout(() => setReady(true), 8000);
    return () => { window.removeEventListener('message', onMsg); clearTimeout(fallback); };
  }, []);

  async function save() {
    const id = fleetId.trim();
    if (!id) { setError('Paste the Fleet ID first.'); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/fleet-embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fleet_id: id }),
      });
      const j = await res.json();
      if (!j.ok) { setError(j.error || 'Could not save.'); return; }
      setUrl(j.url);
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!checked) {
    return <p className="p-4 text-sm text-gray-500">Loading…</p>;
  }

  if (!url) {
    return (
      <div className="mx-auto max-w-xl px-4 py-8">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h1 className="text-lg font-semibold">Fleet</h1>
          {canConfigure ? (
            <>
              <p className="mt-2 text-sm text-gray-600">
                Connect the One Glovebox fleet program — trips, IFTA miles, fuel,
                maintenance, registrations, repairs, and documents — so the crew
                runs it from this tab.
              </p>
              <p className="mt-2 text-sm text-gray-600">
                Find the Fleet ID in One Glovebox under{' '}
                <strong>Settings → Admin → All users</strong>, on the owner&apos;s
                row (&quot;Fleet ID&quot;, tap to copy), then paste it here. This
                is a one-time setup for the whole company.
              </p>
              <label className="mt-3 block">
                <span className="mb-1 block text-xs font-medium text-gray-600">Fleet ID</span>
                <input
                  value={fleetId}
                  onChange={(e) => setFleetId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm"
                />
              </label>
              <button
                onClick={save}
                disabled={busy}
                className="mt-3 rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-900 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Connect fleet'}
              </button>
            </>
          ) : (
            <p className="mt-2 text-sm text-gray-600">
              The fleet program isn&apos;t connected yet — an admin sets it up from
              this tab.
            </p>
          )}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      {!ready && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-50">
          <p className="text-sm text-gray-500">Opening the fleet program…</p>
        </div>
      )}
      <iframe
        src={url}
        title="Fleet"
        className="h-full w-full border-0"
        allow="geolocation; camera; clipboard-write; web-share; fullscreen"
      />
    </div>
  );
}
