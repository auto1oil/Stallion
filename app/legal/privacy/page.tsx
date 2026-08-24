// Public privacy policy page. Used as the "Privacy Policy URL" in the
// Intuit Developer Portal app submission. Plain HTML, no auth required.
export const metadata = {
  title: 'Privacy Policy — Stallion',
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-white">
      <main className="max-w-3xl mx-auto px-6 py-12 prose prose-sm">
        <a href="/login" className="text-sm text-brand-700 hover:underline">← Back to sign in</a>

        <h1 className="text-3xl font-bold mt-4 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: May 22, 2026</p>

        <section className="mb-8">
          <p className="text-sm leading-6">
            Stallion (&quot;Stallion,&quot; &quot;we,&quot; &quot;us&quot;)
            operates this customer ordering and dispatch application
            (the &quot;App&quot;) to make it easier for our customers and team
            to place and fulfill orders. This Privacy Policy explains what
            information we collect, how we use it, and how we protect it.
          </p>
        </section>

        <h2 className="text-lg font-semibold mt-6 mb-2">Information we collect</h2>
        <p className="text-sm leading-6 mb-3">When you create a customer account or interact with the App, we collect:</p>
        <ul className="list-disc pl-6 text-sm leading-6 space-y-1">
          <li><strong>Account information:</strong> business name, contact name, email address, phone number, and delivery address.</li>
          <li><strong>Order information:</strong> products ordered, quantities, container sizes, weights, delivery instructions.</li>
          <li><strong>Customer documents:</strong> any documents you upload (customer profile sheets, sales tax-exempt forms, W-9 / FEIN forms).</li>
          <li><strong>Payment-related information:</strong> we may collect bank or credit card details solely so that we can process invoices and payments. We do not store full card numbers on our own servers.</li>
          <li><strong>Authentication data:</strong> the email and hashed password used to sign in to your account.</li>
        </ul>

        <h2 className="text-lg font-semibold mt-6 mb-2">How we use information</h2>
        <ul className="list-disc pl-6 text-sm leading-6 space-y-1">
          <li>To accept, process, deliver, and bill for your orders.</li>
          <li>To create matching customer records and invoices in our accounting system (Intuit QuickBooks Online).</li>
          <li>To contact you about your orders, your account, and related service updates.</li>
          <li>To improve and secure the App.</li>
        </ul>

        <h2 className="text-lg font-semibold mt-6 mb-2">Information sharing</h2>
        <p className="text-sm leading-6 mb-3">We do not sell or rent your personal information. We share information only as needed to operate the App and serve you:</p>
        <ul className="list-disc pl-6 text-sm leading-6 space-y-1">
          <li><strong>Intuit QuickBooks Online:</strong> when a customer places an order, we create or update a matching customer record and invoice in QuickBooks under your Stallion account.</li>
          <li><strong>Service providers:</strong> we use Vercel for hosting and Supabase for database and authentication. These providers handle data on our behalf under their own privacy commitments.</li>
          <li><strong>Legal compliance:</strong> we may disclose information when required by law, subpoena, or to protect our rights or the safety of others.</li>
        </ul>

        <h2 className="text-lg font-semibold mt-6 mb-2">Data retention</h2>
        <p className="text-sm leading-6">
          We keep customer, order, and document data for as long as your account is active and for a reasonable period afterward to satisfy accounting, tax, and legal obligations.
          You may request deletion of your personal data at any time by contacting us at the email below.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">Security</h2>
        <p className="text-sm leading-6">
          All data is transmitted over HTTPS. Passwords are stored hashed.
          Customer documents are stored in a private, signed-URL bucket that
          is only accessible to authenticated users and Stallion staff.
          QuickBooks access tokens are stored encrypted at rest and never
          shared with end users.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">Your rights</h2>
        <p className="text-sm leading-6">
          You may review, update, or delete your account information at any
          time from the &quot;My account&quot; page after signing in, or by
          contacting us. We will respond to legitimate access, correction,
          and deletion requests promptly.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">Children&apos;s privacy</h2>
        <p className="text-sm leading-6">
          The App is intended for use by businesses. We do not knowingly collect information from anyone under 18.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">Changes to this policy</h2>
        <p className="text-sm leading-6">
          We may update this Privacy Policy from time to time. When we do, we will revise the &quot;Last updated&quot; date at the top of the page.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">Contact us</h2>
        <p className="text-sm leading-6">
          {/* TODO(content): the real registered business name, address,
              phone and email before this page is published. */}
          Stallion<br />
          [Street address]<br />
          [City, State ZIP]<br />
          Phone: [phone]<br />
          Email: <a href="mailto:office@example.com" className="text-brand-700 hover:underline">office@example.com</a>
        </p>
      </main>
    </div>
  );
}
