'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import ContractorSubNav from '@/components/ContractorSubNav';

// The agreed rate per job/phase, read-only. The office maintains this list on
// the Work Orders setup screen; it's here so a contractor can check what a job
// pays without asking.

type Rate = {
  id: string;
  job_number: string;
  phase_code: string | null;
  description: string | null;
  rate: number;
  rate_unit: string;
};

export default function ContractorRatesPage() {
  const supabase = createClient();
  const [rates, setRates] = useState<Rate[] | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('job_rates')
        .select('id, job_number, phase_code, description, rate, rate_unit')
        .eq('active', true)
        .order('job_number');
      setRates((data as Rate[]) || []);
    })();
  }, [supabase]);

  return (
    <div>
      <ContractorSubNav />
      <h1 className="text-2xl font-semibold mb-1">Job rates</h1>
      <p className="text-sm text-gray-500 mb-4">What each job pays. The office keeps this list current.</p>

      {rates === null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : rates.length === 0 ? (
        <p className="text-sm text-gray-500">No rates have been published yet.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {rates.map((r) => (
            <div key={r.id} className="px-4 py-2.5 flex justify-between items-center gap-3">
              <span className="min-w-0">
                <span className="font-medium text-sm">Job {r.job_number}</span>
                {r.phase_code ? <span className="text-sm text-gray-500"> · phase {r.phase_code}</span> : null}
                {r.description ? <span className="block text-xs text-gray-500 truncate">{r.description}</span> : null}
              </span>
              <span className="shrink-0 text-sm tabular-nums font-semibold">
                ${Number(r.rate).toFixed(2)}<span className="text-gray-500 font-normal">/{r.rate_unit}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
