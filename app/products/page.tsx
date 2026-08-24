import Link from 'next/link';
import MarketingNav from '@/components/MarketingNav';
import { CATALOG, CATALOG_CATEGORIES } from '@/lib/catalog';

export const metadata = { title: 'Products — Auto 1 Oil' };

// Public products page (no purchasing). Each product links to its Product Data
// Sheet (PDS) and Safety Data Sheet (SDS). This is the app's landing page.
export default function ProductsPage() {
  const byCat = CATALOG_CATEGORIES
    .map((cat) => ({ cat, items: CATALOG.filter((p) => p.category === cat) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <MarketingNav />
      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
          <div>
            <h1 className="text-3xl font-bold text-brand-900">Products</h1>
            <p className="text-sm text-gray-600 mt-1 max-w-xl">
              Browse our product line and download the Product Data Sheet (PDS) and
              Safety Data Sheet (SDS) for each. Ready to order?
            </p>
          </div>
          <Link href="/shop/login"
            className="px-4 py-2 bg-brand-700 text-white rounded-md font-medium hover:bg-brand-900 whitespace-nowrap">
            Order products →
          </Link>
        </div>

        <div className="space-y-8">
          {byCat.map(({ cat, items }) => (
            <section key={cat}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">{cat}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {items.map((p) => (
                  <div key={p.slug} className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col">
                    <h3 className="font-semibold text-gray-900">{p.name}</h3>
                    <p className="text-sm text-gray-600 mt-1 flex-1">{p.description}</p>
                    <div className="flex gap-2 mt-3">
                      <SheetButton label="PDS" url={p.pdsUrl} />
                      <SheetButton label="SDS" url={p.sdsUrl} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

function SheetButton({ label, url }: { label: string; url?: string }) {
  if (!url) {
    return (
      <span className="px-3 py-1.5 text-xs rounded-md border border-gray-200 text-gray-400 bg-gray-50">
        {label} · coming soon
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="px-3 py-1.5 text-xs rounded-md border border-brand-300 text-brand-700 hover:bg-brand-50 font-medium inline-flex items-center gap-1">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      {label}
    </a>
  );
}
