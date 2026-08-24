'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import InvoiceAdjuster from '@/components/InvoiceAdjuster';

// Build a filesystem-safe base name for an exported PDF.
function safeBase(o: { invoice_number: string | null; customer: string; id: string }) {
  const raw = o.invoice_number ? `invoice-${o.invoice_number}` : o.customer || `order-${o.id.slice(0, 8)}`;
  return raw.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60);
}

// Normalize a customer/business name for matching dispatch orders (free-text
// customer) to a business's saved billing notes.
function normName(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Format an order's placed-at timestamp as "6/2 - 3:30pm".
function fmtOrderedAt(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  return `${date} - ${time}`;
}

type OrderStatus = 'warehouse' | 'out_for_delivery' | 'delivered';

type Order = {
  id: string;
  date: string;
  created_at: string | null;
  customer: string;
  type: 'Fuel' | 'PCMO' | 'DEF' | 'Shipping';
  driver_id: string | null;
  driver_name: string | null;
  sales_rep_id: string | null;
  sales_rep_name: string | null;
  truck: string | null;
  invoice_number: string | null;
  invoice_pdf_path: string | null;
  signed_pdf_path: string | null;
  signer_name: string | null;
  delivery_note: string | null;
  delivered: boolean;
  delivered_at: string | null;
  loaded_at: string | null;
  notes: string | null;
  status: OrderStatus;
  billed: boolean;
  placed_by_name: string | null;
  entry_method: 'placed' | 'uploaded' | null;
  invoice_edited_by_name: string | null;
  invoice_edited_at: string | null;
};

const STATUS_LABEL: Record<OrderStatus, string> = {
  warehouse:        'Warehouse',
  out_for_delivery: 'Out for delivery',
  delivered:        'Delivered',
};
const STATUS_BADGE_CLASS: Record<OrderStatus, string> = {
  warehouse:        'bg-amber-100 text-amber-900',
  out_for_delivery: 'bg-blue-100 text-blue-900',
  delivered:        'bg-emerald-100 text-emerald-900',
};

type Profile = { id: string; full_name: string | null; email: string; role?: string };

// Customer orders that have a QB invoice but haven't been sent to dispatch yet.
// They render in the box at the top so an admin can hand them to drivers
// without navigating back to the Customer Orders list.
export default function AdminOrdersPage() {
  const supabase = createClient();
  const [orders, setOrders] = useState<Order[]>([]);
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [filter, setFilter] = useState<OrderStatus | 'billed'>('warehouse');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  // Row selection + export, used only in the Delivered view.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  // Per-business special billing notes, keyed by normalized name.
  const [billingNotes, setBillingNotes] = useState<Map<string, string>>(new Map());

  async function load() {
    setLoading(true);
    const [ordsRes, drsRes] = await Promise.all([
      supabase
        .from('orders')
        .select('*')
        .order('date', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase
        .from('profiles')
        .select('id, full_name, email, role')
        .order('full_name'),
    ]);
    setOrders((ordsRes.data as Order[]) || []);
    setDrivers((drsRes.data as Profile[]) || []);

    // Special billing notes, matched to orders by customer/business name.
    const { data: bizRows } = await supabase
      .from('businesses')
      .select('name, billing_notes')
      .not('billing_notes', 'is', null);
    const bm = new Map<string, string>();
    ((bizRows as { name: string; billing_notes: string | null }[]) || []).forEach((b) => {
      if (b.billing_notes && b.billing_notes.trim()) bm.set(normName(b.name), b.billing_notes.trim());
    });
    setBillingNotes(bm);

    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Convert an invoiced customer order into a dispatch row. Same logic as
  // the per-order detail page's Step 2 button — duplicated here so the
  let filtered = orders;
  if (filter === 'warehouse' || filter === 'out_for_delivery') {
    filtered = orders.filter((o) => o.status === filter);
  } else if (filter === 'delivered') {
    // Delivered = delivered but not yet billed; once billed it moves to Billed.
    filtered = orders.filter((o) => o.status === 'delivered' && !o.billed);
  } else if (filter === 'billed') {
    filtered = orders.filter((o) => o.billed);
  }

  const isDeliveredView = filter === 'delivered';
  const isBilledView = filter === 'billed';
  // Both delivered + billed views allow row selection for PDF export.
  const enhancedView = isDeliveredView || isBilledView;

  // Drop any selection when leaving the export-capable views so a hidden
  // checkbox can't get swept into an export.
  useEffect(() => {
    if (!enhancedView) setSelected(new Set());
  }, [enhancedView]);

  // Delivered orders that actually have at least one PDF — the only ones
  // worth selecting for export.
  const exportable = filtered.filter((o) => o.invoice_pdf_path || o.signed_pdf_path);
  const allSelected = exportable.length > 0 && selected.size === exportable.length;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === exportable.length ? new Set() : new Set(exportable.map((o) => o.id)),
    );
  }

  // Persist the "billed" mark on the order, with optimistic local update.
  async function setBilled(id: string, value: boolean) {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, billed: value } : o)));
    const { error } = await supabase.from('orders').update({ billed: value }).eq('id', id);
    if (error) {
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, billed: !value } : o)));
      alert('Could not save the billed mark: ' + error.message);
    }
  }

  // Export: download each selected order's PDFs as separate files (invoice
  // and signed), straight to the browser's Downloads folder.
  async function exportSelected() {
    const chosen = orders.filter((o) => selected.has(o.id));
    const files: { path: string; name: string }[] = [];
    for (const o of chosen) {
      if (o.invoice_pdf_path) files.push({ path: o.invoice_pdf_path, name: `${safeBase(o)}-invoice.pdf` });
      if (o.signed_pdf_path) files.push({ path: o.signed_pdf_path, name: `${safeBase(o)}-signed.pdf` });
    }
    if (files.length === 0) {
      alert('None of the selected orders have a PDF on file.');
      return;
    }

    setExporting(true);
    try {
      // De-dupe identical filenames within this export.
      const used = new Set<string>();
      const uniqueName = (name: string) => {
        if (!used.has(name)) { used.add(name); return name; }
        const dot = name.lastIndexOf('.');
        const stem = dot === -1 ? name : name.slice(0, dot);
        const ext = dot === -1 ? '' : name.slice(dot);
        let i = 2;
        while (used.has(`${stem}-${i}${ext}`)) i++;
        const out = `${stem}-${i}${ext}`;
        used.add(out);
        return out;
      };

      let ok = 0;
      const errors: string[] = [];
      for (const f of files) {
        try {
          const { data: blob, error } = await supabase.storage.from('invoices').download(f.path);
          if (error || !blob) {
            errors.push(`${f.name}: ${error?.message || 'not found in storage'}`);
            continue;
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = uniqueName(f.name);
          document.body.appendChild(a);
          a.click();
          a.remove();
          // Let the browser register each download before starting the next;
          // back-to-back downloads can otherwise be dropped.
          await new Promise((r) => setTimeout(r, 300));
          URL.revokeObjectURL(url);
          ok++;
        } catch (err: any) {
          errors.push(`${f.name}: ${err?.message || 'download failed'}`);
        }
      }

      if (errors.length > 0) {
        alert(`Downloaded ${ok} of ${files.length} PDFs.\n\nProblems:\n${errors.slice(0, 8).join('\n')}`);
      }
    } finally {
      setExporting(false);
    }
  }

  // Admin override: drag an order between statuses. Resets timestamps
  // for the stages we're stepping back over so the customer view doesn't
  // show stale "Delivered Tue 10:30am" while it's actually still on the
  // truck.
  async function setOrderStatus(id: string, next: OrderStatus) {
    const patch: Record<string, unknown> = { status: next };
    if (next === 'warehouse') {
      patch.loaded_at = null;
      patch.loaded_by = null;
      patch.loaded_by_name = null;
      patch.delivered = false;
      patch.delivered_at = null;
    } else if (next === 'out_for_delivery') {
      patch.loaded_at = new Date().toISOString();
      patch.delivered = false;
      patch.delivered_at = null;
    } else if (next === 'delivered') {
      const { data: { user } } = await supabase.auth.getUser();
      let name: string | null = null;
      if (user) {
        const { data: profile } = await supabase
          .from('profiles').select('full_name, email').eq('id', user.id).single();
        name = profile?.full_name || profile?.email || null;
      }
      patch.delivered = true;
      patch.delivered_at = new Date().toISOString();
      patch.delivered_by = user?.id || null;
      patch.delivered_by_name = name;
    }
    await supabase.from('orders').update(patch).eq('id', id);
    load();
  }

  async function deleteOrder(id: string) {
    const order = orders.find((o) => o.id === id);
    const inv = order?.invoice_number?.trim();
    const msg = inv
      ? `Delete this order AND void invoice #${inv} in QuickBooks?\n\nVoiding keeps the invoice number but zeroes it to $0 (it won't affect A/R).`
      : 'Delete this order?';
    if (!confirm(msg)) return;

    // Void the QB invoice first; if that fails, stop so the records don't drift.
    if (inv) {
      try {
        const res = await fetch('/api/quickbooks/void-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invoice_number: inv }),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          alert(`Could not void invoice #${inv} in QuickBooks: ${json.error || 'unknown'}. Order was NOT deleted.`);
          return;
        }
        if (json.voided === false) {
          if (!confirm(`Invoice #${inv} wasn't found in QuickBooks (already removed?). Delete the app order anyway?`)) return;
        }
      } catch (e: any) {
        alert(`Could not reach QuickBooks to void invoice #${inv}: ${e?.message || 'network'}. Order was NOT deleted.`);
        return;
      }
    }

    await supabase.from('orders').delete().eq('id', id);
    load();
  }

 async function toggleDelivered(o: Order) {
    if (o.delivered) {
      await supabase.from('orders').update({ 
        delivered: false, 
        delivered_at: null,
        delivered_by: null,
        delivered_by_name: null,
      }).eq('id', o.id);
    } else {
      const { data: { user } } = await supabase.auth.getUser();
      let name: string | null = null;
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('id', user.id)
          .single();
        name = profile?.full_name || profile?.email || null;
      }
      await supabase.from('orders').update({ 
        delivered: true, 
        delivered_at: new Date().toISOString(),
        delivered_by: user?.id || null,
        delivered_by_name: name,
      }).eq('id', o.id);
    }
    load();
  }

  function exportCSV() {
    const headers = ['Date','Customer','Type','Driver','Truck','Invoice #','Status','Delivered At','Signer','Driver Note','Notes'];
    const rows = orders.map(o => [
      o.date, o.customer, o.type, o.driver_name || '',
      o.truck || '', o.invoice_number || '',
      o.delivered ? 'Delivered' : 'Pending',
      o.delivered_at || '',
      o.signer_name || '',
      o.delivery_note || '',
      o.notes || ''
    ]);
    const csv = [headers, ...rows].map(r =>
      r.map(c => `"${(c||'').toString().replace(/"/g,'""')}"`).join(',')
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stallion-orders-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">Orders</h1>
        <div className="flex gap-2 flex-wrap justify-end">
          <button onClick={exportCSV} className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
            Export CSV
          </button>
          <button
            onClick={exportSelected}
            disabled={exporting || selected.size === 0}
            title={selected.size === 0
              ? 'Open the Delivered tab and tick the orders you want, then click here'
              : 'Download the selected orders’ PDFs'}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {exporting ? 'Exporting…' : selected.size > 0 ? `Export PDFs (${selected.size})` : 'Export PDFs'}
          </button>
          <button
            onClick={() => { setEditing(null); setShowForm(true); }}
            className="px-3 py-2 text-sm bg-yellow-400 text-yellow-900 rounded-md hover:bg-yellow-500 font-medium"
          >
            Upload invoice
          </button>
        </div>
      </div>

      {/* Status board: Warehouse → Out for delivery → Delivered → Billed. */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {([
          { key: 'warehouse',        label: 'Warehouse' },
          { key: 'out_for_delivery', label: 'Out for delivery' },
          { key: 'delivered',        label: 'Delivered' },
          { key: 'billed',           label: 'Billed' },
        ] as const).map((f) => {
          const count = f.key === 'billed'
            ? orders.filter((o) => o.billed).length
            : f.key === 'delivered'
              ? orders.filter((o) => o.status === 'delivered' && !o.billed).length
              : orders.filter((o) => o.status === f.key).length;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 text-sm rounded-md border ${
                filter === f.key ? 'bg-brand-50 border-brand-500 text-brand-900 font-medium' : 'bg-white border-gray-300 hover:bg-gray-50'
              }`}
            >
              {f.label}
              {count > 0 && <span className="ml-1.5 text-xs text-gray-500">({count})</span>}
            </button>
          );
        })}
      </div>

      <>
          {enhancedView && filtered.length > 0 && (
            <div className="flex items-center gap-3 mb-3 text-sm flex-wrap">
              <label className="flex items-center gap-1.5 text-gray-600">
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={exportable.length === 0}
                  onChange={toggleSelectAll}
                />
                Select all with PDFs
                {exportable.length > 0 && <span className="text-gray-400">({exportable.length})</span>}
              </label>
              {selected.size > 0 && (
                <span className="text-gray-500">
                  {selected.size} selected — use “Export PDFs” at the top.
                </span>
              )}
              {exportable.length === 0 && (
                <span className="text-xs text-gray-400">No delivered orders have a PDF on file.</span>
              )}
            </div>
          )}

          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-12">No orders here.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map(o => (
                <OrderCard key={o.id} order={o}
                  enhanced={enhancedView}
                  showBilling={isDeliveredView}
                  billingNote={billingNotes.get(normName(o.customer)) || null}
                  selected={selected.has(o.id)}
                  onToggleSelect={() => toggleSelect(o.id)}
                  onSetBilled={(v) => setBilled(o.id, v)}
                  onEdit={() => { setEditing(o); setShowForm(true); }}
                  onDelete={() => deleteOrder(o.id)}
                  onStatusChange={(s) => setOrderStatus(o.id, s)}
                  onAdjusted={load}
                />
              ))}
            </div>
          )}
      </>

      {showForm && (
        <OrderForm
          order={editing}
          drivers={drivers}
          reps={drivers.filter((p) => p.role === 'office' || p.role === 'admin' || p.role === 'master_admin')}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={() => { setShowForm(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}


type DocKind = 'invoice' | 'signed';

function OrderCard({ order, enhanced, showBilling, billingNote, selected, onToggleSelect, onSetBilled, onEdit, onDelete, onStatusChange, onAdjusted }: {
  order: Order;
  enhanced: boolean;
  showBilling?: boolean;
  billingNote?: string | null;
  selected: boolean;
  onToggleSelect: () => void;
  onSetBilled: (value: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatusChange: (s: OrderStatus) => void;
  onAdjusted?: () => void;
}) {
  const supabase = createClient();
  const typeColor = {
    Fuel: 'bg-amber-100 text-amber-900',
    PCMO: 'bg-blue-100 text-blue-900',
    DEF: 'bg-purple-100 text-purple-900',
    Shipping: 'bg-emerald-100 text-emerald-900',
  }[order.type];

  // Inline quick view (single click) and full-screen modal (double click).
  const [expanded, setExpanded] = useState<{ kind: DocKind; url: string } | null>(null);
  const [modal, setModal] = useState<{ url: string; title: string } | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const urlCache = useRef<Map<string, string>>(new Map());

  // Pull the invoice PDF from QuickBooks (by its number) and attach it to an
  // order that has an invoice number but no document.
  async function attachInvoicePdf() {
    setAttachBusy(true);
    try {
      const res = await fetch('/api/quickbooks/attach-invoice-pdf', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: order.id }),
      });
      const j = await res.json();
      if (!j.ok) { alert('Could not attach the invoice: ' + (j.error || 'unknown')); return; }
      onAdjusted?.();
    } catch {
      alert('Could not attach the invoice — network error.');
    } finally {
      setAttachBusy(false);
    }
  }
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!modal) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setModal(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  function pathFor(kind: DocKind) {
    return kind === 'invoice' ? order.invoice_pdf_path : order.signed_pdf_path;
  }

  async function getSignedUrl(path: string): Promise<string | null> {
    const cached = urlCache.current.get(path);
    if (cached) return cached;
    const { data } = await supabase.storage.from('invoices').createSignedUrl(path, 600);
    if (data?.signedUrl) {
      urlCache.current.set(path, data.signedUrl);
      return data.signedUrl;
    }
    return null;
  }

  async function toggleExpand(kind: DocKind) {
    if (expanded?.kind === kind) { setExpanded(null); return; }
    const path = pathFor(kind);
    if (!path) return;
    const url = await getSignedUrl(path);
    if (url) setExpanded({ kind, url });
  }

  async function openModal(kind: DocKind) {
    const path = pathFor(kind);
    if (!path) return;
    const url = await getSignedUrl(path);
    if (!url) return;
    const label = kind === 'invoice' ? 'Invoice' : 'Signed';
    setModal({ url, title: `${label} — ${order.invoice_number ? `#${order.invoice_number}` : order.customer}` });
  }

  function handleTileClick(kind: DocKind) {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      toggleExpand(kind);
    }, 250);
  }

  function handleTileDouble(kind: DocKind) {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    openModal(kind);
  }

  function DocTile({ kind }: { kind: DocKind }) {
    const path = pathFor(kind);
    if (!path) return null;
    const label = kind === 'invoice' ? '📄 Invoice' : '✓ Signed';
    const isOpen = expanded?.kind === kind;
    return (
      <button
        type="button"
        onClick={() => handleTileClick(kind)}
        onDoubleClick={() => handleTileDouble(kind)}
        title="Single-click to preview · double-click to open"
        className={`text-xs px-2 py-1 rounded border select-none ${
          isOpen
            ? 'border-brand-400 bg-brand-50 text-brand-800'
            : kind === 'signed'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100'
              : 'border-gray-300 hover:bg-gray-50'
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <div className={`bg-white rounded-lg p-4 border ${order.status === 'delivered' ? 'border-gray-200 bg-gray-50' : 'border-gray-200'}`}>
      <div className="flex gap-3">
       <div className="flex-1 min-w-0">
      <div className="flex flex-wrap justify-between items-start gap-2 mb-2">
        <div className="flex gap-2 items-center flex-wrap">
          {enhanced && (
            <input
              type="checkbox"
              checked={selected}
              disabled={!order.invoice_pdf_path && !order.signed_pdf_path}
              onChange={onToggleSelect}
              title="Select for export"
              aria-label="Select for export"
              className="w-4 h-4 mr-1"
            />
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeColor}`}>{order.type}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE_CLASS[order.status]}`}>
            {STATUS_LABEL[order.status]}
          </span>
          <span className="text-sm text-gray-500">{order.date}</span>
        </div>
        <div className="flex flex-wrap gap-1 items-center ml-auto">
          {order.status === 'warehouse' && (
            <button
              onClick={() => onStatusChange('out_for_delivery')}
              className="text-xs px-2 py-1 rounded bg-brand-600 text-white hover:bg-brand-700 font-medium whitespace-nowrap"
              title="Move this order to Out for delivery"
            >
              Forward to delivery →
            </button>
          )}
          {/* Status changer — admins can drag an order back to warehouse,
              forward to delivered, etc. Resets timestamps on change so
              the customer view doesn't show stale data. */}
          <select
            value={order.status}
            onChange={(e) => {
              const next = e.target.value as OrderStatus;
              if (next !== order.status && confirm(`Move this order to "${STATUS_LABEL[next]}"?`)) {
                onStatusChange(next);
              }
            }}
            className="text-xs px-2 py-1 border border-gray-300 rounded bg-white"
            aria-label="Change status"
          >
            <option value="warehouse">Warehouse</option>
            <option value="out_for_delivery">Out for delivery</option>
            <option value="delivered">Delivered</option>
          </select>
        </div>
      </div>
      <div className="font-medium mb-1">{order.customer}</div>
      {showBilling && billingNote && (
        <div className="text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded px-2 py-1.5 mb-2">
          <span className="font-semibold">📋 Billing instructions:</span>{' '}
          <span className="whitespace-pre-wrap">{billingNote}</span>
        </div>
      )}
      <div className="text-sm text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
        {order.driver_name && <span>Driver: {order.driver_name}</span>}
        {order.sales_rep_name && <span>Sales rep: {order.sales_rep_name}</span>}
        {order.truck && <span>Truck #{order.truck}</span>}
        {order.invoice_number ? (
          <span>Invoice #{order.invoice_number}</span>
        ) : (
          <span className="italic text-gray-400">No invoice #</span>
        )}
        {order.signer_name && <span>Signed by: {order.signer_name}</span>}
        {(() => {
          // "Order uploaded by" for hand-keyed invoices, "Order placed by" for
          // app orders. Falls back to just the entered date/time when we don't
          // know who (legacy rows).
          const verb = order.entry_method === 'uploaded' ? 'uploaded' : 'placed';
          const when = order.created_at ? fmtOrderedAt(order.created_at) : null;
          if (order.placed_by_name) {
            return <span>Order {verb} by: {order.placed_by_name}{when ? ` · ${when}` : ''}</span>;
          }
          if (when) {
            return <span>{order.entry_method === 'uploaded' ? 'Uploaded' : 'Entered'} · {when}</span>;
          }
          return null;
        })()}
        {order.invoice_edited_by_name && (
          <span className="text-gray-500">
            Invoice edited by: {order.invoice_edited_by_name}
            {order.invoice_edited_at && ` · ${new Date(order.invoice_edited_at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
          </span>
        )}
      </div>
      {order.delivery_note && (
        <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2">
          <span className="font-medium">Driver note:</span> {order.delivery_note}
        </div>
      )}

      {/* Adjust invoice — any dispatched order (warehouse, out for delivery,
          delivered) that has a QB invoice. Edits qty/price on the existing
          invoice in QuickBooks. Admin-only board, so no extra role gate. */}
      <div className="mt-2 flex flex-wrap gap-2">
        {order.invoice_number && (
          <button
            onClick={() => setAdjusting(true)}
            className="text-xs px-2 py-1 border border-brand-300 text-brand-700 rounded hover:bg-brand-50"
          >
            Adjust invoice
          </button>
        )}
        {order.status !== 'delivered' && (
          <Link
            href={`/admin/deliver/${order.id}`}
            className="text-xs px-2 py-1 border border-brand-700 text-brand-800 rounded hover:bg-brand-50 font-medium"
          >
            ✍ Sign / mark delivered
          </Link>
        )}
      </div>
      {adjusting && (
        <InvoiceAdjuster
          orderId={order.id}
          invoiceNumber={order.invoice_number}
          onClose={() => setAdjusting(false)}
          onSaved={() => onAdjusted?.()}
        />
      )}

      <>
        <div className="flex gap-2 mt-2 flex-wrap items-center">
          {(order.invoice_pdf_path || order.signed_pdf_path) ? (
            <>
              <DocTile kind="invoice" />
              <DocTile kind="signed" />
            </>
          ) : (
            <span className="text-xs text-gray-400 italic">No documents</span>
          )}
          {order.invoice_number && !order.invoice_pdf_path && (
            <button
              onClick={attachInvoicePdf}
              disabled={attachBusy}
              className="text-xs px-2.5 py-1 rounded-md border border-brand-300 text-brand-700 hover:bg-brand-50 disabled:opacity-50 font-medium"
              title="Download this invoice's PDF from QuickBooks and attach it"
            >
              {attachBusy ? 'Attaching…' : '📎 Attach invoice PDF from QuickBooks'}
            </button>
          )}
          {enhanced && (
            order.billed ? (
              <button
                onClick={() => onSetBilled(false)}
                className="ml-auto text-xs px-2.5 py-1 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50"
                title="Move back to Delivered"
              >
                Unmark billed
              </button>
            ) : (
              <button
                onClick={() => onSetBilled(true)}
                className="ml-auto text-xs px-2.5 py-1 rounded-md bg-green-600 text-white hover:bg-green-700 font-medium"
                title="Mark billed and move to the Billed tab"
              >
                Bill
              </button>
            )
          )}
        </div>
        {expanded && (
          <div className="mt-2 inline-block border border-gray-200 rounded bg-white align-top">
            <div className="flex items-center justify-between px-2 py-1 border-b border-gray-100 w-[400px] max-w-full">
              <span className="text-[10px] text-gray-500">Quick view · double-click tile to enlarge</span>
              <button onClick={() => setExpanded(null)} className="text-[10px] text-gray-500 hover:text-gray-800">
                ✕
              </button>
            </div>
            {/* ~quarter of a letter sheet (8.5×11), whole first page fit in view. */}
            <iframe
              src={`${expanded.url}#view=Fit&toolbar=0&navpanes=0`}
              title="PDF quick view"
              className="w-[400px] max-w-full h-[518px] block"
            />
          </div>
        )}
      </>
       </div>
       {/* Small Edit up top; Delete dropped to the bottom so it's well clear
          of Edit and rarely fat-fingered. */}
       <div className="flex flex-col items-end justify-between shrink-0">
         <button
           onClick={onEdit}
           title="Edit order"
           aria-label="Edit order"
           className="px-3 py-1.5 rounded-md bg-amber-100 text-amber-900 hover:bg-amber-200 font-medium text-xs"
         >
           Edit
         </button>
         <button
           onClick={onDelete}
           title="Delete order"
           aria-label="Delete order"
           className="text-[10px] text-red-600 hover:text-red-800 hover:underline mt-6"
         >
           Delete
         </button>
       </div>
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-3" onClick={() => setModal(null)}>
          <div
            className="flex-1 flex flex-col bg-white rounded-lg overflow-hidden max-w-5xl w-full mx-auto"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
              <span className="text-sm font-medium truncate">{modal.title}</span>
              <div className="flex items-center gap-3">
                <a href={modal.url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-700 hover:underline">
                  Open in new tab
                </a>
                <button onClick={() => setModal(null)} className="text-sm px-2 py-1 rounded-md border border-gray-300 hover:bg-gray-50">
                  Close ✕
                </button>
              </div>
            </div>
            <iframe src={modal.url} title="PDF" className="flex-1 w-full bg-gray-100" />
          </div>
        </div>
      )}
    </div>
  );
}

function OrderForm({ order, drivers, reps, onClose, onSaved }: {
  order: Order | null;
  drivers: Profile[];
  reps: Profile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const supabase = createClient();
  const [date, setDate] = useState(order?.date || new Date().toISOString().split('T')[0]);
  const [customer, setCustomer] = useState(order?.customer || '');
  const [type, setType] = useState<'Fuel' | 'PCMO' | 'DEF' | 'Shipping'>(order?.type || 'Fuel');
  const [driverId, setDriverId] = useState(order?.driver_id || '');
  const [salesRepId, setSalesRepId] = useState(order?.sales_rep_id || '');
  const [truck, setTruck] = useState(order?.truck || '');
  const [invoiceNumber, setInvoiceNumber] = useState(order?.invoice_number || '');
  const [notes, setNotes] = useState(order?.notes || '');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      // Upload the file FIRST, so a failed upload surfaces a clear error and
      // doesn't leave a duplicate order behind on retry.
      let invoicePath: string | undefined;
      if (pdfFile) {
        const ext = (pdfFile.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
        const path = `uploads/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from('invoices').upload(path, pdfFile, {
          contentType: pdfFile.type || undefined,
        });
        if (upErr) throw new Error(`Invoice file upload failed: ${upErr.message}`);
        invoicePath = path;
      }

      const driver = drivers.find(d => d.id === driverId);
      const rep = reps.find(r => r.id === salesRepId);
      const payload = {
        date,
        customer,
        type,
        driver_id: driverId || null,
        driver_name: driver?.full_name || driver?.email || null,
        sales_rep_id: salesRepId || null,
        sales_rep_name: rep?.full_name || rep?.email || null,
        truck: truck || null,
        invoice_number: invoiceNumber || null,
        notes: notes || null,
        ...(invoicePath ? { invoice_pdf_path: invoicePath } : {}),
      };

      if (order) {
        await supabase.from('orders').update(payload).eq('id', order.id);
      } else {
        // Stamp who entered this order (the admin) + when, so the card shows
        // "Order placed by … · time" like orders that came from a customer.
        const { data: { user } } = await supabase.auth.getUser();
        let placedByName: string | null = null;
        if (user) {
          const { data: prof } = await supabase
            .from('profiles').select('full_name, email').eq('id', user.id).single();
          placedByName = prof?.full_name || prof?.email || null;
        }
        const { data, error: insertError } = await supabase
          .from('orders')
          .insert({
            ...payload,
            created_by: user?.id || null,
            placed_by: user?.id || null,
            placed_by_name: placedByName,
          })
          .select('id')
          .single();
        if (insertError) throw insertError;
        await supabase.from('orders').update({ entry_method: 'uploaded' }).eq('id', data!.id);
      }

      onSaved();
    } catch (err: any) {
      setError(err.message || 'Save failed');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-lg font-semibold mb-4">{order ? 'Edit order' : 'New order'}</h2>
          <form onSubmit={handleSave} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Date</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} required
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Type</label>
                <select value={type} onChange={e => setType(e.target.value as any)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm">
                  <option>Fuel</option>
                  <option>PCMO</option>
                  <option>DEF</option>
                  <option>Shipping</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Customer</label>
              <input type="text" value={customer} onChange={e => setCustomer(e.target.value)} required
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Driver</label>
                <select value={driverId} onChange={e => setDriverId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm">
                  <option value="">— Unassigned —</option>
                  {drivers.map(d => <option key={d.id} value={d.id}>{d.full_name || d.email}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Truck #</label>
                <input type="text" value={truck} onChange={e => setTruck(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Sales rep <span className="text-gray-400 font-normal">(so it shows on their invoices)</span></label>
                <select value={salesRepId} onChange={e => setSalesRepId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm">
                  <option value="">— None —</option>
                  {reps.map(r => <option key={r.id} value={r.id}>{r.full_name || r.email}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Invoice # (QuickBooks)</label>
              <input type="text" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Invoice file (optional)</label>
              <input type="file" accept="application/pdf,image/*,.heic,.doc,.docx" onChange={e => setPdfFile(e.target.files?.[0] || null)}
                className="w-full text-sm" />
              {order?.invoice_pdf_path && !pdfFile && (
                <p className="text-xs text-gray-500 mt-1">Existing PDF on file. Upload a new one to replace.</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save order'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
