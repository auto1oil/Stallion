// ============================================================================
// Scan & fill — a photo of paperwork becomes the form's fields.
// ============================================================================
// A registration card, a pump receipt, or a shop bill is photographed on the
// phone, read by Claude (vision), and handed back as JSON matching the form
// it fills. The key lives in app_settings ('anthropic_api_key'), master-admin
// only, same as the factoring credentials; each scan costs a fraction of a
// cent on that key.

import Anthropic from '@anthropic-ai/sdk';

export type ScanKind = 'registration' | 'fuel' | 'service';

export const SCAN_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ScanMediaType = (typeof SCAN_MEDIA_TYPES)[number];

const PROMPTS: Record<ScanKind, string> = {
  registration:
    'This photo is a vehicle registration card or similar vehicle paperwork. '
    + 'Read it and answer with ONLY this JSON, nothing else:\n'
    + '{"year": "...", "make": "...", "model": "...", "vin": "...", "plate": "...", '
    + '"plate_state": "..", "registration_expires": "YYYY-MM-DD"}\n'
    + 'plate_state is the two-letter state. Any value you cannot read is null. '
    + 'Dates are YYYY-MM-DD. Do not guess a VIN — null unless clearly legible.',
  fuel:
    'This photo is a fuel receipt from a truck stop or gas station. '
    + 'Read it and answer with ONLY this JSON, nothing else:\n'
    + '{"filled_on": "YYYY-MM-DD", "gallons": 0, "total_cost": 0, "vendor": "...", '
    + '"state": "..", "odometer": null}\n'
    + 'state is the two-letter state the station is in (from its address). '
    + 'gallons and total_cost are numbers. total_cost is the final total paid. '
    + 'Any value you cannot read is null.',
  service:
    'This photo is a repair-shop invoice, parts receipt, or maintenance record for a truck. '
    + 'Read it and answer with ONLY this JSON, nothing else:\n'
    + '{"service_date": "YYYY-MM-DD", "kind": "maintenance", "description": "...", '
    + '"cost": 0, "odometer": null}\n'
    + 'kind is "repair" if something broken was fixed, otherwise "maintenance". '
    + 'description is one short line: the shop name and what was done. '
    + 'cost is the final total as a number. Any value you cannot read is null.',
};

// Only these keys come back to the client, per kind — whatever else the model
// writes is dropped.
const FIELDS: Record<ScanKind, string[]> = {
  registration: ['year', 'make', 'model', 'vin', 'plate', 'plate_state', 'registration_expires'],
  fuel: ['filled_on', 'gallons', 'total_cost', 'vendor', 'state', 'odometer'],
  service: ['service_date', 'kind', 'description', 'cost', 'odometer'],
};

export async function scanImage(
  apiKey: string,
  kind: ScanKind,
  base64: string,
  mediaType: ScanMediaType,
): Promise<Record<string, string | number | null>> {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    output_config: { effort: 'low' },
    // On a safety decline the API retries on a fallback model in the same
    // call, so a scan doesn't just die.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system:
      'You read photos of paperwork for a hauling company and answer with '
      + 'nothing but the requested JSON. No prose, no code fences.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: PROMPTS[kind] },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The scanner declined to read that photo — type the fields in by hand.');
  }

  const text = response.content
    .filter((b): b is Extract<typeof response.content[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not read anything useful off that photo — try a straighter, closer shot.');

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    throw new Error('Could not read anything useful off that photo — try a straighter, closer shot.');
  }

  const out: Record<string, string | number | null> = {};
  for (const key of FIELDS[kind]) {
    const v = raw[key];
    if (v === null || v === undefined || v === '') { out[key] = null; continue; }
    out[key] = typeof v === 'number' ? v : String(v).trim();
  }
  return out;
}
