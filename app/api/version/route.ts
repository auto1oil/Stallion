// GET /api/version — the running deploy's commit SHA. The client polls this
// when the app regains focus; if it changed since load, a new version shipped
// and the app reloads itself (so users stop seeing a stale cached bundle).

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || 'dev';
  return NextResponse.json({ sha }, { headers: { 'Cache-Control': 'no-store' } });
}
