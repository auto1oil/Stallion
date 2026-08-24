'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import CustomersSubNav from '@/components/CustomersSubNav';
import VisitForm from '@/components/VisitForm';

// One row in the salesman_visits table. We pull every visit (across all
// salesmen) so the page can answer "when did anyone last drop in on Joe's
// Auto?". Read access is gated by the "Salesmen view all visits" RLS policy.
type Visit = {
  id: string;
  salesman_id: string | null;
  salesman_name: string;
  business_name: string;
  city: string | null;
  contact_person: string | null;
  notes: string | null;
  visit_date: string;
  visit_at: string;
};

type Customer = {
  id: string;
  business_name: string | null;
  city: string | null;
  full_name: string | null;
  email: string;
};

// One stored business-card photo, keyed by the same normalized name+city
// string the businesses list buckets on (see `key` in the Business type).
type BusinessCard = {
  business_key: string;
  file_path: string;
};

// Aggregated "this is a place we've been" row. Visits with the same
// normalized business name + city are bucketed into one entry. The display
// name/city comes from the most recent visit (preserves the salesman's
// casing/punctuation as the canonical label).
type Business = {
  key: string;
  displayName: string;
  displayCity: string;
  visitCount: number;
  lastVisit: Visit;
  isCustomer: boolean;
};

