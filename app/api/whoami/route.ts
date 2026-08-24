// GET /api/whoami
//
// Returns the public IP our serverless function uses when making outbound
// HTTPS calls. Useful for filling out "tell us where your app is hosted"
// in Intuit's developer dashboard. Note: on Vercel's standard plans the
// egress IP can change between invocations and over time.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
    const j = await r.json();
    return NextResponse.json({
      egress_ip: j.ip,
      country: 'United States',
      hosting: 'Vercel (AWS US-East-1, Washington DC region)',
      note: 'Vercel serverless functions do not have a single static egress IP — the IP shown can change between invocations. For Intuit\'s purposes either pick a representative IP or list Vercel\'s region range.',
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
