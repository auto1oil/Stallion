'use client';

// Admin "Forms" tab — the blank fillable forms (customer profile, sales-tax
// TC-721, W-9). Download a blank, or fill one out in-app for a specific person;
// the filled copy is saved into the Documents library (under "Filled forms").

import { useState } from 'react';
import AdminSubNav from '@/components/AdminSubNav';
import BlankFormFiller from '@/components/BlankFormFiller';
import { W9_CONFIG } from '@/lib/pdf-forms';

// Friendly labels for the W-9 fillable fields, lifted from the guided config.
const W9_LABELS: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const sec of W9_CONFIG.sections) {
    for (const f of sec.fields) {
      if (f.kind === 'text') m[f.field] = f.label;
      if (f.kind === 'radio') for (const o of f.options) m[o.field] = `${f.label}: ${o.label}`;
    }
  }
  if (W9_CONFIG.tin) {
    W9_CONFIG.tin.ssn.forEach((f, i) => { m[f] = `SSN (part ${i + 1})`; });
    W9_CONFIG.tin.ein.forEach((f, i) => { m[f] = `EIN (part ${i + 1})`; });
  }
  return m;
})();

const BLANKS: { key: string; label: string; blankUrl: string; labelMap?: Record<string, string> }[] = [
  { key: 'profile', label: 'Customer profile', blankUrl: '/forms/customer-profile.pdf' },
  { key: 'tax_exempt', label: 'Sales Tax-Exempt (TC-721)', blankUrl: '/forms/tc-721-sales-tax-exempt.pdf' },
  { key: 'w9', label: 'W-9', blankUrl: '/forms/w-9.pdf', labelMap: W9_LABELS },
  { key: 'price_quote', label: 'Price Quote', blankUrl: '/forms/price-quote.pdf' },
];

export default function AdminFormsPage() {
  const [fill, setFill] = useState<{ blankUrl: string; title: string; labelMap?: Record<string, string> } | null>(null);
  const [savedMsg, setSavedMsg] = useState('');

  return (
    <div className="max-w-2xl">
      <AdminSubNav
        tabs={[
          { href: '/admin/customers', label: 'Existing customers' },
          { href: '/salesman/businesses', label: 'Customers visited' },
          { href: '/admin/forms', label: 'Forms' },
          { href: '/admin/quotes', label: 'Quotes' },
        ]}
      />
      <h1 className="text-2xl font-semibold mb-1">Forms</h1>
      <p className="text-sm text-gray-500 mb-4">
        Blank fillable forms. Download a blank, or fill one out for a specific person — the filled
        copy is saved in the Documents tab (under “Filled forms”) so you can send it.
      </p>

      {savedMsg && (
        <div className="mb-3 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">{savedMsg}</div>
      )}

      <div className="space-y-2">
        {BLANKS.map((b) => (
          <div key={b.key} className="flex items-center justify-between gap-2 flex-wrap bg-white border border-gray-200 rounded-lg px-4 py-3">
            <span className="text-sm font-medium">{b.label}</span>
            <div className="flex items-center gap-3 text-sm">
              <a href={b.blankUrl} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">Download blank</a>
              <button onClick={() => { setSavedMsg(''); setFill({ blankUrl: b.blankUrl, title: `Fill out — ${b.label}`, labelMap: b.labelMap }); }}
                className="px-2.5 py-1 rounded-md bg-brand-600 text-white text-xs font-medium hover:bg-brand-700">
                Fill out
              </button>
            </div>
          </div>
        ))}
      </div>

      {fill && (
        <BlankFormFiller
          blankUrl={fill.blankUrl}
          title={fill.title}
          defaultName={fill.title.replace('Fill out — ', '')}
          labelMap={fill.labelMap}
          onClose={() => setFill(null)}
          onSaved={() => { setFill(null); setSavedMsg('Saved to the Documents tab under “Filled forms”.'); }}
        />
      )}
    </div>
  );
}
