// /api/admin/company-docs — admin-only library of company documents (proof of
// insurance, sales-tax cert, W-9, filled forms, etc.) we can store and send out.
//
// All file ops run with the service-role client, which also auto-creates the
// private 'company-documents' bucket on first use — so no SQL/bucket setup is
// needed. Files are stored flat as `${ts}__${category}__${displayName}` so a
// single list call returns everything with its category + name.
//
//   GET    → list every document (with a 7-day signed URL to share/download)
//   POST   → multipart upload { file, name, category }
//   DELETE → { path }   remove a document

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUCKET = 'company-documents';
const SEP = '__';
const SHARE_TTL = 60 * 60 * 24 * 7; // 7 days

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'not signed in', status: 401 as const };
  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (me?.role !== 'admin' && me?.role !== 'master_admin') return { error: 'admin only', status: 403 as const };
  return { error: null, status: 200 as const };
}

async function ensureBucket(db: ReturnType<typeof createAdminClient>) {
  // createBucket is idempotent enough — ignore "already exists".
  const { error } = await db.storage.createBucket(BUCKET, { public: false });
  if (error && !/exist/i.test(error.message)) throw new Error(error.message);
}

const safe = (s: string) => (s || '').replace(new RegExp(SEP, 'g'), '-').replace(/[/\\]/g, '-').trim();

function parseName(stored: string): { category: string; name: string } {
  const parts = stored.split(SEP);
  if (parts.length >= 3) return { category: parts[1] || 'Other', name: parts.slice(2).join(SEP) };
  return { category: 'Other', name: stored };
}

export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });
  const db = createAdminClient();
  try {
    await ensureBucket(db);
    const { data, error } = await db.storage.from(BUCKET).list('', { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const files = (data || []).filter((f) => f.id); // skip folder placeholders
    const docs = await Promise.all(files.map(async (f) => {
      const { category, name } = parseName(f.name);
      const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(f.name, SHARE_TTL, { download: name });
      return {
        path: f.name,
        name,
        category,
        size: (f.metadata as { size?: number } | null)?.size ?? null,
        created_at: f.created_at ?? null,
        url: signed?.signedUrl ?? null,
      };
    }));
    return NextResponse.json({ ok: true, docs });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (gate.error) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });
  const db = createAdminClient();
  try {
    await ensureBucket(db);
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: 'file required' }, { status: 400 });
    const category = safe((form.get('category') as string) || 'Other') || 'Other';
    // Display name: provided name (keep the file's extension) or the file name.
    const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0]) || '';
    let display = safe((form.get('name') as string) || file.name) || file.name;
    if (ext && !display.toLowerCase().endsWith(ext.toLowerCase())) display += ext;
    const stored = `${Date.now()}${SEP}${category}${SEP}${display}`;
    const buf = new Uint8Array(await file.arrayBuffer());
    const { error } = await db.storage.from(BUCKET).upload(stored, buf, {
      contentType: file.type || 'application/octet-stream', upsert: false,
    });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, path: stored });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const gate = await requireAdmin();
  if (gate.error) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });
  const db = createAdminClient();
  try {
    const { path } = await req.json().catch(() => ({}));
    if (!path) return NextResponse.json({ ok: false, error: 'path required' }, { status: 400 });
    const { error } = await db.storage.from(BUCKET).remove([path]);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
