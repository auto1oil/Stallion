import Link from 'next/link';
import MarketingNav from '@/components/MarketingNav';

export const metadata = { title: 'Stallion' };

// Public marketing home — the only page a logged-out visitor lands on.
// Placeholder copy: replace the TODO(content) text and the contact block with
// the real business details before launch.
export default function HomePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <MarketingNav />

      {/* Hero */}
      <section className="bg-brand-900 text-white">
        <div className="max-w-5xl mx-auto px-4 py-16 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/stallion-logo.svg" alt="Stallion" className="h-14 w-auto mx-auto mb-6 bg-white px-3 py-2 rounded" />
          <h1 className="text-3xl sm:text-4xl font-bold">Stallion</h1>
          <p className="mt-3 text-brand-50 max-w-2xl mx-auto">
            {/* TODO(content): the real one-line description of the business. */}
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
            {/* TODO(content): the real About copy. */}
            Stallion runs hauling crews and equipment on job sites, billing by the
            hour or the ton against the phase codes each job is set up under.
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

        {/* Contact — TODO(content): real phone/email/address */}
        <section>
          <h2 className="text-2xl font-bold text-brand-900 mb-3">Contact</h2>
          <p className="text-gray-700">
            {/* TODO(content): real phone, email, address. */}
            Phone, email, and address go here.
          </p>
        </section>
      </main>

      <footer className="border-t border-gray-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 py-6 text-sm text-gray-500 flex items-center justify-between flex-wrap gap-2">
          <span>© {new Date().getFullYear()} Stallion</span>
          <Link href="/login" className="text-brand-700 hover:underline">Staff sign in</Link>
        </div>
      </footer>
    </div>
  );
}
