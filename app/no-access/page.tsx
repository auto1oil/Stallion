'use client';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

// Customer records live in this app as profiles with role 'customer' — they're
// the directory the office invoices against, synced from QuickBooks. Nobody
// signs in as one: there is no customer-facing side any more. If such a login
// does reach the app, it lands here rather than bouncing around redirects.
export default function NoAccessPage() {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50">
      <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 p-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/stallion-logo.svg" alt="Stallion" className="h-14 w-auto mx-auto mb-4" />
        <h1 className="text-lg font-semibold mb-2">This account has no access</h1>
        <p className="text-sm text-gray-600 mb-5">
          This app is for crews, office staff, contractors and funders. If you should have
          access, ask an admin to set your role on the Users screen.
        </p>
        <button
          onClick={signOut}
          className="w-full py-2 bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
