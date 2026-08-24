'use client';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { fillQuotePdf, shareOrDownloadPdf, repLine } from '@/lib/quote-pdf';
import { tierMarkupForGallons, applyMarkup, type FuelTier } from '@/lib/fuel-prices';

// Map an inventory item name to its fuel app-product so it's priced from the
// rack + volume formula (never a manual/special price). Same matcher the invoice
// adjuster uses. Returns null for non-fuel items.
function appFuelProduct(name: string): string | null {
  const n = (name || '').toLowerCase().trim();
  if (!n) return null;
  if (/\b(tax|excise|lust|hazard|envir|cleanup|fee)\b/.test(n)) return null;
  if (/dyed/.test(n) && /(dsl|diesel|fuel|gal)/.test(n)) return 'Dyed Fuel';
  if (/clear/.test(n) && /(dsl|diesel|fuel|gal)/.test(n)) return 'Clear Fuel';
  if (/(^|\D)91(\D|$)|premium/.test(n)) return '91-Octane';
  if (/(gasoline|unleaded|octane|regular|(^|\D)8[57](\D|$)|\bgas\b)/.test(n)) return '85-Octane';
  return null;
}
const FUEL_PRODUCTS = ['Clear Fuel', 'Dyed Fuel', '91-Octane', '85-Octane'];

type Biz = { id: string; name: string; address: string | null; phone: string | null };
type Inv = { id: string; qb_name: string; description: string | null; packaging: string | null; retail_price: number | null };
type Me = { id: string; name: string; phone?: string | null; email?: string | null };
type Line = { invId: string; desc: string; cat: string; pack: string; unit: string; price: number; special?: boolean; requested?: string; shortFuel?: boolean; fuelProduct?: string | null; gallons?: string };

// An existing quote loaded for editing (admin only).
export type EditQuote = {
  id: string;
  business_id: string | null;
  customer_company: string | null;
  customer_contact: string | null;
  customer_address: string | null;
  customer_phone_email: string | null;
  sales_rep_name: string | null;
  sales_rep_phone: string | null;
  sales_rep_email: string | null;
  valid_thru: string | null;
  line_items: Array<{ desc?: string; cat?: string; pack?: string; unit?: string; price?: string; requested_price?: string | null; special?: boolean; inventory_item_id?: string; gallons?: number | null; fuel_product?: string | null }>;
};

function stripPkg(s: string) { const i = (s || '').indexOf(':'); return i >= 0 ? s.slice(i + 1).trim() : s; }

const num = (s?: string | null) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.]/g, '')); return isFinite(n) ? n : 0; };

// Rebuild editable Line[] from a saved quote's line_items.
function linesFromQuote(items: EditQuote['line_items']): Line[] {
  return (items || []).map((li) => ({
    invId: li.inventory_item_id || '',
    desc: li.desc || '',
    cat: li.cat || '',
    pack: li.pack || '',
    unit: li.unit || '',
    price: num(li.price),
    special: !!li.special,
    requested: li.requested_price ? String(num(li.requested_price)) : '',
    fuelProduct: li.fuel_product || null,
    shortFuel: !!li.fuel_product,
    gallons: li.gallons != null ? String(li.gallons) : '',
  }));
}

// Fuel whose price is only good for a few days — clear/dyed fuel and gasoline
// (85/91 octane). Same definition the commission engine uses for fuel lines.
function isShortFuel(name: string): boolean {
  const b = (name || '').toLowerCase();
  if (/dyed/.test(b) && /(dsl|diesel|fuel|gal)/.test(b)) return true;
  if (/clear/.test(b) && /(dsl|diesel|fuel|gal)/.test(b)) return true;
  return /(gasoline|unleaded|octane)/.test(b);
}

