'use client';
import { useEffect, useState } from 'react';
import AdminSubNav from '@/components/AdminSubNav';
import { createClient } from '@/lib/supabase-browser';

// Work-order setup: which QuickBooks item every ticket bills against, and the
// agreed rate per job/phase that the ticket form offers the crew.

type QBItem = { id: string; name: string };
type Rate = {
  id: string;
  job_number: string;
  phase_code: string | null;
  description: string | null;
  rate: number;
  rate_unit: string;
  active: boolean;
};

const RATE_UNITS = ['hour', 'ton', 'load', 'day'];

export default function WorkOrderSetupPage() {
  const supabase = createClient();
  const [items, setItems] = useState<QBItem[]>([]);
  const [itemId, setItemId] = useState('');
  const [itemName, setItemName] = useState('');
  const [itemsError, setItemsError] = useState('');
  const [savedItem, setSavedItem] = useState(false);

  const [rates, setRates] = useState<Rate[]>([]);
  const [newRate, setNewRate] = useState({ job_number: '', phase_code: '', description: '', rate: '', rate_unit: 'hour' });
  const [rateError, setRateError] = useState('');

  // The factoring hand-off: where approved factor-pay tickets get POSTed.
  const [isMaster, setIsMaster] = useState(false);
  const [factorUrl, setFactorUrl] = useState('');
  const [factorKey, setFactorKey] = useState('');
  const [savedFactor, setSavedFactor] = useState(false);
  // Scan & fill: the Claude API key that reads registrations, receipts, and
  // shop bills off photos. Master admin only, like the factoring key.
  const [aiKey, setAiKey] = useState('');
  const [savedAi, setSavedAi] = useState(false);
  // Trip mileage: the Google Maps key behind "Calculate miles by state".
  const [mapsKey, setMapsKey] = useState('');
  const [savedMaps, setSavedMaps] = useState(false);
  // Texting loads: Twilio account, token, and the number texts come from.
  const [twilioSid, setTwilioSid] = useState('');
  const [twilioToken, setTwilioToken] = useState('');
  const [twilioFrom, setTwilioFrom] = useState('');
  const [savedTwilio, setSavedTwilio] = useState(false);
  // Test connection: probes the SAVED settings against the funding app.
  const [pingBusy, setPingBusy] = useState(false);
  const [ping, setPing] = useState<{ ok: boolean; message: string } | null>(null);
  const [everSavedUrl, setEverSavedUrl] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('app_settings')
        .select('key, value')
        .in('key', ['work_order_qb_item_id', 'work_order_qb_item_name', 'factoring_webhook_url', 'factoring_api_key', 'anthropic_api_key', 'google_maps_api_key', 'twilio_account_sid', 'twilio_auth_token', 'twilio_from_number']);
      const m = new Map(((data as { key: string; value: string }[]) || []).map((r) => [r.key, r.value]));
      setItemId(m.get('work_order_qb_item_id') || '');
      setItemName(m.get('work_order_qb_item_name') || '');
      setFactorUrl(m.get('factoring_webhook_url') || '');
      setFactorKey(m.get('factoring_api_key') || '');
      setAiKey(m.get('anthropic_api_key') || '');
      setMapsKey(m.get('google_maps_api_key') || '');
      setTwilioSid(m.get('twilio_account_sid') || '');
      setTwilioToken(m.get('twilio_auth_token') || '');
      setTwilioFrom(m.get('twilio_from_number') || '');
      setEverSavedUrl(!!(m.get('factoring_webhook_url') || '').trim());
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
        setIsMaster(me?.role === 'master_admin');
      }
      await loadRates();
      // The QuickBooks catalog is only reachable through the server route.
      try {
        const res = await fetch('/api/quickbooks/items', { cache: 'no-store' });
        const json = await res.json();
        if (json.ok) setItems((json.items as QBItem[]) || []);
        else setItemsError(json.error || 'Could not read the QuickBooks catalog.');
      } catch {
        setItemsError('Could not reach QuickBooks.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadRates() {
    const { data } = await supabase
      .from('job_rates')
      .select('id, job_number, phase_code, description, rate, rate_unit, active')
      .order('job_number');
    setRates((data as Rate[]) || []);
  }

  async function saveItem(id: string) {
    const picked = items.find((i) => i.id === id);
    setItemId(id);
    setItemName(picked?.name || '');
    setSavedItem(false);
    await supabase.from('app_settings').upsert([
      { key: 'work_order_qb_item_id', value: id },
      { key: 'work_order_qb_item_name', value: picked?.name || '' },
    ], { onConflict: 'key' });
    setSavedItem(true);
    setTimeout(() => setSavedItem(false), 1500);
  }

  async function saveFactoring() {
    setSavedFactor(false); setPing(null);
    await supabase.from('app_settings').upsert([
      { key: 'factoring_webhook_url', value: factorUrl.trim() },
      { key: 'factoring_api_key', value: factorKey.trim() },
    ], { onConflict: 'key' });
    setSavedFactor(true);
    setEverSavedUrl(!!factorUrl.trim());
    setTimeout(() => setSavedFactor(false), 1500);
  }

  async function saveAi() {
    setSavedAi(false);
    await supabase.from('app_settings').upsert([
      { key: 'anthropic_api_key', value: aiKey.trim() },
    ], { onConflict: 'key' });
    setSavedAi(true);
    setTimeout(() => setSavedAi(false), 1500);
  }

  async function saveMaps() {
    setSavedMaps(false);
    await supabase.from('app_settings').upsert([
      { key: 'google_maps_api_key', value: mapsKey.trim() },
    ], { onConflict: 'key' });
    setSavedMaps(true);
    setTimeout(() => setSavedMaps(false), 1500);
  }

  async function saveTwilio() {
    setSavedTwilio(false);
    await supabase.from('app_settings').upsert([
      { key: 'twilio_account_sid', value: twilioSid.trim() },
      { key: 'twilio_auth_token', value: twilioToken.trim() },
      { key: 'twilio_from_number', value: twilioFrom.trim() },
    ], { onConflict: 'key' });
    setSavedTwilio(true);
    setTimeout(() => setSavedTwilio(false), 1500);
  }

  async function testFactoring() {
    setPingBusy(true); setPing(null);
    try {
      const res = await fetch('/api/factoring/ping', { method: 'POST' });
      setPing(await res.json());
    } catch {
      setPing({ ok: false, message: 'Couldn’t reach Auto 1 Funding: network error.' });
    } finally {
      setPingBusy(false);
    }
  }

  async function addRate() {
    setRateError('');
    const job = newRate.job_number.trim();
    const amount = Number(newRate.rate);
    if (!job) { setRateError('Enter the job number.'); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setRateError('Enter the rate.'); return; }
    const { error } = await supabase.from('job_rates').insert({
      job_number: job,
      phase_code: newRate.phase_code.trim() || null,
      description: newRate.description.trim() || null,
      rate: amount,
      rate_unit: newRate.rate_unit,
    });
    if (error) { setRateError(error.message); return; }
    setNewRate({ job_number: '', phase_code: '', description: '', rate: '', rate_unit: 'hour' });
    await loadRates();
  }

  async function removeRate(id: string) {
    await supabase.from('job_rates').delete().eq('id', id);
    await loadRates();
  }

  const input = 'px-2.5 py-1.5 border border-gray-300 rounded-md text-sm';

  return (
    <div>
      <AdminSubNav
        tabs={[
          { href: '/work-orders', label: 'All tickets' },
          { href: '/work-orders/approve', label: 'Approve' },
          { href: '/work-orders/setup', label: 'Setup' },
        ]}
        roles={['office', 'admin', 'master_admin']}
      />
      <h1 className="text-2xl font-semibold mb-4">Work order setup</h1>

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">QuickBooks item</h2>
        <p className="text-xs text-gray-500 mb-3">
          Every approved ticket bills one line against this item — hours (or tonnage) × the ticket&apos;s rate.
        </p>
        {itemsError ? (
          <p className="text-sm text-red-600">{itemsError}</p>
        ) : (
          <select value={itemId} onChange={(e) => saveItem(e.target.value)} className={`${input} w-full max-w-md`}>
            <option value="">— Pick an item —</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}
        {itemId && <p className="text-xs text-gray-500 mt-2">Billing as <strong>{itemName || itemId}</strong>.</p>}
        {savedItem && <p className="text-xs text-emerald-700 mt-1">Saved ✓</p>}
      </div>

      {isMaster && (
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Factoring app</h2>
        <p className="text-xs text-gray-500 mb-3">
          When a hauler completes a ticket as <strong>Factor Payment</strong> and the office
          approves it, the ticket is sent here as approved and ready to fund. Paste the
          endpoint the factoring app gave you; leave it blank and factor tickets simply
          wait until it&apos;s connected.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
          <label className="text-xs text-gray-600 sm:col-span-2">Endpoint URL
            <input value={factorUrl} onChange={(e) => setFactorUrl(e.target.value)}
              placeholder="https://…" className={`${input} w-full block mt-1`} />
          </label>
          <label className="text-xs text-gray-600 sm:col-span-2">API key (if they gave you one)
            <input value={factorKey} onChange={(e) => setFactorKey(e.target.value)}
              type="password" autoComplete="off" className={`${input} w-full block mt-1`} />
          </label>
        </div>
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <button onClick={saveFactoring} className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium">
            Save
          </button>
          <button
            onClick={testFactoring}
            disabled={pingBusy || !everSavedUrl}
            title={everSavedUrl ? undefined : 'Save an endpoint first'}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 font-medium"
          >
            {pingBusy ? 'Testing…' : 'Test connection'}
          </button>
          {savedFactor && <span className="text-xs text-emerald-700">Saved ✓</span>}
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          The test checks what&apos;s <strong>saved</strong> — hit Save first if you just changed something.
        </p>
        {ping && (
          <p className={`mt-2 text-sm font-medium ${ping.ok ? 'text-emerald-700' : 'text-red-600'}`}>
            {ping.ok ? '✓' : '✗'} {ping.message}
          </p>
        )}
      </div>
      )}

      {isMaster && (
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Scan &amp; fill (AI)</h2>
        <p className="text-xs text-gray-500 mb-3">
          Lets the fleet pages read a photo — a registration card, a fuel
          receipt, a shop bill — and fill the form from it. Paste a Claude API
          key from console.anthropic.com; each scan costs a fraction of a cent
          on it. Leave it blank and the scan buttons simply say it&apos;s not
          set up.
        </p>
        <div className="grid grid-cols-1 gap-3 max-w-2xl">
          <label className="text-xs text-gray-600">Claude API key
            <input value={aiKey} onChange={(e) => setAiKey(e.target.value)}
              type="password" autoComplete="off" placeholder="sk-ant-…"
              className={`${input} w-full block mt-1`} />
          </label>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={saveAi} className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium">
            Save
          </button>
          {savedAi && <span className="text-xs text-emerald-700">Saved ✓</span>}
        </div>
      </div>
      )}

      {isMaster && (
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Trip mileage (Google Maps)</h2>
        <p className="text-xs text-gray-500 mb-3">
          Powers &quot;Calculate miles by state&quot; on the fleet trip form:
          Google finds the route, the app splits the miles by state for IFTA.
          Paste a Google Maps API key (console.cloud.google.com, with the
          Routes API enabled) — 10,000 routes a month are free, about half a
          cent each after. Leave it blank and the button simply says it&apos;s
          not set up.
        </p>
        <div className="grid grid-cols-1 gap-3 max-w-2xl">
          <label className="text-xs text-gray-600">Google Maps API key
            <input value={mapsKey} onChange={(e) => setMapsKey(e.target.value)}
              type="password" autoComplete="off" placeholder="AIza…"
              className={`${input} w-full block mt-1`} />
          </label>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={saveMaps} className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium">
            Save
          </button>
          {savedMaps && <span className="text-xs text-emerald-700">Saved ✓</span>}
        </div>
      </div>
      )}

      {isMaster && (
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-5">
        <h2 className="font-semibold mb-1">Text messages (Twilio)</h2>
        <p className="text-xs text-gray-500 mb-3">
          Texts the hauler&apos;s people when loads are sent out, on top of the
          in-app notification and the push. Needs a Twilio account
          (twilio.com): the Account SID and Auth Token from the Console
          dashboard, and the Twilio phone number texts come from. Texts go to
          the phone numbers on people&apos;s profiles — no number on file, no
          text. Leave these blank and the app simply doesn&apos;t text.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
          <label className="text-xs text-gray-600 sm:col-span-2">Account SID
            <input value={twilioSid} onChange={(e) => setTwilioSid(e.target.value)}
              autoComplete="off" placeholder="AC…" className={`${input} w-full block mt-1`} />
          </label>
          <label className="text-xs text-gray-600">Auth Token
            <input value={twilioToken} onChange={(e) => setTwilioToken(e.target.value)}
              type="password" autoComplete="off" className={`${input} w-full block mt-1`} />
          </label>
          <label className="text-xs text-gray-600">From number
            <input value={twilioFrom} onChange={(e) => setTwilioFrom(e.target.value)}
              placeholder="+1801…" className={`${input} w-full block mt-1`} />
          </label>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={saveTwilio} className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium">
            Save
          </button>
          {savedTwilio && <span className="text-xs text-emerald-700">Saved ✓</span>}
        </div>
      </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="font-semibold mb-1">Job rates</h2>
        <p className="text-xs text-gray-500 mb-3">
          What each job pays. The ticket form offers the matching rate so the crew doesn&apos;t have to
          remember it, and contractors see this list on their Rates tab.
        </p>

        <div className="flex flex-wrap gap-2 items-end mb-3">
          <label className="text-xs text-gray-600">Job #
            <input value={newRate.job_number} onChange={(e) => setNewRate({ ...newRate, job_number: e.target.value })} className={`${input} w-28 block mt-1`} />
          </label>
          <label className="text-xs text-gray-600">Phase
            <input value={newRate.phase_code} onChange={(e) => setNewRate({ ...newRate, phase_code: e.target.value })} className={`${input} w-24 block mt-1`} />
          </label>
          <label className="text-xs text-gray-600">Description
            <input value={newRate.description} onChange={(e) => setNewRate({ ...newRate, description: e.target.value })} className={`${input} w-48 block mt-1`} />
          </label>
          <label className="text-xs text-gray-600">Rate
            <input type="number" step="0.01" min="0" value={newRate.rate} onChange={(e) => setNewRate({ ...newRate, rate: e.target.value })} className={`${input} w-24 block mt-1 text-right`} />
          </label>
          <label className="text-xs text-gray-600">Per
            <select value={newRate.rate_unit} onChange={(e) => setNewRate({ ...newRate, rate_unit: e.target.value })} className={`${input} block mt-1`}>
              {RATE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
          <button onClick={addRate} className="px-3 py-1.5 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium">
            Add
          </button>
        </div>
        {rateError && <p className="text-xs text-red-600 mb-2">{rateError}</p>}

        {rates.length === 0 ? (
          <p className="text-sm text-gray-500">No rates set yet.</p>
        ) : (
          <div className="border border-gray-200 rounded-md divide-y divide-gray-100">
            {rates.map((r) => (
              <div key={r.id} className="px-3 py-2 flex justify-between items-center gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">Job {r.job_number}</span>
                  {r.phase_code ? <span className="text-gray-500"> · phase {r.phase_code}</span> : null}
                  {r.description ? <span className="block text-xs text-gray-500 truncate">{r.description}</span> : null}
                </span>
                <span className="shrink-0 tabular-nums">${Number(r.rate).toFixed(2)}/{r.rate_unit}</span>
                <button onClick={() => removeRate(r.id)} className="shrink-0 text-xs text-red-600 hover:underline">Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
