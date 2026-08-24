'use client';
import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import SignatureCanvas from 'react-signature-canvas';
import { PDFDocument } from 'pdf-lib';

type Order = {
  id: string;
  date: string;
  customer: string;
  type: string;
  driver_name: string | null;
  truck: string | null;
  invoice_number: string | null;
  invoice_pdf_path: string | null;
  signed_pdf_path: string | null;
  signer_name: string | null;
  delivery_note: string | null;
  delivered: boolean;
  delivered_at: string | null;
  notes: string | null;
  status: 'warehouse' | 'out_for_delivery' | 'delivered';
  loaded_at: string | null;
  loaded_by_name: string | null;
  placed_by_name: string | null;
};

function statusBadgeClass(s: Order['status']): string {
  if (s === 'delivered')        return 'bg-emerald-100 text-emerald-900';
  if (s === 'out_for_delivery') return 'bg-blue-100 text-blue-900';
  return 'bg-amber-100 text-amber-900';
}

function statusLabel(s: Order['status']): string {
  if (s === 'delivered')        return 'Delivered';
  if (s === 'out_for_delivery') return 'Out for delivery';
  return 'In warehouse';
}

export default function DeliveryDetail({ orderId, backHref = "/driver" }: { orderId: string; backHref?: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [signMode, setSignMode] = useState<null | 'photo' | 'screen'>(null);

  async function load() {
    setLoading(true);
    const { data } = await supabase.from('orders').select('*').eq("id", orderId).single();
    setOrder(data as Order);
    setLoading(false);
  }

  useEffect(() => { load(); }, [orderId]);

  async function downloadInvoice() {
    if (!order?.invoice_pdf_path) return;
    const { data, error } = await supabase.storage.from('invoices').createSignedUrl(order.invoice_pdf_path, 300);
    if (error || !data?.signedUrl) {
      alert('Could not load invoice. ' + (error?.message || ''));
      return;
    }
    window.open(data.signedUrl, '_blank');
  }

  async function markLoaded() {
    if (!confirm('Mark this order as loaded on the truck?')) return;
    const { data: { user } } = await supabase.auth.getUser();
    let name: string | null = null;
    if (user) {
      const { data: profile } = await supabase
        .from('profiles').select('full_name, email').eq('id', user.id).single();
      name = profile?.full_name || profile?.email || null;
    }
    await supabase.from('orders').update({
      status: 'out_for_delivery',
      loaded_at: new Date().toISOString(),
      loaded_by: user?.id || null,
      loaded_by_name: name,
    }).eq('id', order!.id);
    load();
  }

  async function markDeliveredNoProof() {
    if (!confirm('Mark delivered without uploading a signed copy?')) return;
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
      status: 'delivered',
    }).eq('id', order!.id);
    load();
  }

  if (loading || !order) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div>
      <button onClick={() => router.push(backHref)} className="text-sm text-gray-600 hover:text-gray-900 mb-4">← Back to orders</button>

      <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
        <div className="flex gap-2 items-center mb-3 flex-wrap">
          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-900">{order.type}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(order.status)}`}>
            {statusLabel(order.status)}
          </span>
        </div>
        <h1 className="text-xl font-semibold mb-2">{order.customer}</h1>
        <div className="text-sm text-gray-600 space-y-1">
          <div>Date: {order.date}</div>
          {order.driver_name && <div>Driver: {order.driver_name}</div>}
          {order.truck && <div>Truck #{order.truck}</div>}
          {order.invoice_number && <div>Invoice #{order.invoice_number}</div>}
          {order.placed_by_name && <div>Placed by: {order.placed_by_name}</div>}
          {order.notes && <div className="mt-2 text-gray-700">{order.notes}</div>}
          {order.signer_name && <div>Signed by: {order.signer_name}</div>}
          {order.delivery_note && (
            <div className="mt-2 text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              <span className="font-medium">Driver note:</span> {order.delivery_note}
            </div>
          )}
          {order.loaded_at && order.status !== 'delivered' && (
            <div className="text-blue-700">🚚 Loaded {new Date(order.loaded_at).toLocaleString()}{order.loaded_by_name ? ` by ${order.loaded_by_name}` : ''}</div>
          )}
          {order.delivered_at && <div className="text-emerald-700">✓ Delivered {new Date(order.delivered_at).toLocaleString()}</div>}
        </div>
      </div>

      {order.invoice_pdf_path && (
        <button onClick={downloadInvoice} className="w-full mb-3 px-4 py-3 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium text-sm">
          📄 Download invoice PDF
        </button>
      )}

      {order.status === 'warehouse' && (
        <div className="space-y-2 mb-3">
          <p className="text-sm font-medium text-gray-700 mt-4">Loaded on the truck?</p>
          <button onClick={markLoaded} className="w-full px-4 py-3 bg-blue-700 text-white rounded-lg hover:bg-blue-900 font-medium text-sm">
            🚚 Mark loaded — out for delivery
          </button>
          <p className="text-xs text-gray-500">
            The customer will see "Out for delivery" as soon as you tap this.
          </p>
        </div>
      )}

      {!order.delivered && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700 mt-4">Mark delivered:</p>
          <button onClick={() => setSignMode('photo')} className="w-full px-4 py-3 bg-brand-700 text-white rounded-lg hover:bg-brand-900 font-medium text-sm">
            📷 Upload photo of signed invoice
          </button>
          {order.invoice_pdf_path && (
            <button onClick={() => setSignMode('screen')} className="w-full px-4 py-3 bg-brand-700 text-white rounded-lg hover:bg-brand-900 font-medium text-sm">
              ✍ Sign on screen
            </button>
          )}
          <button onClick={markDeliveredNoProof} className="w-full px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
            Mark delivered without proof
          </button>
        </div>
      )}

      {order.delivered && order.signed_pdf_path && (
        <div className="text-sm text-emerald-700 text-center p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
          ✓ Signed copy uploaded
        </div>
      )}

      {signMode === 'photo' && <PhotoUploadModal order={order} onClose={() => setSignMode(null)} onDone={() => { setSignMode(null); load(); }} />}
      {signMode === 'screen' && <ScreenSignModal order={order} onClose={() => setSignMode(null)} onDone={() => { setSignMode(null); load(); }} />}
    </div>
  );
}

