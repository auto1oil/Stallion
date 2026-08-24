'use client';

// Card Charges — company credit-card charges (Chase now, WEX later) pulled from
// Plaid, attributed to a driver, and reconciled against receipts read from the
// fuel/vehicle app. The headline is the "missing receipt" list: charges nobody
// has a receipt for. Drivers keep uploading receipts in the other app; nothing
// is uploaded twice here (the manual attach is only a fallback).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

type Charge = {
  id: string;
  source: 'plaid' | 'manual' | 'quickbooks' | 'oneglovebox';
  card_last4: string | null;
  cardholder_name: string | null;
  merchant: string | null;
  amount: number | null;
  charge_date: string | null;
  driver_id: string | null;
  receipt_status: 'missing' | 'matched' | 'na' | 'submitted';
  receipt_url: string | null;
  receipt_source: 'external_app' | 'upload' | null;
  receipt_matched_at: string | null;
  receipt_note: string | null;
  receipt_vendor: string | null;
  receipt_submitted_at: string | null;
  reviewed: boolean;
  notes: string | null;
  created_at: string;
};

type Driver = { id: string; full_name: string | null; email: string; role: string };
type CardMap = { id: string; card_last4: string; cardholder_name: string; driver_id: string | null; label: string | null };
type PlaidItem = { id: string; institution_name: string | null; created_at: string };

type SyncState = { plaid: boolean; receipts: boolean; quickbooks?: boolean } | null;
type CardAssignment = { id: string; card_last4: string; card_type: string; truck_label: string | null; driver_id: string | null; effective_from: string };

const EMPTY_NEW = { merchant: '', amount: '', charge_date: '', card_last4: '', driver_id: '' };

// Card type → badge label + colors. truck (rotates by driver), driver (one
// permanent driver's misc card), admin (company/office card held by an admin).
const CARD_TYPE_LABEL: Record<string, string> = { truck: 'Truck card', driver: 'Driver card', admin: 'Admin card' };
const CARD_TYPE_BADGE: Record<string, string> = {
  truck: 'bg-blue-100 text-blue-800',
  driver: 'bg-purple-100 text-purple-800',
  admin: 'bg-amber-100 text-amber-800',
};

// Plaid Link is loaded from Plaid's CDN on demand (their script is not bundled).
type PlaidHandler = { open: () => void; exit: () => void };
type PlaidSuccessMeta = { institution?: { name?: string } | null };
type PlaidExitErr = { display_message?: string; error_message?: string } | null;
type PlaidLink = {
  create: (opts: {
    token: string;
    onSuccess: (publicToken: string, metadata: PlaidSuccessMeta) => void;
    onExit: (err: PlaidExitErr) => void;
  }) => PlaidHandler;
};

function loadPlaid(): Promise<PlaidLink> {
  const w = window as unknown as { Plaid?: PlaidLink };
  if (w.Plaid) return Promise.resolve(w.Plaid);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.onload = () => {
      const loaded = (window as unknown as { Plaid?: PlaidLink }).Plaid;
      loaded ? resolve(loaded) : reject(new Error('Plaid failed to load'));
    };
    s.onerror = () => reject(new Error('Plaid failed to load'));
    document.body.appendChild(s);
  });
}

