'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import RepHomeCards from '@/components/RepHomeCards';
import VisitForm from '@/components/VisitForm';
import SalesSubNav from '@/components/SalesSubNav';

type Visit = {
  id: string;
  salesman_id: string | null;
  salesman_name: string;
  business_name: string;
  city: string | null;
  contact_person: string | null;
  notes: string | null;
  visit_date: string;
  visit_at: string;
};

type AdminContact = {
  id: string;
  full_name: string | null;
  email: string;
  phone: string | null;
};

function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtLongDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function buildSummary(salesmanName: string, dateISO: string, visits: Visit[]) {
  const lines: string[] = [];
  lines.push(`Sales visits — ${salesmanName} — ${fmtLongDate(dateISO)}`);
  lines.push('');
  visits.forEach((v, i) => {
    const head = v.city ? `${v.business_name} (${v.city})` : v.business_name;
    lines.push(`${i + 1}) ${head} — ${fmtTime(v.visit_at)}`);
    if (v.contact_person) lines.push(`   Spoke with: ${v.contact_person}`);
    if (v.notes) {
      v.notes.split('\n').forEach((ln) => lines.push(`   ${ln}`));
    }
    lines.push('');
  });
  lines.push(`Total stops: ${visits.length}`);
  return lines.join('\n').trim();
}

export default function SalesmanPage() {
  const supabase = createClient();
  const [visits, setVisits] = useState<Visit[]>([]);
  const [admins, setAdmins] = useState<AdminContact[]>([]);
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Visit | null>(null);
  const [viewDate, setViewDate] = useState(todayLocalISO());

  async function load() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', user.id)
      .single();
    const name = profile?.full_name || profile?.email || 'Salesman';
    setMe({ id: user.id, name });

    const { data: vs } = await supabase
      .from('salesman_visits')
      .select('*')
      .eq('salesman_id', user.id)
      .eq('visit_date', viewDate)
      .order('visit_at', { ascending: true });
    setVisits((vs as Visit[]) || []);

    const { data: adminRows } = await supabase
      .from('profiles')
      .select('id, full_name, email, phone')
      .in('role', ['admin', 'master_admin']);
    setAdmins((adminRows as AdminContact[]) || []);

    setLoading(false);
  }

  useEffect(() => { load(); }, [viewDate]);

  // Opened from the floating "Log visit" button (?log=1) → open the form.
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('log') === '1') {
      setEditing(null);
      setShowForm(true);
    }
  }, []);

  async function deleteVisit(id: string) {
    if (!confirm('Delete this visit?')) return;
    await supabase.from('salesman_visits').delete().eq('id', id);
    load();
  }

  function openTextSummary() {
    if (!me || visits.length === 0) return;
    const recipients = admins
      .map((a) => (a.phone || '').replace(/[^\d+]/g, ''))
      .filter(Boolean);
    if (recipients.length === 0) {
      alert(
        "No admin phone numbers on file. Ask an admin to add their phone " +
        "in the Users page (or you can copy the summary below and text it manually).",
      );
      return;
    }
    const body = buildSummary(me.name, viewDate, visits);
    // sms: URI format — works on iOS and Android. iOS prefers `&` separator,
    // Android prefers `?` — both forms accept the body parameter.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const sep = isIOS ? '&' : '?';
    const href = `sms:${recipients.join(',')}${sep}body=${encodeURIComponent(body)}`;
    window.location.href = href;
  }

  async function copySummary() {
    if (!me) return;
    const body = buildSummary(me.name, viewDate, visits);
    try {
      await navigator.clipboard.writeText(body);
      alert('Summary copied to clipboard.');
    } catch {
      prompt('Copy the summary below:', body);
    }
  }

  const isToday = viewDate === todayLocalISO();
  const summaryPreview = me && visits.length > 0 ? buildSummary(me.name, viewDate, visits) : '';

  return (
    <div>
      <SalesSubNav />
      {/* Two primary actions live on the home screen only — clicking the
          Auto 1 logo in the navbar returns the rep here to use them. */}
      <div className="flex justify-end gap-2 mb-4 flex-wrap">
        <Link
          href="/salesman/order"
          className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium"
        >
          + Place order
        </Link>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 font-medium"
        >
          + Log visit
        </button>
      </div>

      <RepHomeCards />

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3 mt-6">
        Today&apos;s visits
      </h2>

      <div className="flex items-center gap-2 mb-4">
        <label className="text-sm text-gray-700">Date:</label>
        <input
          type="date"
          value={viewDate}
          onChange={(e) => setViewDate(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-md text-sm"
        />
        {!isToday && (
          <button
            onClick={() => setViewDate(todayLocalISO())}
            className="text-sm text-brand-700 hover:text-brand-900"
          >
            Jump to today
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : visits.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-lg p-8 text-center">
          <p className="text-sm text-gray-500">
            No visits logged for {fmtLongDate(viewDate)}.
          </p>
          {isToday && (
            <p className="text-sm text-gray-500 mt-1">
              Tap <span className="font-medium">+ Log visit</span> after your next stop.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {visits.map((v, i) => (
            <div key={v.id} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex justify-between items-start gap-2 mb-1">
                <div className="font-medium">
                  <span className="text-gray-400 mr-2">#{i + 1}</span>
                  {v.business_name}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => { setEditing(v); setShowForm(true); }}
                    className="text-sm text-gray-600 hover:text-gray-900 px-2 py-1"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteVisit(v.id)}
                    className="text-sm text-red-600 hover:text-red-800 px-2 py-1"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="text-sm text-gray-600 flex flex-wrap gap-x-4">
                <span>{fmtTime(v.visit_at)}</span>
                {v.city && <span>{v.city}</span>}
                {v.contact_person && <span>Spoke with: {v.contact_person}</span>}
              </div>
              {v.notes && (
                <div className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{v.notes}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {visits.length > 0 && (
        <div className="mt-6 bg-white border border-gray-200 rounded-lg p-4">
          <h2 className="font-semibold mb-2">End-of-day summary</h2>
          <pre className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded p-3 mb-3">
{summaryPreview}
          </pre>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={openTextSummary}
              className="px-4 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 font-medium"
            >
              Text summary to admins
            </button>
            <button
              onClick={copySummary}
              className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Copy summary
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            "Text summary" opens your phone's Messages app with{' '}
            {admins.filter((a) => a.phone).length} admin recipient
            {admins.filter((a) => a.phone).length === 1 ? '' : 's'} and the
            summary already filled in — just tap Send.
          </p>
        </div>
      )}

      {showForm && me && (
        <VisitForm
          visit={editing}
          salesmanId={me.id}
          salesmanName={me.name}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={() => { setShowForm(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
