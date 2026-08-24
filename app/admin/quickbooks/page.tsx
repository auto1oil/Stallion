'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

function SyncCustomersButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [includeInactive, setIncludeInactive] = useState(false);

  async function go() {
    setBusy(true); setResult(''); setError('');
    try {
      const url = `/api/quickbooks/sync-customers${includeInactive ? '?includeInactive=true' : ''}`;
      const r = await fetch(url, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || 'Sync failed.');
      } else {
        setResult(`Done. ${j.qb_customers_seen} QB customers — ${j.created} created, ${j.updated} updated, ${j.skipped} skipped${j.linksHealed ? `, ${j.linksHealed} broken link${j.linksHealed === 1 ? '' : 's'} repaired` : ''}.`);
      }
    } catch (e: any) {
      setError(e.message || 'Network error');
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={go}
        disabled={busy}
        className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
      >
        {busy ? 'Syncing customers…' : 'Sync customers from QuickBooks'}
      </button>
      <label className="flex items-center gap-1.5 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={includeInactive}
          onChange={(e) => setIncludeInactive(e.target.checked)}
        />
        Include inactive customers
      </label>
      {result && <span className="text-xs text-green-700">{result}</span>}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}

type Conn = {
  realm_id: string;
  environment: 'sandbox' | 'production';
  connected_at: string;
  updated_at: string;
};

export default function AdminQuickBooksPage() {
  const supabase = createClient();
  const search = useSearchParams();
  const justConnected = search?.get('connected') === '1';
  const error = search?.get('error');
  const [conn, setConn] = useState<Conn | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from('quickbooks_connection')
      .select('realm_id, environment, connected_at, updated_at')
      .eq('id', 1)
      .maybeSingle();
    setConn(data as Conn | null);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function disconnect() {
    if (!confirm('Disconnect QuickBooks? New customer orders will go back to manual invoice entry until you reconnect.')) return;
    setWorking(true);
    await supabase.from('quickbooks_connection').delete().eq('id', 1);
    setWorking(false);
    load();
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">QuickBooks</h1>

      {justConnected && (
        <div className="bg-green-50 border border-green-200 text-green-900 rounded-lg p-3 mb-4 text-sm">
          Connected. New customer orders can now have QB invoices generated with one click.
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-900 rounded-lg p-3 mb-4 text-sm">
          Couldn't connect: <code className="font-mono">{decodeURIComponent(error)}</code>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Checking connection…</p>
      ) : conn ? (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-baseline justify-between gap-2 mb-2 flex-wrap">
            <span className="font-medium">Connected</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${conn.environment === 'production' ? 'bg-green-100 text-green-900' : 'bg-amber-100 text-amber-900'}`}>
              {conn.environment}
            </span>
          </div>
          <div className="text-sm text-gray-600 space-y-1">
            <div>Company (realm) id: <span className="font-mono">{conn.realm_id}</span></div>
            <div>Connected: {new Date(conn.connected_at).toLocaleString('en-US')}</div>
            <div>Last refreshed: {new Date(conn.updated_at).toLocaleString('en-US')}</div>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            Seeing “AuthenticationFailed” or 401 errors on QuickBooks actions? The authorization
            lapsed — tap <span className="font-medium">Reconnect</span> and sign in again to refresh it. No data is affected.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 items-start">
            <SyncCustomersButton />
            <Link
              href="/api/quickbooks/authorize"
              className="px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium"
            >
              ↻ Reconnect QuickBooks
            </Link>
            <Link
              href="/admin/quickbooks/mappings"
              className="px-3 py-2 text-sm border border-gray-300 text-gray-800 rounded-md hover:bg-gray-50 font-medium"
            >
              Map products to QB items →
            </Link>
            <button
              onClick={disconnect}
              disabled={working}
              className="px-3 py-2 text-sm border border-red-300 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50 ml-auto"
            >
              {working ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-sm text-gray-600 mb-4">
            Not connected. Authorize QuickBooks once and the app will create
            invoices on demand for every customer order.
          </p>
          <Link
            href="/api/quickbooks/authorize"
            className="inline-block px-5 py-2.5 bg-brand-700 text-white font-semibold rounded-md hover:bg-brand-900"
          >
            Connect QuickBooks
          </Link>
          <p className="text-xs text-gray-400 mt-4">
            You'll be sent to Intuit's site to sign in and approve access.
            Returns here when done.
          </p>
        </div>
      )}
    </div>
  );
}
