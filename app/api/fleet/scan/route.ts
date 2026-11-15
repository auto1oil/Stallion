// POST /api/fleet/scan — read a photo (registration card, fuel receipt, shop
// bill) and hand back the form fields it shows. The phone takes the picture,
// this route has Claude read it, the form fills itself.

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';
import { scanImage, SCAN_MEDIA_TYPES, type ScanKind, type ScanMediaType } from '@/lib/scan';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const KINDS: ScanKind[] = ['registration', 'fuel', 'service'];
const FLEET_ROLES = ['admin', 'master_admin', 'office', 'driver', 'mechanic', 'labor'];

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: 'not signed in' }, { status: 401 });

  // Same circle as the fleet tables' RLS: Stallion's own people.
  const { data: actor } = await supabase
    .from('profiles').select('role, hauler_id').eq('id', user.id).single();
  if (!actor || actor.hauler_id || !FLEET_ROLES.includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'not allowed' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = String(body.kind || '') as ScanKind;
  const image = typeof body.image === 'string' ? body.image : '';
  const mediaType = String(body.media_type || '') as ScanMediaType;
  if (!KINDS.includes(kind) || !image || !SCAN_MEDIA_TYPES.includes(mediaType)) {
    return NextResponse.json({ ok: false, error: 'bad scan request' }, { status: 400 });
  }
  // ~6MB of base64 — far more than a compressed phone photo needs.
  if (image.length > 8_000_000) {
    return NextResponse.json({ ok: false, error: 'that photo is too large — try again, it will compress' }, { status: 400 });
  }

  const { data: setting } = await createAdminClient()
    .from('app_settings').select('value').eq('key', 'anthropic_api_key').maybeSingle();
  const apiKey = ((setting as { value: string | null } | null)?.value || '').trim();
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      error: "Scanning isn't set up yet — the master admin adds the AI key under Work Orders → Setup.",
    }, { status: 400 });
  }

  try {
    const fields = await scanImage(apiKey, kind, image, mediaType);
    return NextResponse.json({ ok: true, fields });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({
        ok: false,
        error: 'The AI key was rejected — check it under Work Orders → Setup.',
      }, { status: 400 });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({
        ok: false,
        error: 'The scanner is catching its breath — try again in a minute.',
      }, { status: 429 });
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json({
        ok: false,
        error: `The scanner had trouble (${err.status}) — try again, or type it in.`,
      }, { status: 502 });
    }
    const msg = err instanceof Error ? err.message : 'Could not read that photo.';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