function PhotoUploadModal({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const supabase = createClient();
  const [file, setFile] = useState<File | null>(null);
  const [signerName, setSignerName] = useState('');
  const [deliveryNote, setDeliveryNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function upload() {
    if (!signerName.trim()) { setError("Please enter the signer's name"); return; }
    if (!file) { setError('Select a photo'); return; }
    setSaving(true); setError('');
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${order.id}/signed-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('invoices').upload(path, file);
      if (upErr) throw upErr;
      const { data: { user } } = await supabase.auth.getUser();
      let driverName: string | null = null;
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('id', user.id)
          .single();
        driverName = profile?.full_name || profile?.email || null;
      }
      const { error: updateErr } = await supabase.from('orders').update({
        signed_pdf_path: path,
        signer_name: signerName,
        delivery_note: deliveryNote.trim() || null,
        delivered: true,
        delivered_at: new Date().toISOString(),
        delivered_by: user?.id || null,
        delivered_by_name: driverName,
        status: 'delivered',
      }).eq('id', order.id);
      if (updateErr) throw updateErr;
      onDone();
    } catch (err: any) {
      console.error('Photo upload failed:', err);
      setError(err.message || 'Unknown error');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-sm w-full p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-3">Upload signed invoice</h2>
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">Printed name of signer</label>
          <input
            type="text"
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            placeholder="e.g. John Smith"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <p className="text-sm text-gray-600 mb-3">Take a photo of the signed paper invoice, or choose one from your library.</p>
        {/* No `capture` attribute: forcing the camera makes the installed PWA
            drop the captured file on some phones (the app backgrounds during
            capture and onChange comes back empty). Without it iOS shows a
            Take Photo / Photo Library / Choose File menu — the camera still
            works, via the reliable path. */}
        <input type="file" accept="image/*,application/pdf"
          onChange={e => setFile(e.target.files?.[0] || null)}
          className="w-full mb-3 text-sm" />
        {file && <p className="text-xs text-emerald-700 mb-3 -mt-1 truncate">Attached: {file.name}</p>}
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">Delivery note (optional)</label>
          <textarea
            value={deliveryNote}
            onChange={(e) => setDeliveryNote(e.target.value)}
            rows={2}
            placeholder="e.g. Changed quantity to 8,500 gallons"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md">Cancel</button>
          <button onClick={upload} disabled={saving || !file} className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md disabled:opacity-50">
            {saving ? 'Uploading…' : 'Upload & mark delivered'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ScreenSignModal({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const supabase = createClient();
  const sigRef = useRef<SignatureCanvas>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [signerName, setSignerName] = useState('');
  const [deliveryNote, setDeliveryNote] = useState('');

  async function save() {
    if (!signerName.trim()) { setError("Please enter the signer's name"); return; }
    if (sigRef.current?.isEmpty()) { setError('Please sign first'); return; }
    setSaving(true); setError('');
    try {
      const sigDataUrl = sigRef.current!.getCanvas().toDataURL('image/png');
      const sigBytes = await (await fetch(sigDataUrl)).arrayBuffer();

      const { data: pdfBlob } = await supabase.storage.from('invoices').download(order.invoice_pdf_path!);
      if (!pdfBlob) throw new Error('Could not load invoice');
      const pdfBytes = await pdfBlob.arrayBuffer();

      const pdfDoc = await PDFDocument.load(pdfBytes);
      const sigImage = await pdfDoc.embedPng(sigBytes);
      const lastPage = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
      const { width, height } = lastPage.getSize();

      // Signature on RECEIVED BY line
      const sigHeight = 60;
      const sigWidth = (sigImage.width / sigImage.height) * sigHeight;
      const finalSigWidth = Math.min(sigWidth, 340);
      const finalSigHeight = (sigImage.height / sigImage.width) * finalSigWidth;
      const sigX = width * 0.16;
      const sigY = height * 0.395;
      lastPage.drawImage(sigImage, {
        x: sigX,
        y: sigY,
        width: finalSigWidth,
        height: finalSigHeight,
      });

      const ts = new Date().toLocaleString();
      lastPage.drawText(`Printed name: ${signerName}`, { x: sigX, y: sigY - 12, size: 9 });
      lastPage.drawText(`Signed: ${ts}`, { x: sigX, y: sigY - 24, size: 8 });

      if (deliveryNote.trim()) {
        const noteLabel = `Note: ${deliveryNote.trim()}`;
        const maxCharsPerLine = 80;
        const lines: string[] = [];
        let remaining = noteLabel;
        while (remaining.length > maxCharsPerLine) {
          let breakAt = remaining.lastIndexOf(' ', maxCharsPerLine);
          if (breakAt < 40) breakAt = maxCharsPerLine;
          lines.push(remaining.substring(0, breakAt));
          remaining = remaining.substring(breakAt).trim();
        }
        lines.push(remaining);
        lines.forEach((line, idx) => {
          lastPage.drawText(line, { x: sigX, y: sigY - 38 - (idx * 11), size: 8 });
        });
      }

      const signedBytes = await pdfDoc.save();
      const path = `${order.id}/signed-${Date.now()}.pdf`;
      const { error: upErr } = await supabase.storage.from('invoices').upload(path, signedBytes, {
        contentType: 'application/pdf',
      });
      if (upErr) throw upErr;

      const { data: { user } } = await supabase.auth.getUser();
      let driverName: string | null = null;
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('id', user.id)
          .single();
        driverName = profile?.full_name || profile?.email || null;
      }
      const { error: updateErr } = await supabase.from('orders').update({
        signed_pdf_path: path,
        signer_name: signerName,
        delivery_note: deliveryNote.trim() || null,
        delivered: true,
        delivered_at: new Date().toISOString(),
        delivered_by: user?.id || null,
        delivered_by_name: driverName,
        status: 'delivered',
      }).eq('id', order.id);
      if (updateErr) throw updateErr;

      onDone();
    } catch (err: any) {
      console.error('Save failed:', err);
      setError(err.message || 'Unknown error');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-3">Customer signature</h2>
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">Printed name of signer</label>
          <input
            type="text"
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            placeholder="e.g. John Smith"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <p className="text-sm text-gray-600 mb-2">Have the customer sign below.</p>
        <div className="border-2 border-dashed border-gray-300 rounded-md mb-2">
          <SignatureCanvas ref={sigRef} canvasProps={{ width: 400, height: 200, className: 'w-full bg-white rounded-md' }} />
        </div>
        <button onClick={() => sigRef.current?.clear()} className="text-xs text-gray-500 hover:text-gray-700 mb-3">Clear</button>
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-1">Delivery note (optional)</label>
          <textarea
            value={deliveryNote}
            onChange={(e) => setDeliveryNote(e.target.value)}
            rows={2}
            placeholder="e.g. Changed quantity to 8,500 gallons"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <p className="text-xs text-gray-400 mt-1">This note will be stamped on the signed invoice.</p>
        </div>
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-md">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md disabled:opacity-50">
            {saving ? 'Saving…' : 'Save & mark delivered'}
          </button>
        </div>
      </div>
    </div>
  );
}