export default function CardChargesPage() {
  const supabase = createClient();
  const [charges, setCharges] = useState<Charge[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [maps, setMaps] = useState<CardMap[]>([]);
  const [assignments, setAssignments] = useState<CardAssignment[]>([]);
  const [qbAccounts, setQbAccounts] = useState<{ id: string; name: string }[]>([]);
  const [selectedAccts, setSelectedAccts] = useState<Set<string>>(new Set());
  const [expenseAccount, setExpenseAccount] = useState('APP Receipts Pending');
  const [plaidItems, setPlaidItems] = useState<PlaidItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'missing' | 'submitted' | 'matched' | 'all'>('missing');
  const [filterDriver, setFilterDriver] = useState<string>(''); // '' = all, 'unassigned', or a driver id
  const [editAmtId, setEditAmtId] = useState<string | null>(null);
  const [amtDraft, setAmtDraft] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDriver, setBulkDriver] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [viewer, setViewer] = useState<{ url: string; title: string; isImage: boolean } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [configured, setConfigured] = useState<SyncState>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_NEW });
  const [showAdd, setShowAdd] = useState(false);

  const driverName = useCallback(
    (id: string | null) => {
      if (!id) return '';
      const d = drivers.find((x) => x.id === id);
      return d ? (d.full_name || d.email) : '';
    },
    [drivers],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const [c, d, m, p, a] = await Promise.all([
      supabase
        .from('card_charges')
        .select('id, source, card_last4, cardholder_name, merchant, amount, charge_date, driver_id, receipt_status, receipt_url, receipt_source, receipt_matched_at, receipt_note, receipt_vendor, receipt_submitted_at, reviewed, notes, created_at')
        .order('charge_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false }),
      supabase
        .from('profiles')
        .select('id, full_name, email, role')
        .neq('role', 'customer')
        .order('full_name'),
      supabase
        .from('card_driver_map')
        .select('id, card_last4, cardholder_name, driver_id, label')
        .order('card_last4'),
      // Never select access_token — connected cards list is safe fields only.
      supabase
        .from('plaid_items')
        .select('id, institution_name, created_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('card_assignments')
        .select('id, card_last4, card_type, truck_label, driver_id, effective_from')
        .order('effective_from', { ascending: false }),
    ]);
    if (c.error) setErr(c.error.message);
    else setCharges((c.data || []) as Charge[]);
    setDrivers((d.data || []) as Driver[]);
    setMaps((m.data || []) as CardMap[]);
    if (!p.error) setPlaidItems((p.data || []) as PlaidItem[]);
    if (!a.error) setAssignments((a.data || []) as CardAssignment[]);
    setLoading(false);
  }, [supabase]);

  // QuickBooks credit-card accounts + which one(s) charges sync from.
  useEffect(() => {
    (async () => {
      const { data: setting } = await supabase.from('app_settings').select('value').eq('key', 'card_charge_account_ids').maybeSingle();
      const ids = String((setting?.value as string) || '').split(',').map((s) => s.trim()).filter(Boolean);
      setSelectedAccts(new Set(ids));
      const { data: expS } = await supabase.from('app_settings').select('value').eq('key', 'card_charge_expense_account').maybeSingle();
      if (expS != null) setExpenseAccount(String((expS.value as string) || ''));
      try {
        const j = await fetch('/api/admin/card-charges/qb-accounts').then((r) => r.json());
        if (j.ok) setQbAccounts(j.accounts as { id: string; name: string }[]);
      } catch { /* QB not connected — panel just won't show */ }
    })();
  }, [supabase]);

  async function toggleAcct(id: string, on: boolean) {
    const next = new Set(selectedAccts);
    if (on) next.add(id); else next.delete(id);
    setSelectedAccts(next);
    await supabase.from('app_settings').upsert({ key: 'card_charge_account_ids', value: Array.from(next).join(',') }, { onConflict: 'key' });
  }
  async function setAccts(ids: string[]) {
    setSelectedAccts(new Set(ids));
    await supabase.from('app_settings').upsert({ key: 'card_charge_account_ids', value: ids.join(',') }, { onConflict: 'key' });
  }
  async function saveExpenseAccount(v: string) {
    setExpenseAccount(v);
    await supabase.from('app_settings').upsert({ key: 'card_charge_expense_account', value: v.trim() }, { onConflict: 'key' });
  }
  // Accounts whose name carries a 4-digit card number = the individual cards
  // (not the parent "Company Credit Card" rollup).
  const cardAccts = useMemo(() => qbAccounts.filter((a) => /(\d{4})(?!.*\d)/.test(a.name)), [qbAccounts]);

  useEffect(() => { void load(); }, [load]);

  async function sync() {
    setSyncing(true); setErr(null); setSyncMsg(null);
    try {
      const res = await fetch('/api/admin/card-charges/sync', { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Sync failed'); return; }
      setConfigured(json.configured);
      const newCount = (json.pulled || 0) + (json.qbPulled || 0);
      setSyncMsg(
        `Pulled ${newCount} new charge${newCount === 1 ? '' : 's'}, matched ${json.matched} to receipts. ${json.missing} still missing a receipt.`,
      );
      if (json.qbError) setErr(`QuickBooks pull error: ${json.qbError}`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  // Open Plaid Link to connect a card. On success we exchange the token
  // server-side, then run a sync so its charges show up immediately.
  async function connectCard() {
    setConnecting(true); setErr(null); setSyncMsg(null);
    try {
      const res = await fetch('/api/admin/plaid/link-token', { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setErr(json.error || 'Could not start Plaid'); return; }
      const Plaid = await loadPlaid();
      const handler = Plaid.create({
        token: json.link_token,
        onSuccess: async (publicToken, metadata) => {
          setErr(null);
          const ex = await fetch('/api/admin/plaid/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ public_token: publicToken, institution_name: metadata?.institution?.name }),
          });
          const exj = await ex.json();
          if (!ex.ok || !exj.ok) { setErr(exj.error || 'Could not link card'); return; }
          await load();
          void sync();
        },
        onExit: (err) => { if (err) setErr(err.display_message || err.error_message || null); },
      });
      handler.open();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start Plaid');
    } finally {
      setConnecting(false);
    }
  }

  async function disconnectCard(id: string) {
    if (!confirm('Disconnect this card? New charges from it will stop importing.')) return;
    const { error } = await supabase.from('plaid_items').delete().eq('id', id);
    if (error) { setErr(error.message); return; }
    setPlaidItems((prev) => prev.filter((p) => p.id !== id));
  }

  async function patch(id: string, fields: Partial<Charge>) {
    const { error } = await supabase.from('card_charges').update(fields).eq('id', id);
    if (error) { setErr(error.message); return; }
    setCharges((prev) => prev.map((c) => (c.id === id ? { ...c, ...fields } : c)));
  }

  // Bulk-attribute the checked charges to one driver's queue in a single update —
  // for cards with no last-4 (unidentifiable in QB), you look the charges up in
  // the bank, tick the ones that are Kyle's, pick Kyle, and they land in his
  // missing-receipts queue. Assigning null clears them back to unassigned.
  function toggleSelect(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }
  async function assignSelected(driverId: string) {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBulkBusy(true); setErr(null);
    const { error } = await supabase.from('card_charges').update({ driver_id: driverId || null }).in('id', ids);
    setBulkBusy(false);
    if (error) { setErr(error.message); return; }
    const pick = new Set(ids);
    setCharges((prev) => prev.map((c) => (pick.has(c.id) ? { ...c, driver_id: driverId || null } : c)));
    setSelected(new Set());
    setBulkDriver('');
  }
  // Permanently remove charges (e.g. junk pulled from a deleted/renamed QB
  // account). Admins only — RLS enforces it too.
  async function deleteSelected() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} charge${ids.length === 1 ? '' : 's'}? This can't be undone.`)) return;
    setBulkBusy(true); setErr(null);
    const { error } = await supabase.from('card_charges').delete().in('id', ids);
    setBulkBusy(false);
    if (error) { setErr(error.message); return; }
    const gone = new Set(ids);
    setCharges((prev) => prev.filter((c) => !gone.has(c.id)));
    setSelected(new Set());
  }
  // Manually nudge drivers about the selected charges: one push + bell
  // notification per driver (grouped), sent via notify_recipients. Their app
  // already shows the standing banner; this is the "hey, do it now" poke.
  async function sendReminders() {
    const chosen = charges.filter((c) => selected.has(c.id));
    const byDriver = new Map<string, number>();
    for (const c of chosen) if (c.driver_id) byDriver.set(c.driver_id, (byDriver.get(c.driver_id) || 0) + 1);
    if (byDriver.size === 0) { setErr('None of the selected charges are assigned to a driver yet — assign them first.'); return; }
    setBulkBusy(true); setErr(null);
    let sent = 0;
    for (const [driverId, count] of byDriver) {
      const { error } = await supabase.rpc('notify_recipients', {
        recipient_ids: [driverId],
        p_kind: 'card_receipt',
        p_title: 'Upload your receipts',
        p_body: `You have ${count} card charge${count === 1 ? '' : 's'} missing a receipt. Please upload ${count === 1 ? 'it' : 'them'} to OneGloveBox.`,
        p_link: '/driver',
      });
      if (error) { setErr(error.message); break; }
      sent++;
    }
    setBulkBusy(false);
    if (sent > 0) {
      setSyncMsg(`Reminder sent to ${sent} ${sent === 1 ? 'driver' : 'drivers'}.`);
      setSelected(new Set());
    }
  }
  async function deleteCharge(id: string) {
    if (!confirm('Delete this charge? This can’t be undone.')) return;
    setErr(null);
    const { error } = await supabase.from('card_charges').delete().eq('id', id);
    if (error) { setErr(error.message); return; }
    setCharges((prev) => prev.filter((c) => c.id !== id));
    setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
  }

  // Update every charge on a card to the driver who had that card's truck on the
  // charge's date (latest effective_from <= charge_date). `list` is newest-first.
  async function recomputeCard(card_last4: string, list: CardAssignment[]) {
    const forCard = list.filter((x) => x.card_last4 === card_last4); // newest-first
    const driverAt = (date: string | null): string | null => {
      if (!forCard.length) return null;
      if (date) {
        const hit = forCard.find((x) => x.effective_from <= date);
        if (hit) return hit.driver_id ?? null;
      }
      // Charge predates every assignment → earliest assignment covers it.
      return forCard[forCard.length - 1].driver_id ?? null;
    };
    const updates: { id: string; driver_id: string | null }[] = [];
    for (const ch of charges) {
      if (ch.card_last4 !== card_last4) continue;
      const want = driverAt(ch.charge_date);
      if (want && want !== ch.driver_id) updates.push({ id: ch.id, driver_id: want });
    }
    for (const u of updates) await supabase.from('card_charges').update({ driver_id: u.driver_id }).eq('id', u.id);
    if (updates.length) {
      setCharges((prev) => prev.map((ch) => {
        const u = updates.find((x) => x.id === ch.id);
        return u ? { ...ch, driver_id: u.driver_id } : ch;
      }));
    }
  }
  async function addAssignment(card_last4: string, driver_id: string, effective_from: string, truck_label: string, card_type: string) {
    const { data, error } = await supabase.from('card_assignments')
      .insert({ card_last4, driver_id: driver_id || null, effective_from, truck_label: card_type === 'truck' ? (truck_label.trim() || null) : null, card_type })
      .select('id, card_last4, card_type, truck_label, driver_id, effective_from').single();
    if (error) { setErr(error.message); return; }
    const next = [...assignments, data as CardAssignment].sort((x, y) => y.effective_from.localeCompare(x.effective_from));
    setAssignments(next);
    await recomputeCard(card_last4, next);
  }
  async function deleteAssignment(id: string, card_last4: string) {
    const { error } = await supabase.from('card_assignments').delete().eq('id', id);
    if (error) { setErr(error.message); return; }
    const next = assignments.filter((x) => x.id !== id);
    setAssignments(next);
    await recomputeCard(card_last4, next);
  }
  const cardList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ch of charges) if (ch.card_last4) counts.set(ch.card_last4, (counts.get(ch.card_last4) || 0) + 1);
    for (const a of assignments) if (a.card_last4 && !counts.has(a.card_last4)) counts.set(a.card_last4, 0);
    // Also list every linked QuickBooks card account (last-4 in the name), even
    // with 0 charges, so you can assign a driver ahead of any charges arriving.
    for (const acct of cardAccts) {
      const last4 = acct.name.match(/(\d{4})(?!.*\d)/)?.[1];
      if (last4 && !counts.has(last4)) counts.set(last4, 0);
    }
    return Array.from(counts.entries()).map(([last4, count]) => ({ last4, count })).sort((x, y) => x.last4.localeCompare(y.last4));
  }, [charges, assignments, cardAccts]);

  // Attach a receipt straight into Auto 1 (fallback — normally receipts come
  // from the other app). Uploads to the card-receipts bucket and marks matched.
  async function attach(charge: Charge, file: File) {
    setErr(null);
    const path = `${(charge.charge_date || '').slice(0, 4) || 'misc'}/${crypto.randomUUID()}-${file.name}`;
    const up = await supabase.storage.from('card-receipts').upload(path, file);
    if (up.error) { setErr(up.error.message); return; }
    await patch(charge.id, {
      receipt_status: 'matched',
      receipt_source: 'upload',
      receipt_url: up.data.path,
    });
  }

  async function openReceipt(charge: Charge) {
    if (!charge.receipt_url) return;
    const title = charge.merchant || 'Receipt';
    // Image vs PDF drives how we render it (fit-to-view <img> vs iframe).
    const isImage = /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test((charge.receipt_url || '').split('?')[0]);
    setZoomed(false);
    // External-app receipts are already full URLs; uploads are storage paths.
    if (charge.receipt_source === 'external_app' || /^https?:\/\//.test(charge.receipt_url)) {
      setViewer({ url: charge.receipt_url, title, isImage });
      return;
    }
    const { data, error } = await supabase.storage.from('card-receipts').createSignedUrl(charge.receipt_url, 300);
    if (error || !data) { setErr(error?.message || 'Could not open receipt'); return; }
    setViewer({ url: data.signedUrl, title, isImage });
  }

  async function addCharge(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true); setErr(null);
    try {
      const { error } = await supabase.from('card_charges').insert({
        source: 'manual',
        merchant: form.merchant || null,
        amount: form.amount ? Number(form.amount) : null,
        charge_date: form.charge_date || null,
        card_last4: form.card_last4 || null,
        driver_id: form.driver_id || null,
        receipt_status: 'missing',
      });
      if (error) { setErr(error.message); return; }
      setForm({ ...EMPTY_NEW });
      await load();
    } finally {
      setAdding(false);
    }
  }

  async function addMap(card_last4: string, cardholder_name: string, driver_id: string, label: string) {
    const { data, error } = await supabase
      .from('card_driver_map')
      .insert({ card_last4: card_last4.trim(), cardholder_name: cardholder_name.trim(), driver_id: driver_id || null, label: label.trim() || null })
      .select('id, card_last4, cardholder_name, driver_id, label')
      .single();
    if (error) { setErr(error.message); return; }
    setMaps((prev) => [...prev, data as CardMap].sort((a, b) => a.card_last4.localeCompare(b.card_last4)));
  }
  async function updateMap(id: string, fields: Partial<CardMap>) {
    const { error } = await supabase.from('card_driver_map').update(fields).eq('id', id);
    if (error) { setErr(error.message); return; }
    setMaps((prev) => prev.map((m) => (m.id === id ? { ...m, ...fields } : m)));
  }
  async function deleteMap(id: string) {
    if (!confirm('Remove this card mapping?')) return;
    const { error } = await supabase.from('card_driver_map').delete().eq('id', id);
    if (error) { setErr(error.message); return; }
    setMaps((prev) => prev.filter((m) => m.id !== id));
  }

  const money = (n: number | null) =>
    n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const missing = charges.filter((c) => c.receipt_status === 'missing');
  const submitted = charges.filter((c) => c.receipt_status === 'submitted');
  const matched = charges.filter((c) => c.receipt_status === 'matched');
  const visible = charges.filter((c) => {
    if (filter === 'missing' && c.receipt_status !== 'missing') return false;
    if (filter === 'submitted' && c.receipt_status !== 'submitted') return false;
    if (filter === 'matched' && c.receipt_status !== 'matched') return false;
    if (filterDriver === 'unassigned' && c.driver_id) return false;
    if (filterDriver && filterDriver !== 'unassigned' && c.driver_id !== filterDriver) return false;
    return true;
  });
  const missingTotal = missing.reduce((s, c) => s + (c.amount || 0), 0);

  // Show the setup banner only once a sync has told us something's unwired.
  // Bank charges come from QuickBooks (or Plaid); receipts (the driver's
  // explanation) come from OneGloveBox via RECEIPTS_API_URL/KEY.
  const bankConnected = !!(configured && (configured.plaid || configured.quickbooks));
  const needsSetup = configured && (!bankConnected || !configured.receipts);

  return (
    <div>
      <div className="flex items-start justify-between gap-2 mb-1">
        <h1 className="text-xl font-semibold">Card charges</h1>
        <div className="flex gap-2 shrink-0">
          <button onClick={connectCard} disabled={connecting}
            className="px-3 py-1.5 text-sm rounded-md border border-brand-600 text-brand-700 disabled:opacity-50 whitespace-nowrap font-medium">
            {connecting ? 'Opening…' : '+ Connect a card'}
          </button>
          <button onClick={sync} disabled={syncing}
            className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white disabled:opacity-50 whitespace-nowrap font-medium">
            {syncing ? 'Syncing…' : '↻ Sync charges'}
          </button>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Company card charges pulled from the bank, each attributed to a driver and matched to a receipt
        from the fuel app. Anything without a receipt shows up in the Missing list.
      </p>

      {needsSetup && (
        <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">
          <div className="font-medium mb-0.5">Finish connecting the sources:</div>
          <ul className="list-disc ml-5 space-y-0.5">
            {!bankConnected && (
              <li>Bank charges not connected — connect QuickBooks (the feed of what actually hit the cards).</li>
            )}
            {!configured?.receipts && (
              <li>Driver receipts (OneGloveBox) not connected — set <span className="font-mono">RECEIPTS_API_URL</span> and <span className="font-mono">RECEIPTS_API_KEY</span> to the OneGloveBox <span className="font-mono">/api/receipts</span> endpoint.</li>
            )}
          </ul>
        </div>
      )}

      {/* Headline: how much is unaccounted for. */}
      <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3 flex items-baseline justify-between">
        <span className="text-sm text-gray-500">Missing receipts</span>
        <span className="text-2xl font-semibold">
          {money(missingTotal)}
          <span className="text-sm font-normal text-gray-400 ml-2">
            {missing.length} charge{missing.length === 1 ? '' : 's'}
          </span>
        </span>
      </div>

      {syncMsg && (
        <div className="mb-3 rounded-md bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">
          {syncMsg}
        </div>
      )}
      {err && (
        <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">
          {err}
        </div>
      )}

      {/* Connected sources. */}
      {(plaidItems.length > 0 || configured?.receipts || configured?.quickbooks) && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">Connected:</span>
          {configured?.quickbooks && (
            <span className="inline-flex items-center gap-1.5 text-xs rounded-full bg-green-100 text-green-800 px-2.5 py-1">
              QuickBooks charges ✓
            </span>
          )}
          {configured?.receipts && (
            <span className="inline-flex items-center gap-1.5 text-xs rounded-full bg-green-100 text-green-800 px-2.5 py-1">
              OneGloveBox receipts ✓
            </span>
          )}
          {plaidItems.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1.5 text-xs rounded-full bg-gray-100 text-gray-700 px-2.5 py-1">
              {p.institution_name || 'Bank'}
              <button onClick={() => disconnectCard(p.id)} title="Disconnect"
                className="text-gray-400 hover:text-red-600">✕</button>
            </span>
          ))}
        </div>
      )}

      {/* Which QuickBooks credit-card account(s) to pull charges from. */}
      {qbAccounts.length > 0 && (
        <details className="mb-4 rounded-lg border border-gray-200 bg-white">
          <summary className="px-3 py-2 text-sm font-medium cursor-pointer list-none flex items-center justify-between">
            <span>Sync from QuickBooks accounts
              <span className="text-gray-400 font-normal"> · {selectedAccts.size ? `${selectedAccts.size} selected` : 'all accounts'}</span>
            </span>
          </summary>
          <div className="border-t border-gray-100 px-3 py-2">
            <div className="mb-3 pb-3 border-b border-gray-100">
              <label className="block text-xs font-medium text-gray-700 mb-1">Only pull charges booked to this account</label>
              <input
                value={expenseAccount}
                onChange={(e) => setExpenseAccount(e.target.value)}
                onBlur={(e) => saveExpenseAccount(e.target.value)}
                placeholder="APP Receipts Pending"
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
              <p className="text-xs text-gray-500 mt-1">
                The QuickBooks holding account your auto-add rule dumps card charges into. Only charges categorized here get pulled in as “missing receipts.” Leave blank to pull every credit-card charge.
              </p>
            </div>
            <p className="text-xs text-gray-500 mb-2">And only from the <span className="font-medium">checked</span> card accounts below. Leave all unchecked to allow every credit-card account.</p>
            <div className="flex gap-2 mb-2">
              <button type="button" onClick={() => setAccts(cardAccts.map((a) => a.id))}
                className="text-xs px-2 py-1 rounded border border-brand-600 text-brand-700 hover:bg-brand-50">
                Select card accounts ({cardAccts.length})
              </button>
              <button type="button" onClick={() => setAccts([])}
                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
                Clear
              </button>
            </div>
            <div className="space-y-0.5 max-h-64 overflow-y-auto">
              {qbAccounts.map((acct) => (
                <label key={acct.id} className="flex items-center gap-2 text-sm py-0.5">
                  <input type="checkbox" checked={selectedAccts.has(acct.id)} onChange={(e) => toggleAcct(acct.id, e.target.checked)} />
                  {acct.name}
                </label>
              ))}
            </div>
          </div>
        </details>
      )}

      {/* Cards -> drivers (time-aware: each card is a truck; the driver changes
          over time, so charges attribute by date). */}
      <CardAssignPanel cards={cardList} assignments={assignments} drivers={drivers}
        onAdd={addAssignment} onDelete={deleteAssignment} driverName={driverName} />

      {/* Manual add — fallback for a charge Plaid didn't pull. */}
      <div className="mb-4">
        <button onClick={() => setShowAdd((s) => !s)} className="text-sm text-brand-700 hover:underline">
          {showAdd ? '– Hide manual add' : '+ Add a charge manually'}
        </button>
        {showAdd && (
          <form onSubmit={addCharge} className="mt-2 rounded-lg border border-gray-200 bg-white p-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <input className="border rounded px-2 py-1.5 text-sm" placeholder="Merchant"
                value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} />
              <input className="border rounded px-2 py-1.5 text-sm" placeholder="Amount" inputMode="decimal"
                value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              <input className="border rounded px-2 py-1.5 text-sm" placeholder="Card last 4"
                value={form.card_last4} onChange={(e) => setForm({ ...form, card_last4: e.target.value })} />
              <label className="text-xs text-gray-500 flex flex-col">Date
                <input type="date" className="border rounded px-2 py-1 text-sm"
                  value={form.charge_date} onChange={(e) => setForm({ ...form, charge_date: e.target.value })} />
              </label>
              <select className="border rounded px-2 py-1.5 text-sm"
                value={form.driver_id} onChange={(e) => setForm({ ...form, driver_id: e.target.value })}>
                <option value="">Driver…</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name || d.email}</option>)}
              </select>
            </div>
            <div className="flex justify-end mt-2">
              <button type="submit" disabled={adding}
                className="px-3 py-1.5 text-sm rounded-md bg-brand-600 text-white disabled:opacity-50">
                {adding ? 'Adding…' : 'Add charge'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Sub-tabs + driver filter. */}
      <div className="flex gap-2 mb-3 items-center flex-wrap">
        {([
          ['missing', 'Missing', missing.length],
          ['submitted', 'Submitted', submitted.length],
          ['matched', 'Matched', matched.length],
          ['all', 'All', charges.length],
        ] as const).map(([key, label, count]) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`px-3 py-1 text-sm rounded-md border ${
              filter === key ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium' : 'bg-white border-gray-300'
            }`}>
            {label}
            {count > 0 && (
              <span className={`ml-1.5 text-xs ${
                key === 'missing' ? 'inline-flex items-center justify-center min-w-[16px] h-4 px-1 font-bold bg-red-500 text-white rounded-full align-middle'
                : key === 'submitted' ? 'inline-flex items-center justify-center min-w-[16px] h-4 px-1 font-bold bg-amber-500 text-white rounded-full align-middle'
                : 'text-gray-500'}`}>
                {count}
              </span>
            )}
          </button>
        ))}
        <select
          value={filterDriver}
          onChange={(e) => setFilterDriver(e.target.value)}
          title="Filter by driver"
          className="sm:ml-auto border border-gray-300 rounded-md px-2 py-1 text-sm bg-white">
          <option value="">All drivers</option>
          <option value="unassigned">Unassigned</option>
          {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name || d.email}</option>)}
        </select>
        {visible.length > 0 && (
          <label className="text-xs text-gray-500 flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={visible.every((c) => selected.has(c.id))}
              ref={(el) => { if (el) el.indeterminate = visible.some((c) => selected.has(c.id)) && !visible.every((c) => selected.has(c.id)); }}
              onChange={(e) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) visible.forEach((c) => next.add(c.id));
                  else visible.forEach((c) => next.delete(c.id));
                  return next;
                });
              }}
            />
            Select all
          </label>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">
          {filter === 'missing'
            ? 'No charges are missing a receipt. Tap “Sync charges” to pull the latest.'
            : 'Nothing here yet.'}
        </p>
      ) : (
        <div className="space-y-2">
          {visible.map((c) => (
            <div key={c.id} className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={(e) => toggleSelect(c.id, e.target.checked)}
                    className="mt-1 shrink-0"
                    title="Select for bulk assign"
                  />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.merchant || '(no merchant)'}</div>
                    <div className="text-xs text-gray-500">
                      {c.charge_date || 'no date'}
                      {c.card_last4 ? ` · card ••${c.card_last4}` : ' · no card #'}
                      {c.source === 'manual' ? ' · manual' : ''}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {editAmtId === c.id ? (
                    <input
                      autoFocus
                      inputMode="decimal"
                      value={amtDraft}
                      onChange={(e) => setAmtDraft(e.target.value)}
                      onBlur={() => {
                        const t = amtDraft.trim();
                        const n = t === '' ? null : Number(t);
                        patch(c.id, { amount: n != null && Number.isFinite(n) ? n : null });
                        setEditAmtId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setEditAmtId(null);
                      }}
                      className="w-24 border rounded px-2 py-0.5 text-sm text-right font-semibold"
                    />
                  ) : (
                    <button
                      onClick={() => { setEditAmtId(c.id); setAmtDraft(c.amount != null ? String(c.amount) : ''); }}
                      title="Click to edit the amount"
                      className="font-semibold hover:underline decoration-dotted underline-offset-2">
                      {money(c.amount)}
                    </button>
                  )}
                  {c.receipt_status === 'matched' ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-800">receipt ✓</span>
                  ) : c.receipt_status === 'submitted' ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">submitted</span>
                  ) : c.receipt_status === 'na' ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">no receipt needed</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800">missing</span>
                  )}
                </div>
              </div>

              {/* Driver-submitted receipt details (awaiting hand-off to OneGloveBox). */}
              {/* Driver's vendor + explanation — kept visible after it moves to
                  matched, so you always see what the charge was for. */}
              {(c.receipt_vendor || c.receipt_note) && (c.receipt_status === 'submitted' || c.receipt_status === 'matched') && (
                <div className={`mt-2 text-xs rounded px-2 py-1.5 border ${c.receipt_status === 'submitted' ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-gray-50 border-gray-200 text-gray-700'}`}>
                  {c.receipt_vendor && <div><span className="font-semibold">Vendor:</span> {c.receipt_vendor}</div>}
                  {c.receipt_note && <div>“{c.receipt_note}”</div>}
                  {c.receipt_submitted_at && (
                    <div className="opacity-70">Submitted {new Date(c.receipt_submitted_at).toLocaleString()}{driverName(c.driver_id) ? ` by ${driverName(c.driver_id)}` : ''}</div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 mt-2">
                {/* Driver attribution. */}
                <select
                  value={c.driver_id || ''}
                  onChange={(e) => patch(c.id, { driver_id: e.target.value || null })}
                  className={`border rounded px-2 py-1 text-xs ${c.driver_id ? '' : 'border-amber-300 bg-amber-50'}`}>
                  <option value="">Unassigned…</option>
                  {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name || d.email}</option>)}
                </select>

                {(c.receipt_status === 'matched' || c.receipt_status === 'submitted') && c.receipt_url && (
                  <button onClick={() => openReceipt(c)} className="text-brand-600 text-xs underline">
                    View receipt
                  </button>
                )}

                {c.receipt_status === 'submitted' && (
                  <>
                    <button onClick={() => patch(c.id, { receipt_status: 'matched', receipt_matched_at: new Date().toISOString() })}
                      className="text-xs px-2 py-1 rounded bg-green-600 text-white font-medium">
                      ✓ Added to OneGloveBox
                    </button>
                    <button onClick={() => patch(c.id, { receipt_status: 'missing' })}
                      className="text-xs text-gray-500 underline">
                      Send back
                    </button>
                  </>
                )}

                {c.receipt_status !== 'matched' && c.receipt_status !== 'submitted' && (
                  <>
                    <label className="text-xs text-brand-700 underline cursor-pointer">
                      Attach receipt
                      <input type="file" accept="application/pdf,image/*" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(c, f); }} />
                    </label>
                    {c.receipt_status === 'missing' ? (
                      <button onClick={() => patch(c.id, { receipt_status: 'na' })}
                        className="text-xs text-gray-500 underline">
                        No receipt needed
                      </button>
                    ) : (
                      <button onClick={() => patch(c.id, { receipt_status: 'missing' })}
                        className="text-xs text-gray-500 underline">
                        Needs receipt
                      </button>
                    )}
                  </>
                )}
                <button onClick={() => deleteCharge(c.id)}
                  className="text-xs text-red-600 underline ml-auto">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bulk assign: tick charges (e.g. the unidentified ones you looked up in
          the bank), pick a driver, and drop them all into that driver's
          missing-receipts queue at once. */}
      {selected.size > 0 && (
        <div className="sticky bottom-2 mt-3 z-10">
          <div className="rounded-lg border border-brand-300 bg-white shadow-lg p-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{selected.size} selected</span>
            <button onClick={() => setSelected(new Set())} className="text-xs text-gray-500 underline">Clear</button>
            <button
              onClick={sendReminders}
              disabled={bulkBusy}
              className="text-xs px-2.5 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 whitespace-nowrap font-medium">
              🔔 Send reminder
            </button>
            <button
              onClick={deleteSelected}
              disabled={bulkBusy}
              className="text-xs px-2.5 py-1.5 rounded-md border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40 whitespace-nowrap font-medium">
              Delete
            </button>
            <div className="flex items-center gap-2 sm:ml-auto">
              <select
                value={bulkDriver}
                onChange={(e) => setBulkDriver(e.target.value)}
                className="border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white">
                <option value="">Assign to…</option>
                <option value="__clear__">Unassigned</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name || d.email}</option>)}
              </select>
              <button
                disabled={!bulkDriver || bulkBusy}
                onClick={() => assignSelected(bulkDriver === '__clear__' ? '' : bulkDriver)}
                className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white disabled:opacity-40 whitespace-nowrap font-medium">
                {bulkBusy ? 'Assigning…' : 'Add to queue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt viewer — opens inline (like the invoice viewer), not a new tab.
          Images fit the view and tap to zoom; PDFs use an iframe. */}
      {viewer && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => { setViewer(null); setZoomed(false); }}>
          <div className="bg-white rounded-lg w-full max-w-3xl h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
              <span className="font-semibold text-sm truncate">{viewer.title}</span>
              <div className="flex items-center gap-3 shrink-0">
                {viewer.isImage && (
                  <button onClick={() => setZoomed((z) => !z)} className="text-xs text-brand-700 hover:underline">
                    {zoomed ? 'Fit' : 'Zoom'}
                  </button>
                )}
                <a href={viewer.url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-700 hover:underline">Open</a>
                <button onClick={() => { setViewer(null); setZoomed(false); }} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
              </div>
            </div>
            {viewer.isImage ? (
              <div className="flex-1 overflow-auto bg-gray-100 rounded-b-lg">
                <div className={zoomed ? 'p-2' : 'min-h-full flex items-center justify-center p-2'}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={viewer.url}
                    alt={viewer.title}
                    onClick={() => setZoomed((z) => !z)}
                    className={zoomed ? 'max-w-none cursor-zoom-out' : 'max-w-full max-h-[calc(85vh-3rem)] object-contain cursor-zoom-in'}
                  />
                </div>
              </div>
            ) : (
              <iframe src={viewer.url} title={viewer.title} className="flex-1 w-full rounded-b-lg" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Cards -> drivers, time-aware. Each card (last-4) belongs to a truck; the
// driver on that truck changes over time. Assigning a driver "as of" a date adds
// a history row, and every charge on the card re-attributes to the driver who
// had it on the charge date.
function CardAssignPanel({ cards, assignments, drivers, onAdd, onDelete, driverName }: {
  cards: { last4: string; count: number }[];
  assignments: CardAssignment[];
  drivers: Driver[];
  onAdd: (last4: string, driverId: string, from: string, truck: string, cardType: string) => void | Promise<void>;
  onDelete: (id: string, last4: string) => void | Promise<void>;
  driverName: (id: string | null) => string;
}) {
  const [open, setOpen] = useState(false);
  const [expand, setExpand] = useState<string | null>(null);
  const forCard = (last4: string) => assignments.filter((a) => a.card_last4 === last4); // newest-first
  const current = (last4: string) => forCard(last4)[0] || null;
  const assignedCount = cards.filter((c) => current(c.last4)?.driver_id).length;

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white">
      <button onClick={() => setOpen((s) => !s)} className="w-full flex items-center justify-between px-3 py-2 text-sm">
        <span className="font-medium">Cards → drivers
          <span className="text-gray-400 font-normal"> · {cards.length} card{cards.length === 1 ? '' : 's'}, {assignedCount} assigned</span>
        </span>
        <span className="text-gray-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {cards.length === 0 && (
            <p className="text-xs text-gray-400 px-3 py-3">No cards yet — sync charges to discover them.</p>
          )}
          {cards.map((c) => {
            const cur = current(c.last4);
            const hist = forCard(c.last4);
            const isOpen = expand === c.last4;
            return (
              <div key={c.last4} className="px-3 py-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-sm flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono">••{c.last4}</span>
                    {cur && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${CARD_TYPE_BADGE[cur.card_type] || CARD_TYPE_BADGE.truck}`}>
                        {CARD_TYPE_LABEL[cur.card_type] || 'Truck card'}
                      </span>
                    )}
                    {cur?.truck_label && <span className="text-gray-500"> · {cur.truck_label}</span>}
                    <span className="text-gray-400 text-xs"> · {c.count} charge{c.count === 1 ? '' : 's'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs ${cur?.driver_id ? 'text-gray-700' : 'text-amber-700'}`}>
                      {cur?.driver_id ? `Now: ${driverName(cur.driver_id)}` : 'Unassigned'}
                    </span>
                    <button onClick={() => setExpand(isOpen ? null : c.last4)} className="text-xs text-brand-700 hover:underline">
                      {isOpen ? 'Close' : 'Assign / history'}
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div className="mt-2 space-y-2">
                    <CardAssignForm last4={c.last4} drivers={drivers} defaultTruck={cur?.truck_label || ''} defaultType={cur?.card_type || 'truck'} onAdd={onAdd} />
                    {hist.length > 0 && (
                      <div className="text-[11px] text-gray-500">
                        <div className="uppercase tracking-wide text-gray-400 mb-1">History (newest first)</div>
                        {hist.map((a) => (
                          <div key={a.id} className="flex items-center justify-between gap-2 py-0.5">
                            <span>{a.effective_from} → {driverName(a.driver_id) || 'Unassigned'}{a.truck_label ? ` (${a.truck_label})` : ''}</span>
                            <button onClick={() => onDelete(a.id, c.last4)} className="text-red-600 hover:underline">Remove</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CardAssignForm({ last4, drivers, defaultTruck, defaultType, onAdd }: {
  last4: string;
  drivers: Driver[];
  defaultTruck: string;
  defaultType: string;
  onAdd: (last4: string, driverId: string, from: string, truck: string, cardType: string) => void | Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [driverId, setDriverId] = useState('');
  const [from, setFrom] = useState(today);
  const [truck, setTruck] = useState(defaultTruck);
  const [cardType, setCardType] = useState(defaultType);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2 bg-gray-50 rounded p-2">
      <label className="text-[10px] text-gray-500 flex flex-col">Card type
        <select value={cardType} onChange={(e) => setCardType(e.target.value)} className="border rounded px-2 py-1 text-xs bg-white">
          <option value="truck">Truck card</option>
          <option value="driver">Driver card</option>
          <option value="admin">Admin card</option>
        </select>
      </label>
      {cardType === 'truck' && (
        <label className="text-[10px] text-gray-500 flex flex-col">Truck
          <input value={truck} onChange={(e) => setTruck(e.target.value)} placeholder="Truck 12" className="border rounded px-2 py-1 text-xs w-24" />
        </label>
      )}
      <label className="text-[10px] text-gray-500 flex flex-col">{cardType === 'truck' ? 'Current driver (optional)' : 'Driver'}
        <select value={driverId} onChange={(e) => setDriverId(e.target.value)} className="border rounded px-2 py-1 text-xs bg-white">
          <option value="">{cardType === 'truck' ? 'None yet…' : 'Select…'}</option>
          {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name || d.email}</option>)}
        </select>
      </label>
      <label className="text-[10px] text-gray-500 flex flex-col">Effective from
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded px-2 py-1 text-xs" />
      </label>
      <button
        disabled={busy || (cardType === 'truck' ? (!driverId && !truck.trim()) : !driverId)}
        onClick={async () => { setBusy(true); await onAdd(last4, driverId, from, truck, cardType); setBusy(false); setDriverId(''); }}
        className="text-xs px-3 py-1.5 rounded bg-brand-600 text-white disabled:opacity-40">
        {busy ? 'Saving…' : 'Assign'}
      </button>
    </div>
  );
}

// Card -> driver map: which driver holds each card, so incoming charges
// auto-attribute. Leave cardholder blank unless a single card is shared.
function CardMapPanel({ drivers, maps, onAdd, onUpdate, onDelete }: {
  drivers: Driver[];
  maps: CardMap[];
  onAdd: (last4: string, holder: string, driverId: string, label: string) => void;
  onUpdate: (id: string, fields: Partial<CardMap>) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [last4, setLast4] = useState('');
  const [holder, setHolder] = useState('');
  const [driverId, setDriverId] = useState('');
  const [label, setLabel] = useState('');

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between">
        <span className="text-sm font-medium">
          Card → driver map <span className="text-gray-400 font-normal">· {maps.length} card{maps.length === 1 ? '' : 's'}</span>
        </span>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3">
          <p className="text-xs text-gray-500 mb-3">
            Map each card’s last 4 digits to the driver who carries it. New charges on that card get
            attributed to that driver automatically. Only set a cardholder name if one card is shared.
          </p>

          <div className="space-y-2">
            {maps.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <span className="text-sm font-mono w-16 shrink-0">••{m.card_last4}</span>
                <select
                  value={m.driver_id || ''}
                  onChange={(e) => onUpdate(m.id, { driver_id: e.target.value || null })}
                  className="flex-1 border rounded px-2 py-1 text-sm">
                  <option value="">Unassigned…</option>
                  {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name || d.email}</option>)}
                </select>
                {m.cardholder_name && <span className="text-xs text-gray-400 shrink-0">{m.cardholder_name}</span>}
                <button onClick={() => onDelete(m.id)} className="text-red-600 text-xs px-1 hover:text-red-800">✕</button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-gray-100">
            <input className="w-20 shrink-0 border rounded px-2 py-1 text-sm font-mono" placeholder="last 4"
              value={last4} onChange={(e) => setLast4(e.target.value)} />
            <select className="border rounded px-2 py-1 text-sm" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">Driver…</option>
              {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name || d.email}</option>)}
            </select>
            <input className="w-28 border rounded px-2 py-1 text-sm" placeholder="holder (opt)"
              value={holder} onChange={(e) => setHolder(e.target.value)} />
            <input className="flex-1 min-w-[6rem] border rounded px-2 py-1 text-sm" placeholder="label (opt)"
              value={label} onChange={(e) => setLabel(e.target.value)} />
            <button
              onClick={() => { if (last4.trim() && driverId) { onAdd(last4, holder, driverId, label); setLast4(''); setHolder(''); setDriverId(''); setLabel(''); } }}
              disabled={!last4.trim() || !driverId}
              className="px-3 py-1 text-sm rounded-md bg-brand-600 text-white disabled:opacity-50 whitespace-nowrap">
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
