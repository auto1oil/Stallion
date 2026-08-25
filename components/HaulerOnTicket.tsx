'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import type { Hauler } from '@/lib/haulers';

// The hauling company block on a haul ticket.
//
// Read live off the haulers row rather than copied onto the ticket, so a
// company that corrects its phone number doesn't leave a hundred old tickets
// showing the wrong one. The company name is still stamped onto the ticket as
// trucking_company, because that is the field the paper form has and the one
// the office audits against.

export default function HaulerOnTicket({ haulerId }: { haulerId: string }) {
  const supabase = createClient();
  const [hauler, setHauler] = useState<Hauler | null>(null);

  useEffect(() => {
    supabase.from('haulers').select('*').eq('id', haulerId).maybeSingle()
      .then(({ data }) => setHauler((data as Hauler) ?? null));
  }, [supabase, haulerId]);

  if (!hauler) return null;

  const facts: [string, string | null][] = [
    ['Contact', hauler.contact_name],
    ['Phone', hauler.phone],
    ['Email', hauler.email],
    ['Address', hauler.address],
    ['MC #', hauler.mc_number],
    ['DOT #', hauler.dot_number],
  ];

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-1">
        Trucking company
      </h2>
      <p className="text-base font-medium">{hauler.name}</p>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm mt-2">
        {facts.filter(([, v]) => v).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-gray-500">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {facts.every(([, v]) => !v) && (
        <p className="text-xs text-gray-500 mt-1">
          No contact details on file yet — add them under Company.
        </p>
      )}
    </div>
  );
}
