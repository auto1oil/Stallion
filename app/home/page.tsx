import Link from 'next/link';
import MarketingNav from '@/components/MarketingNav';

export const metadata = { title: 'Stallion' };

// Public marketing home — the only page a logged-out visitor lands on.
// Contact details come off the company letterhead (same as the haul-ticket
// PDF header), so the public page and the paperwork always agree.
export default function HomePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <MarketingNav />

      {/* Hero */}
      <section className="bg-brand-900 text-white">
        <div className="max-w-5xl mx-auto px-4 py-16 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/stallion-logo.png" alt="Stallion Tank" className="h-16 w-auto mx-auto mb-6 bg-white px-4 py-3 rounded-lg" />
          <h1 className="sr-only">Stallion Tank</h1>
          <p className="mt-3 text-brand-50 max-w-2xl mx-auto">
            Hauling and site work, with every day&apos;s ticket filed, approved, and
            invoiced the same day it&apos;s worked.
          </p>
          <div className="mt-6 flex gap-3 justify-center flex-wrap">
            <Link href="/login" className="px-5 py-2.5 bg-accent-400 text-white rounded-md font-semibold hover:bg-accent-500">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <main className="max-w-5xl mx-auto px-4 py-12 space-y-12">
        {/* About */}
        <section>
          <h2 className="text-2xl font-bold text-brand-900 mb-3">About us</h2>
          <p className="text-gray-700 max-w-3xl">
            Stallion Tank runs hauling crews and equipment on job sites across
            Utah — belly dumps, side dumps, end dumps, water trucks, and the
            dirt, gravel, and asphalt they move — billing by the hour or the
            ton against the phase codes each job is set up under.
          </p>
        </section>

        {/* How the paperwork works */}
        <section>
          <h2 className="text-2xl font-bold text-brand-900 mb-4">How a day gets billed</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              ['1 · The crew files it', 'The operator fills out the field ticket on the job — times, tonnage, unit — and photographs the paper ticket.'],
              ['2 · The office audits it', 'The office checks the ticket against the photo, fixes anything off, and approves.'],
              ['3 · The customer is invoiced', 'Approval raises the QuickBooks invoice the same minute, with the hours and rate already on it.'],
              ['Contractors sign off', 'Each contractor sees their crews’ days and hours and approves their own portion.'],
              ['Funding follows the ticket', 'The funder sees every order and the trucks on each job, and approves funds without an email chain.'],
              ['Nothing gets re-keyed', 'One ticket, one set of numbers, from the job site to the invoice.'],
            ].map(([t, d]) => (
              <div key={t} className="bg-white border border-gray-200 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900">{t}</h3>
                <p className="text-sm text-gray-600 mt-1">{d}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-bold text-brand-900 mb-3">Contact</h2>
          <p className="text-gray-700">
            Stallion Tank LLC
            <br />150 North Main St, Suite 102
            <br />Bountiful, UT 84010
          </p>
          <p className="text-gray-700 mt-2">
            <a href="mailto:Office@Stalliontank.com" className="text-brand-700 hover:underline">
              Office@Stalliontank.com
            </a>
          </p>
        </section>
      </main>

      <footer className="border-t border-gray-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 py-6 text-sm text-gray-500 flex items-center justify-between flex-wrap gap-2">
          <span>© {new Date().getFullYear()} Stallion Tank LLC</span>
          <Link href="/login" className="text-brand-700 hover:underline">Staff sign in</Link>
        </div>
      </footer>
    </div>
  );
}