// Default validity windows: 60 days normally; 5 days when the quote contains a
// fuel product. Reps can shorten but never extend past these caps.
const NORMAL_DAYS = 30, FUEL_DAYS = 5;
function ymdPlusDays(n: number): string {
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Build a price quote from inventory (prices locked to inventory/QuickBooks),
// generate the filled PDF, share it from the phone, and save it to Sent Quotes.
export default function QuoteBuilder({ me, editQuote, onClose, onSaved }: { me: Me; editQuote?: EditQuote | null; onClose: () => void; onSaved: () => void }) {
  const supabase = createClient();
  const [bizList, setBizList] = useState<Biz[]>([]);
  const [inv, setInv] = useState<Inv[]>([]);
  const [fuelBase, setFuelBase] = useState<Record<string, number>>({});
  const [fuelTiers, setFuelTiers] = useState<FuelTier[]>([]);
  const [biz, setBiz] = useState<Biz | null>(null);
  const [company, setCompany] = useState(editQuote?.customer_company || '');
  const [contact, setContact] = useState(editQuote?.customer_contact || '');
  const [address, setAddress] = useState(editQuote?.customer_address || '');
  const [phoneEmail, setPhoneEmail] = useState(editQuote?.customer_phone_email || '');
  const [validThru, setValidThru] = useState(editQuote?.valid_thru || '');
  const [vtTouched, setVtTouched] = useState(!!editQuote); // keep the saved date on edit
  const [lines, setLines] = useState<Line[]>(() => editQuote ? linesFromQuote(editQuote.line_items) : []);
  const [bizSearch, setBizSearch] = useState('');
  const [invSearch, setInvSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    (async () => {
      const [b, prodRes] = await Promise.all([
        supabase.from('businesses').select('id, name, address, phone').order('name'),
        // Full catalog via a server route — inventory_items RLS hides inactive /
        // admin_only rows from non-admin staff, so a direct query would leave
        // salesmen unable to quote products they legitimately sell.
        fetch('/api/quote-products').then((r) => r.json()).catch(() => ({ items: [] })),
      ]);
      setBizList((b.data as Biz[]) || []);
      setInv((prodRes?.items as Inv[]) || []);

      // Fuel pricing context: rack base price per product + the standard volume
      // tiers (fuel is always priced by gallons from the formula, never special).
      const [mapRes, tierRes] = await Promise.all([
        supabase.from('fuel_price_mappings').select('app_product, rack_location, rack_product').in('app_product', FUEL_PRODUCTS),
        supabase.from('fuel_pricing_tiers').select('min_gallons, max_gallons, markup, sort_order'),
      ]);
      const maps = (mapRes.data as { app_product: string; rack_location: string; rack_product: string }[]) || [];
      const base: Record<string, number> = {};
      await Promise.all(maps.map(async (mp) => {
        const { data } = await supabase.from('rack_prices').select('price')
          .eq('location', mp.rack_location).eq('product', mp.rack_product)
          .order('eff_date', { ascending: false, nullsFirst: false })
          .order('received_at', { ascending: false }).limit(1);
        const v = data && data[0] ? Number((data[0] as { price: number }).price) : null;
        if (v != null) base[mp.app_product] = v;
      }));
      setFuelBase(base);
      setFuelTiers((tierRes.data as FuelTier[]) || []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effective per-unit price for a line: fuel is rack + tier markup for its
  // gallons; everything else is its locked inventory retail price.
  const linePrice = (l: Line): number => {
    if (l.fuelProduct) {
      const gal = parseFloat((l.gallons || '').replace(/[^0-9.]/g, ''));
      const base = fuelBase[l.fuelProduct];
      if (!(gal > 0) || base == null) return 0;
      return applyMarkup(base, tierMarkupForGallons(fuelTiers, gal) ?? 0);
    }
    return l.price;
  };

  function pickBiz(b: Biz) {
    setBiz(b); setCompany(b.name); setAddress(b.address || ''); setPhoneEmail(b.phone || ''); setBizSearch('');
  }
  function addInv(it: Inv) {
    if (lines.length >= 10) { setErr('A quote holds up to 10 products.'); return; }
    setErr('');
    const fullName = `${it.description || ''} ${it.qb_name}`;
    const fuelProduct = appFuelProduct(fullName);
    setLines((p) => [...p, {
      invId: it.id, desc: stripPkg(it.description || it.qb_name),
      cat: fuelProduct ? 'Fuel' : '', pack: it.packaging || '', unit: fuelProduct ? 'GAL' : '',
      price: Number(it.retail_price || 0), special: false, requested: '',
      shortFuel: !!fuelProduct || isShortFuel(fullName), fuelProduct, gallons: '',
    }]);
    setInvSearch('');
  }
  const removeLine = (idx: number) => setLines((p) => p.filter((_, i) => i !== idx));
  const setField = (idx: number, k: keyof Line, v: string) => setLines((p) => p.map((l, i) => i === idx ? { ...l, [k]: v } : l));
  const toggleSpecial = (idx: number, on: boolean) => setLines((p) => p.map((l, i) => i === idx ? { ...l, special: on, requested: on ? l.requested : '' } : l));

  const bizMatches = useMemo(() => {
    const n = bizSearch.trim().toLowerCase(); if (!n) return [];
    return bizList.filter((b) => b.name.toLowerCase().includes(n)).slice(0, 8);
  }, [bizSearch, bizList]);
  const invMatches = useMemo(() => {
    const n = invSearch.trim().toLowerCase(); if (!n) return [];
    return inv.filter((it) => {
      const hay = `${it.description || ''} ${it.qb_name}`;
      // Hide non-product line items (taxes, fees, surcharges) that also live in
      // inventory_items but shouldn't be quotable.
      if (/\b(tax|excise|lust|hazmat|hazard|environmental|cleanup|surcharge|\bfee\b)\b/i.test(hay)) return false;
      return hay.toLowerCase().includes(n);
    }).slice(0, 50);
  }, [invSearch, inv]);

  // Validity cap: 5 days if any fuel product is in the quote, else 60.
  const maxDays = useMemo(() => (lines.some((l) => l.shortFuel) ? FUEL_DAYS : NORMAL_DAYS), [lines]);
  const maxDate = useMemo(() => ymdPlusDays(maxDays), [maxDays]);
  const todayStr = useMemo(() => ymdPlusDays(0), []);
  // Default to the longest allowed window; if the rep set a date, only clamp it
  // DOWN to the cap (they can shorten, never extend past it).
  useEffect(() => {
    setValidThru((prev) => (!vtTouched ? maxDate : (prev && prev > maxDate ? maxDate : prev)));
  }, [maxDate, vtTouched]);

  // A line is a valid special-price request only if toggled on with a number > 0.
  const reqNum = (l: Line) => { const n = parseFloat((l.requested || '').replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : NaN; };
  const hasSpecial = lines.some((l) => l.special);

  async function generate() {
    if (!company.trim()) { setErr('Pick or enter a customer.'); return; }
    if (lines.length === 0) { setErr('Add at least one product.'); return; }
    if (lines.some((l) => l.special && isNaN(reqNum(l)))) { setErr('Enter a requested price for each special-price line.'); return; }
    const fuelBad = lines.filter((l) => l.fuelProduct && !(linePrice(l) > 0));
    if (fuelBad.length) { setErr(`Enter gallons for: ${fuelBad.map((l) => l.desc).join(', ')} (fuel is priced by volume; a current rack price must exist).`); return; }
    const noPrice = lines.filter((l) => !l.special && !l.fuelProduct && !(l.price > 0));
    if (noPrice.length) { setErr(`No inventory price set for: ${noPrice.map((l) => l.desc).join(', ')}. Set it in Inventory, or tick “Request special price” to quote it.`); return; }
    setBusy(true); setErr('');
    // Never allow validity past the cap (e.g. fuel added after the date was set).
    const vt = validThru && validThru > maxDate ? maxDate : validThru;
    try {
      const line_items = lines.map((l) => {
        const isFuel = !!l.fuelProduct;
        const special = !isFuel && !!l.special && !isNaN(reqNum(l));
        const gal = parseInt((l.gallons || '').replace(/[^0-9]/g, ''), 10) || null;
        return {
          desc: l.desc,
          cat: l.cat,
          pack: isFuel && gal ? `${gal} gal` : l.pack,
          unit: isFuel ? 'GAL' : l.unit,
          // Fuel snapshots the per-gallon rack+tier price at quote time (to 4dp).
          price: isFuel ? `$${linePrice(l).toFixed(4)}` : `$${l.price.toFixed(2)}`,
          requested_price: special ? `$${reqNum(l).toFixed(2)}` : null,
          special,
          inventory_item_id: l.invId,
          gallons: gal,
          fuel_product: l.fuelProduct || null,
        };
      });
      const special = line_items.some((li) => li.special);
      const fields = {
        business_id: biz?.id ?? editQuote?.business_id ?? null,
        customer_company: company.trim(),
        customer_contact: contact.trim() || null,
        customer_address: address.trim() || null,
        customer_phone_email: phoneEmail.trim() || null,
        valid_thru: vt || null,
        line_items,
        has_special_pricing: special,
        status: special ? 'pending_approval' : 'sent',
        sent_at: special ? null : new Date().toISOString(),
      };
      const q0 = editQuote
        ? await supabase.from('quotes').update(fields).eq('id', editQuote.id).select('quote_number, quote_date').single()
        : await supabase.from('quotes').insert({
            ...fields,
            sales_rep_id: me.id, sales_rep_name: me.name, sales_rep_phone: me.phone || null, sales_rep_email: me.email || null,
          }).select('quote_number, quote_date').single();
      const { data, error } = q0;
      if (error || !data) { setErr(error?.message || 'Could not save the quote.'); setBusy(false); return; }
      const q = data as { quote_number: string; quote_date: string };

      // Special pricing → wait for admin approval; don't generate the PDF yet.
      if (special) { setSubmitted(true); setBusy(false); return; }

      const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-US');
      const bytes = await fillQuotePdf({
        quote_number: q.quote_number,
        quote_date: fmt(q.quote_date),
        valid_thru: vt ? fmt(vt) : '',
        customer_company: company, customer_contact: contact, customer_address: address, customer_phone_email: phoneEmail,
        // On edit keep the original rep's contact on the PDF; on create it's me.
        sales_rep: editQuote
          ? repLine(editQuote.sales_rep_name, editQuote.sales_rep_phone, editQuote.sales_rep_email)
          : repLine(me.name, me.phone, me.email),
        lines: line_items.map((li) => ({ desc: li.desc, cat: li.cat, pack: li.pack, unit: li.unit, price: li.price })),
      });
      await shareOrDownloadPdf(bytes, `Quote ${q.quote_number} - ${company}.pdf`);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to generate the quote.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-3" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-lg my-8 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="font-semibold text-sm">{submitted ? 'Sent for approval' : editQuote ? 'Edit price quote' : 'New price quote'}</h2>
          <button onClick={submitted ? onSaved : onClose} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
        </div>

        {submitted ? (
          <div className="p-5 text-center space-y-3">
            <div className="text-3xl">⏳</div>
            <p className="text-sm font-medium text-gray-800">Special pricing requested</p>
            <p className="text-xs text-gray-500">
              An admin has been notified. Once it&apos;s approved you&apos;ll get a notification, then you can send the quote
              at the approved price. If it&apos;s denied you can still send it at standard pricing. It&apos;s saved under Quotes.
            </p>
            <button onClick={onSaved} className="mt-1 px-4 py-1.5 text-sm rounded-md bg-brand-700 text-white hover:bg-brand-900 font-medium">Done</button>
          </div>
        ) : (
        <>
        <div className="p-4 space-y-3">
          {/* Customer — find an existing one, or just type a new/potential customer below */}
          <div className="relative">
            <label className="block text-xs font-medium text-gray-600 mb-1">Find existing customer <span className="text-gray-400 font-normal">(optional)</span></label>
            <input value={bizSearch} onChange={(e) => setBizSearch(e.target.value)} placeholder="Search customers…"
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
            {bizMatches.length > 0 && (
              <div className="absolute z-10 bg-white border border-gray-200 rounded mt-1 w-full shadow max-h-48 overflow-y-auto">
                {bizMatches.map((b) => (
                  <button key={b.id} onClick={() => pickBiz(b)} className="block w-full text-left px-2 py-1.5 text-sm hover:bg-gray-50">{b.name}</button>
                ))}
              </div>
            )}
            <p className="mt-1 text-[11px] text-gray-400">New or potential customer? Just type their info below — no need to pick from the list.</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-gray-600 col-span-2">Company
              <input value={company} onChange={(e) => setCompany(e.target.value)} className="mt-0.5 w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></label>
            <label className="text-xs text-gray-600">Contact
              <input value={contact} onChange={(e) => setContact(e.target.value)} className="mt-0.5 w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></label>
            <label className="text-xs text-gray-600">Phone / Email
              <input value={phoneEmail} onChange={(e) => setPhoneEmail(e.target.value)} className="mt-0.5 w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></label>
            <label className="text-xs text-gray-600 col-span-2">Address
              <input value={address} onChange={(e) => setAddress(e.target.value)} className="mt-0.5 w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></label>
            <label className="text-xs text-gray-600 col-span-2">Valid through
              <input type="date" value={validThru} min={todayStr} max={maxDate}
                onChange={(e) => { const v = e.target.value; setVtTouched(true); setValidThru(v && v > maxDate ? maxDate : v); }}
                className="mt-0.5 w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
              <span className="mt-0.5 block text-[11px] text-gray-400">
                Pricing is good up to {maxDays} days{maxDays === FUEL_DAYS ? ' (fuel)' : ''}. You can shorten it but not extend past {new Date(maxDate + 'T00:00:00').toLocaleDateString('en-US')}.
              </span>
            </label>
          </div>

          {/* Products */}
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">Products <span className="text-gray-400 font-normal">({lines.length}/10 · inventory price; fuel priced by gallons)</span></div>
            {hasSpecial && <p className="text-[11px] text-amber-700 mb-1">Special pricing needs admin approval — this quote will be held until it&apos;s approved.</p>}
            <div className="space-y-1.5 mb-2">
              {lines.map((l, i) => (
                <div key={i} className="bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{l.desc}</div>
                      <div className="text-[11px] text-gray-500">{l.pack}</div>
                    </div>
                    <span className={`text-sm font-semibold tabular-nums ${l.special ? 'line-through text-gray-400' : ''}`}>
                      {l.fuelProduct
                        ? (linePrice(l) > 0 ? `$${linePrice(l).toFixed(4)}/gal` : '—')
                        : `$${l.price.toFixed(2)}`}
                    </span>
                    <button onClick={() => removeLine(i)} className="text-red-600 text-xs hover:text-red-800">Remove</button>
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    {l.fuelProduct ? (
                      <>
                        <label className="flex items-center gap-1 text-[11px] text-gray-600 select-none">
                          Gallons
                          <input value={l.gallons || ''} onChange={(e) => setField(i, 'gallons', e.target.value)} inputMode="numeric" placeholder="0"
                            className="w-24 px-1.5 py-0.5 border border-gray-300 rounded text-xs tabular-nums" />
                        </label>
                        <span className="text-[11px] text-gray-500">
                          {fuelBase[l.fuelProduct] == null
                            ? 'no current rack price'
                            : linePrice(l) > 0
                              ? `priced by volume · $${linePrice(l).toFixed(4)}/gal`
                              : 'enter gallons to price'}
                        </span>
                      </>
                    ) : (
                      <>
                        <label className="flex items-center gap-1 text-[11px] text-gray-600 select-none">
                          <input type="checkbox" checked={!!l.special} onChange={(e) => toggleSpecial(i, e.target.checked)} />
                          Request special price
                        </label>
                        {l.special && (
                          <div className="flex items-center gap-1">
                            <span className="text-[11px] text-amber-700 font-medium">Requested $</span>
                            <input value={l.requested || ''} onChange={(e) => setField(i, 'requested', e.target.value)} inputMode="decimal" placeholder="0.00"
                              className="w-20 px-1.5 py-0.5 border border-amber-300 rounded text-xs tabular-nums" />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {lines.length < 10 && (
              <div className="relative">
                <input value={invSearch} onChange={(e) => setInvSearch(e.target.value)} placeholder="Add a product from inventory…"
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
                {invMatches.length > 0 && (
                  <div className="absolute z-10 bg-white border border-gray-200 rounded mt-1 w-full shadow max-h-48 overflow-y-auto">
                    {invMatches.map((it) => (
                      <button key={it.id} onClick={() => addInv(it)} className="block w-full text-left px-2 py-1.5 text-sm hover:bg-gray-50">
                        {stripPkg(it.description || it.qb_name)} <span className="text-gray-400">· {it.packaging || ''} · {appFuelProduct(`${it.description || ''} ${it.qb_name}`) ? 'priced by gallons' : it.retail_price != null ? `$${Number(it.retail_price).toFixed(2)}` : 'no price set'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50">Cancel</button>
          <button onClick={generate} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-brand-700 text-white hover:bg-brand-900 disabled:opacity-50 font-medium">
            {busy ? (hasSpecial ? 'Sending…' : 'Saving…') : (hasSpecial ? 'Request approval' : editQuote ? 'Save & Share' : 'Generate & Share')}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
