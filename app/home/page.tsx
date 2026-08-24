import Link from 'next/link';
import MarketingNav from '@/components/MarketingNav';

export const metadata = { title: 'Auto 1 Oil' };

// Public marketing home. Placeholder copy — replace the TODO(content) text with
// the real auto1oil.com homepage content.
export default function HomePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <MarketingNav />

      {/* Hero */}
      <section className="bg-brand-900 text-white">
        <div className="max-w-5xl mx-auto px-4 py-16 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/auto1-logo.png" alt="Auto 1 Oil" className="h-14 w-auto mx-auto mb-6 bg-white px-3 py-2 rounded" />
          <h1 className="text-3xl sm:text-4xl font-bold">Auto 1 Oil Company</h1>
          <p className="mt-3 text-brand-50 max-w-2xl mx-auto">
            A state-of-the-art oil, fuel, DEF, and trucking distributor based in Lehi, Utah —
            top-tier lubricants at market-competitive prices.
          </p>
          <div className="mt-6 flex gap-3 justify-center flex-wrap">
            <Link href="/products" className="px-5 py-2.5 bg-accent-400 text-brand-900 rounded-md font-semibold hover:bg-accent-500">
              View products
            </Link>
            <Link href="/shop/login" className="px-5 py-2.5 bg-white text-brand-900 rounded-md font-semibold hover:bg-gray-100">
              Order products →
            </Link>
          </div>
          <div className="mt-3 flex gap-4 justify-center text-sm">
            <Link href="/shop/login" className="text-white/90 hover:text-white underline">Customer login</Link>
            <Link href="/login" className="text-white/90 hover:text-white underline">Staff login</Link>
          </div>
        </div>
      </section>

      <main className="max-w-5xl mx-auto px-4 py-12 space-y-12">
        {/* About */}
        <section>
          <h2 className="text-2xl font-bold text-brand-900 mb-3">About us</h2>
          <p className="text-gray-700 max-w-3xl">
            Auto 1 Oil is a state-of-the-art distribution company in Lehi, Utah, focused on
            lubrication excellence — bringing top-tier oil, fuel, DEF, coolant, and wash
            products to businesses at market-competitive prices. We follow the West Texas
            Index and adjust pricing quarterly to stay competitive.
          </p>
        </section>

        {/* Services */}
        <section>
          <h2 className="text-2xl font-bold text-brand-900 mb-4">What we offer</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              ['Fuel & DEF', 'Fuel and diesel exhaust fluid delivery for fleets and equipment.'],
              ['Oils & lubricants', 'A full line of motor oils, gear oils, hydraulics, and grease.'],
              ['Coolant & wash', 'Coolants and wash products to round out your shop.'],
              ['Trucking', 'In-house trucking and dependable delivery.'],
              ['Market pricing', 'Quarterly pricing tied to the West Texas Index.'],
              ['Data sheets', 'Product (PDS) and Safety (SDS) data sheets for every product.'],
            ].map(([t, d]) => (
              <div key={t} className="bg-white border border-gray-200 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900">{t}</h3>
                <p className="text-sm text-gray-600 mt-1">{d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Contact — TODO(content): real phone/email/address */}
        <section>
          <h2 className="text-2xl font-bold text-brand-900 mb-3">Contact</h2>
          <p className="text-gray-700">
            Phone, email, and address go here. Or use the <strong>Chat with us</strong> button
            in the corner of the screen.
          </p>
        </section>
      </main>

      <footer className="border-t border-gray-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 py-6 text-sm text-gray-500 flex items-center justify-between flex-wrap gap-2">
          <span>© {new Date().getFullYear()} Auto 1 Oil Company</span>
          <Link href="/shop/login" className="text-brand-700 hover:underline">Customer login</Link>
        </div>
      </footer>
    </div>
  );
}