// Loose normalization for bucketing — case-insensitive, ignore punctuation,
// strip possessive + a handful of corporate suffixes so "Joe's Auto",
// "joes auto", and "Joes Auto LLC" all land in the same bucket.
function normName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[''`]s\b/g, '')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company)\b\.?/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normCity(raw: string | null): string {
  return (raw || '').toLowerCase().trim();
}

// Shrink a photo down to something tiny before it ever leaves the browser:
// cap the longest edge at 1000px and re-encode as JPEG. A phone snapshot of
// a business card drops from several MB to roughly 60–120 KB, so the bucket
// stays small. Returns a JPEG Blob.
async function compressImage(file: File, maxEdge = 1000, quality = 0.7): Promise<Blob> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  const img: HTMLImageElement = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Could not read that image.'));
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported.');
  ctx.drawImage(img, 0, 0, w, h);
  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new Error('Could not compress that image.');
  return blob;
}

function fmtRelative(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(then).getTime()) / 86_400_000,
  );
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return `${diffDays} days ago`;
  if (diffDays >= 7 && diffDays < 30) {
    const w = Math.floor(diffDays / 7);
    return `${w} week${w === 1 ? '' : 's'} ago`;
  }
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function SalesmanBusinessesPage() {
  const supabase = createClient();
  const [visits, setVisits] = useState<Visit[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Salespeople deselected from the view. Empty = everyone shown.
  const [hiddenSales, setHiddenSales] = useState<Set<string>>(new Set());
  // Quick-glance popover of all visit dates for one business.
  const [visitDetail, setVisitDetail] = useState<{ name: string; visits: Visit[] } | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [meName, setMeName] = useState<string>('Salesman');
  const [showLog, setShowLog] = useState(false);
  // business_key → stored file_path, and business_key → signed thumbnail URL.
  const [cardPaths, setCardPaths] = useState<Map<string, string>>(new Map());
  const [cardUrls, setCardUrls] = useState<Map<string, string>>(new Map());
  // The business whose card modal is open, or null when closed.
  const [editing, setEditing] = useState<{ key: string; name: string } | null>(null);

  async function loadCards() {
    const { data } = await supabase
      .from('business_cards')
      .select('business_key, file_path');
    const rows = (data as BusinessCard[]) || [];
    const paths = new Map<string, string>();
    rows.forEach((r) => paths.set(r.business_key, r.file_path));
    setCardPaths(paths);

    // Sign every card path in one batch so thumbnails can render.
    const urls = new Map<string, string>();
    await Promise.all(
      rows.map(async (r) => {
        const { data: signed } = await supabase.storage
          .from('business-cards')
          .createSignedUrl(r.file_path, 60 * 60);
        if (signed?.signedUrl) urls.set(r.business_key, signed.signedUrl);
      }),
    );
    setCardUrls(urls);
  }

  async function load() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    setMeId(user?.id || null);
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', user.id)
        .single();
      setMeName(profile?.full_name || profile?.email || 'Salesman');
    }

    const [vRes, cRes] = await Promise.all([
      supabase
        .from('salesman_visits')
        .select('*')
        .order('visit_at', { ascending: false }),
      supabase
        .from('profiles')
        .select('id, business_name, city, full_name, email')
        .eq('role', 'customer'),
    ]);
    setVisits((vRes.data as Visit[]) || []);
    setCustomers((cRes.data as Customer[]) || []);
    await loadCards();
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Index existing customers by normalized business name → the set of cities
  // they're in. A business in the visits log is tagged "✓ Customer" when its
  // normalized name + city is present in this index. A customer with no city
  // on file is stored as an empty-string entry — that becomes a wildcard so
  // we still tag matches against legacy profiles that pre-date the city
  // field. (Once they fill in city, the match tightens automatically.)
  const customerByName = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of customers) {
      if (!c.business_name) continue;
      const n = normName(c.business_name);
      if (!n) continue;
      const cityKey = normCity(c.city);
      const cities = m.get(n) ?? new Set<string>();
      cities.add(cityKey);
      m.set(n, cities);
    }
    return m;
  }, [customers]);

  function matchesCustomer(normalizedName: string, normalizedCity: string): boolean {
    const cities = customerByName.get(normalizedName);
    if (!cities) return false;
    // Empty city on the customer record is treated as a wildcard so legacy
    // customers without a city still match.
    if (cities.has('')) return true;
    return cities.has(normalizedCity);
  }

  // Bucket visits by (normalized name, normalized city) → one Business row.
  // Visits are pre-sorted desc by visit_at from the query, so the first
  // visit we see for a key is also the most-recent one (used as the display
  // label + lastVisit).
  // Distinct salespeople present in the visit log, for the filter toggles.
  const salespeople = useMemo(() => {
    const m = new Map<string, string>(); // key (id or name) -> display name
    for (const v of visits) {
      const key = v.salesman_id || v.salesman_name;
      if (key && !m.has(key)) m.set(key, v.salesman_name || 'Unknown');
    }
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, [visits]);

  // All visits grouped by the same (normName|normCity) key the businesses use.
  const visitsByKey = useMemo(() => {
    const m = new Map<string, Visit[]>();
    for (const v of visits) {
      const key = `${normName(v.business_name)}|${normCity(v.city)}`;
      const arr = m.get(key) || [];
      arr.push(v);
      m.set(key, arr);
    }
    return m;
  }, [visits]);

  function showVisitDates(b: Business) {
    const all = visitsByKey.get(b.key) || [];
    const cutoff = Date.now() - 365 * 86_400_000;
    const recent = all.filter((v) => new Date(v.visit_at).getTime() >= cutoff);
    setVisitDetail({ name: b.displayName, visits: recent.length ? recent : all });
  }

  function toggleSales(id: string) {
    setHiddenSales((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const businesses = useMemo<Business[]>(() => {
    const map = new Map<string, Business>();
    for (const v of visits) {
      // Skip visits whose salesperson is toggled off.
      if (hiddenSales.has(v.salesman_id || v.salesman_name)) continue;
      const n = normName(v.business_name);
      const c = normCity(v.city);
      if (!n) continue;
      const key = `${n}|${c}`;
      const existing = map.get(key);
      if (existing) {
        existing.visitCount += 1;
      } else {
        map.set(key, {
          key,
          displayName: v.business_name,
          displayCity: v.city || '',
          visitCount: 1,
          lastVisit: v,
          isCustomer: matchesCustomer(n, c),
        });
      }
    }
    // Alphabetical by business name. localeCompare with sensitivity: 'base'
    // ignores case + accents so "joe's auto" sorts next to "Joe's Auto".
    return Array.from(map.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visits, customerByName, hiddenSales]);

  // Type-ahead source for the Log-visit form: every existing customer first
  // (so reps log against the real account), then any other business already
  // in the visit log. Deduped by normalized name + city.
  const visitSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: { name: string; city: string | null }[] = [];
    const add = (name: string | null, city: string | null) => {
      if (!name) return;
      const key = `${normName(name)}|${normCity(city)}`;
      if (!normName(name) || seen.has(key)) return;
      seen.add(key);
      out.push({ name, city });
    };
    customers.forEach((c) => add(c.business_name, c.city));
    visits.forEach((v) => add(v.business_name, v.city));
    return out.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, [customers, visits]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return businesses;
    return businesses.filter(
      (b) =>
        b.displayName.toLowerCase().includes(q) ||
        b.displayCity.toLowerCase().includes(q),
    );
  }, [businesses, search]);

  return (
    <div>
      <CustomersSubNav />
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Customers Visited</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Everywhere any salesman has stopped, sorted A–Z.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/salesman"
            className="text-sm text-brand-700 hover:underline whitespace-nowrap"
          >
            ← My visits
          </Link>
          <button
            onClick={() => setShowLog(true)}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 font-medium whitespace-nowrap"
          >
            + Log visit
          </button>
        </div>
      </div>

      <input
        type="text"
        placeholder="Search business or city…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3"
      />

      {salespeople.length > 1 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-gray-500">Salespeople</span>
            <div className="flex gap-3 text-xs">
              <button onClick={() => setHiddenSales(new Set())} className="text-brand-700 hover:underline">
                Select all
              </button>
              <button onClick={() => setHiddenSales(new Set(salespeople.map((s) => s.id)))} className="text-brand-700 hover:underline">
                Clear
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {salespeople.map((s) => {
              const on = !hiddenSales.has(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => toggleSales(s.id)}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    on
                      ? 'bg-brand-50 border-brand-400 text-brand-800 font-medium'
                      : 'bg-white border-gray-300 text-gray-400 line-through'
                  }`}
                >
                  {on ? '✓ ' : ''}{s.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <p className="text-sm text-gray-500">
            {businesses.length === 0
              ? 'No visits logged yet. They\'ll show up here after the first one.'
              : 'No businesses match that search.'}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {filtered.map((b) => (
            <div
              key={b.key}
              className="px-4 py-3 flex items-start justify-between gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{b.displayName}</span>
                  {b.isCustomer && (
                    <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded-full border bg-green-50 text-green-800 border-green-200">
                      ✓ Customer
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {b.displayCity || <span className="text-gray-400">no city</span>}
                  {' · '}
                  Last visit {fmtRelative(b.lastVisit.visit_at)}
                  {' by '}
                  {b.lastVisit.salesman_id === meId ? 'you' : b.lastVisit.salesman_name}
                </div>
              </div>
              {/* Business-card thumbnail tucked into the gap before the
                  visit count. Click to upload (dashed placeholder) or to
                  view/replace an existing card. */}
              <button
                type="button"
                onClick={() => setEditing({ key: b.key, name: b.displayName })}
                title={cardUrls.has(b.key) ? 'View / change business card' : 'Add business card'}
                className="shrink-0 self-center"
              >
                {cardUrls.has(b.key) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={cardUrls.get(b.key)}
                    alt="Business card"
                    className="w-11 h-7 object-cover rounded border border-gray-200 hover:ring-2 hover:ring-brand-300"
                  />
                ) : (
                  <span className="block w-11 h-7 rounded border border-dashed border-gray-300 hover:border-brand-400" />
                )}
              </button>
              {b.visitCount > 1 ? (
                <button
                  onClick={() => showVisitDates(b)}
                  className="shrink-0 text-right rounded-md px-2 py-1 hover:bg-brand-50"
                  title="See visit dates"
                >
                  <div className="text-sm font-semibold tabular-nums text-brand-700 underline">{b.visitCount}</div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">visits</div>
                </button>
              ) : (
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold tabular-nums">{b.visitCount}</div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">
                    visit{b.visitCount === 1 ? '' : 's'}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {visitDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setVisitDetail(null)}>
          <div className="bg-white rounded-lg w-full max-w-sm max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{visitDetail.name}</div>
                <div className="text-[11px] text-gray-500">{visitDetail.visits.length} visit{visitDetail.visits.length === 1 ? '' : 's'} · last 12 months</div>
              </div>
              <button onClick={() => setVisitDetail(null)} className="text-sm px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Close</button>
            </div>
            <ul className="overflow-y-auto divide-y divide-gray-100">
              {visitDetail.visits.map((v) => (
                <li key={v.id} className="px-4 py-2 flex items-center justify-between gap-2 text-sm">
                  <span>{new Date(v.visit_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  <span className="text-xs text-gray-500 truncate">{v.salesman_id === meId ? 'You' : v.salesman_name}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {showLog && meId && (
        <VisitForm
          visit={null}
          salesmanId={meId}
          salesmanName={meName}
          suggestions={visitSuggestions}
          onClose={() => setShowLog(false)}
          onSaved={() => { setShowLog(false); load(); }}
        />
      )}

      {editing && (
        <BusinessCardModal
          businessKey={editing.key}
          businessName={editing.name}
          existingUrl={cardUrls.get(editing.key) || null}
          existingPath={cardPaths.get(editing.key) || null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await loadCards();
          }}
        />
      )}
    </div>
  );
}

// Modal for adding / viewing / replacing one business's card photo. Picking
// a file shows a preview; Save compresses it, uploads to the private
// `business-cards` bucket, and upserts the row keyed by the business.
function BusinessCardModal({
  businessKey,
  businessName,
  existingUrl,
  existingPath,
  onClose,
  onSaved,
}: {
  businessKey: string;
  businessName: string;
  existingUrl: string | null;
  existingPath: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const supabase = createClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null;
    setError(null);
    setPickedFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
  }

  // Clean up the object URL when the modal unmounts.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function save() {
    if (!pickedFile) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await compressImage(pickedFile);
      const safeKey = businessKey.replace(/[^a-z0-9]+/gi, '-').slice(0, 80);
      const path = `${safeKey}/${Date.now()}.jpg`;

      const { error: upErr } = await supabase.storage
        .from('business-cards')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (upErr) throw upErr;

      const { error: dbErr } = await supabase
        .from('business_cards')
        .upsert(
          { business_key: businessKey, business_name: businessName, file_path: path, uploaded_at: new Date().toISOString() },
          { onConflict: 'business_key' },
        );
      if (dbErr) throw dbErr;

      // Drop the previous image so the bucket doesn't accumulate orphans.
      if (existingPath && existingPath !== path) {
        await supabase.storage.from('business-cards').remove([existingPath]);
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Could not save the business card.');
      setSaving(false);
    }
  }

  const shown = previewUrl || existingUrl;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-1">Business card</h2>
        <p className="text-xs text-gray-500 mb-3 truncate">{businessName}</p>

        <div className="mb-4">
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shown}
              alt="Business card"
              className="w-full max-h-60 object-contain rounded border border-gray-200 bg-gray-50"
            />
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full h-40 flex items-center justify-center rounded border-2 border-dashed border-gray-300 text-gray-400 text-sm hover:border-brand-400 hover:text-brand-500"
            >
              Tap to choose a photo
            </button>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPick}
        />

        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={saving}
            className="text-sm text-brand-700 hover:underline disabled:opacity-50"
          >
            {shown ? 'Choose different photo' : 'Choose photo'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!pickedFile || saving}
              className="px-3 py-1.5 text-sm rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
