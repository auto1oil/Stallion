// Public end-user license agreement / terms of service. Used as the
// "EULA URL" in the Intuit Developer Portal app submission.
export const metadata = {
  title: 'Terms of Service — Stallion',
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white">
      <main className="max-w-3xl mx-auto px-6 py-12 prose prose-sm">
        <a href="/login" className="text-sm text-brand-700 hover:underline">← Back to sign in</a>

        <h1 className="text-3xl font-bold mt-4 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: May 22, 2026</p>

        <section className="mb-6">
          <p className="text-sm leading-6">
            These Terms of Service (&quot;Terms&quot;) govern your use of the
            Stallion customer ordering and dispatch application
            (the &quot;App&quot;), operated by Stallion
            (&quot;Stallion,&quot; &quot;we,&quot; &quot;us&quot;).
            By creating an account, signing in, or placing an order through the
            App, you agree to these Terms.
          </p>
        </section>

        <h2 className="text-lg font-semibold mt-6 mb-2">1. Accounts</h2>
        <p className="text-sm leading-6">
          You must provide accurate information when creating an account and keep that information current. You are responsible for all activity that occurs under your account credentials, and you agree not to share your password.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">2. Orders and pricing</h2>
        <p className="text-sm leading-6">
          Orders placed through the App are subject to acceptance by Stallion. Pricing, availability, and delivery times are confirmed by an Stallion representative and reflected on the invoice we generate for each order. We may decline or cancel any order at our discretion.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">3. Payment terms</h2>
        <p className="text-sm leading-6 mb-3">
          Unless otherwise agreed in writing, the payment terms shown on your customer profile and on each invoice apply (typically 1% Same Day / Net 15). A finance charge of 1.5% per month (18% annual) applies to past-due balances. We accept Visa, MasterCard, and American Express.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">4. Credit application</h2>
        <p className="text-sm leading-6">
          By submitting a customer profile sheet, you authorize Stallion to investigate your financial responsibility and to make any inquiries necessary. You also agree to the additional terms and conditions printed on the customer profile sheet, including any security agreement, personal guarantee, and ACH authorization sections you sign.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">5. Delivery</h2>
        <p className="text-sm leading-6">
          Delivery times are estimates. Risk of loss passes to you upon delivery. You agree to provide a delivery address where our trucks can safely access bulk product and to inspect each delivery promptly.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">6. Document uploads</h2>
        <p className="text-sm leading-6">
          You may upload documents such as customer profile sheets, sales tax-exempt forms, and W-9 / FEIN forms. You represent that you have the right to upload each document and that the information in it is accurate.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">7. Acceptable use</h2>
        <p className="text-sm leading-6">
          You agree not to attempt to interfere with the App&apos;s operation, gain unauthorized access to other customers&apos; information, or use the App for any unlawful purpose.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">8. Disclaimer and limitation of liability</h2>
        <p className="text-sm leading-6">
          The App is provided &quot;as is.&quot; To the maximum extent permitted by law, Stallion disclaims all implied warranties and is not liable for any indirect, incidental, or consequential damages arising from your use of the App. Our total liability for any claim arising from these Terms or your use of the App will not exceed the total amount you paid Stallion for the order giving rise to the claim.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">9. Governing law and venue</h2>
        <p className="text-sm leading-6">
          These Terms are governed by the laws of the State of Utah. Venue for any dispute is the 4th District Court of Utah County, unless Stallion chooses otherwise or statute requires otherwise.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">10. Changes</h2>
        <p className="text-sm leading-6">
          We may update these Terms at any time. Continued use of the App after a change constitutes your acceptance of the updated Terms.
        </p>

        <h2 className="text-lg font-semibold mt-6 mb-2">11. Contact</h2>
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
